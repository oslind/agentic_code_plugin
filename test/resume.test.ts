import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Orchestrator, RESUME_NOTE } from "../src/coordinator/orchestrator";
import { ChatRequest, ModelProvider } from "../src/providers/types";
import { resumableTasks, resumeState } from "../src/state/resume";
import { INTERRUPTED, NewTask, TaskStore } from "../src/state/taskStore";
import { Run } from "../src/state/types";

let base: string;
let repo: string;
let store: TaskStore;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "resume-"));
  repo = path.join(base, "project");
  await mkdir(repo);
  await writeFile(path.join(repo, "README.md"), "hello\n");
  store = new TaskStore(path.join(base, "state"));
});
afterEach(() => rm(base, { recursive: true, force: true }));

type Turn = { thought: string; call: Record<string, unknown> };
type Reply = Turn | ((req: ChatRequest) => Promise<Turn>);

function scripted(scripts: Record<string, Reply[]>, seen: ChatRequest[] = []): ModelProvider {
  return {
    model: "fake",
    contextWindow: 32768,
    async chat(req) {
      seen.push(req);
      const title = /^Task: (.*)$/m.exec(req.messages[1]?.content ?? "")?.[1] ?? "";
      const next = scripts[title]?.shift();
      if (!next) throw new Error(`No scripted reply left for ${title}`);
      return { content: JSON.stringify(typeof next === "function" ? await next(req) : next) };
    },
  };
}

const write = (p: string, content: string): Turn => ({ thought: `write ${p}`, call: { tool: "write_file", path: p, content } });
const finish: Turn = { thought: "done", call: { tool: "finish", summary: "did it" } };
const task = (id: string, fileScope: string[], dependsOn: string[] = []): NewTask => ({ id, title: id, instructions: `Do ${id}`, fileScope, dependsOn });
const DEAD_PID = 2 ** 22 + 12345;

function orchestrator(runId: string, provider: ModelProvider, signal?: AbortSignal) {
  return new Orchestrator({ store, runId, provider, workspaceRoot: repo, checks: [], retryDelayMs: 1, approveTool: async () => false, onChanges: async () => undefined, signal });
}

/** Runs until task "a" hangs on its model call, the way a sub-agent is left when VS Code closes. */
async function crashMidTask(runId: string, before: Turn[]): Promise<void> {
  let hung!: () => void;
  const hanging = new Promise<void>((r) => (hung = r));
  void orchestrator(runId, scripted({ a: [...before, () => (hung(), new Promise<Turn>(() => undefined))] })).run();
  await hanging;
  // The extension host is gone: its pid no longer runs.
  const run = await store.load(runId);
  run.activeIn = { pid: DEAD_PID, since: run.activeIn!.since };
  await store.save(run);
}

describe("resume state", () => {
  const mk = (statuses: [string, number][], extra: Partial<Run> = {}): Run => ({
    id: "r",
    request: "x",
    createdAt: "",
    updatedAt: "",
    tasks: statuses.map(([status, attempts], i) => ({
      id: `t${i}`,
      title: `t${i}`,
      instructions: "",
      dependsOn: [],
      fileScope: [],
      status: status as Run["tasks"][number]["status"],
      attempts,
      createdAt: "",
      updatedAt: "",
    })),
    ...extra,
  });
  const dead = () => false;
  const alive = () => true;

  it("tells interrupted, stopped, unstarted, finished and research runs apart", () => {
    expect(resumeState(mk([["done", 1], ["running", 1]]), 1, dead)).toBe("interrupted");
    expect(resumeState(mk([["done", 1], ["cancelled", 1]]), 1, dead)).toBe("stopped");
    expect(resumeState(mk([["pending", 0]]), 1, dead)).toBeUndefined();
    expect(resumeState(mk([["done", 1], ["done", 1]]), 1, dead)).toBeUndefined();
    expect(resumeState(mk([["running", 1]], { kind: "research" }), 1, dead)).toBeUndefined();
    // Cut off before any status was written, but the run was marked as active by a host that is gone.
    expect(resumeState(mk([["done", 1], ["pending", 0]], { activeIn: { pid: 7, since: "" } }), 1, dead)).toBe("interrupted");
  });

  it("leaves a run alone that another VS Code window is running", () => {
    expect(resumeState(mk([["running", 1]], { activeIn: { pid: 7, since: "" } }), 1, alive)).toBe("elsewhere");
    // The same process: not another window.
    expect(resumeState(mk([["running", 1]], { activeIn: { pid: 1, since: "" } }), 1, alive)).toBe("interrupted");
  });

  it("does not count tasks blocked by a failed task as left", () => {
    const run = mk([["failed", 1], ["pending", 0], ["cancelled", 1]]);
    run.tasks[1]!.dependsOn = ["t0"];
    expect(resumableTasks(run).map((t) => t.id)).toEqual(["t2"]);
    run.tasks[2]!.status = "done";
    expect(resumeState(run, 1, dead)).toBeUndefined();
  });
});

describe("resuming after a restart", () => {
  it("saves a checkpoint before every step and marks the run as active while it runs", async () => {
    const run = await store.createRun("test", repo);
    await store.addTasks(run.id, [task("a", ["a.txt"])]);
    await crashMidTask(run.id, [write("a.txt", "draft A")]);
    const cp = await store.loadCheckpoint(run.id, "a");
    expect(cp?.turns).toBe(1);
    expect(cp?.drafts).toEqual([{ path: "a.txt", original: null, content: "draft A", basis: null }]);
    expect(cp?.history.at(-1)?.content).toContain("a.txt");
    expect((await store.load(run.id)).tasks[0]!.status).toBe("running");
  });

  it("marks cut-off tasks stopped, then continues the sub-agent's own conversation with its drafts", async () => {
    const run = await store.createRun("test", repo);
    await store.addTasks(run.id, [task("a", ["a.txt", "b.txt"]), task("b", ["c.txt"], ["a"])]);
    await crashMidTask(run.id, [write("a.txt", "draft A")]);
    expect(resumeState(await store.load(run.id), process.pid)).toBe("interrupted");

    const cut = await store.markInterrupted(run.id);
    expect(cut.map((t) => t.id)).toEqual(["a"]);
    let after = await store.load(run.id);
    expect(after.tasks.map((t) => [t.id, t.status, t.error])).toEqual([
      ["a", "cancelled", INTERRUPTED],
      ["b", "pending", undefined],
    ]);
    expect(after.activeIn).toBeUndefined();
    // Still shown as interrupted until it is resumed.
    expect(resumeState(after, process.pid)).toBe("interrupted");

    await store.prepareResume(run.id);
    const seen: ChatRequest[] = [];
    const outcome = await orchestrator(run.id, scripted({ a: [write("b.txt", "B"), finish], b: [write("c.txt", "C"), finish] }, seen)).run();
    expect(outcome.done.sort()).toEqual(["a", "b"]);
    // The first call after the restart carries the old conversation and the note, not a fresh start.
    const first = seen[0]!.messages;
    expect(first.some((m) => m.role === "assistant" && m.content.includes("draft A"))).toBe(true);
    expect(first.at(-1)?.content).toBe(RESUME_NOTE);
    after = await store.load(run.id);
    expect(after.changes!.map((c) => [c.path, c.proposed, c.status]).sort()).toEqual([
      ["a.txt", "draft A", "pending"],
      ["b.txt", "B", "pending"],
      ["c.txt", "C", "pending"],
    ]);
    expect(after.activeIn).toBeUndefined();
    // Done: nothing left to continue from.
    expect(await store.loadCheckpoint(run.id, "a")).toBeUndefined();
    expect(resumeState(after, process.pid)).toBeUndefined();
  });

  it("does not bring back a draft the user rejected after the run stopped", async () => {
    const run = await store.createRun("test", repo);
    await store.addTasks(run.id, [task("a", ["a.txt"])]);
    const controller = new AbortController();
    let hung!: () => void;
    const hanging = new Promise<void>((r) => (hung = r));
    const stopped = orchestrator(
      run.id,
      scripted({
        a: [
          write("a.txt", "draft A"),
          (req) => {
            hung();
            return new Promise<Turn>((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
          },
        ],
      }),
      controller.signal,
    ).run();
    await hanging;
    controller.abort();
    await stopped;
    // Stop kept the draft for review and the checkpoint for a resume.
    expect((await store.load(run.id)).changes!.map((c) => c.status)).toEqual(["pending"]);
    expect(await store.loadCheckpoint(run.id, "a")).toBeDefined();
    await store.setChangeStatus(run.id, "a.txt", "rejected");

    await store.prepareResume(run.id);
    await orchestrator(run.id, scripted({ a: [finish] })).run();
    const changes = (await store.load(run.id)).changes!;
    expect(changes.map((c) => [c.path, c.status])).toEqual([["a.txt", "rejected"]]);
  });

  it("starts a failed task over with a note instead of its checkpoint", async () => {
    const run = await store.createRun("test", repo);
    await store.addTasks(run.id, [task("a", ["a.txt"])]);
    await orchestrator(run.id, scripted({ a: [write("a.txt", "A")] })).run();
    expect((await store.load(run.id)).tasks[0]!.status).toBe("failed");
    expect(await store.loadCheckpoint(run.id, "a")).toBeUndefined();
  });

  it("ignores a checkpoint file that is damaged", async () => {
    const run = await store.createRun("test", repo);
    await store.addTasks(run.id, [task("a", ["a.txt"])]);
    const file = path.join(base, "state", "runs", run.id, "checkpoints", "a.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{not json");
    expect(await store.loadCheckpoint(run.id, "a")).toBeUndefined();
    await writeFile(file, JSON.stringify({ history: [{ role: "system", content: "evil" }], drafts: [] }));
    expect(await store.loadCheckpoint(run.id, "a")).toBeUndefined();
  });
});
