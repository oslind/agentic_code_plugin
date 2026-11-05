import * as path from "path";
import { AGENT_DIR, publishDrafts } from "../coordinator/orchestrator";
import { OverlayFiles, pendingBase } from "../changes/overlay";
import { ScratchCopy } from "../changes/scratch";
import { TaskStore } from "../state/taskStore";
import { PendingChange, Run, Task } from "../state/types";
import { ToolCall } from "../tools/protocol";
import { ConversationStore } from "./conversationStore";
import { WorkspaceSandbox } from "../tools/sandbox";
import { Worker } from "../worker/worker";
import { ChatHost } from "./host";
import { ChatSession } from "./session";
import { FollowUpState } from "./viewState";
import { asSentence } from "./helpers";
import { earlierWork } from "./scope";
import { Approvals } from "./approvals";

/**
 * A conversation the user reopened with a sub-agent whose task had ended.
 * The sub-agent resumes with its saved history. Its drafts become pending
 * changes of its run, and when the conversation ends it reports what is new
 * to the coordinator.
 */
interface FollowUp {
  key: string;
  runId: string;
  taskId: string;
  title: string;
  conversationId: string;
  worker: Worker;
  abort: AbortController;
  /** This sub-agent's view of the project, for one that may change files. */
  overlay?: OverlayFiles;
  scratch?: ScratchCopy;
  published: Map<string, string>;
  /** The replies it gave, used if the closing summary cannot be made. */
  replies: string[];
  /** Answering a message right now. */
  working?: Promise<void>;
  /** Writing its update for the coordinator. */
  ending?: Promise<void>;
  /** The last step it logged, so its reply is in the chat before it counts as done. */
  logged?: Promise<void>;
}

const FOLLOW_UP_END = `The user ended this conversation. Call finish now, without other tools. The summary is your update for the coordinator, who plans the next work: in a few sentences, say only what is new since your original report (findings, answers, decisions the user made, drafts you made). If nothing new came up, say "Nothing new."`;

/**
 * Direct messages to sub-agents, and conversations the user reopens with a
 * sub-agent whose task ended. A reopened sub-agent resumes with its saved
 * history, every write and command it wants needs the user's approval, and
 * when the conversation ends it reports what is new to the coordinator.
 */
export class FollowUps {
  /** Conversations the user reopened with finished sub-agents, by "runId:taskId". */
  readonly chats = new Map<string, FollowUp>();
  private readonly host: ChatHost;
  private readonly tasks: TaskStore;
  private readonly conversations: ConversationStore;

  constructor(
    private readonly s: ChatSession,
    private readonly approvals: Approvals,
  ) {
    this.host = s.host;
    this.tasks = s.tasks;
    this.conversations = s.conversations;
  }

  /**
   * Sends a message straight to a sub-agent. A running one reads it before
   * its next step. One whose task has ended is reopened: it resumes with its
   * saved conversation and answers, until the user ends the conversation.
   */
  async messageAgent(runId: string, taskId: string, text: string): Promise<void> {
    const conversationId = this.s.runOwner.get(runId);
    if (!conversationId || !text.trim()) return;
    const run = await this.tasks.load(runId);
    const task = run.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const key = `${runId}:${taskId}`;
    const follow = this.chats.get(key);
    const warn = (msg: string) => this.s.append(conversationId, { author: "system", runId, taskId, agentName: task.title, text: msg, tone: "warning" });
    if (task.status === "running" || task.status === "verifying" || follow?.working) {
      this.s.inboxes.set(key, [...(this.s.inboxes.get(key) ?? []), { from: "user", text: text.trim() }]);
      await this.s.append(conversationId, { author: "user", kind: "direct", runId, taskId, agentName: task.title, text: text.trim() });
      return;
    }
    if (follow?.ending) {
      await warn(`"${task.title}" is passing what it learned to the coordinator. Send your message again in a moment to start a new conversation.`);
      return;
    }
    if (task.status === "pending" || task.status === "awaiting_approval") {
      await warn(`"${task.title}" has not started yet, so it cannot get messages.`);
      return;
    }
    if (this.s.runningRunId === runId) {
      await warn(`The other sub-agents of "${task.title}"'s run are still working. You can talk with it again once the run is done.`);
      return;
    }
    await this.s.append(conversationId, { author: "user", kind: "direct", runId, taskId, agentName: task.title, text: text.trim() });
    try {
      const f = follow ?? (await this.openFollowUp(conversationId, run, task));
      this.answerFollowUp(f, text.trim());
    } catch (err) {
      await this.s.append(conversationId, { author: "system", kind: "error", runId, taskId, agentName: task.title, text: `Could not reopen "${task.title}": ${(err as Error).message}`, tone: "error" });
    }
  }

  /** What each reopened sub-agent conversation is doing, by "runId:taskId". */
  followUpStates(): Record<string, FollowUpState> {
    const out: Record<string, FollowUpState> = {};
    for (const [key, f] of this.chats) out[key] = f.ending ? "ending" : f.working ? "working" : "open";
    return out;
  }

  /** Brings a sub-agent whose task ended back, with its saved conversation, under the usual permissions. */
  async openFollowUp(conversationId: string, run: Run, task: Task): Promise<FollowUp> {
    const workspaceRoot = run.workspaceRoot ?? (await this.conversations.load(conversationId)).workspaceRoot;
    const root = await this.host.openFolder(workspaceRoot);
    if (!root) throw new Error(`${workspaceRoot} is not open in VS Code, so the sub-agent cannot read it.`);
    const research = run.kind === "research" || task.fileScope.length === 0;
    const key = `${run.id}:${task.id}`;
    const abort = new AbortController();
    const disk = await WorkspaceSandbox.create(root);
    // Like during its task: the project as on disk, plus the drafts still waiting for review.
    const overlay = research ? undefined : new OverlayFiles(disk, pendingBase(run.changes));
    // Commands run in a copy, never in the project itself; a researcher's copy just has no drafts.
    const scratch = new ScratchCopy(root, path.join(root, AGENT_DIR, "scratch", `followup-${run.id.slice(0, 8)}`, task.id), ["node_modules"]);
    const checks = research ? [] : ((await this.host.checksFor(workspaceRoot)).saved ?? []);
    const hooks = this.approvals.hooksFor(conversationId, run.id, checks, workspaceRoot);
    const history = await this.tasks.loadHistory(run.id, task.id);
    const published = new Map<string, string>();
    const f: FollowUp = { key, runId: run.id, taskId: task.id, title: task.title, conversationId, abort, overlay, scratch, published, replies: [], worker: undefined as unknown as Worker };
    const conversation = await this.conversations.load(conversationId);
    f.worker = new Worker({
      provider: this.s.live.wrap(this.host.provider(workspaceRoot), key),
      sandbox: overlay ?? disk,
      checkDir: () => scratch.sync(overlay ? overlay.allChanges() : new Map()),
      terminal: this.host.terminal?.(workspaceRoot),
      task,
      checks,
      maxTurns: this.host.researchLimits().maxTurns,
      signal: abort.signal,
      readOnly: research,
      followUp: true,
      history,
      // Without a saved conversation (older runs), it gets what the chat shows of its work.
      context: history?.length ? undefined : earlierWork(task, conversation.entries, run.id),
      // Never auto-approved: its history may hold injected text from files it read, so the user decides every write and command.
      // A researcher cannot write (its file scope is empty), so for it this only covers commands.
      approve: (reason, call, preview) => this.askFollowUpApproval(conversationId, run.id, task, reason, call, preview),
      // Also never auto-approved, and never remembered: each command run is one card for this sub-agent only.
      approveCommand: research
        ? undefined
        : (check) => this.askFollowUpApproval(conversationId, run.id, task, `Run the check "${check.name}" (\`${check.command}\`)`, { tool: "run_check", name: check.name }),
      askUser: (q) => hooks.askUser(task, q),
      beforeAsk: overlay ? async () => void (await publishDrafts(this.tasks, run.id, task, overlay, published, (t, c) => this.announceFollowUpDrafts(conversationId, run.id, t, c))) : undefined,
      inbox: () => this.s.drainInbox(run.id, task.id),
      log: (type, message, data) => {
        // Its finish is a reply to the user here, or, when the conversation ends, its update for the coordinator.
        if (type === "tool_call" && message === "finish") type = f.ending ? "followup_summary" : "followup_reply";
        const summary = (data?.call as { summary?: unknown } | undefined)?.summary;
        f.logged = this.tasks
          .log({ runId: run.id, taskId: task.id, type, message: type.startsWith("followup_") && typeof summary === "string" ? summary : message, data })
          .catch(() => undefined);
      },
    });
    this.chats.set(key, f);
    await this.tasks.log({ runId: run.id, taskId: task.id, type: "followup_opened", message: history?.length ? "with history" : "from the chat" });
    this.s.changed();
    return f;
  }

  /** Lets a reopened sub-agent answer, then any messages that came in meanwhile. */
  answerFollowUp(f: FollowUp, text: string): void {
    const task = async () => {
      let next: string | undefined = text;
      while (next !== undefined && !f.abort.signal.aborted) {
        const result = await f.worker.run(`Message from the user: ${next}`);
        f.replies.push(result.summary);
        await this.settleFollowUpLog(f);
        await this.publishFollowUpDrafts(f);
        await this.tasks.saveHistory(f.runId, f.taskId, f.worker.history()).catch(() => undefined);
        const more = this.s.drainInbox(f.runId, f.taskId);
        next = more.length ? more.join("\n\n") : undefined;
      }
    };
    f.working = task()
      .catch(async (err) => {
        if (f.abort.signal.aborted) return;
        await this.s.append(f.conversationId, { author: "system", kind: "error", runId: f.runId, taskId: f.taskId, agentName: f.title, text: `"${f.title}" could not answer: ${(err as Error).message}`, tone: "error" });
      })
      .finally(() => {
        f.working = undefined;
        this.s.changed();
      });
    this.s.changed();
  }

  /**
   * A reopened sub-agent's write or new command. Always a card for the user,
   * whatever the auto-approve switches say: its conversation may carry
   * instructions planted in a file it read, so it never gets to act alone.
   */
  async askFollowUpApproval(conversationId: string, runId: string, task: Task, reason: string, call: ToolCall, preview?: string): Promise<boolean> {
    const { decision } = await this.s.waitFor(conversationId, {
      author: "agent",
      kind: "approval",
      runId,
      taskId: task.id,
      agentName: task.title,
      preview,
      text:
        call.tool === "run_command"
          ? `I'd like to run \`${call.command}\`.${call.reason ? ` ${asSentence(call.reason)}` : ""} In a reopened conversation every command needs your approval, even with Run commands on. Allowing it covers this one run by me only. It runs in a copy of the project, but like any command it runs as you, so only allow it if you trust it.`
          : call.tool === "request_check"
          ? `I'd like to run \`${call.command}\` as check "${call.name}". ${call.reason} In a reopened conversation every command needs your approval, even with Run commands on. Allowing it covers this one run by me only. It runs as you, so only allow it if you trust it.`
          : call.tool === "run_check"
            ? `${reason}. In a reopened conversation every command needs your approval, even a saved check with Run commands on. Allowing it covers this one run by me only. It runs as you, so only allow it if you trust it.`
            : `${reason}. In a reopened conversation every change needs your approval, even with Edit files on, and it stays a draft for review afterwards.`,
    });
    // Deliberately not remembered (no allowedFor): an approval covers this one call by this sub-agent, nothing else.
    return decision?.kind === "allow";
  }

  /** A reopened sub-agent's drafts: put up for review, and never written by an auto-approve switch. */
  async announceFollowUpDrafts(conversationId: string, runId: string, task: Task, changes: PendingChange[]): Promise<void> {
    await this.s.append(conversationId, {
      author: "agent",
      kind: "review",
      runId,
      taskId: task.id,
      agentName: task.title,
      tone: "warning",
      text: `I have ${changes.length} draft change(s) for you to review under Changes. Changes from a reopened conversation are never accepted automatically: nothing is written until you accept.`,
    });
    for (const ch of changes.slice(0, 3)) await this.host.showChange(runId, ch.path).catch((err) => this.host.log("warn", (err as Error).message));
  }

  /** Lets the reopened sub-agent's latest step land in the chat. */
  async settleFollowUpLog(f: FollowUp): Promise<void> {
    await f.logged;
    await this.s.settle();
  }

  async publishFollowUpDrafts(f: FollowUp): Promise<void> {
    if (!f.overlay) return;
    const run = await this.tasks.load(f.runId);
    const task = run.tasks.find((t) => t.id === f.taskId);
    if (!task) return;
    const changes = await publishDrafts(this.tasks, f.runId, task, f.overlay, f.published, (t, c) => this.announceFollowUpDrafts(f.conversationId, f.runId, t, c));
    if (changes.length) {
      const files = [...new Set([...(task.changedFiles ?? []), ...changes.map((c) => c.path)])];
      await this.tasks.updateTask(f.runId, f.taskId, { changedFiles: files });
    }
  }

  /**
   * Ends a reopened conversation. What came up is added to the chat as an
   * update for the coordinator, which it sees in its next turn and passes to
   * the planner and later sub-agents. With `summarize`, the sub-agent writes
   * it; otherwise (Stop) its replies are passed on as they are.
   */
  endFollowUp(f: FollowUp, summarize: boolean): Promise<void> {
    if (f.ending) return f.ending;
    f.ending = (async () => {
      this.s.changed();
      // Still answering: it is stopped rather than waited for, and its replies so far are passed on as they are.
      if (f.working) summarize = false;
      if (!summarize) {
        f.abort.abort();
        for (const [id, p] of [...this.s.pending]) {
          if (p.runId !== f.runId || p.taskId !== f.taskId) continue;
          this.s.pending.delete(id);
          void this.s.markDecided(p.conversationId, id, "Closed: the conversation ended");
          p.resolve(undefined);
        }
      }
      await f.working;
      let update: string | undefined;
      if (summarize && f.replies.length && !f.abort.signal.aborted) {
        try {
          update = (await f.worker.run(FOLLOW_UP_END)).summary.trim();
          await this.settleFollowUpLog(f);
          await this.publishFollowUpDrafts(f);
          await this.tasks.saveHistory(f.runId, f.taskId, f.worker.history()).catch(() => undefined);
        } catch (err) {
          this.host.log("warn", `Follow-up summary failed: ${(err as Error).message}`);
        }
      }
      if (!update && f.replies.length) update = f.replies.map((r) => r.replace(/\s+/g, " ").trim()).join(" ").slice(0, 1500);
      f.abort.abort();
      await f.scratch?.remove().catch(() => undefined);
      this.chats.delete(f.key);
      if (update) {
        const run = await this.tasks.load(f.runId).catch(() => undefined);
        const task = run?.tasks.find((t) => t.id === f.taskId);
        if (task) {
          // Later plans and the sub-agents that build on this task see it in its report.
          const followUpNote = `After a follow-up with the user: ${update}`;
          await this.tasks.updateTask(f.runId, f.taskId, { summary: task.summary ? `${task.summary}\n\n${followUpNote}` : followUpNote }).catch(() => undefined);
        }
        await this.s.append(f.conversationId, {
          author: "coordinator",
          kind: "report",
          runId: f.runId,
          taskId: f.taskId,
          agentName: f.title,
          tag: "update from follow-up",
          text: `Update from "${f.title}" after you talked with it again: ${update}`,
        });
      } else {
        this.s.changed();
      }
    })();
    return f.ending;
  }

  /** Ends every reopened conversation of a conversation, so the coordinator knows what came up before it answers. */
  async endFollowUpsOf(conversationId: string): Promise<void> {
    const open = [...this.chats.values()].filter((f) => f.conversationId === conversationId);
    if (open.length === 0) return;
    this.s.busy = `Collecting what ${open.length === 1 ? `"${open[0]!.title}"` : `${open.length} sub-agents`} learned in your follow-up…`;
    this.s.changed();
    try {
      await Promise.all(open.map((f) => this.endFollowUp(f, true)));
    } finally {
      this.s.busy = undefined;
    }
  }


  /** Ends every reopened conversation without a summary (Stop): what each one said is passed on as it is. */
  endAll(): void {
    for (const f of [...this.chats.values()]) void this.endFollowUp(f, false);
  }

  /** Stops every reopened conversation at once, for dispose. */
  abortAll(): void {
    for (const f of this.chats.values()) f.abort.abort();
  }
}
