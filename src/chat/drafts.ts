import { TaskStore } from "../state/taskStore";
import { acceptChange, rejectChange } from "../changes/review";
import { ConversationStore } from "./conversationStore";
import { ChatHost } from "./host";
import { ChatSession } from "./session";
import { ReviewAction } from "./viewState";

/** Accepting and rejecting pending changes from the chat. Nothing is written until the user accepts. */
export class Drafts {
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

  /**
   * Shows, accepts or rejects a pending change from the chat. Without a path,
   * accepts or rejects every pending change of that run's task (or the whole run).
   */
  async review(runId: string, action: ReviewAction, filePath?: string, taskId?: string): Promise<void> {
    const conversationId = this.s.runOwner.get(runId) ?? this.s.currentId;
    const run = await this.tasks.load(runId);
    if (action === "show") {
      if (filePath) await this.host.showChange(runId, filePath);
      return;
    }
    const root = run.workspaceRoot && (await this.host.openFolder(run.workspaceRoot));
    if (action === "open") {
      // The written file itself, for an accepted draft.
      if (!root) throw new Error(`${run.workspaceRoot ?? "This run's folder"} is not open in VS Code.`);
      if (filePath && run.changes?.some((c) => c.path === filePath && c.status === "accepted")) await this.host.afterAccept?.(root, [filePath], true);
      return;
    }
    if (!root) throw new Error(`${run.workspaceRoot ?? "This run's folder"} is not open in VS Code, so nothing can be written.`);
    const targets = (run.changes ?? []).filter(
      (c) => c.status === "pending" && (filePath ? c.path === filePath : !taskId || c.taskId === taskId),
    );
    const written: string[] = [];
    const held: string[] = [];
    const failed: string[] = [];
    for (const c of targets) {
      const key = `${runId}:${c.path}`;
      if (action === "reject") {
        await rejectChange(this.tasks, runId, c.path);
        this.s.changeNotes.delete(key);
      } else {
        // A second Accept after a "changed on disk" note means: overwrite.
        let res;
        try {
          res = await acceptChange(this.tasks, runId, c.path, root, { overwrite: this.s.changeNotes.has(key) });
        } catch (err) {
          // One file that cannot be written does not stop the others, and it says why on its card.
          const message = `Could not write ${c.path}: ${(err as Error).message}`;
          this.s.changeNotes.set(key, message);
          this.host.log("error", message);
          failed.push(message);
          continue;
        }
        if (res.ok) {
          this.s.changeNotes.delete(key);
          written.push(c.path);
        } else {
          this.s.changeNotes.set(key, res.message);
          held.push(res.message);
          continue;
        }
      }
      await this.host.closeChange(runId, c.path).catch(() => undefined);
    }
    // Each written file is announced from the store's log (see eventFeed). What was not written says why here,
    // in the chat and not only on its card, so an Accept never looks like it did nothing.
    const warnings = written.length ? ((await this.host.afterAccept?.(root, written, written.length === 1 && !!filePath).catch(() => [])) ?? []) : [];
    if (conversationId && targets.length > 1 && (written.length || action === "reject")) {
      const n = action === "accept" ? written.length : targets.length;
      await this.s.append(conversationId, { author: "system", runId, text: action === "accept" ? `Accepted ${n} draft(s) and wrote them to your project.` : `Rejected ${n} draft(s). Nothing was written for them.` });
    }
    if (conversationId && action === "accept" && (held.length || failed.length || warnings.length)) {
      await this.s.append(conversationId, { author: "system", runId, tone: "warning", text: [...held.map((m) => `Not written yet: ${m}`), ...failed, ...warnings].join("\n") });
    }
    this.s.changed();
    if (failed.length) throw new Error(failed.join(" "));
  }

}
