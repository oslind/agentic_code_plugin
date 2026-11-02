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
  branch?: string;
  /** Commit on `branch` with the task's verified work. */
  commit?: string;
  changedFiles?: string[];
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
  createdAt: string;
  updatedAt: string;
  tasks: Task[];
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
