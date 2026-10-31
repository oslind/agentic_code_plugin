import { planRequest } from "../coordinator/planner";
import { parallelWaves } from "../coordinator/plan";
import { RunOutcome } from "../coordinator/orchestrator";
import { ModelProvider } from "../providers/types";
import { Mutex } from "../util/mutex";
import { TaskStore } from "../state/taskStore";
import { Run, RunEvent, TaskStatus } from "../state/types";
import { ConversationStore } from "./conversationStore";
import { coordinatorTurn } from "./coordinatorChat";
import { eventToEntry } from "./eventFeed";
import { ChatEntry, ChatMode, Conversation, ConversationSummary } from "./types";

/** What the chat needs from VS Code. Kept small so the controller can be tested without it. */
export interface ChatHost {
  provider(): ModelProvider;
  /** The workspace folder a new conversation's agents are confined to. */
  pickWorkspace(): Promise<string | undefined>;
  fileTree(workspaceRoot: string, signal: AbortSignal): Promise<string | undefined>;
  /** Runs a plan with sub-agents. Resolves undefined if the user declined to start it. */
  runPlan(runId: string): Promise<RunOutcome | undefined>;
  cancelRun(runId: string): void;
  defaultMode(): ChatMode;
  setDefaultMode(mode: ChatMode): void;
  log(level: "info" | "warn" | "error", message: string): void;
}

export interface PlanView {
  tasks: { id: string; title: string; status: TaskStatus; fileScope: string[]; dependsOn: string[] }[];
  /** True once any task has started, so the plan can no longer be run from the chat. */
  started: boolean;
  waves: number;
}

export interface ChatViewState {
  mode: ChatMode;
  /** What the chat is doing right now, if anything. */
  busy?: string;
  conversations: ConversationSummary[];
  current?: { id: string; title: string; workspaceRoot: string; entries: ChatEntry[] };
  plans: Record<string, PlanView>;
  runningRunId?: string;
}

function title(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat || "New task";
}

function describePlan(run: Run): string {
  return run.tasks.map((t, i) => `${i + 1}. ${t.title} (files: ${t.fileScope.join(", ")})`).join("\n");
}

function isUnstarted(run: Run): boolean {
  return run.tasks.length > 0 && run.tasks.every((t) => t.status === "pending" && t.attempts === 0);
}

/**
 * Drives the chat: one coordinator per conversation that talks with the user
 * and delegates all project work to sub-agents through plans. The coordinator
 * has no tools; Plan mode never starts sub-agents, Act mode does.
 */
export class ChatController {
  private currentId?: string;
  private mode: ChatMode;
  private busy?: string;
  private abort?: AbortController;
  private runningRunId?: string;
  /** Which conversation each run belongs to, so sub-agent events land in the right chat. */
  private readonly runOwner = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly stopEvents: () => void;
  private readonly ready: Promise<void>;
  private readonly eventQueue = new Mutex();

  constructor(
    private readonly conversations: ConversationStore,
    private readonly tasks: TaskStore,
    private readonly host: ChatHost,
  ) {
    this.mode = host.defaultMode();
    // Events are handled one at a time so sub-agent messages keep their order.
    this.stopEvents = tasks.onEvent((e) => void this.eventQueue.run(() => this.onRunEvent(e)));
    this.ready = this.indexRuns();
  }

  dispose(): void {
    this.stopEvents();
    this.abort?.abort();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  private async indexRuns(): Promise<void> {
    for (const s of await this.conversations.list()) {
      const c = await this.conversations.load(s.id).catch(() => undefined);
      for (const runId of c?.runIds ?? []) this.runOwner.set(runId, s.id);
    }
    this.currentId ??= (await this.conversations.list())[0]?.id;
    const current = this.currentId ? await this.conversations.load(this.currentId).catch(() => undefined) : undefined;
    if (current) this.mode = current.mode;
  }

  async state(): Promise<ChatViewState> {
    await this.ready;
    const conversations = await this.conversations.list();
    let current: Conversation | undefined;
    if (this.currentId) current = await this.conversations.load(this.currentId).catch(() => undefined);
    const plans: Record<string, PlanView> = {};
    for (const runId of current?.runIds ?? []) {
      const run = await this.tasks.load(runId).catch(() => undefined);
      if (!run) continue;
      plans[runId] = {
        tasks: run.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, fileScope: t.fileScope, dependsOn: t.dependsOn })),
        started: !isUnstarted(run),
        waves: parallelWaves(run.tasks).length,
      };
    }
    return {
      mode: this.mode,
      busy: this.busy,
      conversations,
      current: current && { id: current.id, title: current.title, workspaceRoot: current.workspaceRoot, entries: current.entries },
      plans,
      runningRunId: this.runningRunId,
    };
  }

  /** Starts a fresh conversation the next time the user sends a message. */
  newTask(): void {
    if (this.busy) return;
    this.currentId = undefined;
    this.changed();
  }

  async open(id: string): Promise<void> {
    if (this.busy) return;
    await this.ready;
    const c = await this.conversations.load(id);
    this.currentId = c.id;
    this.mode = c.mode;
    this.changed();
  }

  async delete(id: string): Promise<void> {
    if (this.busy && id === this.currentId) return;
    await this.conversations.delete(id);
    for (const [runId, owner] of this.runOwner) if (owner === id) this.runOwner.delete(runId);
    if (this.currentId === id) this.currentId = undefined;
    this.changed();
  }

  async setMode(mode: ChatMode): Promise<void> {
    this.mode = mode;
    this.host.setDefaultMode(mode);
    if (this.currentId) await this.conversations.update(this.currentId, (c) => (c.mode = mode));
    this.changed();
  }

  cancel(): void {
    this.abort?.abort();
    if (this.runningRunId) this.host.cancelRun(this.runningRunId);
  }

  private async append(id: string, entry: Omit<ChatEntry, "id" | "time">): Promise<void> {
    await this.conversations.append(id, entry);
    this.changed();
  }

  private async pendingPlan(c: Conversation): Promise<Run | undefined> {
    const runId = c.runIds.at(-1);
    const run = runId ? await this.tasks.load(runId).catch(() => undefined) : undefined;
    return run && isUnstarted(run) ? run : undefined;
  }

  /** Handles one message from the user: the coordinator answers, and may plan or run. */
  async send(text: string): Promise<void> {
    if (!text.trim() || this.busy) return;
    await this.ready;
    let c: Conversation;
    if (this.currentId) {
      c = await this.conversations.load(this.currentId);
    } else {
      const root = await this.host.pickWorkspace();
      if (!root) return;
      c = await this.conversations.create(root, this.mode, title(text));
      this.currentId = c.id;
    }
    await this.append(c.id, { author: "user", text: text.trim() });

    const abort = new AbortController();
    this.abort = abort;
    this.busy = "Coordinator is thinking…";
    this.changed();
    let startRun: string | undefined;
    try {
      c = await this.conversations.load(c.id);
      const provider = this.host.provider();
      const fileTree = await this.host.fileTree(c.workspaceRoot, abort.signal).catch(() => undefined);
      const pending = await this.pendingPlan(c);
      const turn = await coordinatorTurn(
        provider,
        { mode: this.mode, entries: c.entries, fileTree, pendingPlan: pending && describePlan(pending) },
        { signal: abort.signal, onAttempt: (n, err) => n > 0 && this.host.log("warn", `Coordinator retry ${n}: ${err}`) },
      );
      await this.append(c.id, { author: "coordinator", text: turn.reply });
      if (turn.overridden) await this.append(c.id, { author: "system", text: turn.overridden, tone: "warning" });

      if (turn.action === "plan") {
        this.busy = "Coordinator is splitting the work into sub-agent tasks…";
        this.changed();
        const result = await planRequest(
          provider,
          { request: turn.request, fileTree },
          { signal: abort.signal, onAttempt: (n, err) => n > 0 && this.host.log("warn", `Plan retry ${n}: ${err}`) },
        );
        const run = await this.tasks.createRun(turn.request, c.workspaceRoot);
        this.runOwner.set(run.id, c.id);
        await this.conversations.update(c.id, (x) => x.runIds.push(run.id));
        await this.tasks.addTasks(run.id, result.plan.tasks);
        for (const r of result.repairs) {
          await this.tasks.log({ runId: run.id, taskId: r.taskId, type: "plan_repair", message: `${r.taskId} now waits for ${r.addedDependency}: ${r.reason}` });
        }
        const n = result.plan.tasks.length;
        await this.append(c.id, {
          author: "coordinator",
          kind: "plan",
          runId: run.id,
          text:
            this.mode === "act"
              ? `Plan: ${n} task(s), each for one sub-agent. Starting now.`
              : `Proposed plan: ${n} task(s), each for one sub-agent. Switch to Act mode and press Run when it looks right, or tell me what to change.`,
        });
        if (result.droppedContext.length) this.host.log("warn", `Left out of the plan prompt: ${result.droppedContext.join(", ")}`);
        if (this.mode === "act") startRun = run.id;
      } else if (turn.action === "run" && pending) {
        startRun = pending.id;
      }
    } catch (err) {
      const message = abort.signal.aborted ? "Stopped." : (err as Error).message;
      this.host.log("error", message);
      await this.append(c.id, { author: "system", kind: "error", text: message, tone: abort.signal.aborted ? "warning" : "error" });
    } finally {
      this.abort = undefined;
      this.busy = undefined;
      this.changed();
    }
    if (startRun) await this.runPlan(startRun);
  }

  /**
   * Starts a proposed plan. Running only happens in Act mode; pressing Run in
   * Plan mode is the user switching to Act mode for this conversation.
   */
  async runPlan(runId: string): Promise<void> {
    if (this.busy) return;
    const conversationId = this.runOwner.get(runId);
    if (!conversationId) return;
    const run = await this.tasks.load(runId);
    if (!isUnstarted(run)) {
      await this.append(conversationId, { author: "system", text: "That plan has already run. Retry tasks from the Tasks view.", tone: "warning" });
      return;
    }
    if (this.mode !== "act") await this.setMode("act");

    this.busy = `Sub-agents are working on ${run.tasks.length} task(s)…`;
    this.runningRunId = runId;
    this.changed();
    await this.append(conversationId, {
      author: "coordinator",
      text: `Starting sub-agents for ${run.tasks.length} task(s). Each works on its own branch and may only change its own files.`,
    });
    try {
      const outcome = await this.host.runPlan(runId);
      // Let sub-agent messages that are still queued land before the summary.
      await this.eventQueue.run(async () => {});
      if (!outcome) {
        await this.append(conversationId, { author: "system", text: "The run was not started.", tone: "warning" });
        return;
      }
      const parts = [`${outcome.done.length} done`, `${outcome.failed.length} failed`, `${outcome.blocked.length} blocked`];
      const ok = outcome.failed.length === 0 && outcome.blocked.length === 0;
      await this.append(conversationId, {
        author: "coordinator",
        kind: "outcome",
        runId,
        tone: ok ? "success" : "warning",
        text: `Run finished: ${parts.join(", ")}. The work is on ${outcome.integrationBranch}. Your branch is unchanged until you apply it.`,
      });
    } catch (err) {
      this.host.log("error", (err as Error).message);
      await this.append(conversationId, { author: "system", kind: "error", text: (err as Error).message, tone: "error" });
    } finally {
      this.runningRunId = undefined;
      this.busy = undefined;
      this.changed();
    }
  }

  private async onRunEvent(event: RunEvent): Promise<void> {
    const conversationId = this.runOwner.get(event.runId);
    if (!conversationId) {
      if (event.type === "status") this.changed();
      return;
    }
    try {
      const run = await this.tasks.load(event.runId);
      const entry = eventToEntry(event, run.tasks);
      if (entry) await this.conversations.append(conversationId, entry);
      this.changed();
    } catch (err) {
      this.host.log("warn", `Could not add a sub-agent message to the chat: ${(err as Error).message}`);
    }
  }
}
