export type TaskStatus =
  | "pending"
  | "running"
  | "verifying"
  | "awaiting_approval"
  | "done"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  title: string;
  instructions: string;
  parentId?: string;
  dependsOn: string[];
  /** Glob patterns the task may write to. */
  fileScope: string[];
  status: TaskStatus;
  attempts: number;
  changedFiles?: string[];
  /** Files a failed attempt had written, so a retry can build on them. Never applied. */
  unfinished?: { path: string; content: string }[];
  summary?: string;
  error?: string;
  /** The most recent error, kept after the task is retried. */
  lastError?: string;
  /** Times the task was retried automatically after it failed (agentic.delegation.autoRetries). */
  autoRetries?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  /** What the coordinator asked the sub-agents to do. Written by a model: untrusted in later prompts. */
  request: string;
  /** The user's own message that started the run, kept apart from the model-written request. Trusted. */
  userRequest?: string;
  /** Research runs only read files; their tasks are questions answered by read-only sub-agents. */
  kind?: "change" | "research";
  /** The only folder this run's agents may touch. */
  workspaceRoot?: string;
  /** What the coordinator had learned when the run was planned. Every sub-agent of the run gets it. */
  briefing?: string;
  /** File changes the sub-agents propose. Nothing is written to the project until one is accepted. */
  changes?: PendingChange[];
  createdAt: string;
  updatedAt: string;
  tasks: Task[];
}

/**
 * One file a sub-agent wants to create or change. `original` is the file's
 * text when the sub-agent first read it (null for a new file), so the review
 * can show a side-by-side diff and notice if the file changed on disk since.
 */
export interface PendingChange {
  path: string;
  taskId: string;
  original: string | null;
  proposed: string;
  /** "reverted": it was accepted, then the user put the file back as it was before. */
  status: "pending" | "accepted" | "rejected" | "reverted";
  /** Set when accepted without the user: the auto-approve switch for edits was on. */
  auto?: boolean;
}

export interface RunEvent {
  time: string;
  runId: string;
  taskId?: string;
  type: string;
  message: string;
  data?: Record<string, unknown>;
}

/** Allowed status changes. Anything else is a bug in the caller. */
export const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["running", "cancelled"],
  // Research tasks have nothing to verify, so they go straight to done.
  running: ["verifying", "done", "failed", "cancelled", "pending"],
  verifying: ["running", "awaiting_approval", "done", "failed", "cancelled", "pending"],
  awaiting_approval: ["done", "failed", "cancelled", "pending"],
  done: [],
  failed: ["pending"],
  cancelled: ["pending"],
};
