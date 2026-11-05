import { promises as fs } from "fs";
import { planRequest } from "../coordinator/planner";
import { parallelWaves } from "../coordinator/plan";
import * as path from "path";
import { AGENT_DIR, publishDrafts, RunOutcome } from "../coordinator/orchestrator";
import { OverlayFiles, pendingBase } from "../changes/overlay";
import { ScratchCopy } from "../changes/scratch";
import { ModelProvider } from "../providers/types";
import { Mutex } from "../util/mutex";
import { INTERRUPTED, TaskStore } from "../state/taskStore";
import { PendingChange, Run, RunEvent, Task, TaskStatus } from "../state/types";
import { CheckConfig, CheckResult, runAllChecks } from "../checks/runner";
import { CommandSink } from "../checks/commandTerminal";
import { DetectedCheck } from "../checks/detect";
import { ToolCall } from "../tools/protocol";
import { AutoApprove, isAutoApproved, isCheckAutoApproved, isChangeAutoAccepted } from "../tools/policy";
import { acceptChange, changeKind, rejectChange } from "../changes/review";
import { commandLeavesProject } from "../tools/commandGuard";
import { ConversationStore } from "./conversationStore";
import { untrustedSection } from "../context/untrusted";
import { LiveItem, LiveTracker } from "./live";
import { ResearchReport, summarizeRun, synthesizeFindings } from "./synthesis";
import { coordinatorTurn, CoordinatorResult, editingReason, isReadOnlyPlan, isGoAhead, isReadOnlyRequest, researchQuestions, researchRoundLimit } from "./coordinatorChat";
import { WorkspaceSandbox } from "../tools/sandbox";
import { commandEventData, CoordinatorReply, InboxMessage, Worker } from "../worker/worker";
import { answerSubAgent } from "../coordinator/consult";
import { draftsForReview, isUnreviewed, MAX_REVIEW_ROUNDS, ReviewOutcome, ReviewSkip, reviewSubAgentResult, ReviewVerdict } from "../coordinator/review";
import { checkAnswer, factsOnlyVerification, fixUpNotes, fixUpRequest, Verification, verifyRoundLimit, verifyRun, VerifyTask } from "../coordinator/verify";
import { CallBudget } from "./callBudget";
import { AgentMonitor, Concern, CONCERN_LABEL, superviseAgent } from "../coordinator/monitor";
import { eventToEntry } from "./eventFeed";
import { changedFilesOf, describeOutcome } from "./outcome";
import { ChatEntry, ChatMode, Conversation, ConversationSummary } from "./types";
import { buildDashboard, DashboardView } from "./dashboard";
import { DraftState, draftState, lineCounts } from "./lifecycle";
import { resumableTasks, resumeState } from "../state/resume";

/** What the chat needs from VS Code. Kept small so the controller can be tested without it. */
export interface ChatHost {
  /** A provider built from the current settings, scoped to the conversation's folder. */
  provider(workspaceRoot?: string): ModelProvider;
  /** Short description of the model in use, shown in the chat. */
  modelLabel(workspaceRoot?: string): string;
  /** The workspace folder a new conversation's agents are confined to. */
  pickWorkspace(): Promise<string | undefined>;
  fileTree(workspaceRoot: string, signal: AbortSignal): Promise<string | undefined>;
  /** Runs a plan with sub-agents. Resolves undefined if the user declined to start it. */
  runPlan(runId: string, hooks: RunHooks): Promise<RunOutcome | undefined>;
  /**
   * Checks for a folder: the ones the user approved for it before (if any),
   * the defaults from settings, and suggestions from the project's files.
   */
  checksFor(workspaceRoot: string): Promise<{ saved?: CheckConfig[]; defaults: CheckConfig[]; detected: DetectedCheck[] }>;
  saveChecks(workspaceRoot: string, checks: CheckConfig[]): Promise<void>;
  /** The auto-approve switches. */
  permissions(): AutoApprove;
  setPermission(key: keyof AutoApprove, value: boolean): Promise<void>;
  cancelRun(runId: string): void;
  defaultMode(): ChatMode;
  setDefaultMode(mode: ChatMode): void;
  log(level: "info" | "warn" | "error", message: string): void;
  /** The real path of the folder if it is open in VS Code right now, else undefined. Research may only read there. */
  openFolder(workspaceRoot: string): Promise<string | undefined>;
  /** The extension's terminal for a project folder, where commands are shown as they run. */
  terminal?(workspaceRoot: string): CommandSink;
  /** Limits for read-only research sub-agents. */
  researchLimits(): { maxTurns: number; maxParallel: number };
  /** How heavily the coordinator may delegate. */
  delegationLimits(): {
    maxTasks: number;
    maxResearchers: number;
    maxResearchRounds?: number;
    checkIns?: number;
    progressEvery?: number;
    reviewRounds?: number;
    /** Most model calls one run may make (sub-agents and the coordinator's calls about them). 0 or unset: no limit. */
    maxModelCallsPerRun?: number;
    /** Whether the coordinator verifies a request before it calls it done. Unset: off. */
    verify?: boolean;
    /** Most fix-up rounds when verification finds work left (agentic.delegation.verifyRounds). */
    verifyRounds?: number;
  };
  /** Folders linked, not copied, into a scratch copy of the project, such as node_modules. */
  scratchLinkDirs?(workspaceRoot: string): string[];
  /** Most tokens of earlier conversation sent with each coordinator message. 0 or unset: as much as fits. */
  coordinatorHistoryTokens?(): number;
  /** Opens a pending change in VS Code: a new file as its own editor, an edit as a side-by-side diff. */
  showChange(runId: string, filePath: string): Promise<void>;
  /** Closes the editors showing a change once it is decided. */
  closeChange(runId: string, filePath: string): Promise<void>;
  /**
   * After drafts were written: opens the file itself when `open` is set, and
   * returns a warning for each file that an editor holds with unsaved edits,
   * since that editor still shows the old text.
   */
  afterAccept?(workspaceRoot: string, filePaths: string[], open: boolean): Promise<string[]>;
  /** Lets the user pick files to attach to a prompt. Returns paths relative to the folder, and only files inside it. */
  pickFiles?(workspaceRoot: string): Promise<string[]>;
}

/** How a run started from the chat talks back to the user. */
export interface RunHooks {
  /** The checks approved for this run. They replace the settings for it. */
  checks: CheckConfig[];
  approveTool: (task: Task, reason: string, call: ToolCall, preview?: string) => Promise<boolean>;
  /** Asked before every check command runs, unless commands are auto-approved. */
  approveCommand: (task: Task, check: CheckConfig) => Promise<boolean>;
  askUser: (task: Task, question: string) => Promise<string>;
  /** A sub-agent's question to the coordinator. The coordinator answers, or asks the user. */
  askCoordinator: (task: Task, question: string, signal: AbortSignal) => Promise<CoordinatorReply>;
  /** The coordinator reviews a sub-agent's result (its report and drafts as diffs) before it counts as done. */
  reviewResult?: (task: Task, summary: string, drafts: string, signal: AbortSignal, skip?: ReviewSkip) => Promise<ReviewVerdict>;
  inbox: (taskId: string) => InboxMessage[];
  /** Called once the run has started, with what the coordinator may do to its sub-agents while it supervises them. */
  attach?: (control: RunControl) => void;
  /** A task finished with file changes. They are pending until accepted here or by an auto-approve switch. */
  onChanges: (task: Task, changes: PendingChange[]) => Promise<void>;
  /** The model a sub-agent uses, wrapped so the chat can show its calls live. */
  wrapProvider?: (task: Task, provider: ModelProvider) => ModelProvider;
}

/** What the coordinator can do to a running sub-agent of a plan. */
export interface RunControl {
  /** Stops one sub-agent. Its drafts are kept for review. */
  cancelTask(taskId: string): boolean;
  /** A sub-agent's step budget. */
  maxTurns?: number;
}

/** The coordinator keeping tabs on the sub-agents of one run. */
interface Supervision {
  conversationId: string;
  monitor: AgentMonitor;
  control?: RunControl;
  abort: AbortController;
  /** Sub-agents the coordinator is looking at right now. */
  inFlight: Set<string>;
}

/** What the user can do with a pending change from the chat. */
export type ReviewAction = "show" | "open" | "accept" | "reject";

/** What the user chose on a card that waited for them. */
export type Decision =
  | { kind: "checks"; checks: CheckConfig[]; remember: boolean }
  | { kind: "skip" }
  | { kind: "allow"; remember?: boolean }
  | { kind: "deny" }
  | { kind: "answer"; text: string };

export interface PlanView {
  kind: "change" | "research";
  tasks: { id: string; title: string; status: TaskStatus; fileScope: string[]; dependsOn: string[] }[];
  /** True once any task has started, so the plan can no longer be run from the chat. */
  started: boolean;
  waves: number;
  /** Proposed file changes and what became of them. */
  changes: ChangeView[];
  /**
   * Set when the run can be resumed: "interrupted" when VS Code closed under
   * it, "stopped" when it was stopped or left tasks unstarted. Unset while it runs.
   */
  resumable?: "interrupted" | "stopped";
  /** Tasks a resume would run. */
  tasksLeft?: number;
}

export interface ChangeView {
  path: string;
  taskId: string;
  /** The sub-agent that made the change: its task's title. */
  agentName: string;
  kind: "new" | "edit";
  status: PendingChange["status"];
  /** Where the change is in its lifecycle: draft (waiting for review), applied or discarded. */
  state: DraftState;
  /** Lines added and removed compared with the file the sub-agent started from. */
  added: number;
  removed: number;
  /** Written by an auto-approve switch rather than by the user. */
  auto?: boolean;
  /** Why the last Accept did not go through, e.g. the file changed on disk. */
  note?: string;
}

export interface ChatViewState {
  mode: ChatMode;
  /** The model the next message will use, for example "qwen3:8b at http://localhost:11434/v1". */
  model: string;
  /** What the chat is doing right now, if anything. */
  busy?: string;
  conversations: ConversationSummary[];
  current?: { id: string; title: string; workspaceRoot: string; entries: ChatEntry[] };
  plans: Record<string, PlanView>;
  runningRunId?: string;
  permissions: AutoApprove;
  /** Ids of cards still waiting for the user. */
  waiting: string[];
  /** How the last prompt in this conversation ended, shown as a bar at the bottom. Unset while a prompt runs. */
  done?: DoneBar;
  /** The orchestration dashboard for the current conversation: coordinator, agents, counts and what needs the user. */
  dashboard?: DashboardView;
  /** The folder files are attached from before a conversation exists. */
  attachRoot?: string;
  /** Model calls in flight, by "coordinator" or "runId:taskId": phase, elapsed time, tokens and the latest thought. */
  live?: Record<string, LiveItem>;
}

/** The bar at the bottom of the chat once a prompt is dealt with: green when finished. */
export interface DoneBar {
  status: "finished" | "partial" | "stopped" | "failed";
  text: string;
  /** When the prompt was dealt with. */
  time?: string;
}

/** Thinking can be long; keep enough to follow along. */
function clip(text: string | undefined, max = 4000): string | undefined {
  text = text?.trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}\n[… cut]` : text;
}

function title(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat || "New task";
}

function describePlan(run: Run): string {
  return run.tasks.map((t, i) => `${i + 1}. ${t.title} (files: ${t.fileScope.join(", ")})`).join("\n");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function clipLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** An entry that waits for the user to decide. */
function isCard(e: ChatEntry): boolean {
  return e.kind === "checks" || e.kind === "approval" || e.kind === "question";
}

function isUnstarted(run: Run): boolean {
  return run.tasks.length > 0 && run.tasks.every((t) => t.status === "pending" && t.attempts === 0);
}

/** What the user's reopened conversation with a finished sub-agent is doing. */
export type FollowUpState = "working" | "open" | "ending";

/**
 * A conversation the user reopened with a sub-agent whose task had ended.
 * The sub-agent resumes with its saved history. Its drafts become pending
 * changes of its run, and when the conversation ends it reports what is new
 * to the coordinator.
 */
interface FollowUp {
  key: string;
  runId: string;
  taskId: string;
  title: string;
  conversationId: string;
  worker: Worker;
  abort: AbortController;
  /** This sub-agent's view of the project, for one that may change files. */
  overlay?: OverlayFiles;
  scratch?: ScratchCopy;
  published: Map<string, string>;
  /** The replies it gave, used if the closing summary cannot be made. */
  replies: string[];
  /** Answering a message right now. */
  working?: Promise<void>;
  /** Writing its update for the coordinator. */
  ending?: Promise<void>;
  /** The last step it logged, so its reply is in the chat before it counts as done. */
  logged?: Promise<void>;
}

const FOLLOW_UP_END = `The user ended this conversation. Call finish now, without other tools. The summary is your update for the coordinator, who plans the next work: in a few sentences, say only what is new since your original report (findings, answers, decisions the user made, drafts you made). If nothing new came up, say "Nothing new."`;

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
  /** How the last prompt ended, for the bar at the bottom of its conversation. */
  private done?: DoneBar & { conversationId: string };
  /** Set by Stop until the work it stopped has wound down. */
  private stopping = false;
  /** The folder files were attached from before the first message, so the new conversation uses the same one. */
  private attachRoot?: string;
  /** Which conversation each run belongs to, so sub-agent events land in the right chat. */
  private readonly runOwner = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly stopEvents: () => void;
  private readonly ready: Promise<void>;
  private readonly eventQueue = new Mutex();
  /** Cards waiting for the user, by entry id. */
  private readonly pending = new Map<string, { conversationId: string; resolve: (d: Decision | undefined) => void; runId?: string; taskId?: string }>();
  /** Messages the user or the coordinator sent to a sub-agent, waiting for its next step. Keyed by run and task. */
  private readonly inboxes = new Map<string, InboxMessage[]>();
  /** Runs whose sub-agents the coordinator is keeping tabs on, by run id. */
  private readonly supervised = new Map<string, Supervision>();
  /** Sub-agents waiting for the coordinator's answer, by "runId:taskId", with their title. */
  private readonly consulting = new Map<string, string>();
  /** Sub-agents the coordinator is checking on right now, by "runId:taskId", with their title. */
  private readonly checkingOn = new Map<string, string>();
  /** Times the coordinator sent a sub-agent's result back, by "runId:taskId". */
  private readonly reviewRounds = new Map<string, number>();
  /** How each sub-agent's latest result came out of review, by "runId:taskId". An unreviewed result is never auto-accepted. */
  private readonly reviewOutcomes = new Map<string, ReviewOutcome>();
  /** Model calls per run: sub-agents' steps and the coordinator's calls about them. */
  private readonly budget = new CallBudget(
    () => this.host.delegationLimits().maxModelCallsPerRun ?? 0,
    (runId, limit) => this.budgetReached(runId, limit),
  );
  /** Why an Accept did not go through, by "runId:path". Cleared once the change is decided. */
  private readonly changeNotes = new Map<string, string>();
  /** Commands the user allowed for the rest of a run, keyed by run id. */
  private readonly allowedCommands = new Map<string, Set<string>>();
  /** Change runs a restart cut off, found when the chat started. */
  private readonly interrupted: { runId: string; conversationId: string; request: string }[] = [];
  /** Conversations the user reopened with finished sub-agents, by "runId:taskId". */
  private readonly followUps = new Map<string, FollowUp>();
  /** What every model call is doing right now, so a long "thinking" shows that it is still working. */
  readonly live = new LiveTracker();

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
    this.live.dispose();
    this.abort?.abort();
    for (const s of this.supervised.values()) s.abort.abort();
    for (const f of this.followUps.values()) f.abort.abort();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called when settings change, so the chat shows the model it will use next. */
  settingsChanged(): void {
    this.changed();
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  /**
   * The model for the coordinator's own calls, shown live under "coordinator".
   * With a run id, the call is about that run's sub-agents and counts against its budget.
   */
  private coordinatorProvider(workspaceRoot: string, runId?: string): ModelProvider {
    const provider = this.live.wrap(this.host.provider(workspaceRoot), "coordinator");
    return runId ? this.budget.wrap(provider, runId) : provider;
  }

  /** A sub-agent's model, shown live and counted against its run's budget. */
  private agentProvider(provider: ModelProvider, runId: string, taskId: string): ModelProvider {
    return this.budget.wrap(this.live.wrap(provider, `${runId}:${taskId}`), runId);
  }

  /**
   * A run used its model-call budget. Its sub-agents are stopped as with
   * Stop (drafts kept for review, never written automatically), and the
   * coordinator stops looking at them. Research sub-agents fail on their next
   * step, and the answer is written from the reports so far.
   */
  private budgetReached(runId: string, limit: number): void {
    this.host.log("warn", `Run ${runId} reached its limit of ${limit} model calls (agentic.delegation.maxModelCallsPerRun).`);
    this.supervised.get(runId)?.abort.abort();
    if (this.runningRunId === runId) this.host.cancelRun(runId);
    const conversationId = this.runOwner.get(runId);
    if (!conversationId) return;
    void this.append(conversationId, {
      author: "system",
      runId,
      tone: "warning",
      text: `This run reached its limit of ${limit} model calls (agentic.delegation.maxModelCallsPerRun in your user settings), so its sub-agents were stopped. Their drafts are kept under Drafts for your review and are not written automatically. Raise the limit and retry the tasks to continue.`,
    }).catch((err) => this.host.log("warn", (err as Error).message));
  }

  private async indexRuns(): Promise<void> {
    for (const s of await this.conversations.list()) {
      const c = await this.conversations.load(s.id).catch(() => undefined);
      // Runs another VS Code window is working on right now: their cards are still live there.
      const elsewhere = new Set<string>();
      for (const runId of c?.runIds ?? []) {
        this.runOwner.set(runId, s.id);
        const run = await this.tasks.load(runId).catch(() => undefined);
        if (!run) continue;
        // Research that was cut off by a restart has no live sub-agent; mark it failed.
        for (const t of run.kind === "research" ? run.tasks.filter((x) => x.status === "running") : []) {
          await this.tasks.setStatus(runId, t.id, "failed", INTERRUPTED).catch(() => undefined);
        }
        const state = resumeState(run, process.pid);
        if (state === "elsewhere") elsewhere.add(runId);
        if (state === "interrupted") await this.noteInterrupted(s.id, run).catch((err) => this.host.log("warn", `Could not mark run ${runId} as interrupted: ${(err as Error).message}`));
      }
      // Nothing in this window waits on a card from before it started, so those cards can no longer be answered.
      if (c?.entries.some((e) => isCard(e) && !e.decided && !(e.runId && elsewhere.has(e.runId)))) {
        await this.conversations
          .update(s.id, (conv) => {
            for (const e of conv.entries) if (isCard(e) && !e.decided && !(e.runId && elsewhere.has(e.runId))) e.decided = "Not answered: VS Code was closed";
          })
          .catch(() => undefined);
      }
    }
    this.currentId ??= (await this.conversations.list())[0]?.id;
    const current = this.currentId ? await this.conversations.load(this.currentId).catch(() => undefined) : undefined;
    if (current) this.mode = current.mode;
  }

  /**
   * A change run VS Code closed under: its cut-off tasks are marked stopped,
   * and the chat says what is kept and offers to resume.
   */
  private async noteInterrupted(conversationId: string, run: Run): Promise<void> {
    const cut = await this.tasks.markInterrupted(run.id);
    const after = await this.tasks.load(run.id);
    const done = after.tasks.filter((t) => t.status === "done").length;
    const drafts = (after.changes ?? []).filter((c) => c.status === "pending").length;
    this.interrupted.push({ runId: run.id, conversationId, request: run.request });
    await this.conversations.append(conversationId, {
      author: "system",
      runId: run.id,
      tone: "warning",
      tag: "interrupted",
      text: [
        `VS Code closed while this run was working${cut.length ? ` on ${plural(cut.length, "task")}` : ""}. ${done} of ${after.tasks.length} task(s) are done.`,
        drafts ? `${plural(drafts, "draft")} are kept under Drafts for your review.` : "",
        `Press "Resume" to continue where it stopped: sub-agents that were cut off pick up from their last step.`,
      ].filter(Boolean).join(" "),
    });
  }

  private resumeView(run: Run): Pick<PlanView, "resumable" | "tasksLeft"> {
    if (this.runningRunId === run.id) return {};
    const state = resumeState(run, process.pid);
    if (state !== "interrupted" && state !== "stopped") return {};
    return { resumable: state, tasksLeft: resumableTasks(run).length };
  }

  /** Whether a run was started from a chat conversation. */
  owns(runId: string): boolean {
    return this.runOwner.has(runId);
  }

  /** Change runs found cut off by a restart when the chat started, for the "Resume?" notification. */
  async interruptedRuns(): Promise<{ runId: string; conversationId: string; request: string }[]> {
    await this.ready;
    const out = [];
    for (const r of this.interrupted) {
      const run = await this.tasks.load(r.runId).catch(() => undefined);
      if (run && resumeState(run, process.pid) && this.runningRunId !== r.runId) out.push(r);
    }
    return out;
  }

  async state(): Promise<ChatViewState> {
    // What the chat is doing at the moment it is asked, before the loads below let a running prompt move on.
    const busy = this.busy;
    const stopping = this.stopping;
    await this.ready;
    const conversations = await this.conversations.list();
    let current: Conversation | undefined;
    if (this.currentId) current = await this.conversations.load(this.currentId).catch(() => undefined);
    const plans: Record<string, PlanView> = {};
    for (const runId of current?.runIds ?? []) {
      const run = await this.tasks.load(runId).catch(() => undefined);
      if (!run) continue;
      plans[runId] = {
        kind: run.kind ?? "change",
        tasks: run.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, fileScope: t.fileScope, dependsOn: t.dependsOn })),
        started: !isUnstarted(run),
        waves: parallelWaves(run.tasks).length,
        ...this.resumeView(run),
        changes: (run.changes ?? []).map((ch) => ({
          path: ch.path,
          taskId: ch.taskId,
          agentName: run.tasks.find((t) => t.id === ch.taskId)?.title ?? ch.taskId,
          kind: changeKind(ch),
          status: ch.status,
          state: draftState(ch.status),
          ...lineCounts(ch.original, ch.proposed),
          auto: ch.auto,
          note: this.changeNotes.get(`${runId}:${ch.path}`),
        })),
      };
    }
    const done = this.done && this.done.conversationId === current?.id ? { status: this.done.status, text: this.done.text, time: this.done.time } : undefined;
    const waiting = [...this.pending.keys()];
    return {
      mode: this.mode,
      model: this.host.modelLabel(current?.workspaceRoot),
      busy,
      conversations,
      current: current && { id: current.id, title: current.title, workspaceRoot: current.workspaceRoot, entries: current.entries },
      plans,
      runningRunId: this.runningRunId,
      permissions: this.host.permissions(),
      waiting,
      done,
      dashboard: current
        ? buildDashboard({
            entries: current.entries,
            plans,
            runIds: current.runIds,
            waiting,
            busy,
            stopping,
            runningRunId: this.runningRunId,
            done,
            followUps: this.followUpStates(),
            consulting: Object.fromEntries(this.consulting),
            checkingOn: Object.fromEntries(this.checkingOn),
          })
        : undefined,
      attachRoot: current ? undefined : this.attachRoot,
      live: this.live.snapshot(),
    };
  }

  /** Starts a fresh conversation the next time the user sends a message. */
  newTask(): void {
    if (this.busy) return;
    this.currentId = undefined;
    this.attachRoot = undefined;
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

  async setPermission(key: keyof AutoApprove, value: boolean): Promise<void> {
    await this.host.setPermission(key, value);
    this.changed();
  }

  async setMode(mode: ChatMode): Promise<void> {
    this.mode = mode;
    this.host.setDefaultMode(mode);
    if (this.currentId) await this.conversations.update(this.currentId, (c) => (c.mode = mode));
    this.changed();
  }

  /**
   * The Stop button: ends everything the coordinator and its sub-agents are
   * doing right now. Model calls are aborted, running commands are killed,
   * and questions waiting for the user are closed. Drafts stay pending for
   * review; nothing is written.
   */
  cancel(): void {
    // Stop also ends reopened sub-agent conversations; what they said is still passed on.
    for (const f of [...this.followUps.values()]) void this.endFollowUp(f, false);
    if (!this.busy && this.pending.size === 0) return;
    if (this.busy) {
      this.busy = "Stopping…";
      this.stopping = true;
      this.changed();
    }
    this.abort?.abort();
    for (const s of this.supervised.values()) s.abort.abort();
    if (this.runningRunId) this.host.cancelRun(this.runningRunId);
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      void this.markDecided(p.conversationId, id, "Stopped");
      p.resolve(undefined);
    }
  }

  private async append(id: string, entry: Omit<ChatEntry, "id" | "time">): Promise<ChatEntry> {
    const full = await this.conversations.append(id, entry);
    this.changed();
    return full;
  }

  private async markDecided(conversationId: string, entryId: string, decided: string, checks?: CheckConfig[]): Promise<void> {
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
  private async waitFor(conversationId: string, entry: Omit<ChatEntry, "id" | "time">): Promise<{ entry: ChatEntry; decision?: Decision }> {
    const full = await this.append(conversationId, entry);
    const decision = await new Promise<Decision | undefined>((resolve) => this.pending.set(full.id, { conversationId, resolve, runId: entry.runId, taskId: entry.taskId }));
    return { entry: full, decision };
  }

  /** The user's answer to a card. Ignored if the card is no longer waiting. */
  async decide(entryId: string, decision: Decision): Promise<void> {
    const p = this.pending.get(entryId);
    if (!p) return;
    this.pending.delete(entryId);
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
    await this.markDecided(p.conversationId, entryId, label, decision.kind === "checks" ? decision.checks : undefined);
    p.resolve(decision);
  }

  /**
   * Shows, accepts or rejects a pending change from the chat. Without a path,
   * accepts or rejects every pending change of that run's task (or the whole run).
   */
  async review(runId: string, action: ReviewAction, filePath?: string, taskId?: string): Promise<void> {
    const conversationId = this.runOwner.get(runId) ?? this.currentId;
    const run = await this.tasks.load(runId);
    if (action === "show") {
      if (filePath) await this.host.showChange(runId, filePath);
      return;
    }
    const root = run.workspaceRoot && (await this.host.openFolder(run.workspaceRoot));
    if (action === "open") {
      // The written file itself, for an accepted draft.
      if (!root) throw new Error(`${run.workspaceRoot ?? "This run's folder"} is not open in VS Code.`);
      if (filePath && run.changes?.some((c) => c.path === filePath && c.status === "accepted")) await this.host.afterAccept?.(root, [filePath], true);
      return;
    }
    if (!root) throw new Error(`${run.workspaceRoot ?? "This run's folder"} is not open in VS Code, so nothing can be written.`);
    const targets = (run.changes ?? []).filter(
      (c) => c.status === "pending" && (filePath ? c.path === filePath : !taskId || c.taskId === taskId),
    );
    const written: string[] = [];
    const held: string[] = [];
    const failed: string[] = [];
    for (const c of targets) {
      const key = `${runId}:${c.path}`;
      if (action === "reject") {
        await rejectChange(this.tasks, runId, c.path);
        this.changeNotes.delete(key);
      } else {
        // A second Accept after a "changed on disk" note means: overwrite.
        let res;
        try {
          res = await acceptChange(this.tasks, runId, c.path, root, { overwrite: this.changeNotes.has(key) });
        } catch (err) {
          // One file that cannot be written does not stop the others, and it says why on its card.
          const message = `Could not write ${c.path}: ${(err as Error).message}`;
          this.changeNotes.set(key, message);
          this.host.log("error", message);
          failed.push(message);
          continue;
        }
        if (res.ok) {
          this.changeNotes.delete(key);
          written.push(c.path);
        } else {
          this.changeNotes.set(key, res.message);
          held.push(res.message);
          continue;
        }
      }
      await this.host.closeChange(runId, c.path).catch(() => undefined);
    }
    // Each written file is announced from the store's log (see eventFeed). What was not written says why here,
    // in the chat and not only on its card, so an Accept never looks like it did nothing.
    const warnings = written.length ? ((await this.host.afterAccept?.(root, written, written.length === 1 && !!filePath).catch(() => [])) ?? []) : [];
    if (conversationId && targets.length > 1 && (written.length || action === "reject")) {
      const n = action === "accept" ? written.length : targets.length;
      await this.append(conversationId, { author: "system", runId, text: action === "accept" ? `Accepted ${n} draft(s) and wrote them to your project.` : `Rejected ${n} draft(s). Nothing was written for them.` });
    }
    if (conversationId && action === "accept" && (held.length || failed.length || warnings.length)) {
      await this.append(conversationId, { author: "system", runId, tone: "warning", text: [...held.map((m) => `Not written yet: ${m}`), ...failed, ...warnings].join("\n") });
    }
    this.changed();
    if (failed.length) throw new Error(failed.join(" "));
  }

  /**
   * Sends a message straight to a sub-agent. A running one reads it before
   * its next step. One whose task has ended is reopened: it resumes with its
   * saved conversation and answers, until the user ends the conversation.
   */
  async messageAgent(runId: string, taskId: string, text: string): Promise<void> {
    const conversationId = this.runOwner.get(runId);
    if (!conversationId || !text.trim()) return;
    const run = await this.tasks.load(runId);
    const task = run.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const key = `${runId}:${taskId}`;
    const follow = this.followUps.get(key);
    const warn = (msg: string) => this.append(conversationId, { author: "system", runId, taskId, agentName: task.title, text: msg, tone: "warning" });
    if (task.status === "running" || task.status === "verifying" || follow?.working) {
      this.inboxes.set(key, [...(this.inboxes.get(key) ?? []), { from: "user", text: text.trim() }]);
      await this.append(conversationId, { author: "user", kind: "direct", runId, taskId, agentName: task.title, text: text.trim() });
      return;
    }
    if (follow?.ending) {
      await warn(`"${task.title}" is passing what it learned to the coordinator. Send your message again in a moment to start a new conversation.`);
      return;
    }
    if (task.status === "pending" || task.status === "awaiting_approval") {
      await warn(`"${task.title}" has not started yet, so it cannot get messages.`);
      return;
    }
    if (this.runningRunId === runId) {
      await warn(`The other sub-agents of "${task.title}"'s run are still working. You can talk with it again once the run is done.`);
      return;
    }
    await this.append(conversationId, { author: "user", kind: "direct", runId, taskId, agentName: task.title, text: text.trim() });
    try {
      const f = follow ?? (await this.openFollowUp(conversationId, run, task));
      this.answerFollowUp(f, text.trim());
    } catch (err) {
      await this.append(conversationId, { author: "system", kind: "error", runId, taskId, agentName: task.title, text: `Could not reopen "${task.title}": ${(err as Error).message}`, tone: "error" });
    }
  }

  /** What each reopened sub-agent conversation is doing, by "runId:taskId". */
  private followUpStates(): Record<string, FollowUpState> {
    const out: Record<string, FollowUpState> = {};
    for (const [key, f] of this.followUps) out[key] = f.ending ? "ending" : f.working ? "working" : "open";
    return out;
  }

  /** Brings a sub-agent whose task ended back, with its saved conversation, under the usual permissions. */
  private async openFollowUp(conversationId: string, run: Run, task: Task): Promise<FollowUp> {
    const workspaceRoot = run.workspaceRoot ?? (await this.conversations.load(conversationId)).workspaceRoot;
    const root = await this.host.openFolder(workspaceRoot);
    if (!root) throw new Error(`${workspaceRoot} is not open in VS Code, so the sub-agent cannot read it.`);
    const research = run.kind === "research" || task.fileScope.length === 0;
    const key = `${run.id}:${task.id}`;
    const abort = new AbortController();
    const disk = await WorkspaceSandbox.create(root);
    // Like during its task: the project as on disk, plus the drafts still waiting for review.
    const overlay = research ? undefined : new OverlayFiles(disk, pendingBase(run.changes));
    // Commands run in a copy, never in the project itself; a researcher's copy just has no drafts.
    const scratch = new ScratchCopy(root, path.join(root, AGENT_DIR, "scratch", `followup-${run.id.slice(0, 8)}`, task.id), ["node_modules"]);
    const checks = research ? [] : ((await this.host.checksFor(workspaceRoot)).saved ?? []);
    const hooks = this.hooksFor(conversationId, run.id, checks, workspaceRoot);
    const history = await this.tasks.loadHistory(run.id, task.id);
    const published = new Map<string, string>();
    const f: FollowUp = { key, runId: run.id, taskId: task.id, title: task.title, conversationId, abort, overlay, scratch, published, replies: [], worker: undefined as unknown as Worker };
    const conversation = await this.conversations.load(conversationId);
    f.worker = new Worker({
      provider: this.live.wrap(this.host.provider(workspaceRoot), key),
      sandbox: overlay ?? disk,
      checkDir: () => scratch.sync(overlay ? overlay.allChanges() : new Map()),
      terminal: this.host.terminal?.(workspaceRoot),
      task,
      checks,
      maxTurns: this.host.researchLimits().maxTurns,
      signal: abort.signal,
      readOnly: research,
      followUp: true,
      history,
      // Without a saved conversation (older runs), it gets what the chat shows of its work.
      context: history?.length ? undefined : earlierWork(task, conversation.entries, run.id),
      // Never auto-approved: its history may hold injected text from files it read, so the user decides every write and command.
      // A researcher cannot write (its file scope is empty), so for it this only covers commands.
      approve: (reason, call, preview) => this.askFollowUpApproval(conversationId, run.id, task, reason, call, preview),
      // Also never auto-approved, and never remembered: each command run is one card for this sub-agent only.
      approveCommand: research
        ? undefined
        : (check) => this.askFollowUpApproval(conversationId, run.id, task, `Run the check "${check.name}" (\`${check.command}\`)`, { tool: "run_check", name: check.name }),
      askUser: (q) => hooks.askUser(task, q),
      beforeAsk: overlay ? async () => void (await publishDrafts(this.tasks, run.id, task, overlay, published, (t, c) => this.announceFollowUpDrafts(conversationId, run.id, t, c))) : undefined,
      inbox: () => this.drainInbox(run.id, task.id),
      log: (type, message, data) => {
        // Its finish is a reply to the user here, or, when the conversation ends, its update for the coordinator.
        if (type === "tool_call" && message === "finish") type = f.ending ? "followup_summary" : "followup_reply";
        const summary = (data?.call as { summary?: unknown } | undefined)?.summary;
        f.logged = this.tasks
          .log({ runId: run.id, taskId: task.id, type, message: type.startsWith("followup_") && typeof summary === "string" ? summary : message, data })
          .catch(() => undefined);
      },
    });
    this.followUps.set(key, f);
    await this.tasks.log({ runId: run.id, taskId: task.id, type: "followup_opened", message: history?.length ? "with history" : "from the chat" });
    this.changed();
    return f;
  }

  /** Lets a reopened sub-agent answer, then any messages that came in meanwhile. */
  private answerFollowUp(f: FollowUp, text: string): void {
    const task = async () => {
      let next: string | undefined = text;
      while (next !== undefined && !f.abort.signal.aborted) {
        const result = await f.worker.run(`Message from the user: ${next}`);
        f.replies.push(result.summary);
        await this.settleFollowUpLog(f);
        await this.publishFollowUpDrafts(f);
        await this.tasks.saveHistory(f.runId, f.taskId, f.worker.history()).catch(() => undefined);
        const more = this.drainInbox(f.runId, f.taskId);
        next = more.length ? more.join("\n\n") : undefined;
      }
    };
    f.working = task()
      .catch(async (err) => {
        if (f.abort.signal.aborted) return;
        await this.append(f.conversationId, { author: "system", kind: "error", runId: f.runId, taskId: f.taskId, agentName: f.title, text: `"${f.title}" could not answer: ${(err as Error).message}`, tone: "error" });
      })
      .finally(() => {
        f.working = undefined;
        this.changed();
      });
    this.changed();
  }

  /**
   * A reopened sub-agent's write or new command. Always a card for the user,
   * whatever the auto-approve switches say: its conversation may carry
   * instructions planted in a file it read, so it never gets to act alone.
   */
  private async askFollowUpApproval(conversationId: string, runId: string, task: Task, reason: string, call: ToolCall, preview?: string): Promise<boolean> {
    const { decision } = await this.waitFor(conversationId, {
      author: "agent",
      kind: "approval",
      runId,
      taskId: task.id,
      agentName: task.title,
      preview,
      text:
        call.tool === "run_command"
          ? `I'd like to run \`${call.command}\`.${call.reason ? ` ${asSentence(call.reason)}` : ""} In a reopened conversation every command needs your approval, even with Run commands on. Allowing it covers this one run by me only. It runs in a copy of the project, but like any command it runs as you, so only allow it if you trust it.`
          : call.tool === "request_check"
          ? `I'd like to run \`${call.command}\` as check "${call.name}". ${call.reason} In a reopened conversation every command needs your approval, even with Run commands on. Allowing it covers this one run by me only. It runs as you, so only allow it if you trust it.`
          : call.tool === "run_check"
            ? `${reason}. In a reopened conversation every command needs your approval, even a saved check with Run commands on. Allowing it covers this one run by me only. It runs as you, so only allow it if you trust it.`
            : `${reason}. In a reopened conversation every change needs your approval, even with Edit files on, and it stays a draft for review afterwards.`,
    });
    // Deliberately not remembered (no allowedFor): an approval covers this one call by this sub-agent, nothing else.
    return decision?.kind === "allow";
  }

  /** A reopened sub-agent's drafts: put up for review, and never written by an auto-approve switch. */
  private async announceFollowUpDrafts(conversationId: string, runId: string, task: Task, changes: PendingChange[]): Promise<void> {
    await this.append(conversationId, {
      author: "agent",
      kind: "review",
      runId,
      taskId: task.id,
      agentName: task.title,
      tone: "warning",
      text: `I have ${changes.length} draft change(s) for you to review under Drafts. Changes from a reopened conversation are never accepted automatically: nothing is written until you accept.`,
    });
    for (const ch of changes.slice(0, 3)) await this.host.showChange(runId, ch.path).catch((err) => this.host.log("warn", (err as Error).message));
  }

  /** Lets the reopened sub-agent's latest step land in the chat. */
  private async settleFollowUpLog(f: FollowUp): Promise<void> {
    await f.logged;
    await this.eventQueue.run(async () => {});
  }

  private async publishFollowUpDrafts(f: FollowUp): Promise<void> {
    if (!f.overlay) return;
    const run = await this.tasks.load(f.runId);
    const task = run.tasks.find((t) => t.id === f.taskId);
    if (!task) return;
    const changes = await publishDrafts(this.tasks, f.runId, task, f.overlay, f.published, (t, c) => this.announceFollowUpDrafts(f.conversationId, f.runId, t, c));
    if (changes.length) {
      const files = [...new Set([...(task.changedFiles ?? []), ...changes.map((c) => c.path)])];
      await this.tasks.updateTask(f.runId, f.taskId, { changedFiles: files });
    }
  }

  /** The "End chat" button: the sub-agent sends what is new to the coordinator, and the conversation closes. */
  async endAgentChat(runId: string, taskId: string): Promise<void> {
    const f = this.followUps.get(`${runId}:${taskId}`);
    if (!f) return;
    await this.endFollowUp(f, true);
    await this.continueAfterFollowUp(f.conversationId, runId, taskId);
  }

  /**
   * Ends a reopened conversation. What came up is added to the chat as an
   * update for the coordinator, which it sees in its next turn and passes to
   * the planner and later sub-agents. With `summarize`, the sub-agent writes
   * it; otherwise (Stop) its replies are passed on as they are.
   */
  private endFollowUp(f: FollowUp, summarize: boolean): Promise<void> {
    if (f.ending) return f.ending;
    f.ending = (async () => {
      this.changed();
      // Still answering: it is stopped rather than waited for, and its replies so far are passed on as they are.
      if (f.working) summarize = false;
      if (!summarize) {
        f.abort.abort();
        for (const [id, p] of [...this.pending]) {
          if (p.runId !== f.runId || p.taskId !== f.taskId) continue;
          this.pending.delete(id);
          void this.markDecided(p.conversationId, id, "Closed: the conversation ended");
          p.resolve(undefined);
        }
      }
      await f.working;
      let update: string | undefined;
      if (summarize && f.replies.length && !f.abort.signal.aborted) {
        try {
          update = (await f.worker.run(FOLLOW_UP_END)).summary.trim();
          await this.settleFollowUpLog(f);
          await this.publishFollowUpDrafts(f);
          await this.tasks.saveHistory(f.runId, f.taskId, f.worker.history()).catch(() => undefined);
        } catch (err) {
          this.host.log("warn", `Follow-up summary failed: ${(err as Error).message}`);
        }
      }
      if (!update && f.replies.length) update = f.replies.map((r) => r.replace(/\s+/g, " ").trim()).join(" ").slice(0, 1500);
      f.abort.abort();
      await f.scratch?.remove().catch(() => undefined);
      this.followUps.delete(f.key);
      if (update) {
        const run = await this.tasks.load(f.runId).catch(() => undefined);
        const task = run?.tasks.find((t) => t.id === f.taskId);
        if (task) {
          // Later plans and the sub-agents that build on this task see it in its report.
          const followUpNote = `After a follow-up with the user: ${update}`;
          await this.tasks.updateTask(f.runId, f.taskId, { summary: task.summary ? `${task.summary}\n\n${followUpNote}` : followUpNote }).catch(() => undefined);
        }
        await this.append(f.conversationId, {
          author: "coordinator",
          kind: "report",
          runId: f.runId,
          taskId: f.taskId,
          agentName: f.title,
          tag: "update from follow-up",
          text: `Update from "${f.title}" after you talked with it again: ${update}`,
        });
      } else {
        this.changed();
      }
    })();
    return f.ending;
  }

  /** Ends every reopened conversation of a conversation, so the coordinator knows what came up before it answers. */
  private async endFollowUpsOf(conversationId: string): Promise<void> {
    const open = [...this.followUps.values()].filter((f) => f.conversationId === conversationId);
    if (open.length === 0) return;
    this.busy = `Collecting what ${open.length === 1 ? `"${open[0]!.title}"` : `${open.length} sub-agents`} learned in your follow-up…`;
    this.changed();
    try {
      await Promise.all(open.map((f) => this.endFollowUp(f, true)));
    } finally {
      this.busy = undefined;
    }
  }

  private drainInbox(runId: string, taskId: string): InboxMessage[] {
    const key = `${runId}:${taskId}`;
    const messages = this.inboxes.get(key) ?? [];
    this.inboxes.delete(key);
    return messages;
  }

  /** Starts keeping tabs on a run's sub-agents. */
  private supervise(runId: string, conversationId: string, maxTurns: number): void {
    this.supervised.get(runId)?.abort.abort();
    this.supervised.set(runId, { conversationId, monitor: new AgentMonitor({ maxTurns }), abort: new AbortController(), inFlight: new Set() });
  }

  private endSupervision(runId: string): void {
    this.supervised.get(runId)?.abort.abort();
    this.supervised.delete(runId);
    this.budget.clear(runId);
    for (const map of [this.consulting, this.checkingOn, this.reviewRounds, this.reviewOutcomes]) for (const key of [...map.keys()]) if (key.startsWith(`${runId}:`)) map.delete(key);
  }

  /**
   * Every logged step of a supervised run passes through here. The monitor
   * counts steps without a model call; only a sign of trouble makes the
   * coordinator look at the sub-agent (at most agentic.delegation.checkIns
   * times per sub-agent, one look at a time).
   */
  private watch(event: RunEvent, run: Run): void {
    const s = this.supervised.get(event.runId);
    const task = event.taskId ? run.tasks.find((t) => t.id === event.taskId) : undefined;
    if (!s || !task) return;
    s.monitor.observe(event, task);
    // What it reported is news for the others: the coordinator looks at them soon after.
    if (event.type === "status" && event.message === "done") s.monitor.finished(task.id);
    if (event.type !== "tool_call" && event.type !== "denied" && event.type !== "checks") return;
    if (task.status !== "running" && task.status !== "verifying") return;
    if (s.inFlight.has(task.id) || s.abort.signal.aborted || this.budget.exhausted(run.id)) return;
    // Its last step was finishing: the review of its result is the next look.
    if (event.type === "tool_call" && event.message === "finish") return;
    const limits = this.host.delegationLimits();
    const limit = limits.checkIns ?? 2;
    let concern = limit > 0 && s.monitor.checkIns(task.id) < limit ? s.monitor.concerns(task.id)[0] : undefined;
    if (concern) s.monitor.markRaised(task.id, concern.kind);
    else if ((concern = s.monitor.progressDue(task.id, limits.progressEvery ?? 8))) s.monitor.markProgressCheck(task.id);
    if (!concern) return;
    s.inFlight.add(task.id);
    void this.checkOn(s, run, task, concern)
      .catch((err) => {
        if (!s.abort.signal.aborted) this.host.log("warn", `The coordinator could not check on "${task.title}": ${(err as Error).message}`);
      })
      .finally(() => {
        s.inFlight.delete(task.id);
        this.checkingOn.delete(`${run.id}:${task.id}`);
        this.changed();
      });
  }

  /** One look at a sub-agent that shows a sign of trouble: let it be, send it a note, or stop it. */
  private async checkOn(s: Supervision, run: Run, task: Task, concern: Concern): Promise<void> {
    const key = `${run.id}:${task.id}`;
    this.checkingOn.set(key, task.title);
    this.changed();
    const c = await this.conversations.load(s.conversationId);
    const notesSent = s.monitor.notesSent(task.id);
    const scope = runScope(c.entries, run.id);
    const fresh = await this.tasks.load(run.id).catch(() => run);
    const decision = await superviseAgent(
      this.coordinatorProvider(c.workspaceRoot, run.id),
      {
        userMessages: userMessagesOf(scope),
        request: run.request,
        agent: task,
        concern,
        activity: s.monitor.describe(task.id),
        notesSent,
        learned: learnedSoFar(scope) ?? fresh.briefing,
        team: s.monitor.teamStatus(fresh.tasks, task.id),
      },
      { signal: s.abort.signal },
    );
    const now = (await this.tasks.load(run.id)).tasks.find((t) => t.id === task.id);
    // It may have finished while the coordinator was looking.
    if (!now || (now.status !== "running" && now.status !== "verifying") || s.abort.signal.aborted) return;
    let { action, adjusted } = decision;
    let note = decision.message;
    if (action === "stop" && !s.control) {
      // Researchers run outside the orchestrator and cannot be stopped one by one; tell it to wrap up instead.
      action = "message";
      note = note || "Finish now with what you have found so far, and say what is still open.";
      adjusted = "This sub-agent cannot be stopped on its own, so it was told to finish instead.";
    }
    // Logged first, so the check-in is in the chat before the sub-agent acts on the note.
    await this.tasks.log({
      runId: run.id,
      taskId: task.id,
      type: "coordinator_checkin",
      message: action,
      data: { concern: concern.kind, detail: concern.detail, evidence: concern.evidence, note: action === "message" ? note : undefined, thought: decision.thought, thinking: clip(decision.thinking), adjusted },
    });
    if (action === "message") this.inboxes.set(key, [...(this.inboxes.get(key) ?? []), { from: "coordinator", text: note }]);
    this.host.log("info", `Coordinator checked on "${task.title}" (${CONCERN_LABEL[concern.kind]}) and chose "${action}".${adjusted ? ` ${adjusted}` : ""}`);
    if (action === "stop") s.control?.cancelTask(task.id);
  }

  /**
   * A sub-agent asked the coordinator something. The coordinator answers from
   * what it knows (the user's messages, research findings, the plan, the other
   * sub-agents). Only a decision its notes do not settle goes to the user.
   */
  private async consultCoordinator(conversationId: string, runId: string, task: Task, question: string, signal: AbortSignal): Promise<CoordinatorReply> {
    const key = `${runId}:${task.id}`;
    this.consulting.set(key, task.title);
    this.changed();
    try {
      const c = await this.conversations.load(conversationId);
      const run = await this.tasks.load(runId);
      const team = this.supervised.get(runId)?.monitor.teamStatus(run.tasks, task.id);
      // Only what belongs to this run: earlier, unrelated tasks in the same conversation stay out of reach.
      const scope = runScope(c.entries, runId);
      let result;
      try {
        result = await answerSubAgent(
          this.coordinatorProvider(c.workspaceRoot, runId),
          {
            userMessages: userMessagesOf(scope),
            request: run.request,
            agent: { title: task.title, instructions: task.instructions, fileScope: task.fileScope, research: run.kind === "research" },
            question,
            learned: learnedSoFar(scope),
            briefing: run.briefing,
            team,
            earlier: earlierAnswers(scope),
          },
          { signal },
        );
      } catch (err) {
        if (signal.aborted) throw err;
        this.host.log("warn", `The coordinator could not answer "${task.title}": ${(err as Error).message}`);
        await this.tasks.log({ runId, taskId: task.id, type: "coordinator_answer", message: "I could not answer this time (the model gave no usable reply), so it goes on with its best judgement.", data: { question, failed: true } });
        return { from: "coordinator", text: "The coordinator could not answer right now. Continue with your best judgement, and say what you assumed in your summary." };
      }
      if (!result.askUser) {
        await this.tasks.log({ runId, taskId: task.id, type: "coordinator_answer", message: result.answer, data: { question, thought: result.thought, thinking: clip(result.thinking) } });
        return { from: "coordinator", text: result.answer };
      }
      // Only the user can decide. The sub-agent's question is in the chat already; put the card after it.
      this.consulting.delete(key);
      await this.eventQueue.run(async () => {});
      const { decision } = await this.waitFor(conversationId, {
        author: "coordinator",
        kind: "question",
        runId,
        taskId: task.id,
        agentName: task.title,
        tag: "for a sub-agent",
        thought: result.thought,
        quote: question,
        text: `"${task.title}" asked me something only you can decide: ${result.answer}`,
      });
      if (decision?.kind === "answer") {
        await this.tasks.log({ runId, taskId: task.id, type: "coordinator_answer", message: decision.text, data: { question, from: "user" } });
        return { from: "user", text: decision.text };
      }
      return { from: "coordinator", text: "The user did not answer. Make a reasonable choice within your task and say which in your summary." };
    } finally {
      this.consulting.delete(key);
      this.changed();
    }
  }

  /**
   * A sub-agent called finish. Before its result counts, the coordinator
   * reads the report and the drafts and accepts them, or sends the sub-agent
   * back with feedback (at most agentic.delegation.reviewRounds times).
   *
   * When it cannot be sent back (too few steps left, or sent back as often as
   * allowed), the result is still reviewed, and a "revise" goes to the user.
   * A review that cannot happen (the model call fails, the run used its
   * model-call budget) never counts as a pass. Either way the chat says so,
   * and the drafts wait for the user even when auto-approve is on.
   */
  private async reviewResult(conversationId: string, runId: string, task: Task, summary: string, drafts: string, signal: AbortSignal, skip?: ReviewSkip): Promise<ReviewVerdict> {
    const key = `${runId}:${task.id}`;
    const limit = Math.min(MAX_REVIEW_ROUNDS, this.host.delegationLimits().reviewRounds ?? 1);
    const round = this.reviewRounds.get(key) ?? 0;
    const final: ReviewSkip | undefined = skip ?? (round >= limit ? "limit_reached" : undefined);
    const research = task.fileScope.length === 0;
    const unreviewed = async (reason: ReviewOutcome, extra: Record<string, unknown> = {}): Promise<ReviewVerdict> => {
      this.reviewOutcomes.set(key, reason);
      await this.tasks.log({ runId, taskId: task.id, type: "coordinator_review", message: "unavailable", data: { reason, research, ...extra } });
      this.host.log("warn", `The coordinator did not review "${task.title}" (${reason}). Its drafts wait for the user.`);
      return { accept: true, outcome: reason };
    };
    if (limit <= 0) {
      // The user turned review off in their own settings: nothing to flag.
      this.reviewOutcomes.set(key, "off");
      return { accept: true, outcome: "off" };
    }
    if (this.budget.exhausted(runId)) return unreviewed("over_budget");
    this.checkingOn.set(key, task.title);
    this.changed();
    try {
      const c = await this.conversations.load(conversationId);
      const run = await this.tasks.load(runId);
      const scope = runScope(c.entries, runId);
      let result;
      try {
        result = await reviewSubAgentResult(
          this.coordinatorProvider(c.workspaceRoot, runId),
          {
            userMessages: userMessagesOf(scope),
            request: run.request,
            agent: { title: task.title, instructions: task.instructions, fileScope: task.fileScope, research: run.kind === "research" || research },
            summary,
            drafts,
            learned: learnedSoFar(scope) ?? run.briefing,
            team: this.supervised.get(runId)?.monitor.teamStatus(run.tasks, task.id),
            round,
            final,
          },
          { signal },
        );
      } catch (err) {
        if (signal.aborted) throw err;
        this.host.log("warn", `The coordinator could not review "${task.title}": ${(err as Error).message}`);
        return await unreviewed(this.budget.exhausted(runId) ? "over_budget" : "failed");
      }
      signal.throwIfAborted();
      // It asked for changes without saying which: that is no review at all, so the user decides.
      if (result.adjusted) return await unreviewed("unclear", { thought: result.thought, thinking: clip(result.thinking) });
      const revise = result.verdict === "revise";
      const outcome: ReviewOutcome = !revise ? "accepted" : final ? "not_accepted" : "sent_back";
      if (outcome === "sent_back") this.reviewRounds.set(key, round + 1);
      this.reviewOutcomes.set(key, outcome);
      await this.tasks.log({
        runId,
        taskId: task.id,
        type: "coordinator_review",
        message: outcome === "not_accepted" ? "not_accepted" : result.verdict,
        data: { feedback: result.feedback, thought: result.thought, thinking: clip(result.thinking), final, research },
      });
      this.host.log("info", `Coordinator reviewed "${task.title}": ${outcome}.`);
      return outcome === "sent_back" ? { accept: false, feedback: result.feedback, outcome } : { accept: true, outcome };
    } finally {
      this.checkingOn.delete(key);
      this.changed();
    }
  }

  private allowedFor(runId: string): Set<string> {
    let set = this.allowedCommands.get(runId);
    if (!set) this.allowedCommands.set(runId, (set = new Set()));
    return set;
  }

  /**
   * A command a sub-agent wants to run with run_command. With "Run commands"
   * on it runs at once (the chat says so); otherwise a card shows the command
   * and nothing runs until the user allows it. "Allow for the rest of this
   * run" covers the same command again, by any sub-agent of this run.
   */
  private async approveAgentCommand(conversationId: string, runId: string, task: Task, call: Extract<ToolCall, { tool: "run_command" }>): Promise<boolean> {
    if (isAutoApproved(call, this.host.permissions()) || this.allowedFor(runId).has(call.command)) return true;
    const { decision } = await this.waitFor(conversationId, {
      author: "agent",
      kind: "approval",
      runId,
      taskId: task.id,
      agentName: task.title,
      rememberable: true,
      rememberLabel: "Allow for the rest of this run",
      text: `I'd like to run \`${call.command}\`.${call.reason ? ` ${asSentence(call.reason)}` : ""} Nothing runs until you allow it. It runs in a copy of the project, so your files are not touched, but like any command it runs as you and can read files elsewhere or use the network, so only allow it if you trust it. Turn on "Run commands" to stop being asked.`,
    });
    if (decision?.kind !== "allow") return false;
    if (decision.remember) this.allowedFor(runId).add(call.command);
    return true;
  }

  private hooksFor(conversationId: string, runId: string, checks: CheckConfig[], workspaceRoot: string): RunHooks {
    // The checks the user approved for this run (saved for the folder, or chosen in the checks form).
    // Only these, and commands approved during the run, may run without asking; the same rule as outside the chat.
    const trusted = new Set(checks.map((c) => c.command));
    return {
      checks,
      wrapProvider: (task, provider) => this.agentProvider(provider, runId, task.id),
      inbox: (taskId) => this.drainInbox(runId, taskId),
      askCoordinator: (task, question, signal) => this.consultCoordinator(conversationId, runId, task, question, signal),
      reviewResult: (task, summary, drafts, signal, skip) => this.reviewResult(conversationId, runId, task, summary, drafts, signal, skip),
      attach: (control) => {
        const s = this.supervised.get(runId);
        if (s) s.control = control;
        if (s && control.maxTurns) s.monitor = new AgentMonitor({ maxTurns: control.maxTurns });
      },
      askUser: async (task, question) => {
        const { decision } = await this.waitFor(conversationId, {
          author: "agent",
          kind: "question",
          runId,
          taskId: task.id,
          agentName: task.title,
          text: question,
        });
        return decision?.kind === "answer" ? decision.text : "The user did not answer. Make a reasonable choice and say which in your summary.";
      },
      approveTool: async (task, reason, call, preview) => {
        if (call.tool === "run_command") return this.approveAgentCommand(conversationId, runId, task, call);
        if (isAutoApproved(call, this.host.permissions())) {
          // "Run commands" is on: the user has given this authority for commands sub-agents request.
          if (call.tool === "request_check") this.allowedFor(runId).add(call.command);
          await this.append(conversationId, {
            author: "system",
            runId,
            taskId: task.id,
            text: `Auto-approved for "${task.title}": ${call.tool === "request_check" ? `run \`${call.command}\`` : reason}`,
          });
          return true;
        }
        const isCommand = call.tool === "request_check";
        const { decision } = await this.waitFor(conversationId, {
          author: "agent",
          kind: "approval",
          runId,
          taskId: task.id,
          agentName: task.title,
          rememberable: isCommand,
          rememberLabel: isCommand ? "Allow, and keep it for this folder" : undefined,
          preview,
          text: isCommand
            ? `I'd like to run \`${call.command}\` as check "${call.name}". ${call.reason} Nothing runs until you allow it. It starts in the project folder, but like any command it runs as you and can read files elsewhere or use the network, so only allow it if you trust it.`
            : `${reason}. Nothing is written until you allow it.`,
        });
        if (decision?.kind !== "allow") return false;
        if (decision.remember && isCommand) {
          const info = await this.host.checksFor(workspaceRoot);
          const base = (info.saved ?? info.defaults).filter((c) => c.name !== call.name);
          await this.host.saveChecks(workspaceRoot, [...base, { name: call.name, command: call.command }]);
          this.allowedFor(runId).add(call.command);
        }
        return true;
      },
      onChanges: async (task, changes) => {
        const auto = this.host.permissions();
        // Nobody checked this result although a review was due: the user decides, whatever the switches say.
        const outcome = this.reviewOutcomes.get(`${runId}:${task.id}`);
        const held = isUnreviewed(outcome) ? changes.filter((ch) => isChangeAutoAccepted(ch.path, auto)).length : 0;
        const written: string[] = [];
        for (const ch of changes) {
          if (held || !isChangeAutoAccepted(ch.path, auto)) continue;
          const res = await acceptChange(this.tasks, runId, ch.path, workspaceRoot, { auto: true });
          if (res.ok) written.push(ch.path);
          else this.changeNotes.set(`${runId}:${ch.path}`, res.message);
        }
        const waiting = changes.filter((ch) => !written.includes(ch.path));
        await this.append(conversationId, {
          author: "agent",
          kind: "review",
          runId,
          taskId: task.id,
          agentName: task.title,
          tone: waiting.length ? "warning" : "success",
          text: waiting.length
            ? `I have ${waiting.length} draft change(s) for you to review under Drafts. Nothing is written to your project until you accept.${written.length ? ` ${written.length} other change(s) were accepted and written right away because an auto-approve switch is on.` : ""}${held ? " My result did not pass the coordinator's review, so they were not written automatically even though an auto-approve switch is on." : ""}`
            : `My ${written.length} change(s) were written to your project, because an auto-approve switch is on.`,
        });
        // Open what waits for review, so the user sees it right away.
        for (const ch of waiting.slice(0, 3)) await this.host.showChange(runId, ch.path).catch((err) => this.host.log("warn", (err as Error).message));
      },
      approveCommand: async (task, check) => {
        if (isCheckAutoApproved(this.host.permissions().commands, trusted, check.command) || this.allowedFor(runId).has(check.command)) return true;
        const { decision } = await this.waitFor(conversationId, {
          author: "agent",
          kind: "approval",
          runId,
          taskId: task.id,
          agentName: task.title,
          rememberable: true,
          rememberLabel: "Allow for the rest of this run",
          text: `I'd like to run \`${check.command}\` (check "${check.name}") to verify my work. It starts in the project folder, but like any command it runs as you and can read files elsewhere or use the network, so only allow it if you trust it. Turn on "Run commands" to stop being asked.`,
        });
        if (decision?.kind !== "allow") return false;
        if (decision.remember) this.allowedFor(runId).add(check.command);
        return true;
      },
    };
  }

  /**
   * The checks for a run. If the user has not chosen checks for this folder
   * yet, proposes the defaults plus what the project's files suggest and
   * waits for approval. Resolves undefined if the user stopped.
   */
  private async chooseChecks(conversationId: string, workspaceRoot: string, force = false): Promise<CheckConfig[] | undefined> {
    const info = await this.host.checksFor(workspaceRoot);
    if (info.saved && !force) {
      await this.append(conversationId, {
        author: "coordinator",
        kind: "checks",
        checks: info.saved,
        decided: "Saved for this folder",
        text: info.saved.length ? "Using the checks saved for this folder to verify the sub-agents' work." : "No checks are saved for this folder, so only the sub-agents' own requested checks will verify their work.",
      });
      return info.saved;
    }
    const proposed: CheckConfig[] = [...(info.saved ?? info.defaults)];
    for (const d of info.detected) if (!proposed.some((c) => c.name === d.name)) proposed.push(d);
    if (proposed.length === 0 && !force) {
      // Nothing to propose: don't stop the user with an empty form. Sub-agents can still request a check if their work needs one.
      await this.append(conversationId, {
        author: "system",
        text: "No test, lint or type-check commands were found for this project, so the run starts without checks. Use the beaker button to add some.",
        tone: "warning",
      });
      return [];
    }
    const { decision } = await this.waitFor(conversationId, {
      author: "coordinator",
      kind: "checks",
      checks: proposed,
      text: proposed.length
        ? "These commands will verify the sub-agents' work. Edit, add or remove them, then press Use these checks. Sub-agents can also ask you for more checks while they work."
        : "I found no test, lint or type-check commands for this project. Add the ones you use, or run without checks. Sub-agents can also ask you for checks while they work.",
    });
    if (!decision || (decision.kind !== "checks" && decision.kind !== "skip")) return undefined;
    const entered = decision.kind === "checks" ? decision.checks.filter((c) => c.name.trim() && c.command.trim()) : [];
    const refused = entered.filter((c) => commandLeavesProject(c.command));
    const checks = entered.filter((c) => !refused.includes(c));
    for (const c of refused) {
      await this.append(conversationId, {
        author: "system",
        tone: "warning",
        text: `The check "${c.name}" (\`${c.command}\`) was left out: ${commandLeavesProject(c.command)}`,
      });
    }
    if (decision.kind === "checks" && decision.remember) await this.host.saveChecks(workspaceRoot, checks);
    return checks;
  }

  /** Lets the user review and change the checks saved for the current conversation's folder. */
  async editChecks(): Promise<void> {
    if (this.busy || !this.currentId) return;
    const c = await this.conversations.load(this.currentId);
    this.busy = "Waiting for you to choose the checks…";
    this.changed();
    try {
      await this.chooseChecks(c.id, c.workspaceRoot, true);
    } finally {
      this.busy = undefined;
      this.stopping = false;
      this.changed();
    }
  }

  private async pendingPlan(c: Conversation): Promise<Run | undefined> {
    const runId = c.runIds.at(-1);
    const run = runId ? await this.tasks.load(runId).catch(() => undefined) : undefined;
    return run && isUnstarted(run) ? run : undefined;
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
    if (this.currentId) root = (await this.conversations.load(this.currentId)).workspaceRoot;
    else root = this.attachRoot ?? (await this.host.pickWorkspace());
    if (!root) return [];
    if (!this.currentId) this.attachRoot = root;
    return this.host.pickFiles(root);
  }

  /** Handles one message from the user: the coordinator answers, and may plan or run. */
  async send(text: string, attachments: string[] = []): Promise<void> {
    if (!text.trim() || this.busy) return;
    await this.ready;
    if (attachments.length) text = `${text.trim()}\n\nAttached files: ${[...new Set(attachments)].join(", ")}`;
    let c: Conversation;
    if (this.currentId) {
      c = await this.conversations.load(this.currentId);
    } else {
      const root = this.attachRoot ?? (await this.host.pickWorkspace());
      this.attachRoot = undefined;
      if (!root) return;
      c = await this.conversations.create(root, this.mode, title(text));
      this.currentId = c.id;
    }
    // A new prompt: the bar goes away until this one is dealt with.
    this.done = undefined;
    // Talking to the coordinator again ends any reopened sub-agent conversation, so it hears what came up first.
    await this.endFollowUpsOf(c.id);
    await this.append(c.id, { author: "user", text: text.trim() });
    await this.respond(c, text);
  }

  /**
   * The "End chat and update coordinator" button for a sub-agent whose run is
   * not finished (for example a failed task the user retried in the chat):
   * the update is a new turn for the coordinator, which picks the original
   * request up again and plans what is still left.
   */
  private async continueAfterFollowUp(conversationId: string, runId: string, taskId: string): Promise<void> {
    const run = await this.tasks.load(runId).catch(() => undefined);
    const task = run?.tasks.find((t) => t.id === taskId);
    if (!run || !task || run.kind === "research") return;
    const unfinished = run.tasks.filter((t) => t.status !== "done");
    if (unfinished.length === 0) return;
    if (this.busy) {
      await this.append(conversationId, { author: "system", runId, tone: "warning", text: "The coordinator got the update but is busy with another prompt, so it did not continue the task. Ask it to continue when it is done." });
      return;
    }
    const c = await this.conversations.load(conversationId);
    const update = c.entries.filter((e) => e.runId === runId && e.taskId === taskId && e.tag === "update from follow-up").at(-1)?.text ?? "";
    await this.append(conversationId, { author: "system", runId, text: `Continuing "${run.request.slice(0, 200)}" with the update from "${task.title}".` });
    const status = unfinished.map((t) => `- "${t.title}": ${t.status.replace("_", " ")}`).join("\n");
    const continuation = [
      `The user talked with sub-agent "${task.title}" again after the run, then ended that chat and asked you to continue the original request with what came out of it.`,
      `The original request: ${run.request}`,
      `Tasks of that run that are not done:\n${status}`,
      // Written by a sub-agent that read project files: data, not instructions.
      untrustedSection(`The update from "${task.title}":`, `update from sub-agent "${task.title}" after a follow-up chat`, update || "(no update)"),
      "Continue the original request from where it stands now. Plan only what is still left to do (drafts waiting for review are already done), or answer if nothing is left. Do not plan work that is already done.",
    ].join("\n\n");
    await this.respond(await this.conversations.load(conversationId), run.request, continuation);
  }

  /** The coordinator's turn on a message: answer, research, plan or run. `continuation` replaces a new user message. */
  private async respond(c: Conversation, text: string, continuation?: string): Promise<void> {
    this.done = undefined;
    const waiting = !continuation && isGoAhead(text) ? await this.pendingPlan(await this.conversations.load(c.id)) : undefined;
    if (waiting && this.runOwner.has(waiting.id)) {
      // "go" with a plan waiting is the same as pressing Run it. No model call, nothing to misread.
      await this.append(c.id, { author: "coordinator", text: this.mode === "act" ? "Starting the plan." : "Starting the plan. This switches the chat to Act mode." });
      await this.runPlan(waiting.id);
      return;
    }

    const abort = new AbortController();
    this.abort = abort;
    this.busy = "Coordinator is thinking…";
    this.changed();
    let startRun: string | undefined;
    let ended: DoneBar = { status: "finished", text: "Finished" };
    // Every research round of this message, and the coordinator's last reply when it chose to answer.
    // Unless a plan follows, the prompt always ends with one answer that combines all the reports.
    const researchRuns: string[] = [];
    let planned = false;
    let draft: { reply: string; thought?: string; thinking?: string } | undefined;
    let limitReached = false;
    try {
      c = await this.conversations.load(c.id);
      const provider = this.coordinatorProvider(c.workspaceRoot);
      this.host.log("info", `Coordinator using ${this.host.modelLabel(c.workspaceRoot)}`);
      const fileTree = await this.host.fileTree(c.workspaceRoot, abort.signal).catch(() => undefined);
      const pending = await this.pendingPlan(c);
      const turn = await coordinatorTurn(
        provider,
        {
          mode: this.mode,
          entries: c.entries,
          fileTree,
          pendingPlan: pending && describePlan(pending),
          maxResearchers: this.host.delegationLimits().maxResearchers,
          historyTokens: this.host.coordinatorHistoryTokens?.(),
          continuation,
        },
        { signal: abort.signal, onAttempt: (n, err) => n > 0 && this.host.log("warn", `Coordinator retry ${n}: ${err}`) },
      );
      this.host.log(
        "info",
        `Coordinator (${this.mode} mode) chose "${turn.modelAction ?? turn.action}"${turn.modelAction && turn.modelAction !== turn.action ? `, changed to "${turn.action}"` : ""}. Message looks read-only: ${isReadOnlyRequest(text) ? "yes" : "no"}.`,
      );
      await this.append(c.id, { author: "coordinator", text: turn.reply, thought: turn.thought || undefined, thinking: clip(turn.thinking) });
      if (turn.overridden) await this.append(c.id, { author: "system", text: turn.overridden, tone: "warning" });

      // Research can take several rounds: a broad first look, then narrower researchers
      // (for example one per file) when the reports are too general to answer from.
      const maxRounds = researchRoundLimit(this.host.delegationLimits().maxResearchRounds);
      let round = 0;
      const doResearch = async (t: CoordinatorResult): Promise<void> => {
        round++;
        researchRuns.push(await this.research(c, t, abort.signal, round > 1 ? learnedSoFar(c.entries) : undefined));
        c = await this.conversations.load(c.id);
        this.busy = "Coordinator is reading the reports…";
        this.runningRunId = undefined;
        this.changed();
        let answer: CoordinatorResult;
        try {
          answer = await coordinatorTurn(
            provider,
            {
              mode: this.mode,
              entries: c.entries,
              fileTree,
              answerFromResearch: true,
              researchRoundsLeft: maxRounds - round,
              maxResearchers: this.host.delegationLimits().maxResearchers,
              historyTokens: this.host.coordinatorHistoryTokens?.(),
            },
            { signal: abort.signal, onAttempt: (n, err) => n > 0 && this.host.log("warn", `Coordinator retry ${n}: ${err}`) },
          );
        } catch (err) {
          // A small model that fails the JSON turn after research must not cost the user the answer:
          // the reports are there, so the answer is written from them below.
          if (abort.signal.aborted) throw err;
          this.host.log("warn", `The coordinator's reply after research round ${round} failed (${(err as Error).message}). Writing the answer from the reports instead.`);
          return;
        }
        this.host.log(
          "info",
          `Coordinator after research round ${round} of ${maxRounds} chose "${answer.modelAction ?? answer.action}"${answer.modelAction && answer.modelAction !== answer.action ? `, changed to "${answer.action}"` : ""}.`,
        );
        if (answer.action === "plan" || answer.action === "research") {
          await this.append(c.id, { author: "coordinator", text: answer.reply, thought: answer.thought || undefined, thinking: clip(answer.thinking) });
        }
        // The user asked for a change: the research was the first step, the plan is the next.
        if (answer.action === "plan") await makePlan(answer, true);
        // The reports were too general: send narrower researchers.
        else if (answer.action === "research") await doResearch(answer);
        else {
          // The coordinator's reply is only a draft: the answer combining every report is written below.
          draft = { reply: answer.reply, thought: answer.thought || undefined, thinking: clip(answer.thinking) };
          if (!answer.researchLimitReached) return;
          limitReached = true;
          await this.append(c.id, {
            author: "system",
            tone: "warning",
            text: `The coordinator wanted to dig deeper, but this message already used ${maxRounds} research round(s), so no more sub-agents were sent. Ask again to continue from what was found, or raise agentic.delegation.maxResearchRounds.`,
          });
        }
      };

      const makePlan = async (t: CoordinatorResult, afterResearch: boolean): Promise<void> => {
        this.busy = "Coordinator is splitting the work into sub-agent tasks…";
        this.changed();
        let planThinking: string | undefined;
        c = await this.conversations.load(c.id);
        const learned = learnedSoFar(c.entries);
        const result = await planRequest(
          provider,
          { request: t.request, fileTree, learned, maxTasks: this.host.delegationLimits().maxTasks },
          {
            signal: abort.signal,
            onAttempt: (n, err) => n > 0 && this.host.log("warn", `Plan retry ${n}: ${err}`),
            onThinking: (x) => (planThinking = x),
          },
        );
        const editing = result.plan.tasks.map(editingReason).find((r) => r !== undefined);
        if (editing) this.host.log("info", `Plan kept as a change plan because ${editing}.`);
        if (isReadOnlyPlan(result.plan.tasks)) {
          if (afterResearch && round >= maxRounds) {
            // Every research round for this message is used; reading again would only loop.
            await this.append(c.id, { author: "system", tone: "warning", text: "The plan only read files, which the research already did, so nothing was started. Say what should change, for example which file to edit." });
            limitReached = true;
            return;
          }
          // Every task only reads: that is research, which needs no Act mode and changes nothing.
          await this.append(c.id, {
            author: "system",
            tone: "warning",
            text: "These tasks only read the project, so they run now as read-only sub-agents instead of a plan. Nothing will be changed, and Plan mode is fine.",
          });
          // Tasks that only combine others' findings are left out: the coordinator combines the reports itself.
          const own = result.plan.tasks.filter((x) => x.dependsOn.length === 0);
          const questions = (own.length ? own : result.plan.tasks).map((x) => `${x.title}: ${x.instructions} (Start with: ${x.fileScope.join(", ")})`.slice(0, 500));
          await doResearch({ ...t, action: "research", request: "", questions });
          return;
        }
        const run = await this.tasks.createRun(t.request, c.workspaceRoot, undefined, learned);
        planned = true;
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
          thinking: clip(planThinking),
          text:
            this.mode === "act"
              ? `Plan: ${n} task(s), each for one sub-agent. Starting now.`
              : `Proposed plan: ${n} task(s), each for one sub-agent. Press "Run it" (or say "go") to start, or tell me what to change.`,
        });
        if (result.droppedContext.length) this.host.log("warn", `Left out of the plan prompt: ${result.droppedContext.join(", ")}`);
        if (this.mode === "act") startRun = run.id;
      };

      if (turn.action === "plan") {
        await makePlan(turn, false);
      } else if (turn.action === "run" && pending) {
        startRun = pending.id;
      } else if (turn.action === "research") {
        await doResearch(turn);
      }
      if (researchRuns.length && !planned) {
        // Before the answer goes out, the coordinator checks that it answers the question, and sends
        // researchers after what is still open while research rounds are left.
        const limits = this.host.delegationLimits();
        // Extra research rounds the check may start (agentic.delegation.verifyRounds), within the research round limit.
        let moreRounds = verifyRoundLimit(limits.verifyRounds);
        for (;;) {
          const review = limits.verify ? (answer: string) => this.checkResearchAnswer(c.workspaceRoot, text, answer, abort.signal) : undefined;
          const open = await this.answerFromReports(c, text, researchRuns, draft, limitReached, abort.signal, review, moreRounds > 0 && round < maxRounds);
          if (!open) break;
          moreRounds--;
          await this.append(c.id, {
            author: "coordinator",
            tag: "not verified",
            tone: "warning",
            text: `I checked my answer against your question, and it does not cover everything yet. Sending researchers after what is still open:\n${open.map((q) => `- ${q}`).join("\n")}`,
          });
          round++;
          researchRuns.push(await this.research(c, { ...turn, action: "research", request: "", questions: open }, abort.signal, learnedSoFar(c.entries)));
          c = await this.conversations.load(c.id);
        }
      }
    } catch (err) {
      const message = abort.signal.aborted ? "Stopped." : (err as Error).message;
      ended = abort.signal.aborted ? { status: "stopped", text: "Stopped" } : { status: "failed", text: "Failed. See the message above." };
      this.host.log("error", message);
      await this.append(c.id, { author: "system", kind: "error", text: message, tone: abort.signal.aborted ? "warning" : "error" });
      // Research that finished before the failure still answers the question.
      if (!abort.signal.aborted && researchRuns.length && !planned) {
        await this.answerFromReports(c, text, researchRuns, draft, limitReached, abort.signal).catch((e) => this.host.log("warn", `Could not answer from the reports: ${(e as Error).message}`));
      }
    } finally {
      this.abort = undefined;
      this.busy = undefined;
      this.runningRunId = undefined;
      if (abort.signal.aborted) startRun = undefined;
      this.stopping = false;
      // A plan that starts now is still part of this prompt; runPlan shows the bar when it ends.
      if (!startRun) this.done = { ...ended, time: new Date().toISOString(), conversationId: c.id };
      this.changed();
    }
    if (startRun) await this.runPlan(startRun);
  }

  /**
   * Starts a proposed plan. Running only happens in Act mode; pressing Run in
   * Plan mode is the user switching to Act mode for this conversation.
   */
  async runPlan(runId: string): Promise<void> {
    const conversationId = this.runOwner.get(runId);
    if (!conversationId) return;
    if (this.busy) {
      // Never ignored without a word: the button looks like it did nothing otherwise.
      await this.append(conversationId, { author: "system", tone: "warning", text: `The plan was not started because the chat is busy (${this.busy.replace(/…$/, "")}). Press "Run it" again when it is done.` });
      return;
    }
    const run = await this.tasks.load(runId);
    if (!isUnstarted(run)) {
      if (resumeState(run, process.pid)) return this.resumeRun(runId);
      await this.append(conversationId, { author: "system", text: "That plan has already run. Retry tasks from the Tasks view.", tone: "warning" });
      return;
    }
    await this.startRun(conversationId, run, false);
  }

  /**
   * Continues a run that VS Code closed under, or that was stopped: the
   * stopped sub-agents pick up their own conversation and drafts where they
   * were, tasks that never started start now, and done tasks and every draft
   * stay as they are. The user approves the checks again, as for any run.
   */
  async resumeRun(runId: string): Promise<void> {
    await this.ready;
    const conversationId = this.runOwner.get(runId);
    if (!conversationId) return;
    if (this.busy) {
      await this.append(conversationId, { author: "system", tone: "warning", text: `The run was not resumed because the chat is busy (${this.busy.replace(/…$/, "")}). Press "Resume" again when it is done.` });
      return;
    }
    const run = await this.tasks.load(runId);
    const state = resumeState(run, process.pid);
    if (state === "elsewhere") {
      await this.append(conversationId, { author: "system", tone: "warning", text: "This run is still working in another VS Code window, so it was not resumed here." });
      return;
    }
    if (!state) {
      await this.append(conversationId, { author: "system", tone: "warning", text: "There is nothing left to resume in that run." });
      return;
    }
    if (this.currentId !== conversationId) {
      this.currentId = conversationId;
      this.mode = (await this.conversations.load(conversationId)).mode;
    }
    await this.startRun(conversationId, run, true);
  }

  /** Runs a plan's sub-agents, or resumes the ones left, then verifies and reports. */
  private async startRun(conversationId: string, run: Run, resume: boolean): Promise<void> {
    const runId = run.id;
    if (this.mode !== "act") await this.setMode("act");
    // The plan's sub-agents may work on the same files; reopened conversations pass on what they found first.
    await this.endFollowUpsOf(conversationId);

    this.busy = "Waiting for you to approve the checks…";
    this.runningRunId = runId;
    this.done = undefined;
    this.changed();
    let ended: DoneBar = { status: "stopped", text: "The run was not started" };
    try {
      const workspaceRoot = run.workspaceRoot ?? (await this.conversations.load(conversationId)).workspaceRoot;
      const checks = await this.chooseChecks(conversationId, workspaceRoot);
      if (!checks) {
        await this.append(conversationId, { author: "system", text: "The run was not started.", tone: "warning" });
        return;
      }
      if (resume) {
        // Checked again: the user may have answered the checks card after something else changed the run.
        const left = resumableTasks(await this.tasks.load(runId));
        if (left.length === 0 || resumeState(await this.tasks.load(runId), process.pid) === "elsewhere") {
          await this.append(conversationId, { author: "system", text: "There is nothing left to resume in that run.", tone: "warning" });
          return;
        }
        const again = await this.tasks.prepareResume(runId);
        const current = await this.tasks.load(runId);
        const done = current.tasks.filter((t) => t.status === "done").length;
        const drafts = (current.changes ?? []).filter((c) => c.status === "pending").length;
        this.busy = `Sub-agents are working on ${left.length} task(s) left…`;
        this.changed();
        await this.append(conversationId, {
          author: "coordinator",
          runId,
          tag: "resumed",
          text: [
            `Resuming "${clipLine(run.request, 200)}": ${plural(left.length, "task")} left, ${done} of ${current.tasks.length} already done.`,
            again.length ? `Sub-agents that were cut off continue from their last step with their own drafts.` : "",
            drafts ? `${plural(drafts, "draft")} from before stay under Drafts for your review.` : "",
            "Each may only change its own files, and you review every change before it is written.",
          ].filter(Boolean).join(" "),
        });
      } else {
        this.busy = `Sub-agents are working on ${run.tasks.length} task(s)…`;
        this.changed();
        await this.append(conversationId, {
          author: "coordinator",
          text: `Starting sub-agents for ${run.tasks.length} task(s). Each may only change its own files, and you review every change before it is written.`,
        });
      }
      this.supervise(runId, conversationId, this.host.researchLimits().maxTurns);
      const hooks = this.hooksFor(conversationId, runId, checks, workspaceRoot);
      let outcome = await this.host.runPlan(runId, hooks);
      // Let sub-agent messages that are still queued land before the summary.
      await this.eventQueue.run(async () => {});
      if (!outcome) {
        await this.append(conversationId, { author: "system", text: "The run was not started.", tone: "warning" });
        return;
      }
      // A sub-agent saying "done" is not the end: the coordinator verifies the request and sends sub-agents back for what is left.
      let verification: Verification | undefined;
      if (!this.stopping) ({ outcome, verification } = await this.verifyUntilDone(conversationId, workspaceRoot, runId, hooks, outcome));
      const ok = outcome.failed.length === 0 && outcome.blocked.length === 0;
      const finished = await this.tasks.load(runId);
      const waitingReview = (finished.changes ?? []).filter((ch) => ch.status === "pending").length;
      // The bar's live detail line counts the drafts; a count frozen in here would go stale after Accept.
      const review = waitingReview ? " Drafts are waiting for your review." : "";
      const notDone = outcome.failed.length + outcome.blocked.length;
      ended = this.stopping
        ? { status: "stopped", text: `Stopped.${review}` }
        : verification
          ? verification.verified
            ? { status: "finished", text: `Finished and verified.${review}` }
            : { status: "partial", text: `Finished, but not verified${verification.missing.length ? `: ${verification.missing.length} thing(s) still left` : ""}.${review}` }
          : ok
            ? { status: "finished", text: `Finished.${review}` }
            : { status: "partial", text: `Finished, but ${notDone} of ${finished.tasks.length} task(s) did not complete.${review}` };
      await this.append(conversationId, {
        author: "coordinator",
        kind: "outcome",
        runId,
        tone: ok ? "success" : "warning",
        text: describeOutcome(finished, outcome, this.stopping),
        outcome: { changedFiles: changedFilesOf(finished), failed: outcome.failed.length + outcome.blocked.length },
      });
      // The outcome lists what happened; the coordinator's own reply says what it means. A stop skips it.
      if (!this.stopping) await this.answerFromRun(conversationId, workspaceRoot, finished, outcome, verification);
    } catch (err) {
      this.host.log("error", (err as Error).message);
      ended = { status: "failed", text: "Failed. See the message above." };
      await this.append(conversationId, { author: "system", kind: "error", text: (err as Error).message, tone: "error" });
    } finally {
      this.endSupervision(runId);
      this.runningRunId = undefined;
      this.busy = undefined;
      this.stopping = false;
      this.done = { ...ended, time: new Date().toISOString(), conversationId };
      this.changed();
    }
  }

  /**
   * Sends read-only sub-agents to answer the coordinator's questions about the
   * project. They read the open folder directly and their file scope is
   * empty, so the policy refuses every write.
   */
  /** One research round. `learned` is what earlier rounds found, so follow-up researchers build on it. */
  private async research(c: Conversation, turn: CoordinatorResult, signal: AbortSignal, learned?: string): Promise<string> {
    const root = await this.host.openFolder(c.workspaceRoot);
    if (!root) throw new Error(`${c.workspaceRoot} is not open in VS Code, so the sub-agents cannot read it.`);
    const questions = researchQuestions(turn, this.host.delegationLimits().maxResearchers);
    const run = await this.tasks.createRun(turn.request.trim() || questions.join(" "), c.workspaceRoot, "research");
    this.runOwner.set(run.id, c.id);
    await this.conversations.update(c.id, (x) => x.runIds.push(run.id));
    const added = await this.tasks.addTasks(
      run.id,
      questions.map((q, i) => ({ id: `research-${i + 1}`, title: title(q), instructions: q, fileScope: [] })),
    );
    await this.append(c.id, {
      author: "coordinator",
      kind: "research",
      runId: run.id,
      text: `Sending ${added.length} read-only sub-agent(s) to look into the project. They can read files and run commands in a copy of the project, but not change anything.`,
    });
    this.busy = `${added.length} read-only sub-agent(s) are researching…`;
    this.runningRunId = run.id;
    this.changed();

    const sandbox = await WorkspaceSandbox.create(root);
    const { maxTurns, maxParallel } = this.host.researchLimits();
    const terminal = this.host.terminal?.(c.workspaceRoot);
    // Researchers' commands run in their own copy of the project, made when the first one runs.
    const scratches: ScratchCopy[] = [];
    const provider = this.host.provider(c.workspaceRoot);
    const queue = [...added];
    this.supervise(run.id, c.id, maxTurns);
    const workerLoop = async () => {
      for (let task = queue.shift(); task; task = queue.shift()) {
        if (signal.aborted) {
          await this.tasks.setStatus(run.id, task.id, "cancelled", "Stopped");
          continue;
        }
        await this.tasks.setStatus(run.id, task.id, "running");
        let worker: Worker | undefined;
        // Nothing is copied until the first command runs.
        const scratch = new ScratchCopy(root, path.join(root, AGENT_DIR, "scratch", `research-${run.id.slice(0, 8)}`, task.id), ["node_modules"]);
        scratches.push(scratch);
        try {
          worker = new Worker({
            provider: this.agentProvider(provider, run.id, task.id),
            sandbox,
            task,
            checks: [],
            maxTurns,
            signal,
            readOnly: true,
            terminal,
            checkDir: () => scratch.sync(new Map()),
            context: learned ? untrustedSection("What earlier researchers found (build on it, do not repeat it):", "earlier research and sub-agent reports", learned) : undefined,
            // Only commands reach this: a researcher's empty file scope refuses every write.
            approve: async (_reason, call) => call.tool === "run_command" && (await this.approveAgentCommand(c.id, run.id, task!, call)),
            inbox: () => this.drainInbox(run.id, task!.id),
            askCoordinator: (q) => this.consultCoordinator(c.id, run.id, task!, q, signal),
            reviewResult: (summary, skip) => this.reviewResult(c.id, run.id, task!, summary, "", signal, skip),
            log: (type, message, data) => void this.tasks.log({ runId: run.id, taskId: task!.id, type, message, data }),
          });
          const result = await worker.run();
          await this.tasks.updateTask(run.id, task.id, { summary: result.summary, changedFiles: [] });
          await this.tasks.saveHistory(run.id, task.id, worker.history()).catch(() => undefined);
          worker = undefined;
          await this.tasks.setStatus(run.id, task.id, "done");
        } catch (err) {
          const stopped = signal.aborted;
          await this.tasks.setStatus(run.id, task.id, stopped ? "cancelled" : "failed", stopped ? "Stopped" : (err as Error).message);
          if (!stopped) await this.tasks.log({ runId: run.id, taskId: task.id, type: "task_failed", message: (err as Error).message });
        }
        // Kept so the user can reopen this researcher later.
        if (worker) await this.tasks.saveHistory(run.id, task.id, worker.history()).catch(() => undefined);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(maxParallel, added.length)) }, workerLoop)).finally(async () => {
      this.endSupervision(run.id);
      for (const scratch of scratches) await scratch.remove().catch(() => undefined);
      await fs.rmdir(path.join(root, AGENT_DIR, "scratch", `research-${run.id.slice(0, 8)}`)).catch(() => undefined);
    });
    // Let queued sub-agent messages land before the summary.
    await this.eventQueue.run(async () => {});
    signal.throwIfAborted();
    await this.append(c.id, { author: "coordinator", runId: run.id, text: `Research finished.${await this.reports(run.id)}` });
    return run.id;
  }

  /**
   * The guaranteed last step of research that ends in an answer: one model
   * call that combines every report from every round into a reply to the
   * user. Small models often end the JSON turn with "Research is done.", so
   * that reply is only used as a hint, and as the lead of the fallback.
   */
  private async answerFromReports(
    c: Conversation,
    question: string,
    runIds: string[],
    draft: { reply: string; thought?: string; thinking?: string } | undefined,
    limitReached: boolean,
    signal: AbortSignal,
    review?: (answer: string) => Promise<{ answered: boolean; missing: string[] } | undefined>,
    canResearchMore = false,
  ): Promise<string[] | undefined> {
    this.busy = "Coordinator is combining the reports into an answer…";
    this.changed();
    const reports: ResearchReport[] = [];
    for (const id of runIds) {
      const run = await this.tasks.load(id).catch(() => undefined);
      for (const t of run?.tasks ?? []) {
        reports.push({ title: t.title, status: t.status.replace("_", " "), text: t.summary ?? (t.error ? `No report: ${t.error}` : "") });
      }
    }
    const result = await synthesizeFindings(
      this.coordinatorProvider(c.workspaceRoot),
      { question, reports, draft: draft?.reply, limitReached },
      { signal, onError: (m) => this.host.log("warn", m) },
    );
    this.host.log("info", `Combined ${reports.length} research report(s) into the answer${result.fallback ? " without the model (it gave no usable summary)" : ""}.`);
    // The raw reports (fallback) are not checked: there is no answer to check, only the reports.
    let check: { answered: boolean; missing: string[] } | undefined;
    if (review && !result.fallback) {
      this.busy = "Coordinator is checking that the answer covers your question…";
      this.changed();
      check = await review(result.text);
      signal.throwIfAborted();
      if (check && !check.answered && check.missing.length && canResearchMore) return check.missing;
    }
    if (check) {
      await this.append(c.id, {
        author: "coordinator",
        tag: check.answered ? "verified" : "not verified",
        tone: check.answered ? "success" : "warning",
        text: check.answered
          ? "I checked the answer below against your question: it covers every part."
          : `I checked the answer below against your question, and it may not cover everything. No research rounds are left to look further. Still open:\n${check.missing.map((q) => `- ${q}`).join("\n")}`,
      });
    }
    if (result.suspicious.length) {
      const which = result.suspicious.map((n) => `"${reports[n - 1]!.title}"`).join(", ");
      this.host.log("warn", `Research report(s) ${which} contain text that reads like instructions to an AI (possible prompt injection from a project file).`);
      await this.append(c.id, {
        author: "system",
        tone: "warning",
        text: `The report from ${which} contains text that reads like orders to an AI, for example "ignore previous instructions". It may come from a file in the project that tries to steer the agents. It was treated as data, not followed, but check the answer below against the files yourself.`,
      });
    }
    await this.append(c.id, {
      author: "coordinator",
      kind: "answer",
      tag: "from research",
      text: result.text,
      thought: draft?.thought,
      thinking: clip(result.thinking ?? draft?.thinking),
    });
    return undefined;
  }

  /** Does the combined answer cover the question? Undefined when the check itself failed; the answer is then sent as it is. */
  private async checkResearchAnswer(workspaceRoot: string, question: string, answer: string, signal: AbortSignal): Promise<{ answered: boolean; missing: string[] } | undefined> {
    try {
      const res = await checkAnswer(this.coordinatorProvider(workspaceRoot), question, answer, { signal });
      this.host.log("info", `Checked the research answer: ${res.answered ? "it answers the question" : `still open: ${res.missing.join(" | ")}`}.`);
      return res;
    } catch (err) {
      if (signal.aborted) throw err;
      this.host.log("warn", `Could not check the research answer: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * The coordinator's final reply after a change run, so a finished run
   * always ends with an answer in words and not only the outcome list. If the
   * model gives nothing usable, the outcome above is the reply.
   */
  private async answerFromRun(conversationId: string, workspaceRoot: string, run: Run, outcome: RunOutcome, verification?: Verification): Promise<void> {
    this.busy = "Coordinator is writing its final reply…";
    // Stop ends this call too; the outcome above then stays the reply.
    const abort = new AbortController();
    this.abort = abort;
    this.changed();
    try {
      await this.writeRunReply(conversationId, workspaceRoot, run, outcome, abort.signal, verification);
    } catch (err) {
      if (!abort.signal.aborted) throw err;
    } finally {
      if (this.abort === abort) this.abort = undefined;
    }
  }

  private async writeRunReply(conversationId: string, workspaceRoot: string, run: Run, outcome: RunOutcome, signal: AbortSignal, verification?: Verification): Promise<void> {
    const c = await this.conversations.load(conversationId);
    const question = [...runScope(c.entries, run.id)].reverse().find((e) => e.author === "user" && e.kind !== "direct")?.text ?? run.request;
    const changes = run.changes ?? [];
    const of = (status: string) => [...new Set(changes.filter((ch) => ch.status === status).map((ch) => ch.path))];
    const result = await summarizeRun(
      this.coordinatorProvider(workspaceRoot),
      {
        question,
        request: run.request,
        tasks: run.tasks.map((t) => ({
          title: t.title,
          status: outcome.blocked.includes(t.id) ? "did not start" : t.status.replace("_", " "),
          text: t.summary ?? (t.error ? `No report: ${t.error}` : ""),
          files: [...new Set(changes.filter((ch) => ch.taskId === t.id).map((ch) => ch.path))],
        })),
        drafts: { pending: of("pending"), accepted: of("accepted"), rejected: of("rejected") },
        verification: verification && { verified: verification.verified, evidence: verification.evidence, summary: verification.summary, missing: verification.missing },
      },
      { signal, onError: (m) => this.host.log("warn", m) },
    );
    if (!result || signal.aborted) return;
    if (result.suspicious.length) {
      const which = result.suspicious.map((n) => `"${run.tasks[n - 1]!.title}"`).join(", ");
      await this.append(conversationId, {
        author: "system",
        tone: "warning",
        text: `The report from ${which} contains text that reads like orders to an AI. It was treated as data, not followed, but check the reply below against the drafts yourself.`,
      });
    }
    await this.append(conversationId, { author: "coordinator", kind: "answer", tag: "final reply", runId: run.id, text: result.text, thinking: clip(result.thinking) });
  }

  /**
   * The coordinator keeps going until it can verify the request is done.
   * After the sub-agents finish, it runs the approved checks on all drafts
   * together and reads the drafts against the request. If something is left,
   * it plans fix-up tasks for exactly that, runs them in the same run (so
   * they build on the drafts), and verifies again, at most
   * agentic.delegation.verifyRounds times. Every write and command still
   * needs the same approval as before, and drafts stay pending.
   */
  private async verifyUntilDone(
    conversationId: string,
    workspaceRoot: string,
    runId: string,
    hooks: RunHooks,
    first: RunOutcome,
  ): Promise<{ outcome: RunOutcome; verification?: Verification }> {
    const limits = this.host.delegationLimits();
    if (!limits.verify) return { outcome: first };
    const maxRounds = verifyRoundLimit(limits.verifyRounds);
    let outcome = first;
    let verification: Verification | undefined;
    // Tasks of the latest round: one of them not finishing means the request is not done.
    let latest = new Set((await this.tasks.load(runId)).tasks.map((t) => t.id));
    for (let round = 0; ; round++) {
      if (this.stopping) return { outcome, verification };
      const abort = new AbortController();
      this.abort = abort;
      this.runningRunId = undefined;
      try {
        verification = await this.verifyOnce(conversationId, workspaceRoot, runId, hooks.checks, latest, round, abort.signal);
        if (verification.verified) return { outcome, verification };
        if (round >= maxRounds) {
          await this.append(conversationId, {
            author: "coordinator",
            runId,
            tone: "warning",
            tag: "not verified",
            text: maxRounds
              ? `I sent sub-agents back ${maxRounds} time(s) and still cannot verify that the request is done, so I stopped here. Tell me how to go on, or raise agentic.delegation.verifyRounds to allow more rounds.`
              : "Fix-up rounds are off (agentic.delegation.verifyRounds is 0), so I did not send sub-agents back for what is left.",
          });
          return { outcome, verification };
        }
        if (verification.missing.length === 0) return { outcome, verification };
        if (this.budget.exhausted(runId)) {
          await this.append(conversationId, {
            author: "coordinator",
            runId,
            tone: "warning",
            tag: "not verified",
            text: "This run used its model-call limit (agentic.delegation.maxModelCallsPerRun), so I did not send sub-agents back for what is left. Raise the limit or tell me how to go on.",
          });
          return { outcome, verification };
        }
        const added = await this.planFixUp(conversationId, workspaceRoot, runId, verification, round + 1, abort.signal);
        if (added.length === 0) return { outcome, verification };
        latest = new Set(added.map((t) => t.id));
        await this.append(conversationId, {
          author: "coordinator",
          runId,
          tag: `fix-up ${round + 1} of ${maxRounds}`,
          text: `The work is not done yet, so I am sending ${added.length} sub-agent(s) back for what is left: ${added.map((t) => `"${t.title}"`).join(", ")}. They start from the drafts already made, and you still review every change.`,
        });
      } catch (err) {
        if (abort.signal.aborted || this.stopping) return { outcome, verification };
        throw err;
      } finally {
        if (this.abort === abort) this.abort = undefined;
      }
      this.busy = `Sub-agents are working on what is left (fix-up round ${round + 1})…`;
      this.runningRunId = runId;
      this.changed();
      outcome = (await this.host.runPlan(runId, hooks)) ?? outcome;
      await this.eventQueue.run(async () => {});
    }
  }

  /** One verification: the checks on all drafts together, then one model call. The result is shown in the chat. */
  private async verifyOnce(
    conversationId: string,
    workspaceRoot: string,
    runId: string,
    checks: CheckConfig[],
    latest: ReadonlySet<string>,
    round: number,
    signal: AbortSignal,
  ): Promise<Verification> {
    this.busy = "Coordinator is verifying the work…";
    this.changed();
    await this.append(conversationId, {
      author: "coordinator",
      runId,
      tag: "verifying",
      text: checks.length
        ? `Verifying the work before I call it done: running ${checks.length} check(s) on a copy of the project with all drafts together, then reading the drafts against your request.`
        : "Verifying the work before I call it done: reading the drafts against your request. No checks are set up for this project, so nothing is run.",
    });
    const results = await this.runVerifyChecks(conversationId, workspaceRoot, runId, checks, signal);
    signal.throwIfAborted();
    const run = await this.tasks.load(runId);
    const c = await this.conversations.load(conversationId);
    const tasks: VerifyTask[] = run.tasks.map((t) => {
      const notStarted = t.status === "pending";
      return {
        title: t.title,
        status: notStarted ? "did not start" : t.status.replace("_", " "),
        summary: t.summary ?? (t.error ? `No report: ${t.error}` : ""),
        unfinished: latest.has(t.id) && t.status !== "done" ? (notStarted ? "a task it depends on did not finish" : (t.error ?? t.status)) : undefined,
      };
    });
    // The newest draft of each file that is not rejected: what the user would get.
    const newest = new Map<string, PendingChange>();
    for (const ch of run.changes ?? []) if (ch.status !== "rejected") newest.set(ch.path, ch);
    const ctx = {
      userMessages: userMessagesOf(runScope(c.entries, runId)),
      request: run.request,
      tasks,
      drafts: draftsForReview([...newest.values()]),
      checks: results,
      round,
    };
    let v: Verification;
    try {
      // Counted against the run's model-call budget, like every other coordinator call about its sub-agents.
      v = await verifyRun(this.coordinatorProvider(workspaceRoot, runId), ctx, { signal });
    } catch (err) {
      if (signal.aborted) throw err;
      this.host.log("warn", `The coordinator could not verify the run: ${(err as Error).message}`);
      v = factsOnlyVerification(ctx, "the model call failed");
    }
    signal.throwIfAborted();
    this.host.log("info", `Verification ${round + 1}: ${v.verified ? "verified" : "not verified"}.${v.adjusted ? ` ${v.adjusted}` : ""}`);
    const left = v.missing.length ? `\n\nStill left:\n${v.missing.map((m) => `- ${m}`).join("\n")}` : "";
    await this.append(conversationId, {
      author: "coordinator",
      runId,
      tag: v.verified ? "verified" : "not verified",
      tone: v.verified ? "success" : "warning",
      text: `${v.verified ? "Verified: the request is done." : "Not verified yet."} ${v.evidence}${v.summary ? ` ${v.summary}` : ""}${left}`,
      thought: v.thought,
      thinking: clip(v.thinking),
    });
    return v;
  }

  /**
   * The run's approved checks, on a scratch copy of the project with every
   * pending draft of the run written in. Accepted drafts are already on disk.
   * Each one needs the same approval as a sub-agent's check.
   */
  private async runVerifyChecks(conversationId: string, workspaceRoot: string, runId: string, checks: CheckConfig[], signal: AbortSignal): Promise<CheckResult[]> {
    if (checks.length === 0) return [];
    const root = await this.host.openFolder(workspaceRoot);
    if (!root) throw new Error(`${workspaceRoot} is not open in VS Code, so the work cannot be verified.`);
    const run = await this.tasks.load(runId);
    const scratch = new ScratchCopy(root, path.join(root, AGENT_DIR, "scratch", `verify-${runId.slice(0, 8)}`), this.host.scratchLinkDirs?.(workspaceRoot) ?? ["node_modules"]);
    const trusted = new Set(checks.map((c) => c.command));
    try {
      const dir = await scratch.sync(pendingBase(run.changes));
      const results = await runAllChecks(checks, dir, signal, (check) => this.approveVerifyCheck(conversationId, runId, check, trusted), this.host.terminal?.(workspaceRoot));
      for (const r of results) {
        const command = checks.find((k) => k.name === r.name)?.command;
        if (r.skipped || !command) continue;
        const data = commandEventData(command, r);
        await this.append(conversationId, {
          author: "coordinator",
          runId,
          kind: "command",
          tag: `check ${r.name}`,
          tone: r.passed ? "success" : "warning",
          text: `Check "${r.name}" on all drafts together: ${r.passed ? "passed" : r.timedOut ? "timed out" : "failed"}. The full output is in the Agentic Code terminal.`,
          command: { line: command, output: String(data.output ?? "") },
        });
      }
      return results;
    } finally {
      await scratch.remove().catch(() => undefined);
    }
  }

  /** Same rule as a sub-agent's checks: approved checks run when "Run commands" is on or allowed for this run, otherwise the user is asked. */
  private async approveVerifyCheck(conversationId: string, runId: string, check: CheckConfig, trusted: ReadonlySet<string>): Promise<boolean> {
    if (isCheckAutoApproved(this.host.permissions().commands, trusted, check.command) || this.allowedFor(runId).has(check.command)) return true;
    const { decision } = await this.waitFor(conversationId, {
      author: "coordinator",
      kind: "approval",
      runId,
      rememberable: true,
      rememberLabel: "Allow for the rest of this run",
      text: `I'd like to run \`${check.command}\` (check "${check.name}") to verify the work with all drafts together. It runs in a copy of the project, so your files are not touched, but like any command it runs as you and can read files elsewhere or use the network, so only allow it if you trust it. Turn on "Run commands" to stop being asked.`,
    });
    if (decision?.kind !== "allow") return false;
    if (decision.remember) this.allowedFor(runId).add(check.command);
    return true;
  }

  /** Plans fix-up tasks for what verification found left, and adds them to the run. Returns the tasks added. */
  private async planFixUp(conversationId: string, workspaceRoot: string, runId: string, v: Verification, round: number, signal: AbortSignal): Promise<Task[]> {
    this.busy = "Coordinator is planning what is left…";
    this.changed();
    const run = await this.tasks.load(runId);
    const fileTree = await this.host.fileTree(workspaceRoot, signal).catch(() => undefined);
    const reports: VerifyTask[] = run.tasks.map((t) => ({ title: t.title, status: t.status.replace("_", " "), summary: t.summary ?? t.error ?? "" }));
    let result;
    try {
      result = await planRequest(
        this.coordinatorProvider(workspaceRoot, runId),
        { request: fixUpRequest(run.request, round), fileTree, learned: fixUpNotes(v, v.checks ?? [], reports), maxTasks: Math.min(4, this.host.delegationLimits().maxTasks) },
        { signal, onAttempt: (n, err) => n > 0 && this.host.log("warn", `Fix-up plan retry ${n}: ${err}`) },
      );
    } catch (err) {
      if (signal.aborted) throw err;
      await this.append(conversationId, { author: "system", runId, tone: "warning", text: `I could not plan the fix-up tasks (${(err as Error).message}), so the work stays unverified.` });
      return [];
    }
    if (isReadOnlyPlan(result.plan.tasks)) {
      await this.append(conversationId, { author: "system", runId, tone: "warning", text: "The fix-up plan only read files and changed nothing, so it was not started. Say what should change to finish the request." });
      return [];
    }
    // New ids, so they never clash with the run's earlier tasks; dependencies point at the new ids.
    const taken = new Set(run.tasks.map((t) => t.id));
    const ids = new Map<string, string>();
    for (const t of result.plan.tasks) {
      let id = `fix${round}-${t.id}`;
      for (let n = 2; taken.has(id); n++) id = `fix${round}-${t.id}-${n}`;
      taken.add(id);
      ids.set(t.id, id);
    }
    const added = await this.tasks.addTasks(
      runId,
      result.plan.tasks.map((t) => ({ ...t, id: ids.get(t.id)!, dependsOn: t.dependsOn.map((d) => ids.get(d)!).filter(Boolean) })),
    );
    for (const r of result.repairs) {
      await this.tasks.log({ runId, taskId: ids.get(r.taskId), type: "plan_repair", message: `${ids.get(r.taskId)} now waits for ${ids.get(r.addedDependency)}: ${r.reason}` });
    }
    return added;
  }

  /**
   * What each sub-agent reported back, added to the run summary. The summary
   * is a coordinator message, so the coordinator sees the reports next turn.
   */
  private async reports(runId: string): Promise<string> {
    const run = await this.tasks.load(runId).catch(() => undefined);
    if (!run) return "";
    const lines = run.tasks.map((t) => {
      const said = t.summary ?? t.error ?? "no report";
      return `- ${t.title} (${t.status.replace("_", " ")}): ${said.replace(/\s+/g, " ").slice(0, 300)}`;
    });
    return `\n\nReports from the sub-agents:\n${lines.join("\n")}`;
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
      this.watch(event, run);
      this.changed();
    } catch (err) {
      this.host.log("warn", `Could not add a sub-agent message to the chat: ${(err as Error).message}`);
    }
  }
}

/**
 * What the coordinator has learned in this conversation, for planning and for
 * every sub-agent of the next run: sub-agent reports (research answers and
 * finished work) and its own answers after research, newest first, kept small
 * for local models. Every line is labelled with its source. It is untrusted:
 * pass it on only through untrustedSection(), never as instructions.
 */
export function learnedSoFar(entries: ChatEntry[], maxChars = 3000): string | undefined {
  const lines: string[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    let line: string | undefined;
    // Each line says where it came from. None of it was checked by the user, and all of it
    // was written by models that read project files, so callers pass it on as untrusted data.
    if (e.kind === "report" && e.author === "coordinator") line = `- [run summary with sub-agent reports] ${e.text}`;
    else if (e.kind === "report") line = `- [report from sub-agent "${e.agentName ?? "unnamed"}"] ${e.text}`;
    // The coordinator's answer right after research reports sums them up.
    else if (e.author === "coordinator" && e.tag === "from research") line = `- [answer combined from research reports] ${e.text}`;
    // What the user decided when a sub-agent's question was passed on to them.
    else if (e.author === "coordinator" && e.kind === "question" && e.quote && e.decided?.startsWith("You answered: "))
      line = `- [the user's answer to a sub-agent's question] Q: ${e.quote} A: ${e.decided.slice("You answered: ".length)}`;
    if (!line) continue;
    line = line.replace(/\s+/g, " ").slice(0, 800);
    if (used + line.length > maxChars) break;
    lines.unshift(line);
    used += line.length;
  }
  return lines.length ? lines.join("\n") : undefined;
}


const isPrompt = (e: ChatEntry) => e.author === "user" && e.kind !== "direct";

/**
 * The part of a conversation that belongs to one run, for what the
 * coordinator may use when a sub-agent of that run asks it something or
 * when it checks on one. It starts at the user's message that led to the
 * run, and takes in the message before that only when the coordinator
 * answered it with a question and no run (a clarifying question, which the
 * user's next message answers). Earlier, unrelated tasks and chat of the
 * conversation are left out, so a sub-agent cannot draw them out of the
 * coordinator. It ends before the user's next message to the coordinator,
 * so later tasks are out of reach too. Empty if the run is not in it.
 */
export function runScope(entries: ChatEntry[], runId: string): ChatEntry[] {
  const at = entries.findIndex((e) => e.runId === runId && (e.kind === "plan" || e.kind === "research"));
  if (at < 0) return [];
  let start = at;
  while (start > 0 && !isPrompt(entries[start]!)) start--;
  for (;;) {
    let prev = start - 1;
    while (prev >= 0 && !isPrompt(entries[prev]!)) prev--;
    if (prev < 0) break;
    const between = entries.slice(prev, start);
    const reply = between.filter((e) => e.author === "coordinator").at(-1);
    if (between.some((e) => e.runId) || !reply?.text.trim().endsWith("?")) break;
    start = prev;
  }
  let end = at + 1;
  while (end < entries.length && !isPrompt(entries[end]!)) end++;
  return entries.slice(start, end);
}

/** The user's own messages to the coordinator, oldest first. Direct messages to sub-agents are left out. */
export function userMessagesOf(entries: ChatEntry[]): string[] {
  return entries.filter(isPrompt).map((e) => e.text);
}

/**
 * Questions sub-agents asked the coordinator in this conversation and how
 * they were answered, newest last, so a later question gets a consistent
 * answer and a decision the user made is not asked again.
 */
export function earlierAnswers(entries: ChatEntry[], maxChars = 2000): string | undefined {
  const lines: string[] = [];
  for (const e of entries) {
    if (!e.quote || e.author !== "coordinator") continue;
    const q = e.quote.replace(/\s+/g, " ").slice(0, 200);
    if (e.kind === "consult") lines.push(`- "${e.agentName ?? "A sub-agent"}" asked: ${q} You answered: ${e.text.replace(/\s+/g, " ").slice(0, 300)}`);
    else if (e.kind === "question" && e.decided?.startsWith("You answered: ")) lines.push(`- "${e.agentName ?? "A sub-agent"}" asked: ${q} The user decided: ${e.decided.slice("You answered: ".length).replace(/\s+/g, " ").slice(0, 300)}`);
  }
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  return out || undefined;
}

/**
 * What a sub-agent did, rebuilt from the chat, for reopening one whose
 * conversation was not saved (runs from before follow-ups existed).
 */
export function earlierWork(task: Task, entries: ChatEntry[], runId: string, maxChars = 4000): string {
  const steps = entries
    // The coordinator's own entries about this sub-agent (check-ins, answers) are left out: they quote what
    // a sub-agent's tool calls said, which is untrusted, and they are not the sub-agent's own work.
    .filter((e) => e.runId === runId && e.taskId === task.id && e.author !== "coordinator" && e.kind !== "spawn" && e.kind !== "report")
    .map((e) => (e.author === "user" ? `- The user said: ${e.text}` : `- ${e.tag ? `${e.tag}: ` : ""}${e.thought || e.text}`).replace(/\s+/g, " ").slice(0, 300));
  let shown = steps.join("\n");
  if (shown.length > maxChars) shown = `[… earlier steps left out]\n${shown.slice(-maxChars)}`;
  return [
    task.summary ? `Your report when you finished:\n${task.summary}` : task.error ? `Your task ended with: ${task.error}` : "",
    shown ? `Your steps:\n${shown}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A model-written reason as a sentence of its own: capital first letter, full stop at the end. */
function asSentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const s = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}
