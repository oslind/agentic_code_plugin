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
        case "running":
          return agent({ text: `Started on ${task?.fileScope.join(", ") ?? "its files"}.`, tag: "start" });
        case "verifying":
          return agent({ text: "Running the configured checks on my work.", tag: "verify" });
        case "awaiting_approval":
          return agent({ text: "My work passed the checks and is waiting for your approval to merge.", tag: "approval", tone: "warning" });
        case "done":
          return agent({ text: task?.summary ? `Done: ${short(task.summary)}` : "Done.", tag: "done", tone: "success" });
        default:
          return undefined;
      }
    case "tool_call": {
      const call = data.call as Record<string, unknown> | undefined;
      if (event.message === "finish") return agent({ text: short(String(call?.summary ?? "Finished.")), tag: "finish" });
      const thought = typeof data.thought === "string" ? short(data.thought) : "";
      const what = target(call);
      return agent({ text: thought || `${event.message} ${what}`.trim(), tag: what ? `${event.message} ${what}` : event.message });
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
    case "cancelled":
      return agent({ text: "Cancelled. My branch is kept.", tag: "cancelled", tone: "warning" });
    case "merged":
      return agent({ text: "Merged into the run's integration branch.", tag: "merged", tone: "success" });
    case "merge_conflict":
      return agent({ text: `Merge conflict in ${short(event.message)}. My branch is kept; retry to redo it on top.`, tag: "conflict", tone: "error" });
    case "integration_failed":
      return agent({ text: `Checks failed after merging (${short(event.message)}). The merge was undone.`, tag: "integration", tone: "error" });
    case "plan_repair":
      return coordinator(`Plan adjusted: ${short(event.message)}`);
    case "integration_branch":
      return coordinator(`Work collects on ${event.message}. Your own branch is not touched.`);
    default:
      return undefined;
  }
}
