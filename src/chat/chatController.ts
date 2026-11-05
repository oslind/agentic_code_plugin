import { OVERSIGHT_LEVELS, type OversightLevel } from "../userSettings";
import { TaskStore } from "../state/taskStore";
import { ConflictChoice, RunEvent } from "../state/types";
import { Restarts } from "./restarts";
import { AutoApprove } from "../tools/policy";
import { Approvals } from "./approvals";
import { ConversationStore } from "./conversationStore";
import { Drafts } from "./drafts";
import { eventToEntry } from "./eventFeed";
import { FollowUps } from "./followUps";
import { title } from "./helpers";
import { ChatHost } from "./host";
import { LiveTracker } from "./live";
import { Oversight } from "./oversight";
import { RunLoop } from "./runLoop";
import { ChatSession } from "./session";
import { ChatMode, Conversation } from "./types";
import { Verifier } from "./verifier";
import { buildViewState, ChatViewState, Decision, ReviewAction } from "./viewState";

export type { ChatHost, RunControl, RunHooks } from "./host";
export type { ChangeView, ChatViewState, Decision, DoneBar, FollowUpState, PlanView, ReviewAction } from "./viewState";
export { earlierAnswers, earlierWork, learnedSoFar, runScope, userMessagesOf, userRequestOf } from "./scope";

/**
 * Drives the chat: one coordinator per conversation that talks with the user
 * and delegates all project work to sub-agents through plans. The coordinator
 * has no tools; Plan mode never starts sub-agents, Act mode does.
 *
 * This class is the chat's public face for the webview and VS Code. The work
 * is done by its parts, which share one ChatSession:
 * - RunLoop (runLoop.ts): the coordinator's turn, research rounds, running a plan, the final reply;
 * - Oversight (oversight.ts): watching sub-agents, check-ins, answers to their questions, result reviews;
 * - Verifier (verifier.ts): verifying a request before it is called done, with fix-up rounds;
 * - Approvals (approvals.ts): the cards for commands, writes and checks, and a run's hooks;
 * - FollowUps (followUps.ts): direct messages and reopened sub-agent conversations;
 * - Drafts (drafts.ts): Accept, Reject and Revert;
 * - Restarts (restarts.ts): what a VS Code restart left behind, and runs to resume;
 * - viewState.ts: what the webview shows.
 */
export class ChatController {
  private readonly s: ChatSession;
  private readonly oversight: Oversight;
  private readonly approvals: Approvals;
  private readonly followUps: FollowUps;
  private readonly verifier: Verifier;
  private readonly runLoop: RunLoop;
  private readonly drafts: Drafts;
  private readonly restarts: Restarts;
  private readonly stopEvents: () => void;
  private readonly ready: Promise<void>;

  constructor(
    private readonly conversations: ConversationStore,
    private readonly tasks: TaskStore,
    private readonly host: ChatHost,
  ) {
    this.s = new ChatSession(conversations, tasks, host);
    this.oversight = new Oversight(this.s);
    this.s.onBudgetReached = (runId, limit) => this.oversight.budgetReached(runId, limit);
    this.approvals = new Approvals(this.s, this.oversight);
    this.followUps = new FollowUps(this.s, this.approvals);
    this.verifier = new Verifier(this.s);
    this.runLoop = new RunLoop(this.s, this.oversight, this.approvals, this.followUps, this.verifier);
    this.drafts = new Drafts(this.s);
    this.restarts = new Restarts(this.s);
    // Events are handled one at a time so sub-agent messages keep their order.
    this.stopEvents = tasks.onEvent((e) => void this.s.eventQueue.run(() => this.onRunEvent(e)));
    this.ready = this.restarts.indexRuns();
  }

  /** What every model call is doing right now, so a long "thinking" shows that it is still working. */
  get live(): LiveTracker {
    return this.s.live;
  }

  dispose(): void {
    this.stopEvents();
    this.s.live.dispose();
    this.s.abort?.abort();
    this.oversight.abortAll();
    this.followUps.abortAll();
  }

  onChange(listener: () => void): () => void {
    this.s.listeners.add(listener);
    return () => this.s.listeners.delete(listener);
  }

  /** Called when settings change, so the chat shows the model it will use next. */
  settingsChanged(): void {
    this.s.changed();
  }

  state(): Promise<ChatViewState> {
    // What the chat is doing at the moment it is asked, before the loads let a running prompt move on.
    return buildViewState(this.s, { busy: this.s.busy, stopping: this.s.stopping, ready: this.ready }, () => ({
      followUps: this.followUps.followUpStates(),
      consulting: Object.fromEntries(this.oversight.consulting),
      checkingOn: Object.fromEntries(this.oversight.checkingOn),
      resumeView: (run) => this.restarts.resumeView(run),
    }));
  }

  /** Starts a fresh conversation the next time the user sends a message. */
  newTask(): void {
    if (this.s.busy) return;
    this.s.currentId = undefined;
    this.s.attachRoot = undefined;
    this.s.changed();
  }

  async open(id: string): Promise<void> {
    if (this.s.busy) return;
    await this.ready;
    const c = await this.conversations.load(id);
    this.s.currentId = c.id;
    this.s.mode = c.mode;
    this.s.changed();
  }

  async delete(id: string): Promise<void> {
    if (this.s.busy && id === this.s.currentId) return;
    await this.conversations.delete(id);
    for (const [runId, owner] of this.s.runOwner) if (owner === id) this.s.runOwner.delete(runId);
    if (this.s.currentId === id) this.s.currentId = undefined;
    this.s.changed();
  }

  async setPermission(key: keyof AutoApprove, value: boolean): Promise<void> {
    await this.host.setPermission(key, value);
    this.s.changed();
  }

  async setOversight(level: OversightLevel): Promise<void> {
    if (!OVERSIGHT_LEVELS.includes(level) || !this.host.setOversight) return;
    await this.host.setOversight(level);
    this.s.changed();
  }

  /** Reads the skills of the current conversation's folder again, for Settings. */
  async refreshSkills(): Promise<void> {
    if (!this.s.currentId || !this.host.skillsView) return;
    const c = await this.conversations.load(this.s.currentId);
    this.s.skills = { workspaceRoot: c.workspaceRoot, view: await this.host.skillsView(c.workspaceRoot) };
    this.s.changed();
  }

  /** Trusts the current folder's own skill files as they are now, or stops using them. */
  async trustProjectSkills(trust: boolean): Promise<void> {
    if (!this.s.currentId || !this.host.trustProjectSkills) return;
    const c = await this.conversations.load(this.s.currentId);
    await this.host.trustProjectSkills(c.workspaceRoot, trust);
    await this.refreshSkills();
  }

  async openSkill(name: string): Promise<void> {
    if (!this.s.currentId || !this.host.openSkill) return;
    const c = await this.conversations.load(this.s.currentId);
    await this.host.openSkill(c.workspaceRoot, name);
  }

  async openSkillsFolder(): Promise<void> {
    await this.host.openSkillsFolder?.();
  }

  setMode(mode: ChatMode): Promise<void> {
    return this.s.setMode(mode);
  }

  /**
   * The Stop button: ends everything the coordinator and its sub-agents are
   * doing right now. Model calls are aborted, running commands are killed,
   * and questions waiting for the user are closed. Drafts stay pending for
   * review; nothing is written.
   */
  cancel(): void {
    // Stop also ends reopened sub-agent conversations; what they said is still passed on.
    this.followUps.endAll();
    if (!this.s.busy && this.s.pending.size === 0) return;
    if (this.s.busy) {
      this.s.busy = "Stopping…";
      this.s.stopping = true;
      this.s.changed();
    }
    this.s.abort?.abort();
    this.oversight.abortAll();
    if (this.s.runningRunId) this.host.cancelRun(this.s.runningRunId);
    for (const [id, p] of [...this.s.pending]) {
      this.s.pending.delete(id);
      void this.s.markDecided(p.conversationId, id, "Stopped");
      p.resolve(undefined);
    }
  }

  /** The user's answer to a card. Ignored if the card is no longer waiting. */
  async decide(entryId: string, decision: Decision): Promise<void> {
    const p = this.s.pending.get(entryId);
    if (!p) return;
    this.s.pending.delete(entryId);
    const label =
      decision.kind === "checks"
        ? `Approved ${decision.checks.length} check(s)${decision.remember ? ", saved for this folder" : ""}`
        : decision.kind === "skip"
          ? "Run without checks"
          : decision.kind === "allow"
            ? decision.remember
              ? "Allowed and remembered"
              : "Allowed"
            : decision.kind === "deny"
              ? "Denied"
              : `You answered: ${decision.text}`;
    await this.s.markDecided(p.conversationId, entryId, label, decision.kind === "checks" ? decision.checks : undefined);
    p.resolve(decision);
  }

  /**
   * Shows, accepts or rejects a pending change from the chat. Without a path,
   * accepts or rejects every pending change of that run's task (or the whole run).
   */
  review(runId: string, action: ReviewAction, filePath?: string, taskId?: string, choice?: ConflictChoice): Promise<void> {
    return this.drafts.review(runId, action, filePath, taskId, choice);
  }

  /**
   * Sends a message straight to a sub-agent. A running one reads it before
   * its next step. One whose task has ended is reopened: it resumes with its
   * saved conversation and answers, until the user ends the conversation.
   */
  messageAgent(runId: string, taskId: string, text: string): Promise<void> {
    return this.followUps.messageAgent(runId, taskId, text);
  }

  /** The "End chat" button: the sub-agent sends what is new to the coordinator, and the conversation closes. */
  async endAgentChat(runId: string, taskId: string): Promise<void> {
    const f = this.followUps.chats.get(`${runId}:${taskId}`);
    if (!f) return;
    await this.followUps.endFollowUp(f, true);
    await this.runLoop.continueAfterFollowUp(f.conversationId, runId, taskId);
  }

  /** Lets the user review and change the checks saved for the current conversation's folder. */
  async editChecks(): Promise<void> {
    if (this.s.busy || !this.s.currentId) return;
    const c = await this.conversations.load(this.s.currentId);
    this.s.busy = "Waiting for you to choose the checks…";
    this.s.changed();
    try {
      await this.approvals.chooseChecks(c.id, c.workspaceRoot, true);
    } finally {
      this.s.busy = undefined;
      this.s.stopping = false;
      this.s.changed();
    }
  }

  /**
   * Lets the user pick files in the conversation's folder to attach to the
   * next prompt. Only their paths are attached: the coordinator never reads
   * files, it passes the paths on to the sub-agents, who read through the
   * sandbox like any other file.
   */
  async pickAttachments(): Promise<string[]> {
    if (!this.host.pickFiles) return [];
    await this.ready;
    let root: string | undefined;
    if (this.s.currentId) root = (await this.conversations.load(this.s.currentId)).workspaceRoot;
    else root = this.s.attachRoot ?? (await this.host.pickWorkspace());
    if (!root) return [];
    if (!this.s.currentId) this.s.attachRoot = root;
    return this.host.pickFiles(root);
  }

  /**
   * The Compact button (or "/compact"): the older part of the current
   * conversation becomes a summary the coordinator gets instead, whatever its
   * length. Stop ends it like any other model call.
   */
  async compact(): Promise<void> {
    if (this.s.busy || !this.s.currentId) return;
    await this.ready;
    const c = await this.conversations.load(this.s.currentId);
    const abort = new AbortController();
    this.s.abort = abort;
    try {
      const { skipped } = await this.runLoop.compact(c, abort.signal, { force: true });
      if (skipped) await this.s.append(c.id, { author: "system", tone: "warning", text: skipped });
    } catch (err) {
      await this.s.append(c.id, { author: "system", tone: "warning", text: abort.signal.aborted ? "Compacting was stopped. Nothing was changed." : (err as Error).message });
    } finally {
      this.s.abort = undefined;
      this.s.busy = undefined;
      this.s.stopping = false;
      this.s.changed();
    }
  }

  /** Handles one message from the user: the coordinator answers, and may plan or run. */
  async send(text: string, attachments: string[] = []): Promise<void> {
    if (!text.trim() || this.s.busy) return;
    await this.ready;
    if (/^\s*\/compact\s*$/i.test(text) && !attachments.length) {
      if (this.s.currentId) return this.compact();
      return;
    }
    if (attachments.length) text = `${text.trim()}\n\nAttached files: ${[...new Set(attachments)].join(", ")}`;
    let c: Conversation;
    if (this.s.currentId) {
      c = await this.conversations.load(this.s.currentId);
    } else {
      const root = this.s.attachRoot ?? (await this.host.pickWorkspace());
      this.s.attachRoot = undefined;
      if (!root) return;
      c = await this.conversations.create(root, this.s.mode, title(text));
      this.s.currentId = c.id;
    }
    // A new prompt: the bar goes away until this one is dealt with.
    this.s.done = undefined;
    // Talking to the coordinator again ends any reopened sub-agent conversation, so it hears what came up first.
    await this.followUps.endFollowUpsOf(c.id);
    await this.s.append(c.id, { author: "user", text: text.trim() });
    await this.runLoop.respond(c, text);
  }

  /**
   * Starts a proposed plan. Running only happens in Act mode; pressing Run in
   * Plan mode is the user switching to Act mode for this conversation.
   */
  runPlan(runId: string): Promise<void> {
    return this.runLoop.runPlan(runId);
  }

  /**
   * Continues a run that VS Code closed under, or that was stopped: the
   * stopped sub-agents pick up their own conversation and drafts where they
   * were, tasks that never started start now, and done tasks and every draft
   * stay as they are. The user approves the checks again, as for any run.
   */
  async resumeRun(runId: string): Promise<void> {
    await this.ready;
    return this.runLoop.resumeRun(runId);
  }

  /** Whether a run was started from a chat conversation. */
  owns(runId: string): boolean {
    return this.s.runOwner.has(runId);
  }

  /** Change runs found cut off by a restart when the chat started, for the "Resume?" notification. */
  async interruptedRuns(): Promise<{ runId: string; conversationId: string; request: string }[]> {
    await this.ready;
    return this.restarts.interruptedRuns();
  }

  private async onRunEvent(event: RunEvent): Promise<void> {
    const conversationId = this.s.runOwner.get(event.runId);
    if (!conversationId) {
      if (event.type === "status") this.s.changed();
      return;
    }
    try {
      const run = await this.tasks.load(event.runId);
      const entry = eventToEntry(event, run.tasks);
      if (entry) await this.conversations.append(conversationId, entry);
      this.oversight.watch(event, run);
      this.s.changed();
    } catch (err) {
      this.host.log("warn", `Could not add a sub-agent message to the chat: ${(err as Error).message}`);
    }
  }
}
