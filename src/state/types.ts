import { ChatMessage } from "../providers/types";

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
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  request: string;
  /** Research runs only read files; their tasks are questions answered by read-only sub-agents. */
  kind?: "change" | "research";
  /** The only folder this run's agents may touch. */
  workspaceRoot?: string;
  /** What the coordinator had learned when the run was planned. Every sub-agent of the run gets it. */
  briefing?: string;
  /** File changes the sub-agents propose. Nothing is written to the project until one is accepted. */
  changes?: PendingChange[];
  /**
   * The VS Code extension host running this run right now. Set while its
   * sub-agents work and cleared when they stop, so a run left with this set
   * by a process that no longer exists was cut off by a restart.
   */
  activeIn?: { pid: number; since: string };
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
  status: "pending" | "accepted" | "rejected";
  /** Set when accepted without the user: the auto-approve switch for edits was on. */
  auto?: boolean;
}

/**
 * Where a sub-agent was when it last started a step: its conversation and
 * its drafts. Saved as it works, so a sub-agent cut off by a restart can
 * continue from there instead of starting over.
 */
export interface TaskCheckpoint {
  savedAt: string;
  /** Steps it had taken in that attempt. */
  turns: number;
  history: ChatMessage[];
  drafts: { path: string; original: string | null; content: string }[];
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
