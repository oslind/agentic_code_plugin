import { promises as fs } from "fs";
import * as path from "path";
import { CheckConfig, CheckResult, runAllChecks } from "../checks/runner";
import { Git } from "../git/git";
import { ModelProvider } from "../providers/types";
import { readyTasks, TaskStore } from "../state/taskStore";
import { Task } from "../state/types";
import { matchesAny } from "../tools/paths";
import { ToolCall } from "../tools/protocol";
import { WorkspaceSandbox } from "../tools/sandbox";
import { Mutex } from "../util/mutex";
import { Worker } from "../worker/worker";

export const AGENT_DIR = ".agentic";

export interface MergeRequest {
  task: Task;
  changedFiles: string[];
  diff: string;
  checks: CheckResult[];
}

export interface OrchestratorOptions {
  store: TaskStore;
  runId: string;
  provider: ModelProvider;
  /** The workspace folder. It must be the root of a git repository. */
  workspaceRoot: string;
  checks: CheckConfig[];
  maxParallel?: number;
  maxTurns?: number;
  maxFixRounds?: number;
  /** Folders linked from the workspace into each worktree, such as node_modules. */
  linkDirs?: string[];
  signal?: AbortSignal;
  /** The user's go-ahead before a task's work is merged. Resolves true to merge. */
  approveMerge: (request: MergeRequest) => Promise<boolean>;
  approveTool: (task: Task, reason: string, call: ToolCall) => Promise<boolean>;
  onChange?: () => void;
}

export interface RunOutcome {
  integrationBranch: string;
  done: string[];
  failed: string[];
  /** Pending tasks that could not start because a dependency failed. */
  blocked: string[];
}

export class OrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorError";
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function integrationBranchFor(runId: string): string {
  return `agentic/${shortId(runId)}/integration`;
}

/**
 * Runs a planned run to completion. Each task gets its own branch and worktree
 * inside the workspace's .agentic folder. Verified work is merged, one task at
 * a time and only with the user's approval, into a per-run integration branch.
 * The user's own branch is never touched here.
 */
export class Orchestrator {
  private readonly git: Git;
  private readonly mergeLock = new Mutex();
  private readonly o: Required<Omit<OrchestratorOptions, "signal" | "onChange">> & Pick<OrchestratorOptions, "signal" | "onChange">;
  private root = "";
  private integrationDir = "";
  readonly integrationBranch: string;

  constructor(options: OrchestratorOptions) {
    this.o = { maxParallel: 2, maxTurns: 40, maxFixRounds: 2, linkDirs: ["node_modules"], ...options };
    this.git = new Git(options.workspaceRoot);
    this.integrationBranch = integrationBranchFor(options.runId);
  }

  private log(type: string, message: string, taskId?: string, data?: Record<string, unknown>): Promise<void> {
    return this.o.store.log({ runId: this.o.runId, taskId, type, message, data });
  }

  private async setStatus(task: Task, status: Task["status"], error?: string): Promise<void> {
    await this.o.store.setStatus(this.o.runId, task.id, status, error);
    this.o.onChange?.();
  }

  private worktreeDir(name: string): string {
    return path.join(this.root, AGENT_DIR, "worktrees", shortId(this.o.runId), name);
  }

  private async prepare(): Promise<void> {
    this.root = await fs.realpath(this.o.workspaceRoot);
    if (!(await this.git.isRepo())) {
      throw new OrchestratorError("The workspace is not a git repository. Workers need git to work on isolated branches.");
    }
    const top = await fs.realpath(await this.git.toplevel());
    if (top !== this.root) {
      throw new OrchestratorError(`Open the repository root (${top}) as the workspace folder, so worktrees stay inside it.`);
    }
    await this.git.excludeLocally(`/${AGENT_DIR}/`);
    // Linked folders are symlinks inside worktrees; keep git from committing them.
    for (const d of this.o.linkDirs) await this.git.excludeLocally(d);

    this.integrationDir = this.worktreeDir("_integration");
    if (!(await exists(this.integrationDir))) {
      await fs.mkdir(path.dirname(this.integrationDir), { recursive: true });
      await this.git.addWorktree(this.integrationDir, this.integrationBranch, "HEAD");
      await this.log("integration_branch", this.integrationBranch);
    }
    await this.linkDirs(this.integrationDir);
  }

  private async linkDirs(worktree: string): Promise<void> {
    for (const d of this.o.linkDirs) {
      const source = path.join(this.root, d);
      const target = path.join(worktree, d);
      if ((await exists(source)) && !(await exists(target))) {
        await fs.symlink(source, target, process.platform === "win32" ? "junction" : "dir");
      }
    }
  }

  async run(): Promise<RunOutcome> {
    await this.prepare();
    await this.o.store.recoverInterrupted(this.o.runId);
    const active = new Map<string, Promise<void>>();

    for (;;) {
      if (this.o.signal?.aborted) break;
      const run = await this.o.store.load(this.o.runId);
      for (const task of readyTasks(run)) {
        if (active.size >= this.o.maxParallel) break;
        if (active.has(task.id)) continue;
        active.set(
          task.id,
          this.runTask(task).finally(() => active.delete(task.id)),
        );
      }
      if (active.size === 0) break;
      await Promise.race(active.values());
    }
    await Promise.allSettled(active.values());

    const final = await this.o.store.load(this.o.runId);
    if (this.o.signal?.aborted) {
      for (const t of final.tasks.filter((x) => x.status === "pending")) {
        await this.setStatus(t, "cancelled", "Run cancelled");
      }
    }
    const after = await this.o.store.load(this.o.runId);
    return {
      integrationBranch: this.integrationBranch,
      done: after.tasks.filter((t) => t.status === "done").map((t) => t.id),
      failed: after.tasks.filter((t) => t.status === "failed" || t.status === "cancelled").map((t) => t.id),
      blocked: after.tasks.filter((t) => t.status === "pending").map((t) => t.id),
    };
  }

  private async runTask(task: Task): Promise<void> {
    const dir = this.worktreeDir(task.id);
    try {
      await this.setStatus(task, "running");
      const attempt = (await this.o.store.load(this.o.runId)).tasks.find((t) => t.id === task.id)?.attempts ?? 1;
      // A retry gets a new branch, so earlier attempts stay available for recovery.
      const branch = `agentic/${shortId(this.o.runId)}/${task.id}${attempt > 1 ? `-try${attempt}` : ""}`;
      // Start from the integration branch, which already holds the work of finished dependencies.
      const base = await this.git.at(this.integrationDir).head();
      if (await exists(dir)) await this.git.removeWorktree(dir);
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await this.git.addWorktree(dir, branch, base);
      await this.linkDirs(dir);
      await this.o.store.updateTask(this.o.runId, task.id, { branch });
      await this.log("worktree", dir, task.id, { branch, base });

      const sandbox = await WorkspaceSandbox.create(dir);
      const worker = new Worker({
        provider: this.o.provider,
        sandbox,
        task,
        checks: this.o.checks,
        maxTurns: this.o.maxTurns,
        signal: this.o.signal,
        approve: (reason, call) => this.o.approveTool(task, reason, call),
        log: (type, message, data) => void this.log(type, message, task.id, data),
      });

      let result = await worker.run();
      let checks: CheckResult[] = [];
      for (let round = 0; ; round++) {
        await this.setStatus(task, "verifying");
        // A worker saying it is done is not enough: the configured checks decide.
        checks = await runAllChecks(this.o.checks, dir, this.o.signal);
        const failed = checks.filter((c) => !c.passed);
        await this.log("checks", failed.length ? "failed" : "passed", task.id, { results: checks.map((c) => ({ name: c.name, passed: c.passed })) });
        if (failed.length === 0) break;
        if (round >= this.o.maxFixRounds) {
          throw new OrchestratorError(`Checks failed: ${failed.map((c) => c.name).join(", ")}`);
        }
        await this.setStatus(task, "running");
        result = await worker.run(
          `Your work is not done. These checks failed:\n\n${failed.map((c) => `## ${c.name}\n${c.output}`).join("\n\n")}\n\nFix the problems, then finish.`,
        );
      }

      // Only files in the task's scope are committed. The policy already stops the
      // worker writing elsewhere, so anything else is a side effect of checks.
      const { commit, ignored } = await this.commitScoped(dir, task, result.summary);
      if (ignored.length) await this.log("ignored_changes", ignored.join(", "), task.id);
      if (!commit) {
        await this.o.store.updateTask(this.o.runId, task.id, { summary: result.summary, changedFiles: [] });
        await this.log("no_changes", "Task finished without changing files", task.id);
        await this.setStatus(task, "done");
        await this.git.removeWorktree(dir);
        return;
      }
      const changedFiles = await this.git.changedFiles(base, branch);
      await this.o.store.updateTask(this.o.runId, task.id, { commit, changedFiles, summary: result.summary });

      await this.setStatus(task, "awaiting_approval");
      const diff = await this.git.diff(base, branch);
      const latest = (await this.o.store.load(this.o.runId)).tasks.find((t) => t.id === task.id) ?? task;
      if (!(await this.o.approveMerge({ task: latest, changedFiles, diff, checks }))) {
        throw new OrchestratorError("Merge rejected by the user. The branch is kept.");
      }
      await this.integrate(task, branch);
      await this.setStatus(task, "done");
      await this.git.removeWorktree(dir);
    } catch (err) {
      const cancelled = this.o.signal?.aborted;
      const message = cancelled ? "Cancelled" : (err as Error).message;
      await this.log(cancelled ? "cancelled" : "task_failed", message, task.id);
      const current = (await this.o.store.load(this.o.runId)).tasks.find((t) => t.id === task.id);
      if (current && current.status !== "done" && current.status !== "failed" && current.status !== "cancelled") {
        await this.setStatus(task, cancelled ? "cancelled" : "failed", message);
      }
    }
  }

  private async commitScoped(dir: string, task: Task, summary: string): Promise<{ commit?: string; ignored: string[] }> {
    const git = this.git.at(dir);
    const out = await git.run(["status", "--porcelain", "-z", "--untracked-files=all", "--no-renames"]);
    const files = out.split("\0").filter(Boolean).map((line) => line.slice(3));
    const inScope = files.filter((f) => matchesAny(f, task.fileScope));
    const ignored = files.filter((f) => !matchesAny(f, task.fileScope));
    if (inScope.length === 0) return { ignored };
    await git.run(["--literal-pathspecs", "add", "-A", "--", ...inScope]);
    const commit = await git.commitStaged(`${task.title}\n\nAgentic task ${task.id}: ${summary}`);
    return { commit, ignored };
  }

  /** Merges one task branch into the integration branch. Only one merge runs at a time. */
  private integrate(task: Task, branch: string): Promise<void> {
    return this.mergeLock.run(async () => {
      const git = this.git.at(this.integrationDir);
      const before = await git.head();
      const conflicts = await git.merge(branch, `Merge agentic task ${task.id}: ${task.title}`);
      if (conflicts.length) {
        await this.log("merge_conflict", conflicts.join(", "), task.id, { branch });
        throw new OrchestratorError(`Merge conflict in ${conflicts.join(", ")}. The branch ${branch} is kept for recovery.`);
      }
      // Each task passed on its own; the combination must pass too.
      const checks = await runAllChecks(this.o.checks, this.integrationDir, this.o.signal);
      const failed = checks.filter((c) => !c.passed);
      if (failed.length) {
        await git.resetHard(before);
        await this.log("integration_failed", failed.map((c) => c.name).join(", "), task.id, { output: failed.map((c) => c.output).join("\n") });
        throw new OrchestratorError(`Checks failed after merging: ${failed.map((c) => c.name).join(", ")}. The merge was undone; ${branch} is kept.`);
      }
      await this.log("merged", branch, task.id, { into: this.integrationBranch, before, after: await git.head() });
    });
  }
}

/**
 * Brings a finished run into the user's checked-out branch. This changes the
 * user's working tree, so callers must get explicit approval first.
 */
export async function applyRun(workspaceRoot: string, integrationBranch: string): Promise<string[]> {
  const git = new Git(workspaceRoot);
  if (!(await git.isClean())) {
    throw new OrchestratorError("Your working tree has uncommitted changes. Commit or stash them first.");
  }
  return git.merge(integrationBranch, `Merge ${integrationBranch}`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}
