import { RunEvent, Task } from "../state/types";
import { ChatEntry } from "./types";

type FeedEntry = Omit<ChatEntry, "id" | "time">;

function short(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function target(call: Record<string, unknown> | undefined): string {
  if (!call) return "";
  for (const key of ["path", "glob", "query", "name", "command"]) {
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
      if (event.message === "ask_coordinator") {
        return agent({ kind: "consult", text: String(call?.question ?? ""), tag: "asked the coordinator", thought: thought || undefined, thinking });
      }
      if (event.message === "finish") {
        return agent({ kind: "report", text: String(call?.summary ?? "Finished."), tag: "report to coordinator", thought: thought || undefined, thinking });
      }
      const what = target(call);
      return agent({ text: thought || `${event.message} ${what}`.trim(), thought: thought || undefined, thinking, tag: what ? `${event.message} ${what}` : event.message });
    }
    case "command": {
      const secs = typeof data.durationMs === "number" ? ` in ${(data.durationMs / 1000).toFixed(1)}s` : "";
      const code = typeof data.code === "number" ? data.code : undefined;
      const status = data.timedOut
        ? `Timed out${secs}.`
        : data.passed
          ? `Finished${secs} (exit code 0).`
          : code !== undefined
            ? `Failed${secs} (exit code ${code}).`
            : `Did not run to the end${secs}.`;
      const check = typeof data.check === "string" ? data.check : undefined;
      return agent({
        kind: "command",
        text: `${check ? `Check "${check}": ` : ""}${status} The full output is in the Agentic Code terminal.`,
        tag: check ? `check ${check}` : "ran a command",
        tone: data.passed ? "success" : "warning",
        command: { line: String(data.command ?? event.message), output: typeof data.output === "string" ? data.output : "" },
      });
    }
    case "followup_opened":
      return agent({
        text:
          event.message === "with history"
            ? "Reopened. I remember my task and what I did, and I'm answering your message."
            : "Reopened. My earlier conversation was not saved, so I'm going by my report and the steps shown here.",
        tag: "reopened",
      });
    case "followup_reply": {
      const thinking = typeof data.thinking === "string" && data.thinking.trim() ? data.thinking.trim() : undefined;
      const thought = typeof data.thought === "string" ? short(data.thought) : "";
      return agent({ text: event.message, tag: "reply", thought: thought || undefined, thinking });
    }
    case "coordinator_answer": {
      // The user's own answer is already on the question card.
      if (data.from === "user") return undefined;
      const thinking = typeof data.thinking === "string" && data.thinking.trim() ? data.thinking.trim() : undefined;
      return {
        author: "coordinator",
        kind: "consult",
        runId: event.runId,
        taskId: event.taskId,
        agentName: task?.title ?? event.taskId,
        tag: data.failed ? "could not answer" : "answered",
        tone: data.failed ? "warning" : undefined,
        text: event.message,
        thought: typeof data.thought === "string" ? short(data.thought) : undefined,
        thinking,
        quote: typeof data.question === "string" ? data.question : undefined,
      };
    }
    case "coordinator_checkin": {
      const name = `"${task?.title ?? event.taskId ?? "a sub-agent"}"`;
      // Shown to the user only; the evidence names the call a sub-agent repeated.
      const detail = [data.detail, data.evidence].filter((x): x is string => typeof x === "string" && !!x).map((x) => (/[.!?]$/.test(x) ? x : `${x}.`)).join(" ");
      const adjusted = typeof data.adjusted === "string" ? ` (${data.adjusted})` : "";
      const progress = data.concern === "progress";
      const text =
        event.message === "stop"
          ? `Stopped ${name}. ${detail} Its drafts are kept for your review, and you can retry the task.`
          : event.message === "message"
            ? `Checked on ${name}. ${detail} I sent it a note: ${String(data.note ?? "")}${adjusted}`
            : progress
              ? `Checked on ${name}'s progress. It is on track, and I had nothing to add.${adjusted}`
              : `Checked on ${name}. ${detail} It looks fine, so I let it continue.${adjusted}`;
      const thinking = typeof data.thinking === "string" && data.thinking.trim() ? data.thinking.trim() : undefined;
      return {
        author: "coordinator",
        kind: "checkin",
        runId: event.runId,
        taskId: event.taskId,
        agentName: task?.title ?? event.taskId,
        tag: event.message === "stop" ? "stopped by coordinator" : event.message === "message" ? "note from coordinator" : progress ? "progress check" : "check-in",
        tone: event.message === "stop" ? "warning" : "info",
        text,
        thought: typeof data.thought === "string" ? short(data.thought) : undefined,
        thinking,
      };
    }
    case "coordinator_review": {
      const name = `"${task?.title ?? event.taskId ?? "a sub-agent"}"`;
      const revise = event.message === "revise";
      const feedback = typeof data.feedback === "string" ? data.feedback.trim() : "";
      const adjusted = typeof data.adjusted === "string" ? ` (${data.adjusted})` : "";
      const thinking = typeof data.thinking === "string" && data.thinking.trim() ? data.thinking.trim() : undefined;
      return {
        author: "coordinator",
        kind: "checkin",
        runId: event.runId,
        taskId: event.taskId,
        agentName: task?.title ?? event.taskId,
        tag: revise ? "sent back" : "reviewed",
        tone: revise ? "warning" : "info",
        text: revise
          ? `Reviewed ${name}'s result and sent it back: ${feedback}`
          : `Reviewed ${name}'s result and accepted it.${feedback ? ` ${feedback}` : ""}${adjusted}`,
        thought: typeof data.thought === "string" ? short(data.thought) : undefined,
        thinking,
      };
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
