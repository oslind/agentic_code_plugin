import { ModelProvider } from "../providers/types";
import { Mutex } from "../util/mutex";
import { TaskStore } from "../state/taskStore";
import { CheckConfig } from "../checks/runner";
import { ConversationStore } from "./conversationStore";
import { LiveTracker } from "./live";
import { InboxMessage } from "../worker/worker";
import { CallBudget } from "./callBudget";
import { ChatEntry, ChatMode } from "./types";
import { ChatHost } from "./host";
import { Decision, DoneBar } from "./viewState";

/**
 * What every part of the chat shares: the stores, the host, what the chat is
 * doing right now (the UI state), the cards waiting for the user, and the
 * model wrappers that show calls live and count them against a run's budget.
 * The run loop, oversight, verification and follow-ups all work on one session.
 */
export class ChatSession {
  currentId?: string;
  mode: ChatMode;
  busy?: string;
  abort?: AbortController;
  runningRunId?: string;
  /** How the last prompt ended, for the bar at the bottom of its conversation. */
  done?: DoneBar & { conversationId: string };
  /** Set by Stop until the work it stopped has wound down. */
  stopping = false;
  /** The folder files were attached from before the first message, so the new conversation uses the same one. */
  attachRoot?: string;
  /** Which conversation each run belongs to, so sub-agent events land in the right chat. */
  readonly runOwner = new Map<string, string>();
  readonly listeners = new Set<() => void>();
  /** Cards waiting for the user, by entry id. */
  readonly pending = new Map<string, { conversationId: string; resolve: (d: Decision | undefined) => void; runId?: string; taskId?: string }>();
  /** Messages the user or the coordinator sent to a sub-agent, waiting for its next step. Keyed by run and task. */
  readonly inboxes = new Map<string, InboxMessage[]>();
  /** Why an Accept did not go through, by "runId:path". Cleared once the change is decided. */
  readonly changeNotes = new Map<string, string>();
  /** Commands the user allowed for the rest of a run, keyed by run id. */
  readonly allowedCommands = new Map<string, Set<string>>();
  /** What every model call is doing right now, so a long "thinking" shows that it is still working. */
  readonly live = new LiveTracker();

  /** Sub-agent events are handled one at a time, so their messages keep their order. */
  readonly eventQueue = new Mutex();
  /** Model calls per run: sub-agents' steps and the coordinator's calls about them. */
  readonly budget: CallBudget;
  /** What to do when a run uses its model-call budget. Set by the controller once oversight exists. */
  onBudgetReached?: (runId: string, limit: number) => void;

  constructor(
    readonly conversations: ConversationStore,
    readonly tasks: TaskStore,
    readonly host: ChatHost,
  ) {
    this.mode = host.defaultMode();
    this.budget = new CallBudget(
      () => this.host.delegationLimits().maxModelCallsPerRun ?? 0,
      (runId, limit) => this.onBudgetReached?.(runId, limit),
    );
  }

  /** Lets sub-agent messages that are still queued land in the chat. */
  settle(): Promise<void> {
    return this.eventQueue.run(async () => {});
  }

  changed(): void {
    for (const l of this.listeners) l();
  }

  /**
   * The model for the coordinator's own calls, shown live under "coordinator".
   * With a run id, the call is about that run's sub-agents and counts against its budget.
   */
  coordinatorProvider(workspaceRoot: string, runId?: string): ModelProvider {
    const provider = this.live.wrap(this.host.provider(workspaceRoot), "coordinator");
    return runId ? this.budget.wrap(provider, runId) : provider;
  }

  /** A sub-agent's model, shown live and counted against its run's budget. */
  agentProvider(provider: ModelProvider, runId: string, taskId: string): ModelProvider {
    return this.budget.wrap(this.live.wrap(provider, `${runId}:${taskId}`), runId);
  }

  async setMode(mode: ChatMode): Promise<void> {
    this.mode = mode;
    this.host.setDefaultMode(mode);
    if (this.currentId) await this.conversations.update(this.currentId, (c) => (c.mode = mode));
    this.changed();
  }

  async append(id: string, entry: Omit<ChatEntry, "id" | "time">): Promise<ChatEntry> {
    const full = await this.conversations.append(id, entry);
    this.changed();
    return full;
  }

  async markDecided(conversationId: string, entryId: string, decided: string, checks?: CheckConfig[]): Promise<void> {
    await this.conversations
      .update(conversationId, (c) => {
        const e = c.entries.find((x) => x.id === entryId);
        if (e) {
          e.decided = decided;
          if (checks) e.checks = checks;
        }
      })
      .catch(() => undefined);
    this.changed();
  }

  /** Posts a card and waits until the user decides on it (or stops everything). */
  async waitFor(conversationId: string, entry: Omit<ChatEntry, "id" | "time">): Promise<{ entry: ChatEntry; decision?: Decision }> {
    const full = await this.append(conversationId, entry);
    const decision = await new Promise<Decision | undefined>((resolve) => this.pending.set(full.id, { conversationId, resolve, runId: entry.runId, taskId: entry.taskId }));
    return { entry: full, decision };
  }

  drainInbox(runId: string, taskId: string): InboxMessage[] {
    const key = `${runId}:${taskId}`;
    const messages = this.inboxes.get(key) ?? [];
    this.inboxes.delete(key);
    return messages;
  }

  allowedFor(runId: string): Set<string> {
    let set = this.allowedCommands.get(runId);
    if (!set) this.allowedCommands.set(runId, (set = new Set()));
    return set;
  }

}
