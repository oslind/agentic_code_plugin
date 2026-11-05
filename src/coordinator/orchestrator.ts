import { promises as fs } from "fs";
import * as path from "path";
import { OverlayFiles, pendingBase } from "../changes/overlay";
import { ScratchCopy } from "../changes/scratch";
import { CommandSink } from "../checks/commandTerminal";
import { untrustedSection } from "../context/untrusted";
import { draftsForReview, ReviewSkip, ReviewVerdict } from "./review";
import { CheckConfig, CheckResult, runAllChecks } from "../checks/runner";
import { ProviderError } from "../providers/openaiCompatible";
import { ModelProvider } from "../providers/types";
import { readyTasks, TaskStore } from "../state/taskStore";
import { PendingChange, Task } from "../state/types";
import { ToolCall } from "../tools/protocol";
import { WorkspaceSandbox } from "../tools/sandbox";
import { commandEventData, CoordinatorReply, InboxMessage, Worker } from "../worker/worker";

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
  /** The extension's terminal for this project, where every command is shown as it runs. */
  terminal?: CommandSink;
  /** Called when a task has finished with file changes. They are pending: nothing is written until accepted. */
  onChanges?: (task: Task, changes: PendingChange[]) => Promise<void>;
  /** The user's go-ahead for a call the policy flagged, such as a new check command. */
  approveTool: (task: Task, reason: string, call: ToolCall, preview?: string) => Promise<boolean>;
  /** Asked before every check command runs, including verification. Without it, approved checks run freely. */
  approveCommand?: (task: Task, check: CheckConfig) => Promise<boolean>;
  /** Lets a sub-agent ask the user a question. Without it, sub-agents decide on their own. */
  askUser?: (task: Task, question: string) => Promise<string>;
  /** Messages the user or the coordinator sent directly to a sub-agent. Each call drains them. */
  inbox?: (taskId: string) => InboxMessage[];
  /** Lets a sub-agent ask the coordinator a question. Without it, sub-agents are told the coordinator cannot be reached. */
  askCoordinator?: (task: Task, question: string, signal: AbortSignal) => Promise<CoordinatorReply>;
  /** The coordinator reviews a sub-agent's report and drafts when it finishes, and may send it back. */
  reviewResult?: (task: Task, summary: string, drafts: string, signal: AbortSignal, skip?: ReviewSkip) => Promise<ReviewVerdict>;
  onChange?: () => void;
  /** The model a task's sub-agent uses. By default `provider`; the chat wraps it to show each call live. */
  wrapProvider?: (task: Task, provider: ModelProvider) => ModelProvider;
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

type Optional = "signal" | "onChange" | "askUser" | "inbox" | "approveCommand" | "onChanges" | "askCoordinator" | "reviewResult" | "terminal" | "wrapProvider";

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
    // Briefings and reports were written by models that read project files: data, never instructions.
    if (run.briefing) parts.push(untrustedSection("What the coordinator knows about this project:", "earlier research and sub-agent reports", run.briefing));
    const reports = task.dependsOn
      .map((id) => run.tasks.find((t) => t.id === id))
      .filter((t): t is Task => !!t && t.status === "done" && !!t.summary)
      .map((t) => `- [report from sub-agent "${t.title}"] ${t.summary!.replace(/\s+/g, " ").slice(0, 600)}`);
    if (reports.length) parts.push(untrustedSection("The tasks you build on are done. Their reports:", "reports from the tasks you build on", reports.join("\n")));
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
    let worker: Worker | undefined;
    // Drafts already put up for review while the task ran, by path, so they are not announced twice.
    const published = new Map<string, string>();
    try {
      const fresh = (await this.current(task.id)) ?? task;
      const note = [await this.briefingFor(fresh), this.previousAttemptNote(fresh)].filter(Boolean).join("\n\n") || undefined;
      await this.setStatus(task, "running");
      // The project as on disk, plus what earlier tasks of this run proposed.
      const run = await this.o.store.load(this.o.runId);
      files = new OverlayFiles(await WorkspaceSandbox.create(this.root), pendingBase(run.changes));
      const overlay = files;
      const checkDir = () => scratch.sync(overlay.allChanges());

      worker = new Worker({
        provider: this.o.wrapProvider ? this.o.wrapProvider(task, this.o.provider) : this.o.provider,
        sandbox: overlay,
        checkDir,
        terminal: this.o.terminal,
        task,
        context: note,
        checks: this.o.checks,
        maxTurns: this.o.maxTurns,
        signal,
        approve: (reason, call, preview) => this.o.approveTool(task, reason, call, preview),
        approveCommand: this.o.approveCommand && ((check) => this.o.approveCommand!(task, check)),
        askUser: this.o.askUser && ((q) => this.o.askUser!(task, q)),
        askCoordinator: this.o.askCoordinator && ((q) => this.o.askCoordinator!(task, q, signal)),
        reviewResult: this.o.reviewResult && ((summary, skip) => this.o.reviewResult!(task, summary, draftsForReview(overlay.pending(task.id)), signal, skip)),
        // A question is usually about the drafts ("is this what you wanted?"), so show them first.
        beforeAsk: async () => void (await this.publishDrafts(task, overlay, published)),
        inbox: this.o.inbox && (() => this.o.inbox!(task.id)),
        log: (type, message, data) => void this.log(type, message, task.id, data),
      });

      const w = worker;
      let result = await w.run();
      for (let round = 0; w.checks.length > 0 && overlay.writes.size > 0; round++) {
        await this.setStatus(task, "verifying");
        // A worker saying it is done is not enough: the checks decide. They run on a scratch copy.
        const checks: CheckResult[] = await runAllChecks(w.checks, await checkDir(), signal, this.o.approveCommand && ((c) => this.o.approveCommand!(task, c)), this.o.terminal);
        signal.throwIfAborted();
        // Each check that ran is shown in the chat with its output, like a command a sub-agent ran.
        for (const c of checks) {
          const command = w.checks.find((k) => k.name === c.name)?.command;
          if (!c.skipped && command) await this.log("command", command, task.id, { ...commandEventData(command, c), check: c.name });
        }
        const failed = checks.filter((c) => !c.passed);
        await this.log("checks", failed.length ? "failed" : "passed", task.id, { results: checks.map((c) => ({ name: c.name, passed: c.passed, skipped: c.skipped })) });
        if (failed.length === 0) break;
        if (round >= this.o.maxFixRounds) {
          throw new OrchestratorError(`Checks failed: ${failed.map((c) => c.name).join(", ")}`);
        }
        await this.setStatus(task, "running");
        result = await w.run(
          `Your work is not done. These checks failed:\n\n${failed.map((c) => `## ${c.name}\n${c.output}`).join("\n\n")}\n\nFix the problems, then finish.`,
        );
      }

      const changes = await this.publishDrafts(task, overlay, published, false);
      const changedFiles = [...new Set([...published.keys(), ...overlay.pending(task.id).map((c) => c.path)])];
      await this.o.store.updateTask(this.o.runId, task.id, { summary: result.summary, changedFiles, unfinished: undefined });
      if (changedFiles.length === 0) await this.log("no_changes", "Task finished without changing files", task.id);
      // Saved before "done", so a follow-up the user starts right away has it.
      await this.o.store.saveHistory(this.o.runId, task.id, w.history()).catch(() => undefined);
      worker = undefined;
      await this.setStatus(task, "done");
      if (changes.length) await this.o.onChanges?.(task, changes);
    } catch (err) {
      if (files?.writes.size) {
        const unfinished = [...files.writes].map(([p, content]) => ({ path: p, content: content.slice(0, 20000) })).slice(0, 20);
        await this.o.store.updateTask(this.o.runId, task.id, { unfinished }).catch(() => undefined);
      }
      // Stopped by the user: what the sub-agent drafted stays reviewable. Nothing is written, and the
      // auto-approve switches do not apply, because the user asked for everything to stop.
      let kept: string[] = [];
      if (files && signal.aborted) {
        await this.publishDrafts(task, files, published, false).catch(() => []);
        kept = [...published.keys()];
        if (kept.length) await this.o.store.updateTask(this.o.runId, task.id, { changedFiles: kept }).catch(() => undefined);
      }
      await this.handleFailure(task, err, controller.signal.aborted, kept);
    } finally {
      // Kept so the user can reopen this sub-agent later and it remembers its work.
      if (worker) await this.o.store.saveHistory(this.o.runId, task.id, worker.history()).catch(() => undefined);
      this.taskControllers.delete(task.id);
      await scratch.remove().catch(() => undefined);
    }
  }

  /**
   * Records this task's drafts that are new since the last call as pending
   * changes. With `announce`, the user is shown them right away (and the
   * auto-approve switches apply), which is what happens before a question.
   * Returns the changes it recorded.
   */
  private publishDrafts(task: Task, overlay: OverlayFiles, published: Map<string, string>, announce = true): Promise<PendingChange[]> {
    return publishDrafts(this.o.store, this.o.runId, task, overlay, published, announce ? this.o.onChanges : undefined);
  }

  private async handleFailure(task: Task, err: unknown, taskCancelled: boolean, kept: string[] = []): Promise<void> {
    const cancelled = taskCancelled || this.o.signal?.aborted === true;
    const message = cancelled ? "Cancelled" : (err as Error).message;
    const current = await this.current(task.id);
    if (!current || current.status === "done" || current.status === "failed" || current.status === "cancelled") return;
    // Brief outages of the model server should not need the user: try again automatically.
    if (!cancelled && isTransient(err) && current.attempts < this.o.maxAttempts) {
      await this.log("transient_failure", message, task.id, { attempt: current.attempts });
      await sleep(this.o.retryDelayMs * current.attempts, this.o.signal);
      await this.setStatus(task, "pending", `Retrying after: ${message}`);
      return;
    }
    await this.log(cancelled ? "cancelled" : "task_failed", message, task.id, cancelled && kept.length ? { kept } : undefined);
    await this.setStatus(task, cancelled ? "cancelled" : "failed", message);
  }
}

/**
 * Records a sub-agent's drafts that are new since the last call as pending
 * changes of its run, and hands them to `announce` (which shows them to the
 * user and applies the auto-approve switches). `published` remembers what
 * was already recorded, by path. Returns the changes it recorded.
 */
export async function publishDrafts(
  store: TaskStore,
  runId: string,
  task: Task,
  overlay: OverlayFiles,
  published: Map<string, string>,
  announce?: (task: Task, changes: PendingChange[]) => Promise<void>,
): Promise<PendingChange[]> {
  const run = await store.load(runId);
  // A draft the user already accepted is on disk now; later drafts of that file are edits on top of it.
  for (const [p, text] of published) {
    if (run.changes?.some((c) => c.path === p && c.taskId === task.id && c.status === "accepted" && c.proposed === text)) overlay.rebase(p, text);
  }
  const changes = overlay.pending(task.id).filter((c) => published.get(c.path) !== c.proposed);
  if (changes.length === 0) return [];
  await store.addChanges(runId, changes);
  for (const c of changes) published.set(c.path, c.proposed);
  await store.log({ runId, taskId: task.id, type: "changes_pending", message: changes.map((c) => c.path).join(", "), data: { files: changes.map((c) => c.path) } });
  await announce?.(task, changes);
  return changes;
}

function isTransient(err: unknown): boolean {
  return err instanceof ProviderError && err.retryable;
}

/** Waits, but ends early when the run is stopped. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((r) => {
    if (signal?.aborted) return r();
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      r();
    }
  });
}
