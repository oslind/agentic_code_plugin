import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckConfig } from "../src/checks/runner";
import { applyRun, MergeRequest, Orchestrator } from "../src/coordinator/orchestrator";
import { NewTask, TaskStore } from "../src/state/taskStore";
import { ModelProvider } from "../src/providers/types";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let base: string;
let repo: string;
let store: TaskStore;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "orch-"));
  repo = path.join(base, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  await writeFile(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  store = new TaskStore(path.join(base, "state"));
});
afterEach(() => rm(base, { recursive: true, force: true }));

type Turn = { thought: string; call: Record<string, unknown> };

/** Replies per task, keyed by the task title in the worker's first user message. */
function scriptedProvider(scripts: Record<string, Turn[]>): ModelProvider {
  return {
    model: "fake",
    contextWindow: 32768,
    async chat(req) {
      const title = /^Task: (.*)$/m.exec(req.messages[1]?.content ?? "")?.[1] ?? "";
      const turn = scripts[title]?.shift();
      if (!turn) throw new Error(`No scripted reply left for ${title}`);
      return { content: JSON.stringify(turn) };
    },
  };
}

const write = (p: string, content: string): Turn => ({ thought: `write ${p}`, call: { tool: "write_file", path: p, content } });
const finish: Turn = { thought: "done", call: { tool: "finish", summary: "did it" } };
const task = (id: string, fileScope: string[], dependsOn: string[] = []): NewTask => ({
  id,
  title: id,
  instructions: `Do ${id}`,
  fileScope,
  dependsOn,
});

async function setup(tasks: NewTask[]) {
  const run = await store.createRun("test", repo);
  await store.addTasks(run.id, tasks);
  return run.id;
}

function orchestrator(runId: string, provider: ModelProvider, extra: Partial<ConstructorParameters<typeof Orchestrator>[0]> = {}) {
  const merges: MergeRequest[] = [];
  const o = new Orchestrator({
    store,
    runId,
    provider,
    workspaceRoot: repo,
    checks: [],
    approveMerge: async (r) => {
      merges.push(r);
      return true;
    },
    approveTool: async () => false,
    ...extra,
  });
  return { o, merges };
}

const node = (code: string) => `node -e ${JSON.stringify(code)}`;

describe("Orchestrator", () => {
  it("runs tasks in parallel worktrees, merges approved work and leaves the user's branch alone", async () => {
    const runId = await setup([task("a", ["src/a.txt"]), task("b", ["src/b.txt"]), task("c", ["src/c.txt"], ["a"])]);
    const provider = scriptedProvider({
      a: [write("src/a.txt", "A"), finish],
      b: [write("src/b.txt", "B"), finish],
      c: [{ thought: "read dep", call: { tool: "read_file", path: "src/a.txt" } }, write("src/c.txt", "C"), finish],
    });
    const { o, merges } = orchestrator(runId, provider);
    const outcome = await o.run();

    expect(outcome.done.sort()).toEqual(["a", "b", "c"]);
    expect(merges.map((m) => m.task.id).sort()).toEqual(["a", "b", "c"]);
    expect(merges.find((m) => m.task.id === "a")?.changedFiles).toEqual(["src/a.txt"]);
    expect(git(repo, "ls-tree", "-r", "--name-only", outcome.integrationBranch).split("\n").sort()).toEqual([
      "README.md",
      "src/a.txt",
      "src/b.txt",
      "src/c.txt",
    ]);
    // The user's checkout is untouched until they apply the run.
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(existsSync(path.join(repo, "src"))).toBe(false);
    expect(git(repo, "status", "--porcelain")).toBe("");

    expect(await applyRun(repo, outcome.integrationBranch)).toEqual([]);
    expect(readFileSync(path.join(repo, "src", "c.txt"), "utf8")).toBe("C");
  });

  it("sends failing checks back to the worker until they pass", async () => {
    const checks: CheckConfig[] = [{ name: "test", command: node("process.exit(require('fs').readFileSync('v.txt','utf8')==='ok'?0:1)") }];
    const runId = await setup([task("fix", ["v.txt"])]);
    const provider = scriptedProvider({ fix: [write("v.txt", "bad"), finish, write("v.txt", "ok"), finish] });
    const { o } = orchestrator(runId, provider, { checks });
    const outcome = await o.run();
    expect(outcome.done).toEqual(["fix"]);
    expect(git(repo, "show", `${outcome.integrationBranch}:v.txt`)).toBe("ok");
    const log = await store.readLog(runId);
    expect(log.filter((e) => e.type === "checks").map((e) => e.message)).toEqual(["failed", "passed"]);
  });

  it("fails a task when checks keep failing, and blocks its dependents", async () => {
    const checks: CheckConfig[] = [{ name: "test", command: node("process.exit(1)") }];
    const runId = await setup([task("a", ["a.txt"]), task("b", ["b.txt"], ["a"])]);
    const provider = scriptedProvider({ a: [write("a.txt", "x"), finish, finish] });
    const { o } = orchestrator(runId, provider, { checks, maxFixRounds: 1 });
    const outcome = await o.run();
    expect(outcome.failed).toEqual(["a"]);
    expect(outcome.blocked).toEqual(["b"]);
    const a = (await store.load(runId)).tasks[0]!;
    expect(a.error).toMatch(/Checks failed: test/);
  });

  it("keeps the branch when the user rejects a merge", async () => {
    const runId = await setup([task("a", ["a.txt"])]);
    const { o } = orchestrator(runId, scriptedProvider({ a: [write("a.txt", "x"), finish] }), { approveMerge: async () => false });
    const outcome = await o.run();
    expect(outcome.failed).toEqual(["a"]);
    const t = (await store.load(runId)).tasks[0]!;
    expect(t.branch).toBeDefined();
    expect(git(repo, "show", `${t.branch}:a.txt`)).toBe("x");
    expect(git(repo, "ls-tree", "--name-only", outcome.integrationBranch)).not.toContain("a.txt");
  });

  it("refuses writes outside the task's scope and never commits them", async () => {
    const runId = await setup([task("a", ["a.txt"])]);
    const provider = scriptedProvider({ a: [write("other.txt", "nope"), write("a.txt", "ok"), finish] });
    const { o, merges } = orchestrator(runId, provider);
    await o.run();
    expect(merges[0]?.changedFiles).toEqual(["a.txt"]);
    const denied = (await store.readLog(runId)).filter((e) => e.type === "denied");
    expect(denied[0]?.message).toMatch(/outside this task's file scope/);
  });

  it("does not commit files that checks create outside the scope", async () => {
    const checks: CheckConfig[] = [{ name: "build", command: node("require('fs').writeFileSync('artifact.log','x')") }];
    const runId = await setup([task("a", ["a.txt"])]);
    const { o, merges } = orchestrator(runId, scriptedProvider({ a: [write("a.txt", "ok"), finish] }), { checks });
    await o.run();
    expect(merges[0]?.changedFiles).toEqual(["a.txt"]);
  });

  it("detects merge conflicts, keeps the branch and leaves the integration branch clean", async () => {
    // Same file, no dependency: the planner would order these, but the orchestrator must still cope.
    const runId = await setup([task("a", ["same.txt"]), task("b", ["same.txt"])]);
    const provider = scriptedProvider({ a: [write("same.txt", "A\n"), finish], b: [write("same.txt", "B\n"), finish] });
    const { o } = orchestrator(runId, provider);
    const outcome = await o.run();
    expect(outcome.done).toHaveLength(1);
    expect(outcome.failed).toHaveLength(1);
    const failed = (await store.load(runId)).tasks.find((t) => t.status === "failed")!;
    expect(failed.error).toMatch(/Merge conflict in same.txt/);
    expect(git(repo, "show", `${failed.branch}:same.txt`)).toMatch(/[AB]/);
    const integration = path.join(repo, ".agentic", "worktrees", runId.slice(0, 8), "_integration");
    expect(git(integration, "status", "--porcelain")).toBe("");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("undoes a merge that breaks the combined checks", async () => {
    // Each task passes alone, but both files together fail the check.
    const checks: CheckConfig[] = [{ name: "test", command: node("const fs=require('fs');process.exit(fs.existsSync('x.txt')&&fs.existsSync('y.txt')?1:0)") }];
    const runId = await setup([task("x", ["x.txt"]), task("y", ["y.txt"])]);
    const provider = scriptedProvider({ x: [write("x.txt", "1"), finish], y: [write("y.txt", "1"), finish] });
    const { o } = orchestrator(runId, provider, { checks });
    const outcome = await o.run();
    expect(outcome.done).toHaveLength(1);
    expect(outcome.failed).toHaveLength(1);
    const failed = (await store.load(runId)).tasks.find((t) => t.status === "failed")!;
    expect(failed.error).toMatch(/merge was undone/);
    const files = git(repo, "ls-tree", "--name-only", outcome.integrationBranch).split("\n");
    expect(files).not.toContain(`${failed.id}.txt`);
  });

  it("rejects a workspace that is not a git repository root", async () => {
    const runId = await setup([task("a", ["a.txt"])]);
    const { o } = orchestrator(runId, scriptedProvider({}), { workspaceRoot: base });
    await expect(o.run()).rejects.toThrow(/not a git repository|repository root/);
  });

  it("stops starting tasks when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const runId = await setup([task("a", ["a.txt"])]);
    const { o } = orchestrator(runId, scriptedProvider({}), { signal: controller.signal });
    const outcome = await o.run();
    expect(outcome.failed).toEqual(["a"]);
    expect((await store.load(runId)).tasks[0]?.status).toBe("cancelled");
  });
});
