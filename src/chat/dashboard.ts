import { AGENT_LABEL, AgentState, agentState, COORDINATOR_LABEL, CoordinatorState, coordinatorState, isActiveAgent } from "./lifecycle";
import { ChatEntry } from "./types";
import type { DoneBar, FollowUpState, PlanView } from "./viewState";

/** One sub-agent as a card in the Agents view. */
export interface AgentCard {
  runId: string;
  taskId: string;
  title: string;
  state: AgentState;
  label: string;
  /** What it is doing or did last, in one line. */
  activity: string;
  /** Files it may change. Empty for a read-only sub-agent. */
  fileScope: string[];
  /** Its drafts waiting for review. */
  drafts: number;
  /** All its drafts, decided or not. */
  draftFiles: number;
  /** Its latest thinking, shown collapsed. */
  thinking?: string;
  /** Its report to the coordinator, once it gave one. */
  report?: string;
  research: boolean;
  /** Whether it can get a direct message right now. */
  canMessage: boolean;
  /** Set while the user has reopened the conversation with it after its task ended. */
  followUp?: FollowUpState;
  /** Its task ended, so a message reopens the conversation with it. */
  reopenable: boolean;
  /** Its exchanges with the coordinator: questions it asked, and notes or a stop from the coordinator keeping tabs on it. */
  coordinator: { questions: number; notes: number; stopped: boolean; review?: ReviewBadge };
}

/**
 * How the coordinator's latest review of its result came out. "unavailable"
 * and "not_accepted" mean the result did not pass a review, so its drafts
 * wait for the user even with auto-approve on.
 */
export type ReviewBadge = "accepted" | "sent_back" | "not_accepted" | "unavailable";

const REVIEW_TAGS: Record<string, ReviewBadge> = { reviewed: "accepted", "sent back": "sent_back", "not accepted": "not_accepted", "review unavailable": "unavailable" };

export interface CoordinatorCard {
  state: CoordinatorState;
  label: string;
  activity: string;
  thinking?: string;
  /** How it kept tabs on the sub-agents in this conversation. */
  oversight: {
    /** Questions from sub-agents it answered itself. */
    answered: number;
    /** Questions it passed on to the user. */
    askedYou: number;
    /** Times it looked at a sub-agent that showed a sign of trouble. */
    checkIns: number;
    /** Notes it sent to sub-agents. */
    notes: number;
    /** Sub-agents it stopped. */
    stopped: number;
  };
}

export interface DashboardView {
  /** What the current prompt does: reading only, drafting changes, or just talking. */
  kind: "analysis" | "changes" | "chat";
  coordinator: CoordinatorCard;
  /** Every sub-agent of this conversation, newest run first. */
  agents: AgentCard[];
  /** For the current prompt's runs (or the latest run if the prompt made none). */
  counts: { total: number; completed: number; running: number; queued: number; failed: number; stopped: number; checksRun: number };
  /** Changes across the whole conversation. */
  drafts: { awaiting: number; accepted: number; rejected: number };
  /** Cards waiting for the user, so they are never hidden in another tab. */
  attention: { id: string; kind: string; tab: "overview" | "drafts" | "checks"; who: string; text: string }[];
  /** Set once the last prompt is dealt with. Finished does not mean the drafts were accepted. */
  finished?: DoneBar & { detail: string };
}

export interface DashboardInput {
  entries: ChatEntry[];
  /** Plans of the conversation by run id, in the order the runs were made. */
  plans: Record<string, PlanView>;
  runIds: string[];
  waiting: string[];
  busy?: string;
  stopping: boolean;
  runningRunId?: string;
  done?: DoneBar;
  /** Reopened conversations with sub-agents whose task ended, by "runId:taskId". */
  followUps?: Record<string, FollowUpState>;
  /** Sub-agents waiting for the coordinator's answer, by "runId:taskId", with their title. */
  consulting?: Record<string, string>;
  /** Sub-agents the coordinator is checking on right now, by "runId:taskId", with their title. */
  checkingOn?: Record<string, string>;
}

const FOLLOW_UP_LABEL: Record<FollowUpState, string> = {
  working: "Answering you",
  open: "Chat open",
  ending: "Updating the coordinator",
};

/** Markdown marks taken out of one-line previews, where the reply is not rendered. */
export function stripMarkdown(text: string): string {
  return text
    // A code block is only named in a preview; its code does not fit on one line.
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S]))/gm, " [code] ")
    .replace(/^ {0,3}(`{3,}|~{3,}).*$/gm, "")
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^ {0,3}>[ \t]?/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/gm, "")
    .replace(/^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/gm, "")
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, "$1")
    .replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/`([^`\n]+)`/g, "$1");
}

function oneLine(text: string | undefined, max = 140): string {
  // Only the start is ever shown, so only the start is cleaned.
  const flat = stripMarkdown((text ?? "").slice(0, Math.max(2000, max * 8))).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function last<T>(items: T[], pred: (x: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i]!)) return items[i];
  return undefined;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Builds what the dashboard shows from the conversation and its runs. Pure, so it can be tested without VS Code. */
export function buildDashboard(input: DashboardInput): DashboardView {
  const { entries, plans, waiting } = input;
  const waitingSet = new Set(waiting);
  const waitingEntries = entries.filter((e) => waitingSet.has(e.id));

  // The current prompt: everything after the user's last message to the coordinator.
  let promptStart = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.author === "user" && e.kind !== "direct") {
      promptStart = i;
      break;
    }
  }
  const promptRuns = new Set(entries.slice(promptStart).filter((e) => (e.kind === "plan" || e.kind === "research") && e.runId).map((e) => e.runId!));
  const latestRun = input.runIds.filter((id) => plans[id]).at(-1);
  if (promptRuns.size === 0 && latestRun) promptRuns.add(latestRun);

  const agents: AgentCard[] = [];
  for (const runId of [...input.runIds].reverse()) {
    const plan = plans[runId];
    if (!plan) continue;
    for (const t of plan.tasks) {
      const mine = entries.filter((e) => e.runId === runId && e.taskId === t.id && e.author === "agent");
      const latest = mine.at(-1);
      const waitingOnUser = waitingEntries.some((e) => e.runId === runId && e.taskId === t.id);
      const askingCoordinator = !!input.consulting?.[`${runId}:${t.id}`];
      const fromCoordinator = entries.filter((e) => e.runId === runId && e.taskId === t.id && e.author === "coordinator" && e.kind === "checkin");
      const followUp = input.followUps?.[`${runId}:${t.id}`];
      const ended = t.status === "done" || t.status === "failed" || t.status === "cancelled";
      // A reopened sub-agent shows as working while it answers, whatever its task's status.
      const state =
        followUp && followUp !== "open"
          ? waitingOnUser
            ? "needs_you"
            : "working"
          : agentState(t.status, { planStarted: plan.started, hasActivity: mine.length > 0, waitingOnUser, askingCoordinator });
      const changes = plan.changes.filter((c) => c.taskId === t.id);
      const report = last(mine, (e) => e.kind === "report");
      const withThinking = last(mine, (e) => !!e.thinking);
      let activity: string;
      if (state === "planned") activity = "Waiting for the plan to run";
      else if (state === "queued") activity = "Waiting for a free slot or for the tasks it depends on";
      else if (state === "initializing") activity = "Starting up";
      else if (state === "asking") activity = `Asked the coordinator: ${oneLine(last(mine, (e) => e.kind === "consult")?.text, 120)}`;
      else if (state === "completed" && report && !followUp) activity = oneLine(report.text);
      else activity = oneLine(latest?.thought || latest?.text) || AGENT_LABEL[state];
      agents.push({
        runId,
        taskId: t.id,
        title: t.title,
        state,
        label: followUp && state !== "needs_you" ? FOLLOW_UP_LABEL[followUp] : AGENT_LABEL[state],
        activity,
        fileScope: t.fileScope,
        drafts: changes.filter((c) => c.status === "pending").length,
        draftFiles: changes.length,
        thinking: withThinking?.thinking,
        report: report?.text,
        research: plan.kind === "research",
        // A running sub-agent reads messages on its next step. One whose task ended is reopened by a message,
        // unless its run is still going (other sub-agents may be drafting the same files).
        canMessage: t.status === "running" || t.status === "verifying" || (ended && followUp !== "ending" && input.runningRunId !== runId),
        followUp,
        reopenable: ended,
        coordinator: {
          questions: mine.filter((e) => e.kind === "consult").length,
          notes: fromCoordinator.filter((e) => e.tag === "note from coordinator").length,
          stopped: fromCoordinator.some((e) => e.tag === "stopped by coordinator"),
          review: REVIEW_TAGS[last(fromCoordinator, (e) => !!e.tag && e.tag in REVIEW_TAGS)?.tag ?? ""],
        },
      });
    }
  }

  const counted = agents.filter((a) => promptRuns.has(a.runId));
  const count = (pred: (s: AgentState) => boolean) => counted.filter((a) => pred(a.state)).length;
  const checksRun = entries.slice(promptStart).filter((e) => e.author === "agent" && e.tag === "checks").length;

  const allChanges = input.runIds.flatMap((id) => plans[id]?.changes ?? []);
  const drafts = {
    awaiting: allChanges.filter((c) => c.status === "pending").length,
    accepted: allChanges.filter((c) => c.status === "accepted").length,
    rejected: allChanges.filter((c) => c.status === "rejected").length,
  };

  const cState = coordinatorState({
    busy: input.busy,
    stopping: input.stopping,
    runningRun: !!input.runningRunId,
    waitingOnUser: waitingEntries.length > 0,
    done: input.done?.status,
  });
  const lastCoordinator = last(entries, (e) => e.author === "coordinator" && e.kind !== "spawn");
  const coordinatorThinking = last(entries, (e) => e.author === "coordinator" && !!e.thinking);
  const running = count(isActiveAgent);
  const consultingNames = Object.values(input.consulting ?? {});
  const checkingNames = Object.values(input.checkingOn ?? {});
  const supervising = consultingNames.length
    ? `Answering a question from ${consultingNames.map((n) => `"${n}"`).join(", ")}`
    : checkingNames.length
      ? `Checking on ${checkingNames.map((n) => `"${n}"`).join(", ")}`
      : running
        ? `Keeping tabs on ${plural(running, "sub-agent")} and answering their questions`
        : "Reviewing results and planning next steps";
  const checkIns = entries.filter((e) => e.author === "coordinator" && e.kind === "checkin");
  const oversight = {
    answered: entries.filter((e) => e.author === "coordinator" && e.kind === "consult" && e.tag === "answered").length,
    askedYou: entries.filter((e) => e.author === "coordinator" && e.kind === "question" && e.tag === "for a sub-agent").length,
    checkIns: checkIns.length,
    notes: checkIns.filter((e) => e.tag === "note from coordinator").length,
    stopped: checkIns.filter((e) => e.tag === "stopped by coordinator").length,
  };
  const coordinatorActivity: Record<CoordinatorState, string> = {
    idle: oneLine(lastCoordinator?.thought || lastCoordinator?.text) || "Waiting for your request",
    thinking: input.busy ?? "Thinking",
    supervising,
    needs_you: `Waiting for you: ${plural(waitingEntries.length, "request")} to answer`,
    stopping: "Stopping every sub-agent. Drafts are kept for review.",
    finished: oneLine(lastCoordinator?.thought || lastCoordinator?.text) || "Done with your request",
    partial: "Done, but some tasks did not complete",
    stopped: "Stopped by you",
    failed: "Something went wrong. See the activity below.",
  };

  const attention = waitingEntries.map((e) => {
    // Command approvals offer "remember"; file-change approvals do not.
    const isCommand = e.kind === "checks" || (e.kind === "approval" && !!e.rememberable);
    const tab: "overview" | "drafts" | "checks" = isCommand ? "checks" : e.kind === "approval" ? "drafts" : "overview";
    const who = e.author === "coordinator" && e.agentName ? `Coordinator, for "${e.agentName}"` : (e.agentName ?? "Coordinator");
    return { id: e.id, kind: e.kind ?? "message", tab, who, text: oneLine(e.text, 120) };
  });

  const promptPlans = [...promptRuns].map((id) => plans[id]).filter((p): p is PlanView => !!p);
  const kind: DashboardView["kind"] = promptPlans.some((p) => p.kind === "change") ? "changes" : promptPlans.length ? "analysis" : "chat";

  let finished: DashboardView["finished"];
  if (input.done && !input.busy) {
    const detail = [
      plural(drafts.awaiting, "draft") + " awaiting review",
      drafts.accepted ? `${drafts.accepted} accepted` : "",
      drafts.rejected ? `${drafts.rejected} rejected` : "",
      plural(checksRun, "check") + " run",
    ]
      .filter(Boolean)
      .join(" · ");
    finished = { ...input.done, detail };
  }

  return {
    kind,
    coordinator: {
      state: cState,
      label: COORDINATOR_LABEL[cState],
      activity: coordinatorActivity[cState],
      thinking: coordinatorThinking?.thinking,
      oversight,
    },
    agents,
    counts: {
      total: counted.length,
      completed: count((s) => s === "completed"),
      running,
      queued: count((s) => s === "queued" || s === "planned"),
      failed: count((s) => s === "failed"),
      stopped: count((s) => s === "stopped"),
      checksRun,
    },
    drafts,
    attention,
    finished,
  };
}
