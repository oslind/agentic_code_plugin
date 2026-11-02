import { existsSync, readFileSync } from "fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceptChange, changeKind, rejectChange } from "../src/changes/review";
import { CheckConfig } from "../src/checks/runner";
import { Orchestrator, OrchestratorOptions } from "../src/coordinator/orchestrator";
import { ProviderError } from "../src/providers/openaiCompatible";
import { RetryingProvider } from "../src/providers/retrying";
import { ChatRequest, ModelProvider } from "../src/providers/types";
import { NewTask, TaskStore } from "../src/state/taskStore";
import { PendingChange, Task } from "../src/state/types";

const node = (code: string) => `node -e ${JSON.stringify(code)}`;

let base: string;
let repo: string;
let store: TaskStore;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "orch-"));
  repo = path.join(base, "project");
  await mkdir(repo);
  await writeFile(path.join(repo, "README.md"), "hello\nworld\n");
  store = new TaskStore(path.join(base, "state"));
});
afterEach(() => rm(base, { recursive: true, force: true }));

type Turn = { thought: string; call: Record<string, unknown> };
type Reply = Turn | ((req: ChatRequest) => Promise<Turn>);

/** Replies per task, keyed by the task title in the worker's first user message. */
function scripted(scripts: Record<string, Reply[]>, seen: ChatRequest[] = []): ModelProvider {
  return {
    model: "fake",
    contextWindow: 32768,
    async chat(req) {
      seen.push(req);
      const title = /^Task: (.*)$/m.exec(req.messages[1]?.content ?? "")?.[1] ?? "";
      const next = scripts[title]?.shift();
      if (!next) throw new Error(`No scripted reply left for ${title}`);
      const turn = typeof next === "function" ? await next(req) : next;
      return { content: JSON.stringify(turn) };
    },
  };
}

const write = (p: string, content: string): Turn => ({ thought: `write ${p}`, call: { tool: "write_file", path: p, content } });
const read = (p: string): Turn => ({ thought: `read ${p}`, call: { tool: "read_file", path: p } });
const finish: Turn = { thought: "done", call: { tool: "finish", summary: "did it" } };
const task = (id: string, fileScope: string[], dependsOn: string[] = []): NewTask => ({ id, title: id, instructions: `Do ${id}`, fileScope, dependsOn });

async function setup(tasks: NewTask[]) {
  const run = await store.createRun("test", repo);
  await store.addTasks(run.id, tasks);
  return run.id;
}

function make(runId: string, provider: ModelProvider, extra: Partial<OrchestratorOptions> = {}) {
  const proposed: { task: Task; changes: PendingChange[] }[] = [];
  const o = new Orchestrator({
    store,
    runId,
    provider,
    workspaceRoot: repo,
    checks: [],
    retryDelayMs: 1,
    onChanges: async (t, changes) => void proposed.push({ task: t, changes }),
    approveTool: async () => false,
    ...extra,
  });
  return { o, proposed };
}

const changesOf = async (runId: string) => (await store.load(runId)).changes ?? [];
const onDisk = (p: string) => (existsSync(path.join(repo, p)) ? readFileSync(path.join(repo, p), "utf8") : undefined);

describe("Orchestrator without git", () => {
  it("runs tasks in parallel and leaves every change pending; nothing is written to the project", async () => {
    const runId = await setup([task("a", ["src/a.txt"]), task("b", ["src/b.txt"]), task("c", ["src/c.txt"], ["a"])]);
    const provider = scripted({
      a: [write("src/a.txt", "A"), finish],
      b: [write("src/b.txt", "B"), finish],
      c: [read("src/a.txt"), write("src/c.txt", "C"), finish],
    });
    const { o, proposed } = make(runId, provider);
    const outcome = await o.run();

    expect(outcome.done.sort()).toEqual(["a", "b", "c"]);
    expect(proposed.map((p) => p.task.id).sort()).toEqual(["a", "b", "c"]);
    const changes = await changesOf(runId);
    expect(changes.map((c) => [c.path, c.status, c.original]).sort()).toEqual([
      ["src/a.txt", "pending", null],
      ["src/b.txt", "pending", null],
      ["src/c.txt", "pending", null],
    ]);
    expect(changes.every((c) => changeKind(c) === "new")).toBe(true);
    expect(existsSync(path.join(repo, "src"))).toBe(false);
    // No git, and the scratch copies are gone.
    expect(existsSync(path.join(repo, ".git"))).toBe(false);
    expect(existsSync(path.join(repo, ".agentic", "scratch", runId.slice(0, 8)))).toBe(false);
  });

  it("lets a dependent task see what an earlier task proposed", async () => {
    const runId = await setup([task("a", ["a.txt"]), task("b", ["b.txt"], ["a"])]);
    const seen: ChatRequest[] = [];
    const provider = scripted({ a: [write("a.txt", "from a"), finish], b: [read("a.txt"), write("b.txt", "B"), finish] }, seen);
    await make(runId, provider).o.run();
    const afterRead = seen.find((r) => r.messages.some((m) => m.content.includes("from a") && m.role === "user"));
    expect(afterRead).toBeDefined();
    expect(onDisk("a.txt")).toBeUndefined();
  });

  it("records an edit to an existing file with its original text", async () => {
    const runId = await setup([task("edit", ["README.md"])]);
    const provider = scripted({
      edit: [read("README.md"), { thought: "edit", call: { tool: "replace_in_file", path: "README.md", search: "world", replace: "there" } }, finish],
    });
    await make(runId, provider).o.run();
    const [change] = await changesOf(runId);
    expect(change).toMatchObject({ path: "README.md", original: "hello\nworld\n", proposed: "hello\nthere\n", status: "pending" });
    expect(changeKind(change!)).toBe("edit");
    expect(onDisk("README.md")).toBe("hello\nworld\n");
  });

  it("tells each sub-agent what the coordinator learned and what the tasks it builds on reported", async () => {
    const run = await store.createRun("test", repo, undefined, "- Physics lives in src/physics.ts.");
    await store.addTasks(run.id, [task("a", ["src/a.txt"]), task("b", ["src/b.txt"], ["a"])]);
    const seen: ChatRequest[] = [];
    const provider = scripted(
      { a: [write("src/a.txt", "A"), { thought: "done", call: { tool: "finish", summary: "Added A; it exports wind()." } }], b: [write("src/b.txt", "B"), finish] },
      seen,
    );
    expect((await make(run.id, provider).o.run()).done.sort()).toEqual(["a", "b"]);
    const first = (t: string) => seen.find((r) => r.messages[1]?.content.startsWith(`Task: ${t}`))!.messages[1]!.content;
    expect(first("a")).toMatch(/Physics lives in src\/physics\.ts/);
    expect(first("a")).not.toMatch(/Their reports/);
    expect(first("b")).toMatch(/Their reports:\n- a: Added A; it exports wind\(\)\./);
  });

  it("runs checks on a scratch copy and sends failures back to the worker until they pass", async () => {
    const checks: CheckConfig[] = [{ name: "test", command: node("process.exit(require('fs').readFileSync('v.txt','utf8')==='ok'?0:1)") }];
    const runId = await setup([task("fix", ["v.txt"])]);
    const provider = scripted({ fix: [write("v.txt", "bad"), finish, write("v.txt", "ok"), finish] });
    const outcome = await make(runId, provider, { checks }).o.run();
    expect(outcome.done).toEqual(["fix"]);
    expect((await changesOf(runId))[0]?.proposed).toBe("ok");
    expect(onDisk("v.txt")).toBeUndefined();
    const log = await store.readLog(runId);
    expect(log.filter((e) => e.type === "checks").map((e) => e.message)).toEqual(["failed", "passed"]);
  });

  it("does not turn files that checks create into changes", async () => {
    const checks: CheckConfig[] = [{ name: "build", command: node("require('fs').writeFileSync('artifact.log','x')") }];
    const runId = await setup([task("a", ["a.txt"])]);
    await make(runId, scripted({ a: [write("a.txt", "ok"), finish] }), { checks }).o.run();
    expect((await changesOf(runId)).map((c) => c.path)).toEqual(["a.txt"]);
    expect(onDisk("artifact.log")).toBeUndefined();
  });

  it("fails a task when checks keep failing, and blocks its dependents", async () => {
    const checks: CheckConfig[] = [{ name: "test", command: node("process.exit(1)") }];
    const runId = await setup([task("a", ["a.txt"]), task("b", ["b.txt"], ["a"])]);
    const outcome = await make(runId, scripted({ a: [write("a.txt", "x"), finish, finish] }), { checks, maxFixRounds: 1 }).o.run();
    expect(outcome.failed).toEqual(["a"]);
    expect(outcome.blocked).toEqual(["b"]);
    const a = (await store.load(runId)).tasks[0]!;
    expect(a.error).toMatch(/Checks failed: test/);
    expect(a.unfinished).toEqual([{ path: "a.txt", content: "x" }]);
    expect(await changesOf(runId)).toEqual([]);
  });

  it("refuses writes outside the task's scope", async () => {
    const runId = await setup([task("a", ["a.txt"])]);
    await make(runId, scripted({ a: [write("other.txt", "nope"), write("a.txt", "ok"), finish] })).o.run();
    expect((await changesOf(runId)).map((c) => c.path)).toEqual(["a.txt"]);
    const denied = (await store.readLog(runId)).filter((e) => e.type === "denied");
    expect(denied[0]?.message).toMatch(/outside this task's file scope/);
  });

  it("refuses writes that leave the project, even when in scope", async () => {
    const runId = await setup([task("a", ["**"])]);
    await make(runId, scripted({ a: [write("../escape.txt", "x"), write(".git/config", "x"), finish] })).o.run();
    expect(await changesOf(runId)).toEqual([]);
    expect(existsSync(path.join(base, "escape.txt"))).toBe(false);
  });

  it("stops starting tasks when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const runId = await setup([task("a", ["a.txt"])]);
    const outcome = await make(runId, scripted({}), { signal: controller.signal }).o.run();
    expect(outcome.failed).toEqual(["a"]);
    expect((await store.load(runId)).tasks[0]?.status).toBe("cancelled");
  });
});

describe("recovery", () => {
  it("retries a failed task and tells the worker what the last attempt wrote", async () => {
    const checks = [{ name: "test", command: node("process.exit(require('fs').readFileSync('v.txt','utf8')==='ok'?0:1)") }];
    const runId = await setup([task("v", ["v.txt"]), task("after", ["after.txt"], ["v"])]);
    const seen: ChatRequest[] = [];
    const provider = scripted({ v: [write("v.txt", "bad"), finish, write("v.txt", "ok"), finish], after: [write("after.txt", "1"), finish] }, seen);

    const first = await make(runId, provider, { checks, maxFixRounds: 0 }).o.run();
    expect(first.failed).toEqual(["v"]);
    expect(first.blocked).toEqual(["after"]);

    await store.retryTask(runId, "v");
    const second = await make(runId, provider, { checks, maxFixRounds: 0 }).o.run();
    expect(second.done.sort()).toEqual(["after", "v"]);
    const retryPrompt = seen.find((r) => r.messages[1]?.content.includes("previous attempt"))?.messages[1]?.content;
    expect(retryPrompt).toMatch(/Checks failed: test/);
    expect(retryPrompt).toMatch(/## v\.txt\nbad/);
    expect((await store.load(runId)).tasks[0]!.unfinished).toBeUndefined();
  });

  it("resumes tasks that were running when VS Code stopped", async () => {
    const runId = await setup([task("a", ["a.txt"])]);
    await store.setStatus(runId, "a", "running");
    expect((await make(runId, scripted({ a: [write("a.txt", "A"), finish] })).o.run()).done).toEqual(["a"]);
  });

  it("retries automatically when the model server is briefly down", async () => {
    const runId = await setup([task("a", ["a.txt"])]);
    let calls = 0;
    const flaky: ModelProvider = {
      model: "fake",
      contextWindow: 32768,
      async chat() {
        calls++;
        if (calls === 1) throw new ProviderError("connection refused", undefined, true);
        return { content: JSON.stringify(calls === 2 ? write("a.txt", "A") : finish) };
      },
    };
    expect((await make(runId, flaky).o.run()).done).toEqual(["a"]);
    expect((await store.load(runId)).tasks[0]!.attempts).toBe(2);
  });

  it("gives up on transient failures after maxAttempts", async () => {
    const runId = await setup([task("a", ["a.txt"])]);
    const down: ModelProvider = { model: "fake", contextWindow: 32768, chat: async () => Promise.reject(new ProviderError("down", 503, true)) };
    expect((await make(runId, down, { maxAttempts: 2 }).o.run()).failed).toEqual(["a"]);
    expect((await store.load(runId)).tasks[0]!.attempts).toBe(2);
  });

  it("cancels one task without stopping the others", async () => {
    const runId = await setup([task("slow", ["s.txt"]), task("fast", ["f.txt"])]);
    let started!: () => void;
    const slowStarted = new Promise<void>((r) => (started = r));
    const hang = (req: ChatRequest) =>
      new Promise<Turn>((_, reject) => {
        started();
        req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const { o } = make(runId, scripted({ slow: [hang], fast: [write("f.txt", "F"), finish] }));
    const running = o.run();
    await slowStarted;
    expect(o.cancelTask("slow")).toBe(true);
    const outcome = await running;
    expect(outcome.done).toEqual(["fast"]);
    expect((await store.load(runId)).tasks.find((t) => t.id === "slow")!.status).toBe("cancelled");
    await store.retryTask(runId, "slow");
    expect((await store.load(runId)).tasks.find((t) => t.id === "slow")!.status).toBe("pending");
  });
});

describe("reviewing changes", () => {
  async function proposedRun(scripts: Record<string, Reply[]>, tasks: NewTask[]) {
    const runId = await setup(tasks);
    await make(runId, scripted(scripts)).o.run();
    return runId;
  }

  it("writes an accepted change to the project and drops a rejected one", async () => {
    const runId = await proposedRun({ a: [write("a.txt", "A"), write("b.txt", "B"), finish] }, [task("a", ["a.txt", "b.txt"])]);
    const accepted = await acceptChange(store, runId, "a.txt", repo);
    expect(accepted.ok).toBe(true);
    expect(onDisk("a.txt")).toBe("A");
    await rejectChange(store, runId, "b.txt");
    expect(onDisk("b.txt")).toBeUndefined();
    expect((await changesOf(runId)).map((c) => [c.path, c.status])).toEqual([
      ["a.txt", "accepted"],
      ["b.txt", "rejected"],
    ]);
    const log = (await store.readLog(runId)).map((e) => e.type);
    expect(log).toContain("change_accepted");
    expect(log).toContain("change_rejected");
    expect((await acceptChange(store, runId, "a.txt", repo)).ok).toBe(false);
  });

  it("does not overwrite a file the user changed meanwhile unless asked to", async () => {
    const runId = await proposedRun(
      { e: [read("README.md"), write("README.md", "agent version\n"), finish] },
      [task("e", ["README.md"])],
    );
    await writeFile(path.join(repo, "README.md"), "my newer version\n");
    const first = await acceptChange(store, runId, "README.md", repo);
    expect(first).toMatchObject({ ok: false, reason: "changed_on_disk" });
    expect(onDisk("README.md")).toBe("my newer version\n");
    expect((await acceptChange(store, runId, "README.md", repo, { overwrite: true })).ok).toBe(true);
    expect(onDisk("README.md")).toBe("agent version\n");
  });

  it("never writes protected paths, even from a tampered change list", async () => {
    const runId = await setup([task("a", ["a.txt"])]);
    await store.addChanges(runId, [{ path: ".agentic/x.json", taskId: "a", original: null, proposed: "x", status: "pending" }]);
    expect(await acceptChange(store, runId, ".agentic/x.json", repo)).toMatchObject({ ok: false, reason: "protected" });
    expect(existsSync(path.join(repo, ".agentic", "x.json"))).toBe(false);
  });

  it("builds a later task on an earlier pending change and keeps the first original", async () => {
    const runId = await proposedRun(
      { a: [write("README.md", "one\n"), finish], b: [read("README.md"), write("README.md", "two\n"), finish] },
      [task("a", ["README.md"]), task("b", ["README.md"], ["a"])],
    );
    const changes = await changesOf(runId);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ original: "hello\nworld\n", proposed: "two\n", taskId: "b" });
    expect(await readdir(repo)).toEqual(["README.md"]);
  });
});

describe("RetryingProvider", () => {
  it("retries retryable errors with backoff and passes others through", async () => {
    let n = 0;
    const inner: ModelProvider = {
      model: "m",
      contextWindow: 1,
      chat: async () => {
        n++;
        if (n < 3) throw new ProviderError("busy", 503, true);
        return { content: "ok" };
      },
    };
    expect((await new RetryingProvider(inner, 3, 1).chat({ messages: [] })).content).toBe("ok");
    const bad: ModelProvider = { ...inner, chat: async () => Promise.reject(new ProviderError("bad", 400, false)) };
    await expect(new RetryingProvider(bad, 3, 1).chat({ messages: [] })).rejects.toThrow("bad");
  });
});
