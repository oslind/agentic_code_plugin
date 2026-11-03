import { planRequest } from "../coordinator/planner";
import { parallelWaves } from "../coordinator/plan";
import { RunOutcome } from "../coordinator/orchestrator";
import { ModelProvider } from "../providers/types";
import { Mutex } from "../util/mutex";
import { TaskStore } from "../state/taskStore";
import { PendingChange, Run, RunEvent, Task, TaskStatus } from "../state/types";
import { CheckConfig } from "../checks/runner";
import { DetectedCheck } from "../checks/detect";
import { ToolCall } from "../tools/protocol";
import { AutoApprove, isAutoApproved, isChangeAutoAccepted } from "../tools/policy";
import { acceptChange, changeKind, rejectChange } from "../changes/review";
import { commandLeavesProject } from "../tools/commandGuard";
import { ConversationStore } from "./conversationStore";
import { coordinatorTurn, CoordinatorResult, editingReason, isReadOnlyPlan, isGoAhead, isReadOnlyRequest, researchQuestions, researchRoundLimit } from "./coordinatorChat";
import { WorkspaceSandbox } from "../tools/sandbox";
import { Worker } from "../worker/worker";
import { eventToEntry } from "./eventFeed";
import { changedFilesOf, describeOutcome } from "./outcome";
import { ChatEntry, ChatMode, Conversation, ConversationSummary } from "./types";

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
  /** Limits for read-only research sub-agents. */
  researchLimits(): { maxTurns: number; maxParallel: number };
  /** How heavily the coordinator may delegate. */
  delegationLimits(): { maxTasks: number; maxResearchers: number; maxResearchRounds?: number };
  /** Opens a pending change in VS Code: a new file as its own editor, an edit as a side-by-side diff. */
  showChange(runId: string, filePath: string): Promise<void>;
  /** Closes the editors showing a change once it is decided. */
  closeChange(runId: string, filePath: string): Promise<void>;
}

/** How a run started from the chat talks back to the user. */
export interface RunHooks {
  /** The checks approved for this run. They replace the settings for it. */
  checks: CheckConfig[];
  approveTool: (task: Task, reason: string, call: ToolCall, preview?: string) => Promise<boolean>;
  /** Asked before every check command runs, unless commands are auto-approved. */
  approveCommand: (task: Task, check: CheckConfig) => Promise<boolean>;
  askUser: (task: Task, question: string) => Promise<string>;
  inbox: (taskId: string) => string[];
  /** A task finished with file changes. They are pending until accepted here or by an auto-approve switch. */
  onChanges: (task: Task, changes: PendingChange[]) => Promise<void>;
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
}

/** The bar at the bottom of the chat once a prompt is dealt with: green when finished. */
export interface DoneBar {
  status: "finished" | "partial" | "stopped" | "failed";
  text: string;
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
  /** Which conversation each run belongs to, so sub-agent events land in the right chat. */
  private readonly runOwner = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly stopEvents: () => void;
  private readonly ready: Promise<void>;
  private readonly eventQueue = new Mutex();
  /** Cards waiting for the user, by entry id. */
  private readonly pending = new Map<string, { conversationId: string; resolve: (d: Decision | undefined) => void }>();
  /** Messages the user sent to a sub-agent, waiting for its next step. Keyed by run and task. */
  private readonly inboxes = new Map<string, string[]>();
  /** Why an Accept did not go through, by "runId:path". Cleared once the change is decided. */
  private readonly changeNotes = new Map<string, string>();
  /** Commands the user allowed for the rest of a run, keyed by run id. */
  private readonly allowedCommands = new Map<string, Set<string>>();

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
          auto: ch.auto,
          note: this.changeNotes.get(`${runId}:${ch.path}`),
        })),
      };
    }
    return {
      mode: this.mode,
      model: this.host.modelLabel(current?.workspaceRoot),
      busy: this.busy,
      conversations,
      current: current && { id: current.id, title: current.title, workspaceRoot: current.workspaceRoot, entries: current.entries },
      plans,
      runningRunId: this.runningRunId,
      permissions: this.host.permissions(),
      waiting: [...this.pending.keys()],
      done: this.done && this.done.conversationId === current?.id ? { status: this.done.status, text: this.done.text } : undefined,
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
    if (!this.busy && this.pending.size === 0) return;
    if (this.busy) {
      this.busy = "Stopping…";
      this.stopping = true;
      this.changed();
    }
    this.abort?.abort();
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
    const decision = await new Promise<Decision | undefined>((resolve) => this.pending.set(full.id, { conversationId, resolve }));
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
      await this.append(conversationId, { author: "system", runId, text: action === "accept" ? `Accepted ${n} change(s).` : `Rejected ${n} change(s). Nothing was written for them.` });
    }
    this.changed();
  }

  /** Sends a message straight to a running sub-agent. It reads it before its next step. */
  async messageAgent(runId: string, taskId: string, text: string): Promise<void> {
    const conversationId = this.runOwner.get(runId);
    if (!conversationId || !text.trim()) return;
    const run = await this.tasks.load(runId);
    const task = run.tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (task.status !== "running" && task.status !== "verifying") {
      await this.append(conversationId, { author: "system", text: `"${task.title}" is not working right now, so it cannot get messages. Retry it to start it again.`, tone: "warning" });
      return;
    }
    const key = `${runId}:${taskId}`;
    this.inboxes.set(key, [...(this.inboxes.get(key) ?? []), text.trim()]);
    await this.append(conversationId, { author: "user", kind: "direct", runId, taskId, agentName: task.title, text: text.trim() });
  }

  private drainInbox(runId: string, taskId: string): string[] {
    const key = `${runId}:${taskId}`;
    const messages = this.inboxes.get(key) ?? [];
    this.inboxes.delete(key);
    return messages;
  }

  private allowedFor(runId: string): Set<string> {
    let set = this.allowedCommands.get(runId);
    if (!set) this.allowedCommands.set(runId, (set = new Set()));
    return set;
  }

  private hooksFor(conversationId: string, runId: string, checks: CheckConfig[], workspaceRoot: string): RunHooks {
    return {
      checks,
      inbox: (taskId) => this.drainInbox(runId, taskId),
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
        if (isAutoApproved(call, this.host.permissions())) {
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
            ? `I'd like to run \`${call.command}\` as check "${call.name}". ${call.reason} It runs inside the project folder only, and nothing runs until you allow it.`
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
            ? `I have ${waiting.length} change(s) for you to review. Nothing is written to your project until you accept.${written.length ? ` ${written.length} other change(s) were written right away because an auto-approve switch is on.` : ""}`
            : `My ${written.length} change(s) were written to your project, because an auto-approve switch is on.`,
        });
        // Open what waits for review, so the user sees it right away.
        for (const ch of waiting.slice(0, 3)) await this.host.showChange(runId, ch.path).catch((err) => this.host.log("warn", (err as Error).message));
      },
      approveCommand: async (task, check) => {
        if (this.host.permissions().commands || this.allowedFor(runId).has(check.command)) return true;
        const { decision } = await this.waitFor(conversationId, {
          author: "agent",
          kind: "approval",
          runId,
          taskId: task.id,
          agentName: task.title,
          rememberable: true,
          rememberLabel: "Allow for the rest of this run",
          text: `I'd like to run \`${check.command}\` (check "${check.name}") to verify my work. It runs inside the project folder only. Turn on "Run commands" to stop being asked.`,
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
        ? "These commands will verify the sub-agents' work. Edit, add or remove them, then approve. Sub-agents can also ask you for more checks while they work."
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
        text: `The check "${c.name}" (\`${c.command}\`) was left out: ${commandLeavesProject(c.command)} Commands always run inside the project folder.`,
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
    // A new prompt: the bar goes away until this one is dealt with.
    this.done = undefined;
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
        { mode: this.mode, entries: c.entries, fileTree, pendingPlan: pending && describePlan(pending), maxResearchers: this.host.delegationLimits().maxResearchers },
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
        await this.research(c, t, abort.signal, round > 1 ? learnedSoFar(c.entries) : undefined);
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
          },
          { signal: abort.signal, onAttempt: (n, err) => n > 0 && this.host.log("warn", `Coordinator retry ${n}: ${err}`) },
        );
        this.host.log(
          "info",
          `Coordinator after research round ${round} of ${maxRounds} chose "${answer.modelAction ?? answer.action}"${answer.modelAction && answer.modelAction !== answer.action ? `, changed to "${answer.action}"` : ""}.`,
        );
        await this.append(c.id, { author: "coordinator", tag: "from research", text: answer.reply, thought: answer.thought || undefined, thinking: clip(answer.thinking) });
        // The user asked for a change: the research was the first step, the plan is the next.
        if (answer.action === "plan") await makePlan(answer, true);
        // The reports were too general: send narrower researchers.
        else if (answer.action === "research") await doResearch(answer);
        else if (answer.researchLimitReached) {
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
      if (!startRun) this.done = { ...ended, conversationId: c.id };
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
      const review = waitingReview ? ` ${waitingReview} change(s) wait for your review.` : "";
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
      this.runningRunId = undefined;
      this.busy = undefined;
      this.stopping = false;
      this.done = { ...ended, conversationId };
      this.changed();
    }
  }

  /**
   * Sends read-only sub-agents to answer the coordinator's questions about the
   * project. They read the open folder directly and their file scope is
   * empty, so the policy refuses every write.
   */
  /** One research round. `learned` is what earlier rounds found, so follow-up researchers build on it. */
  private async research(c: Conversation, turn: CoordinatorResult, signal: AbortSignal, learned?: string): Promise<void> {
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
      text: `Sending ${added.length} read-only sub-agent(s) to look into the project. They can read files but not change anything.`,
    });
    this.busy = `${added.length} read-only sub-agent(s) are researching…`;
    this.runningRunId = run.id;
    this.changed();

    const sandbox = await WorkspaceSandbox.create(root);
    const { maxTurns, maxParallel } = this.host.researchLimits();
    const provider = this.host.provider(c.workspaceRoot);
    const queue = [...added];
    const workerLoop = async () => {
      for (let task = queue.shift(); task; task = queue.shift()) {
        if (signal.aborted) {
          await this.tasks.setStatus(run.id, task.id, "cancelled", "Stopped");
          continue;
        }
        await this.tasks.setStatus(run.id, task.id, "running");
        try {
          const worker = new Worker({
            provider,
            sandbox,
            task,
            checks: [],
            maxTurns,
            signal,
            readOnly: true,
            context: learned ? `What earlier researchers found (build on it, do not repeat it):\n${learned}` : undefined,
            approve: async () => false,
            inbox: () => this.drainInbox(run.id, task!.id),
            log: (type, message, data) => void this.tasks.log({ runId: run.id, taskId: task!.id, type, message, data }),
          });
          const result = await worker.run();
          await this.tasks.updateTask(run.id, task.id, { summary: result.summary, changedFiles: [] });
          await this.tasks.setStatus(run.id, task.id, "done");
        } catch (err) {
          const stopped = signal.aborted;
          await this.tasks.setStatus(run.id, task.id, stopped ? "cancelled" : "failed", stopped ? "Stopped" : (err as Error).message);
          if (!stopped) await this.tasks.log({ runId: run.id, taskId: task.id, type: "task_failed", message: (err as Error).message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(maxParallel, added.length)) }, workerLoop));
    // Let queued sub-agent messages land before the summary.
    await this.eventQueue.run(async () => {});
    signal.throwIfAborted();
    await this.append(c.id, { author: "coordinator", runId: run.id, text: `Research finished.${await this.reports(run.id)}` });
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
 * for local models.
 */
export function learnedSoFar(entries: ChatEntry[], maxChars = 3000): string | undefined {
  const lines: string[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    let line: string | undefined;
    if (e.kind === "report") line = `- ${e.agentName ?? "A sub-agent"} reported: ${e.text}`;
    // The coordinator's answer right after research reports sums them up.
    else if (e.author === "coordinator" && e.tag === "from research") line = `- Coordinator concluded: ${e.text}`;
    if (!line) continue;
    line = line.replace(/\s+/g, " ").slice(0, 800);
    if (used + line.length > maxChars) break;
    lines.unshift(line);
    used += line.length;
  }
  return lines.length ? lines.join("\n") : undefined;
}

