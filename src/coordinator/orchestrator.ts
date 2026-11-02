import { promises as fs } from "fs";
import * as path from "path";
import { OverlayFiles, pendingBase } from "../changes/overlay";
import { ScratchCopy } from "../changes/scratch";
import { CheckConfig, CheckResult, runAllChecks } from "../checks/runner";
import { ProviderError } from "../providers/openaiCompatible";
import { ModelProvider } from "../providers/types";
import { readyTasks, TaskStore } from "../state/taskStore";
import { PendingChange, Task } from "../state/types";
import { ToolCall } from "../tools/protocol";
import { WorkspaceSandbox } from "../tools/sandbox";
import { Worker } from "../worker/worker";

export const AGENT_DIR = ".agentic";

export interface OrchestratorOptions {
  store: TaskStore;
  runId: string;
  provider: ModelProvider;
  /** The project folder open in VS Code. Nothing outside it is read or written. */
  workspaceRoot: string;
  checks: CheckConfig[];
  maxParallel?: number;
  maxTurns?: number;
  maxFixRounds?: number;
  /** Attempts per task before a transient failure (such as the model server being down) needs the user. */
  maxAttempts?: number;
  retryDelayMs?: number;
  /** Folders linked, not copied, into the scratch copy where checks run, such as node_modules. */
  linkDirs?: string[];
  signal?: AbortSignal;
  /** Called when a task has finished with file changes. They are pending: nothing is written until accepted. */
  onChanges?: (task: Task, changes: PendingChange[]) => Promise<void>;
  /** The user's go-ahead for a call the policy flagged, such as a new check command. */
  approveTool: (task: Task, reason: string, call: ToolCall, preview?: string) => Promise<boolean>;
  /** Asked before every check command runs, including verification. Without it, approved checks run freely. */
  approveCommand?: (task: Task, check: CheckConfig) => Promise<boolean>;
  /** Lets a sub-agent ask the user a question. Without it, sub-agents decide on their own. */
  askUser?: (task: Task, question: string) => Promise<string>;
  /** Messages the user sent directly to a sub-agent. Each call drains them. */
  inbox?: (taskId: string) => string[];
  onChange?: () => void;
}

export interface RunOutcome {
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

type Optional = "signal" | "onChange" | "askUser" | "inbox" | "approveCommand" | "onChanges";

/**
 * Runs a planned run to completion, without git. Each sub-agent works on the
 * project as it is on disk plus the changes earlier tasks proposed; its own
 * writes stay in memory and become pending changes for the user to review.
 * Tasks that run at the same time have separate files (the plan makes tasks
 * that share files wait for each other), so their changes never collide.
 */
export class Orchestrator {
  private readonly o: Required<Omit<OrchestratorOptions, Optional>> & Pick<OrchestratorOptions, Optional>;
  private readonly taskControllers = new Map<string, AbortController>();
  private root = "";

  constructor(options: OrchestratorOptions) {
    this.o = { maxParallel: 2, maxTurns: 40, maxFixRounds: 2, maxAttempts: 3, retryDelayMs: 2000, linkDirs: ["node_modules"], ...options };
  }

  private log(type: string, message: string, taskId?: string, data?: Record<string, unknown>): Promise<void> {
    return this.o.store.log({ runId: this.o.runId, taskId, type, message, data });
  }

  private async setStatus(task: Task, status: Task["status"], error?: string): Promise<void> {
    await this.o.store.setStatus(this.o.runId, task.id, status, error);
    this.o.onChange?.();
  }

  private scratchDir(taskId: string): string {
    return path.join(this.root, AGENT_DIR, "scratch", shortId(this.o.runId), taskId);
  }

  /** Stops one task. What it wrote so far is kept for a retry. */
  cancelTask(taskId: string): boolean {
    const controller = this.taskControllers.get(taskId);
    controller?.abort();
    return controller !== undefined;
  }

  async run(): Promise<RunOutcome> {
    this.root = await fs.realpath(this.o.workspaceRoot);
    // Tasks that were mid-flight when VS Code stopped have no live worker; start them again.
    await this.o.store.recoverInterrupted(this.o.runId);
    const active = new Map<string, Promise<void>>();

    for (;;) {
      if (this.o.signal?.aborted) break;
      const run = await this.o.store.load(this.o.runId);
      for (const task of readyTasks(run)) {
        if (active.size >= this.o.maxParallel) break;
        if (active.has(task.id)) continue;
        active.set(task.id, this.runTask(task).finally(() => active.delete(task.id)));
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
    await fs.rm(path.join(this.root, AGENT_DIR, "scratch", shortId(this.o.runId)), { recursive: true, force: true });
    const after = await this.o.store.load(this.o.runId);
    return {
      done: after.tasks.filter((t) => t.status === "done").map((t) => t.id),
      failed: after.tasks.filter((t) => t.status === "failed" || t.status === "cancelled").map((t) => t.id),
      blocked: after.tasks.filter((t) => t.status === "pending").map((t) => t.id),
    };
  }

  private async current(taskId: string): Promise<Task | undefined> {
    return (await this.o.store.load(this.o.runId)).tasks.find((t) => t.id === taskId);
  }

  /**
   * What this sub-agent should know besides its own instructions: what the
   * coordinator learned before planning, and what the tasks it depends on
   * reported when they finished.
   */
  private async briefingFor(task: Task): Promise<string | undefined> {
    const run = await this.o.store.load(this.o.runId);
    const parts: string[] = [];
    if (run.briefing) parts.push(`What the coordinator knows about this project:\n${run.briefing}`);
    const reports = task.dependsOn
      .map((id) => run.tasks.find((t) => t.id === id))
      .filter((t): t is Task => !!t && t.status === "done" && !!t.summary)
      .map((t) => `- ${t.title}: ${t.summary!.replace(/\s+/g, " ").slice(0, 600)}`);
    if (reports.length) parts.push(`The tasks you build on are done. Their reports:\n${reports.join("\n")}`);
    return parts.length ? parts.join("\n\n") : undefined;
  }

  /** What the last attempt left behind, so a retry can build on it instead of starting blind. */
  private previousAttemptNote(task: Task): string | undefined {
    const error = task.error ?? task.lastError;
    if (!error || task.attempts === 0) return undefined;
    const files = (task.unfinished ?? []).map((f) => `## ${f.path}\n${f.content}`).join("\n\n");
    const shown = files.length > 6000 ? `${files.slice(0, 6000)}\n[... cut ...]` : files;
    return [
      `A previous attempt at this task failed: ${error}`,
      shown ? `What it had written is below for reference. Reuse what is still useful; it was never applied.\n\n${shown}` : "It had not written anything.",
    ].join("\n\n");
  }

  private async runTask(task: Task): Promise<void> {
    const controller = new AbortController();
    this.taskControllers.set(task.id, controller);
    const signal = this.o.signal ? AbortSignal.any([this.o.signal, controller.signal]) : controller.signal;
    const scratch = new ScratchCopy(this.root, this.scratchDir(task.id), this.o.linkDirs);
    let files: OverlayFiles | undefined;
    try {
      const fresh = (await this.current(task.id)) ?? task;
      const note = [await this.briefingFor(fresh), this.previousAttemptNote(fresh)].filter(Boolean).join("\n\n") || undefined;
      await this.setStatus(task, "running");
      // The project as on disk, plus what earlier tasks of this run proposed.
      const run = await this.o.store.load(this.o.runId);
      files = new OverlayFiles(await WorkspaceSandbox.create(this.root), pendingBase(run.changes));
      const overlay = files;
      const checkDir = () => scratch.sync(overlay.allChanges());

      const worker = new Worker({
        provider: this.o.provider,
        sandbox: overlay,
        checkDir,
        task,
        context: note,
        checks: this.o.checks,
        maxTurns: this.o.maxTurns,
        signal,
        approve: (reason, call, preview) => this.o.approveTool(task, reason, call, preview),
        approveCommand: this.o.approveCommand && ((check) => this.o.approveCommand!(task, check)),
        askUser: this.o.askUser && ((q) => this.o.askUser!(task, q)),
        inbox: this.o.inbox && (() => this.o.inbox!(task.id)),
        log: (type, message, data) => void this.log(type, message, task.id, data),
      });

      let result = await worker.run();
      for (let round = 0; worker.checks.length > 0 && overlay.writes.size > 0; round++) {
        await this.setStatus(task, "verifying");
        // A worker saying it is done is not enough: the checks decide. They run on a scratch copy.
        const checks: CheckResult[] = await runAllChecks(worker.checks, await checkDir(), signal, this.o.approveCommand && ((c) => this.o.approveCommand!(task, c)));
        signal.throwIfAborted();
        const failed = checks.filter((c) => !c.passed);
        await this.log("checks", failed.length ? "failed" : "passed", task.id, { results: checks.map((c) => ({ name: c.name, passed: c.passed, skipped: c.skipped })) });
        if (failed.length === 0) break;
        if (round >= this.o.maxFixRounds) {
          throw new OrchestratorError(`Checks failed: ${failed.map((c) => c.name).join(", ")}`);
        }
        await this.setStatus(task, "running");
        result = await worker.run(
          `Your work is not done. These checks failed:\n\n${failed.map((c) => `## ${c.name}\n${c.output}`).join("\n\n")}\n\nFix the problems, then finish.`,
        );
      }

      const changes = overlay.pending(task.id);
      await this.o.store.updateTask(this.o.runId, task.id, { summary: result.summary, changedFiles: changes.map((c) => c.path), unfinished: undefined });
      if (changes.length) {
        await this.o.store.addChanges(this.o.runId, changes);
        await this.log("changes_pending", changes.map((c) => c.path).join(", "), task.id, { files: changes.map((c) => c.path) });
      } else {
        await this.log("no_changes", "Task finished without changing files", task.id);
      }
      await this.setStatus(task, "done");
      if (changes.length) await this.o.onChanges?.(task, changes);
    } catch (err) {
      if (files?.writes.size) {
        const unfinished = [...files.writes].map(([p, content]) => ({ path: p, content: content.slice(0, 20000) })).slice(0, 20);
        await this.o.store.updateTask(this.o.runId, task.id, { unfinished }).catch(() => undefined);
      }
      await this.handleFailure(task, err, controller.signal.aborted);
    } finally {
      this.taskControllers.delete(task.id);
      await scratch.remove().catch(() => undefined);
    }
  }

  private async handleFailure(task: Task, err: unknown, taskCancelled: boolean): Promise<void> {
    const cancelled = taskCancelled || this.o.signal?.aborted === true;
    const message = cancelled ? "Cancelled" : (err as Error).message;
    const current = await this.current(task.id);
    if (!current || current.status === "done" || current.status === "failed" || current.status === "cancelled") return;
    // Brief outages of the model server should not need the user: try again automatically.
    if (!cancelled && isTransient(err) && current.attempts < this.o.maxAttempts) {
      await this.log("transient_failure", message, task.id, { attempt: current.attempts });
      await sleep(this.o.retryDelayMs * current.attempts);
      await this.setStatus(task, "pending", `Retrying after: ${message}`);
      return;
    }
    await this.log(cancelled ? "cancelled" : "task_failed", message, task.id);
    await this.setStatus(task, cancelled ? "cancelled" : "failed", message);
  }
}

function isTransient(err: unknown): boolean {
  return err instanceof ProviderError && err.retryable;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
