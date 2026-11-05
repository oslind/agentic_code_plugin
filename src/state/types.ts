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
  /** "reverted": it was accepted, then the user put the file back as it was before. */
  status: "pending" | "accepted" | "rejected" | "reverted";
  /** Set when accepted without the user: the auto-approve switch for edits was on. */
  auto?: boolean;
  /**
   * The text this draft was built on: the last version its sub-agent put up
   * for review, or else what the file held (with earlier drafts of the run)
   * when the sub-agent first wrote it. A draft whose basis is not the pending
   * draft of the same file did not see that draft, so the two are combined
   * instead of one replacing the other.
   */
  basis?: string | null;
  /** Other sub-agents whose drafts of this file were combined into this one, by task id. */
  combinedWith?: string[];
  /** Set when the file on disk had changed and the draft was combined with it on Accept. */
  combinedWithDisk?: boolean;
  /** Two versions changed the same lines. The draft cannot be accepted until the user picks how to resolve it. */
  conflict?: DraftConflict;
}

/**
 * Two versions of one file that changed the same lines: this draft and either
 * another sub-agent's draft ("draft") or the file as it is now on disk
 * ("disk"). Nothing is lost: both texts are kept until the user picks one,
 * or both with conflict markers to sort out in the editor.
 */
export interface DraftConflict {
  with: "draft" | "disk";
  /** The other sub-agent, for a conflict between two drafts. */
  otherTaskId?: string;
  /** The other version: the other sub-agent's draft, or the file on disk. */
  other: string;
  /** The text both versions started from. */
  base: string;
  /** Both versions combined, with git-style markers around each conflicting part (the other version first). */
  markers: string;
  /** How many places conflict. */
  regions: number;
}

/** How the user resolves a conflict: keep the other version, keep this draft, or keep both with markers. */
export type ConflictChoice = "other" | "draft" | "both";

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
  drafts: { path: string; original: string | null; content: string; basis?: string | null }[];
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
