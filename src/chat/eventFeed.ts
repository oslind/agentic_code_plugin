import { RunEvent, Task } from "../state/types";
import { ChatEntry } from "./types";

type FeedEntry = Omit<ChatEntry, "id" | "time">;

function short(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function target(call: Record<string, unknown> | undefined): string {
  if (!call) return "";
  for (const key of ["path", "glob", "query", "name"]) {
    if (typeof call[key] === "string") return call[key] as string;
  }
  return "";
}

/**
 * Turns a run event into a chat message from the sub-agent (or the
 * coordinator) it belongs to. Events that are only bookkeeping return undefined.
 */
export function eventToEntry(event: RunEvent, tasks: Task[]): FeedEntry | undefined {
  const task = event.taskId ? tasks.find((t) => t.id === event.taskId) : undefined;
  const agent = (e: Omit<FeedEntry, "author" | "runId" | "taskId" | "agentName">): FeedEntry => ({
    author: "agent",
    runId: event.runId,
    taskId: event.taskId,
    agentName: task?.title ?? event.taskId ?? "Sub-agent",
    ...e,
  });
  const coordinator = (text: string, tone: ChatEntry["tone"] = "info"): FeedEntry => ({ author: "coordinator", runId: event.runId, text, tone });
  const data = event.data ?? {};

  switch (event.type) {
    case "status":
      if (!event.taskId) return undefined;
      switch (event.message) {
        case "running": {
          // Shown as the coordinator handing a task to a new sub-agent.
          const attempt = task && task.attempts > 1 ? ` (attempt ${task.attempts})` : "";
          return {
            author: "coordinator",
            kind: "spawn",
            runId: event.runId,
            taskId: event.taskId,
            agentName: task?.title ?? event.taskId,
            tag: "sub-agent started",
            text: `Started sub-agent "${task?.title ?? event.taskId}"${attempt}.\n${
              task && task.fileScope.length === 0 ? "Read-only: it may not change any files." : `May change: ${task?.fileScope.join(", ") ?? "its files"}`
            }${
              task ? `\nTask: ${short(task.instructions, 300)}` : ""
            }`,
          };
        }
        case "verifying":
          return agent({ text: "Running the checks on a scratch copy that has my changes. Your files are not touched.", tag: "verify" });
        case "done":
          return agent({ text: "Task complete.", tag: "done", tone: "success" });
        default:
          return undefined;
      }
    case "tool_call": {
      const call = data.call as Record<string, unknown> | undefined;
      // Whitespace-only thinking (some local models send it) would show as an empty box.
      const thinking = typeof data.thinking === "string" && data.thinking.trim() ? data.thinking.trim() : undefined;
      const thought = typeof data.thought === "string" ? short(data.thought) : "";
      if (event.message === "finish") {
        return agent({ kind: "report", text: String(call?.summary ?? "Finished."), tag: "report to coordinator", thought: thought || undefined, thinking });
      }
      const what = target(call);
      return agent({ text: thought || `${event.message} ${what}`.trim(), thought: thought || undefined, thinking, tag: what ? `${event.message} ${what}` : event.message });
    }
    case "denied":
      return agent({ text: `Blocked: ${short(event.message)}`, tag: "policy", tone: "warning" });
    case "checks":
      return agent({
        text: event.message === "passed" ? "Checks passed." : "Checks failed. Fixing.",
        tag: "checks",
        tone: event.message === "passed" ? "success" : "warning",
      });
    case "no_changes":
      return agent({ text: "Finished without changing any files.", tag: "done" });
    case "transient_failure":
      return agent({ text: `Model server trouble, retrying: ${short(event.message)}`, tag: "retry", tone: "warning" });
    case "task_failed":
      return agent({ text: `Failed: ${short(event.message)}`, tag: "failed", tone: "error" });
    case "cancelled": {
      const kept = Array.isArray(data.kept) ? (data.kept as string[]) : [];
      return agent({
        text: kept.length
          ? `Stopped. Nothing was written to your project. My drafts of ${kept.join(", ")} are kept: review them under Drafts, and Accept or Reject as usual.`
          : "Stopped. Nothing was written to your project.",
        tag: "stopped",
        tone: "warning",
      });
    }
    case "change_accepted":
      return { author: "system", text: `Accepted the draft of ${event.message} and wrote it to your project.`, tone: "success" };
    case "change_rejected":
      return { author: "system", text: `Rejected the draft of ${event.message}. Nothing was written.` };
    case "plan_repair":
      return coordinator(`Plan adjusted: ${short(event.message)}`);
    default:
      return undefined;
  }
}
