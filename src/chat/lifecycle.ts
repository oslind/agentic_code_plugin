import { PendingChange, TaskStatus } from "../state/types";

/**
 * Explicit lifecycles for what the chat shows, kept apart from how it looks.
 * The stores keep their own statuses; these functions map them onto the
 * states the user sees, so every view uses the same words and colors.
 */

/**
 * A file change from a sub-agent:
 *
 *   proposed → draft → applied   (the user, or an auto-approve switch, accepted it)
 *                    → discarded (the user rejected it)
 *   applied → reverted  (the user undid the accept: the file is back as before)
 *
 * "proposed" is a change a sub-agent is still working on: it is in the
 * sub-agent's scratch overlay and not yet shown. A draft waits for review.
 * Only "applied" means the file was written to the project.
 */
export type DraftState = "proposed" | "draft" | "applied" | "discarded" | "reverted";

export const DRAFT_TRANSITIONS: Record<DraftState, DraftState[]> = {
  proposed: ["draft"],
  draft: ["applied", "discarded"],
  applied: ["reverted"],
  discarded: [],
  reverted: [],
};

/** Labels the user sees. An unaccepted draft is never called written, created or modified. */
export const DRAFT_LABEL: Record<DraftState, string> = {
  proposed: "Proposed",
  draft: "Draft",
  applied: "Accepted",
  discarded: "Rejected",
  reverted: "Reverted",
};

export function draftState(status: PendingChange["status"]): DraftState {
  return status === "accepted" ? "applied" : status === "rejected" ? "discarded" : status === "reverted" ? "reverted" : "draft";
}

/**
 * A sub-agent:
 *
 *   planned → queued → initializing → working ⇄ verifying ⇄ needs_you
 *                                       working ⇄ asking
 *                                            → completed | failed | stopped
 *
 * "planned" is a task in a plan that has not been run yet. "needs_you" is a
 * sub-agent waiting on an approval or an answer from the user. "asking" is a
 * sub-agent waiting for the coordinator to answer its question.
 */
export type AgentState = "planned" | "queued" | "initializing" | "working" | "verifying" | "asking" | "needs_you" | "completed" | "failed" | "stopped";

export const AGENT_LABEL: Record<AgentState, string> = {
  planned: "Not started",
  queued: "Queued",
  initializing: "Starting",
  working: "Working",
  verifying: "Running checks",
  asking: "Asking the coordinator",
  needs_you: "Needs you",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

export function agentState(
  status: TaskStatus,
  opts: { planStarted: boolean; hasActivity: boolean; waitingOnUser: boolean; askingCoordinator?: boolean },
): AgentState {
  switch (status) {
    case "pending":
      return opts.planStarted ? "queued" : "planned";
    case "running":
      if (opts.waitingOnUser) return "needs_you";
      if (opts.askingCoordinator) return "asking";
      return opts.hasActivity ? "working" : "initializing";
    case "verifying":
      return opts.waitingOnUser ? "needs_you" : "verifying";
    case "awaiting_approval":
      return "needs_you";
    case "done":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
  }
}

export function isActiveAgent(s: AgentState): boolean {
  return s === "initializing" || s === "working" || s === "verifying" || s === "asking" || s === "needs_you";
}

/**
 * The coordinator, which lives across the whole conversation and may plan new
 * tasks while sub-agents run. A finished sub-agent does not mean the
 * coordinator is finished.
 */
export type CoordinatorState = "idle" | "thinking" | "supervising" | "needs_you" | "stopping" | "finished" | "partial" | "stopped" | "failed";

export const COORDINATOR_LABEL: Record<CoordinatorState, string> = {
  idle: "Ready",
  thinking: "Working",
  supervising: "Supervising",
  needs_you: "Needs you",
  stopping: "Stopping",
  finished: "Finished",
  partial: "Partly done",
  stopped: "Stopped",
  failed: "Failed",
};

export function coordinatorState(opts: {
  busy?: string;
  stopping: boolean;
  runningRun: boolean;
  waitingOnUser: boolean;
  done?: "finished" | "partial" | "stopped" | "failed";
}): CoordinatorState {
  if (opts.busy) {
    if (opts.stopping) return "stopping";
    if (opts.waitingOnUser) return "needs_you";
    return opts.runningRun ? "supervising" : "thinking";
  }
  if (opts.waitingOnUser) return "needs_you";
  return opts.done ?? "idle";
}

/**
 * Lines added and removed between two texts, like a diff's +/- counts.
 * Common leading and trailing lines are skipped; the rest is compared with a
 * longest-common-subsequence when it is small enough, otherwise counted whole.
 */
export function lineCounts(original: string | null, proposed: string): { added: number; removed: number } {
  const split = (s: string) => (s === "" ? [] : s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));
  const a = original === null ? [] : split(original);
  const b = split(proposed);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0 || midB.length === 0 || midA.length * midB.length > 4_000_000) {
    return { added: midB.length, removed: midA.length };
  }
  // One row of the LCS table at a time.
  let prev = new Uint32Array(midB.length + 1);
  let row = new Uint32Array(midB.length + 1);
  for (let i = 1; i <= midA.length; i++) {
    for (let j = 1; j <= midB.length; j++) {
      row[j] = midA[i - 1] === midB[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!);
    }
    [prev, row] = [row, prev];
  }
  const common = prev[midB.length]!;
  return { added: midB.length - common, removed: midA.length - common };
}
