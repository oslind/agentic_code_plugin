import { promises as fs } from "fs";
import { planRequest } from "../coordinator/planner";
import { parallelWaves } from "../coordinator/plan";
import * as path from "path";
import { AGENT_DIR, publishDrafts, RunOutcome } from "../coordinator/orchestrator";
import { OverlayFiles, pendingBase } from "../changes/overlay";
import { ScratchCopy } from "../changes/scratch";
import { ModelProvider } from "../providers/types";
import { Mutex } from "../util/mutex";
import { TaskStore } from "../state/taskStore";
import { PendingChange, Run, RunEvent, Task, TaskStatus } from "../state/types";
import { CheckConfig } from "../checks/runner";
import { CommandSink } from "../checks/commandTerminal";
import { DetectedCheck } from "../checks/detect";
import { ToolCall } from "../tools/protocol";
import { AutoApprove, isAutoApproved, isCheckAutoApproved, isChangeAutoAccepted } from "../tools/policy";
import { acceptChange, changeKind, rejectChange } from "../changes/review";
import { commandLeavesProject } from "../tools/commandGuard";
import { ConversationStore } from "./conversationStore";
import { untrustedSection } from "../context/untrusted";
import { ResearchReport, synthesizeFindings } from "./synthesis";
import { coordinatorTurn, CoordinatorResult, editingReason, isReadOnlyPlan, isGoAhead, isReadOnlyRequest, researchQuestions, researchRoundLimit } from "./coordinatorChat";
import { WorkspaceSandbox } from "../tools/sandbox";
import { CoordinatorReply, InboxMessage, Worker } from "../worker/worker";
import { answerSubAgent } from "../coordinator/consult";
import { AgentMonitor, Concern, CONCERN_LABEL, superviseAgent } from "../coordinator/monitor";
import { eventToEntry } from "./eventFeed";
import { changedFilesOf, describeOutcome } from "./outcome";
import { ChatEntry, ChatMode, Conversation, ConversationSummary } from "./types";
import { buildDashboard, DashboardView } from "./dashboard";
import { DraftState, draftState, lineCounts } from "./lifecycle";

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
  delegationLimits(): { maxTasks: number; maxResearchers: number; maxResearchRounds?: number; checkIns?: number };
  /** Most tokens of earlier conversation sent with each coordinator message. 0 or unset: as much as fits. */
  coordinatorHistoryTokens?(): number;
  /** Opens a pending change in VS Code: a new file as its own editor, an edit as a side-by-side diff. */
  showChange(runId: string, filePath: string): Promise<void>;
  /** Closes the editors showing a change once it is decided. */
  closeChange(runId: string, filePath: string): Promise<void>;
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
  inbox: (taskId: string) => InboxMessage[];
  /** Called once the run has started, with what the coordinator may do to its sub-agents while it supervises them. */
  attach?: (control: RunControl) => void;
  /** A task finished with file changes. They are pending until accepted here or by an auto-approve switch. */
  onChanges: (task: Task, changes: PendingChange[]) => Promise<void>;
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
export type ReviewAction = "show" | "accept" | "reject";

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
  /** Why an Accept did not go through, by "runId:path". Cleared once the change is decided. */
  private readonly changeNotes = new Map<string, string>();
  /** Commands the user allowed for the rest of a run, keyed by run id. */
  private readonly allowedCommands = new Map<string, Set<string>>();
  /** Conversations the user reopened with finished sub-agents, by "runId:taskId". */
  private readonly followUps = new Map<string, FollowUp>();

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

  private async indexRuns(): Promise<void> {
    for (const s of await this.conversations.list()) {
      const c = await this.conversations.load(s.id).catch(() => undefined);
      for (const runId of c?.runIds ?? []) {
        this.runOwner.set(runId, s.id);
        // Research that was cut off by a restart has no live sub-agent; mark it failed.
        const run = await this.tasks.load(runId).catch(() => undefined);
        for (const t of run?.kind === "research" ? run.tasks.filter((x) => x.status === "running") : []) {
          await this.tasks.setStatus(runId, t.id, "failed", "Interrupted by restart").catch(() => undefined);
        }
      }
    }
    this.currentId ??= (await this.conversations.list())[0]?.id;
    const current = this.currentId ? await this.conversations.load(this.currentId).catch(() => undefined) : undefined;
    if (current) this.mode = current.mode;
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
    if (!root) throw new Error(`${run.workspaceRoot ?? "This run's folder"} is not open in VS Code, so nothing can be written.`);
    const targets = (run.changes ?? []).filter(
      (c) => c.status === "pending" && (filePath ? c.path === filePath : !taskId || c.taskId === taskId),
    );
    for (const c of targets) {
      const key = `${runId}:${c.path}`;
      if (action === "reject") {
        await rejectChange(this.tasks, runId, c.path);
        this.changeNotes.delete(key);
      } else {
        // A second Accept after a "changed on disk" note means: overwrite.
        const res = await acceptChange(this.tasks, runId, c.path, root, { overwrite: this.changeNotes.has(key) });
        if (res.ok) this.changeNotes.delete(key);
        else {
          this.changeNotes.set(key, res.message);
          continue;
        }
      }
      await this.host.closeChange(runId, c.path).catch(() => undefined);
    }
    if (conversationId && targets.length > 1) {
      const n = targets.length;
      await this.append(conversationId, { author: "system", runId, text: action === "accept" ? `Accepted ${n} draft(s) and wrote them to your project.` : `Rejected ${n} draft(s). Nothing was written for them.` });
    }
    this.changed();
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
      provider: this.host.provider(workspaceRoot),
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
    if (f) await this.endFollowUp(f, true);
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
    for (const map of [this.consulting, this.checkingOn]) for (const key of [...map.keys()]) if (key.startsWith(`${runId}:`)) map.delete(key);
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
    if (event.type !== "tool_call" && event.type !== "denied" && event.type !== "checks") return;
    if (task.status !== "running" && task.status !== "verifying") return;
    const limit = this.host.delegationLimits().checkIns ?? 2;
    if (limit <= 0 || s.inFlight.has(task.id) || s.monitor.checkIns(task.id) >= limit || s.abort.signal.aborted) return;
    const concern = s.monitor.concerns(task.id)[0];
    if (!concern) return;
    s.monitor.markRaised(task.id, concern.kind);
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
    const decision = await superviseAgent(
      this.host.provider(c.workspaceRoot),
      { userMessages: userMessagesOf(runScope(c.entries, run.id)), request: run.request, agent: task, concern, activity: s.monitor.describe(task.id), notesSent },
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
          this.host.provider(c.workspaceRoot),
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
      inbox: (taskId) => this.drainInbox(runId, taskId),
      askCoordinator: (task, question, signal) => this.consultCoordinator(conversationId, runId, task, question, signal),
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
        const written: string[] = [];
        for (const ch of changes) {
          if (!isChangeAutoAccepted(ch.path, auto)) continue;
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
            ? `I have ${waiting.length} draft change(s) for you to review under Drafts. Nothing is written to your project until you accept.${written.length ? ` ${written.length} other change(s) were accepted and written right away because an auto-approve switch is on.` : ""}`
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

    const waiting = isGoAhead(text) ? await this.pendingPlan(await this.conversations.load(c.id)) : undefined;
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
    try {
      c = await this.conversations.load(c.id);
      const provider = this.host.provider(c.workspaceRoot);
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
      // Every research round of this message, and the coordinator's last reply when it chose to answer.
      // Unless a plan follows, the prompt always ends with one answer that combines all the reports.
      const researchRuns: string[] = [];
      let planned = false;
      let draft: { reply: string; thought?: string; thinking?: string } | undefined;
      let limitReached = false;
      const doResearch = async (t: CoordinatorResult): Promise<void> => {
        round++;
        researchRuns.push(await this.research(c, t, abort.signal, round > 1 ? learnedSoFar(c.entries) : undefined));
        c = await this.conversations.load(c.id);
        this.busy = "Coordinator is reading the reports…";
        this.runningRunId = undefined;
        this.changed();
        const answer = await coordinatorTurn(
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
      if (researchRuns.length && !planned) await this.answerFromReports(c, text, researchRuns, draft, limitReached, abort.signal);
    } catch (err) {
      const message = abort.signal.aborted ? "Stopped." : (err as Error).message;
      ended = abort.signal.aborted ? { status: "stopped", text: "Stopped" } : { status: "failed", text: "Failed. See the message above." };
      this.host.log("error", message);
      await this.append(c.id, { author: "system", kind: "error", text: message, tone: abort.signal.aborted ? "warning" : "error" });
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
    if (this.busy) return;
    const conversationId = this.runOwner.get(runId);
    if (!conversationId) return;
    const run = await this.tasks.load(runId);
    if (!isUnstarted(run)) {
      await this.append(conversationId, { author: "system", text: "That plan has already run. Retry tasks from the Tasks view.", tone: "warning" });
      return;
    }
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
      this.busy = `Sub-agents are working on ${run.tasks.length} task(s)…`;
      this.changed();
      await this.append(conversationId, {
        author: "coordinator",
        text: `Starting sub-agents for ${run.tasks.length} task(s). Each may only change its own files, and you review every change before it is written.`,
      });
      this.supervise(runId, conversationId, this.host.researchLimits().maxTurns);
      const outcome = await this.host.runPlan(runId, this.hooksFor(conversationId, runId, checks, workspaceRoot));
      // Let sub-agent messages that are still queued land before the summary.
      await this.eventQueue.run(async () => {});
      if (!outcome) {
        await this.append(conversationId, { author: "system", text: "The run was not started.", tone: "warning" });
        return;
      }
      const ok = outcome.failed.length === 0 && outcome.blocked.length === 0;
      const finished = await this.tasks.load(runId);
      const waitingReview = (finished.changes ?? []).filter((ch) => ch.status === "pending").length;
      const review = waitingReview ? ` ${waitingReview} draft(s) await your review.` : "";
      const notDone = outcome.failed.length + outcome.blocked.length;
      ended = this.stopping
        ? { status: "stopped", text: `Stopped.${review}` }
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
            provider,
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
  ): Promise<void> {
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
      this.host.provider(c.workspaceRoot),
      { question, reports, draft: draft?.reply, limitReached },
      { signal, onError: (m) => this.host.log("warn", m) },
    );
    this.host.log("info", `Combined ${reports.length} research report(s) into the answer${result.fallback ? " without the model (it gave no usable summary)" : ""}.`);
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
