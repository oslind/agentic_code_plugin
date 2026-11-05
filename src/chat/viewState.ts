import type { SkillsView } from "../skills/service";
import type { OversightLevel } from "../userSettings";
import { PendingChange, Run, TaskStatus } from "../state/types";
import { latestAccepted } from "../state/taskStore";
import { CheckConfig } from "../checks/runner";
import { AutoApprove } from "../tools/policy";
import { parallelWaves } from "../coordinator/plan";
import { changeKind } from "../changes/review";
import { hasConflictMarkers } from "../changes/merge";
import { ChatEntry, ChatMode, Conversation, ConversationSummary } from "./types";
import { buildDashboard, DashboardView } from "./dashboard";
import { DraftState, draftState, lineCounts } from "./lifecycle";
import { LiveItem } from "./live";
import { isUnstarted } from "./helpers";
import type { ChatSession } from "./session";

/** What the user can do with a pending change from the chat. */
export type ReviewAction = "show" | "open" | "accept" | "reject" | "resolve" | "revert";

/** What the user chose on a card that waited for them. */
export type Decision =
  | { kind: "checks"; checks: CheckConfig[]; remember: boolean }
  | { kind: "skip" }
  | { kind: "allow"; remember?: boolean }
  | { kind: "deny" }
  | { kind: "answer"; text: string };

export interface PlanView {
  kind: "change" | "research";
  tasks: { id: string; title: string; status: TaskStatus; fileScope: string[]; dependsOn: string[]; skills?: string[] }[];
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
  /** Why the last Accept (or Revert) did not go through, e.g. the file changed on disk. */
  note?: string;
  /** Other sub-agents whose drafts of this file were combined into this one, by name. */
  combinedWith?: string[];
  /** Combined with a newer version of the file on disk when it was accepted. */
  combinedWithDisk?: boolean;
  /** This draft and another version changed the same lines. It cannot be accepted until the user picks how to resolve it. */
  conflict?: { with: "draft" | "disk"; otherAgent?: string; regions: number };
  /** The draft still has conflict markers (the user chose to keep both versions). */
  markers?: boolean;
  /** The newest accepted change of its file in this run: Revert puts the file back as it was before it. */
  revertable?: boolean;
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
  /** The oversight level, shown in the chat's Settings view. */
  oversight?: OversightLevel;
  /** Skills for the current conversation's folder, shown in the chat's Settings view. */
  skills?: SkillsView;
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

/** What the user's reopened conversation with a finished sub-agent is doing. */
export type FollowUpState = "working" | "open" | "ending";

/** What the view needs besides the session: what the coordinator and reopened sub-agents are doing right now. */
export interface ViewExtras {
  followUps: Record<string, FollowUpState>;
  consulting: Record<string, string>;
  checkingOn: Record<string, string>;
  /** Whether a run can be resumed, and how many tasks it has left. */
  resumeView: (run: Run) => Pick<PlanView, "resumable" | "tasksLeft">;
}

/**
 * The whole chat as the webview shows it: the conversations, the current
 * one with its plans and drafts, what waits for the user, and the dashboard.
 * `busy` and `stopping` are taken by the caller before any await, so they
 * describe the moment the view was asked for.
 */
export async function buildViewState(
  s: ChatSession,
  snapshot: { busy?: string; stopping: boolean; ready: Promise<void> },
  extras: () => ViewExtras,
): Promise<ChatViewState> {
  const { busy, stopping } = snapshot;
  await snapshot.ready;
  const conversations = await s.conversations.list();
  let current: Conversation | undefined;
  if (s.currentId) current = await s.conversations.load(s.currentId).catch(() => undefined);
  const now = extras();
  const plans: Record<string, PlanView> = {};
  for (const runId of current?.runIds ?? []) {
    const run = await s.tasks.load(runId).catch(() => undefined);
    if (!run) continue;
    const titleOf = (taskId: string) => run.tasks.find((t) => t.id === taskId)?.title ?? taskId;
    plans[runId] = {
      kind: run.kind ?? "change",
      tasks: run.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, fileScope: t.fileScope, dependsOn: t.dependsOn, ...(t.skills?.length ? { skills: t.skills } : {}) })),
      started: !isUnstarted(run),
      waves: parallelWaves(run.tasks).length,
      ...now.resumeView(run),
      changes: (run.changes ?? []).map((ch) => ({
        path: ch.path,
        taskId: ch.taskId,
        agentName: titleOf(ch.taskId),
        kind: changeKind(ch),
        status: ch.status,
        state: draftState(ch.status),
        ...lineCounts(ch.original, ch.proposed),
        auto: ch.auto,
        // Accept and Revert notes are kept apart, so a Revert warning never turns the next Accept into an overwrite.
        note: ch.status === "pending" ? s.changeNotes.get(`${runId}:${ch.path}`) : ch === latestAccepted(run.changes, ch.path) ? s.changeNotes.get(`revert:${runId}:${ch.path}`) : undefined,
        revertable: ch === latestAccepted(run.changes, ch.path) || undefined,
        combinedWith: ch.combinedWith?.map(titleOf),
        combinedWithDisk: ch.combinedWithDisk,
        conflict: ch.conflict && { with: ch.conflict.with, otherAgent: ch.conflict.otherTaskId && titleOf(ch.conflict.otherTaskId), regions: ch.conflict.regions },
        markers: ch.status === "pending" && !ch.conflict && hasConflictMarkers(ch.proposed) ? true : undefined,
      })),
    };
  }
  const done = s.done && s.done.conversationId === current?.id ? { status: s.done.status, text: s.done.text, time: s.done.time } : undefined;
  const waiting = [...s.pending.keys()];
  return {
    mode: s.mode,
    model: s.host.modelLabel(current?.workspaceRoot),
    busy,
    conversations,
    current: current && { id: current.id, title: current.title, workspaceRoot: current.workspaceRoot, entries: current.entries },
    plans,
    runningRunId: s.runningRunId,
    permissions: s.host.permissions(),
    oversight: s.host.oversight?.(),
    skills: current && s.skills?.workspaceRoot === current.workspaceRoot ? s.skills.view : undefined,
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
          runningRunId: s.runningRunId,
          done,
          followUps: now.followUps,
          consulting: now.consulting,
          checkingOn: now.checkingOn,
        })
      : undefined,
    attachRoot: current ? undefined : s.attachRoot,
    live: s.live.snapshot(),
  };
}
