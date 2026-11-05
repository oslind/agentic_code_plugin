import { INTERRUPTED, TaskStore } from "../state/taskStore";
import { Run } from "../state/types";
import { ConversationStore } from "./conversationStore";
import { resumableTasks, resumeState } from "../state/resume";
import { ChatHost } from "./host";
import { ChatSession } from "./session";
import { PlanView } from "./viewState";
import { isCard, plural } from "./helpers";

/**
 * What a VS Code restart left behind: runs are matched to their
 * conversations, research cut off by the restart is marked failed, change
 * runs that were cut off are offered for resuming, and cards nobody can
 * answer any more are closed.
 */
export class Restarts {
  private readonly host: ChatHost;
  private readonly tasks: TaskStore;
  private readonly conversations: ConversationStore;

  constructor(
    private readonly s: ChatSession
  ) {
    this.host = s.host;
    this.tasks = s.tasks;
    this.conversations = s.conversations;
  }

  /** Change runs a restart cut off, found when the chat started. */
  readonly interrupted: { runId: string; conversationId: string; request: string }[] = [];
  async indexRuns(): Promise<void> {
    for (const s of await this.conversations.list()) {
      const c = await this.conversations.load(s.id).catch(() => undefined);
      // Runs another VS Code window is working on right now: their cards are still live there.
      const elsewhere = new Set<string>();
      for (const runId of c?.runIds ?? []) {
        this.s.runOwner.set(runId, s.id);
        const run = await this.tasks.load(runId).catch(() => undefined);
        if (!run) continue;
        // Research that was cut off by a restart has no live sub-agent; mark it failed.
        for (const t of run.kind === "research" ? run.tasks.filter((x) => x.status === "running") : []) {
          await this.tasks.setStatus(runId, t.id, "failed", INTERRUPTED).catch(() => undefined);
        }
        const state = resumeState(run, process.pid);
        if (state === "elsewhere") elsewhere.add(runId);
        if (state === "interrupted") await this.noteInterrupted(s.id, run).catch((err) => this.host.log("warn", `Could not mark run ${runId} as interrupted: ${(err as Error).message}`));
      }
      // Nothing in this window waits on a card from before it started, so those cards can no longer be answered.
      if (c?.entries.some((e) => isCard(e) && !e.decided && !(e.runId && elsewhere.has(e.runId)))) {
        await this.conversations
          .update(s.id, (conv) => {
            for (const e of conv.entries) if (isCard(e) && !e.decided && !(e.runId && elsewhere.has(e.runId))) e.decided = "Not answered: VS Code was closed";
          })
          .catch(() => undefined);
      }
    }
    this.s.currentId ??= (await this.conversations.list())[0]?.id;
    const current = this.s.currentId ? await this.conversations.load(this.s.currentId).catch(() => undefined) : undefined;
    if (current) this.s.mode = current.mode;
  }

  /**
   * A change run VS Code closed under: its cut-off tasks are marked stopped,
   * and the chat says what is kept and offers to resume.
   */
  async noteInterrupted(conversationId: string, run: Run): Promise<void> {
    const cut = await this.tasks.markInterrupted(run.id);
    const after = await this.tasks.load(run.id);
    const done = after.tasks.filter((t) => t.status === "done").length;
    const drafts = (after.changes ?? []).filter((c) => c.status === "pending").length;
    this.interrupted.push({ runId: run.id, conversationId, request: run.request });
    await this.conversations.append(conversationId, {
      author: "system",
      runId: run.id,
      tone: "warning",
      tag: "interrupted",
      text: [
        `VS Code closed while this run was working${cut.length ? ` on ${plural(cut.length, "task")}` : ""}. ${done} of ${after.tasks.length} task(s) are done.`,
        drafts ? `${plural(drafts, "draft")} are kept under Changes for your review.` : "",
        `Press "Resume" to continue where it stopped: sub-agents that were cut off pick up from their last step.`,
      ].filter(Boolean).join(" "),
    });
  }

  resumeView(run: Run): Pick<PlanView, "resumable" | "tasksLeft"> {
    if (this.s.runningRunId === run.id) return {};
    const state = resumeState(run, process.pid);
    if (state !== "interrupted" && state !== "stopped") return {};
    return { resumable: state, tasksLeft: resumableTasks(run).length };
  }

  /** Change runs found cut off by a restart when the chat started, for the "Resume?" notification. */
  async interruptedRuns(): Promise<{ runId: string; conversationId: string; request: string }[]> {
    const out = [];
    for (const r of this.interrupted) {
      const run = await this.tasks.load(r.runId).catch(() => undefined);
      if (run && resumeState(run, process.pid) && this.s.runningRunId !== r.runId) out.push(r);
    }
    return out;
  }

}
