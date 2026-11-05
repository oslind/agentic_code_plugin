import { INTERRUPTED } from "./taskStore";
import { Run, Task } from "./types";

/** Whether a process with this id is still running on this machine. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * How an unfinished change run stands when nothing in this window runs it:
 * - "elsewhere": another VS Code window is running it right now; leave it alone.
 * - "interrupted": VS Code closed (or crashed) while its sub-agents worked.
 * - "stopped": the user stopped it, or it ended with tasks never started.
 * Undefined when there is nothing to resume: a research run, an unstarted plan, or all tasks done or failed.
 */
export type ResumeState = "elsewhere" | "interrupted" | "stopped";

const MID_FLIGHT: ReadonlySet<Task["status"]> = new Set(["running", "verifying", "awaiting_approval"]);

export function resumeState(run: Run, ownPid: number, alive: (pid: number) => boolean = isProcessAlive): ResumeState | undefined {
  if (run.kind === "research" || run.tasks.length === 0) return undefined;
  const owner = run.activeIn?.pid;
  if (owner !== undefined && owner !== ownPid && alive(owner)) return "elsewhere";
  const started = run.tasks.some((t) => t.attempts > 0);
  if (!started) return undefined;
  if (run.tasks.some((t) => MID_FLIGHT.has(t.status))) return "interrupted";
  if (owner !== undefined && owner !== ownPid) return "interrupted";
  // Already marked after the restart, and not resumed yet.
  if (run.tasks.some((t) => t.status === "cancelled" && t.error === INTERRUPTED)) return "interrupted";
  return resumableTasks(run).length > 0 ? "stopped" : undefined;
}

/** Tasks a resume would run again or start: stopped ones, and ones never started whose dependencies did not fail. */
export function resumableTasks(run: Run): Task[] {
  const failed = new Set(run.tasks.filter((t) => t.status === "failed").map((t) => t.id));
  const blocked = (t: Task, seen = new Set<string>()): boolean =>
    t.dependsOn.some((d) => {
      if (failed.has(d)) return true;
      if (seen.has(d)) return false;
      seen.add(d);
      const dep = run.tasks.find((x) => x.id === d);
      return !!dep && blocked(dep, seen);
    });
  return run.tasks.filter((t) => (t.status === "cancelled" || t.status === "pending" || MID_FLIGHT.has(t.status)) && !blocked(t));
}
