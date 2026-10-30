import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupRun, MergeRequest, Orchestrator, OrchestratorOptions } from "../src/coordinator/orchestrator";
import { ProviderError } from "../src/providers/openaiCompatible";
import { RetryingProvider } from "../src/providers/retrying";
import { ChatRequest, ModelProvider } from "../src/providers/types";
import { NewTask, TaskStore } from "../src/state/taskStore";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const node = (code: string) => `node -e ${JSON.stringify(code)}`;

let base: string;
let repo: string;
let store: TaskStore;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "recovery-"));
  repo = path.join(base, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  await writeFile(path.join(repo, "README.md"), "hello\nworld\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
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
      const turn = typeof next === "function" ? await next(req) : next;
      return { content: JSON.stringify(turn) };
    },
  };
}

const write = (p: string, content: string): Turn => ({ thought: "w", call: { tool: "write_file", path: p, content } });
const finish: Turn = { thought: "done", call: { tool: "finish", summary: "did it" } };
const task = (id: string, fileScope: string[], dependsOn: string[] = []): NewTask => ({ id, title: id, instructions: `Do ${id}`, fileScope, dependsOn });

async function setup(tasks: NewTask[]) {
  const run = await store.createRun("test", repo);
  await store.addTasks(run.id, tasks);
  return run.id;
}

function make(runId: string, provider: ModelProvider, extra: Partial<OrchestratorOptions> = {}) {
  const merges: MergeRequest[] = [];
  const o = new Orchestrator({
    store,
    runId,
    provider,
    workspaceRoot: repo,
    checks: [],
    retryDelayMs: 1,
    approveMerge: async (r) => {
      merges.push(r);
      return true;
    },
    approveTool: async () => false,
    ...extra,
  });
  return { o, merges };
}

describe("recovery", () => {
  it("commits edits to files that already exist", async () => {
    const runId = await setup([task("edit", ["README.md"])]);
    const provider = scripted({
      edit: [{ thought: "edit", call: { tool: "replace_in_file", path: "README.md", search: "world", replace: "there" } }, finish],
    });
    const { o, merges } = make(runId, provider);
    const outcome = await o.run();
    expect(outcome.done).toEqual(["edit"]);
    expect(merges[0]?.changedFiles).toEqual(["README.md"]);
    expect(git(repo, "show", `${outcome.integrationBranch}:README.md`)).toBe("hello\nthere");
  });

  it("retries a failed task on a new branch, keeps the old one and tells the worker what happened", async () => {
    const checks = [{ name: "test", command: node("process.exit(require('fs').readFileSync('v.txt','utf8')==='ok'?0:1)") }];
    const runId = await setup([task("v", ["v.txt"]), task("after", ["after.txt"], ["v"])]);
    const seen: ChatRequest[] = [];
    const provider = scripted({ v: [write("v.txt", "bad"), finish, write("v.txt", "ok"), finish], after: [write("after.txt", "1"), finish] }, seen);

    const first = await make(runId, provider, { checks, maxFixRounds: 0 }).o.run();
    expect(first.failed).toEqual(["v"]);
    expect(first.blocked).toEqual(["after"]);
    const firstBranch = (await store.load(runId)).tasks[0]!.branch!;

    await store.retryTask(runId, "v");
    const second = await make(runId, provider, { checks, maxFixRounds: 0 }).o.run();
    expect(second.done.sort()).toEqual(["after", "v"]);

    const v = (await store.load(runId)).tasks[0]!;
    expect(v.branch).toMatch(/-try2$/);
    expect(git(repo, "show", `${firstBranch}:v.txt`)).toBe("bad");
    const retryPrompt = seen.find((r) => r.messages[1]?.content.includes("previous attempt"))?.messages[1]?.content;
    expect(retryPrompt).toMatch(/Checks failed: test/);
    expect(retryPrompt).toMatch(/\+bad/);
  });

  it("resumes tasks that were running when VS Code stopped", async () => {
    const runId = await setup([task("a", ["a.txt"])]);
    await store.setStatus(runId, "a", "running");
    const { o } = make(runId, scripted({ a: [write("a.txt", "A"), finish] }));
    expect((await o.run()).done).toEqual(["a"]);
  });

  it("asks again for approval of work verified before a restart, without redoing it", async () => {
    const runId = await setup([task("a", ["a.txt"])]);
    const branch = `agentic/${runId.slice(0, 8)}/a`;
    git(repo, "checkout", "-qb", branch);
    await writeFile(path.join(repo, "a.txt"), "A");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "a");
    const commit = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");
    for (const s of ["running", "verifying", "awaiting_approval"] as const) await store.setStatus(runId, "a", s);
    await store.updateTask(runId, "a", { branch, commit, changedFiles: ["a.txt"] });

    const { o, merges } = make(runId, scripted({}));
    const outcome = await o.run();
    expect(outcome.done).toEqual(["a"]);
    expect(merges[0]?.changedFiles).toEqual(["a.txt"]);
    expect(git(repo, "show", `${outcome.integrationBranch}:a.txt`)).toBe("A");
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
    const outcome = await make(runId, flaky).o.run();
    expect(outcome.done).toEqual(["a"]);
    expect((await store.load(runId)).tasks[0]!.attempts).toBe(2);
  });

  it("gives up on transient failures after maxAttempts", async () => {
    const runId = await setup([task("a", ["a.txt"])]);
    const down: ModelProvider = {
      model: "fake",
      contextWindow: 32768,
      chat: async () => {
        throw new ProviderError("down", 503, true);
      },
    };
    const outcome = await make(runId, down, { maxAttempts: 2 }).o.run();
    expect(outcome.failed).toEqual(["a"]);
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
    const provider = scripted({ slow: [hang], fast: [write("f.txt", "F"), finish] });
    const { o } = make(runId, provider);
    const running = o.run();
    await slowStarted;
    expect(o.cancelTask("slow")).toBe(true);
    const outcome = await running;
    expect(outcome.done).toEqual(["fast"]);
    const slow = (await store.load(runId)).tasks.find((t) => t.id === "slow")!;
    expect(slow.status).toBe("cancelled");
    // A cancelled task can be retried later.
    await store.retryTask(runId, "slow");
    expect((await store.load(runId)).tasks.find((t) => t.id === "slow")!.status).toBe("pending");
  });

  it("cleans up worktrees and keeps branches unless asked", async () => {
    const runId = await setup([task("a", ["a.txt"])]);
    await make(runId, scripted({ a: [write("a.txt", "A"), finish] }), { approveMerge: async () => false }).o.run();
    const short = runId.slice(0, 8);
    expect(existsSync(path.join(repo, ".agentic", "worktrees", short))).toBe(true);

    const kept = await cleanupRun(repo, runId);
    expect(kept.branches).toEqual([]);
    expect(existsSync(path.join(repo, ".agentic", "worktrees", short))).toBe(false);
    expect(git(repo, "branch", "--list", `agentic/${short}/*`)).toContain(`agentic/${short}/a`);

    const removed = await cleanupRun(repo, runId, true);
    expect(removed.branches.sort()).toEqual([`agentic/${short}/a`, `agentic/${short}/integration`]);
    expect(git(repo, "branch", "--list", `agentic/${short}/*`)).toBe("");
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
