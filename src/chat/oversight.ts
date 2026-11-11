import { TaskStore } from "../state/taskStore";
import { unaskedFixes } from "../coordinator/verify";
import { WorkspaceSandbox } from "../tools/sandbox";
import { draftProblemsOf } from "../changes/moduleStyle";
import { Run, RunEvent, Task } from "../state/types";
import { ConversationStore } from "./conversationStore";
import { CoordinatorReply } from "../worker/worker";
import { answerSubAgent } from "../coordinator/consult";
import { failureLines } from "../checks/failures";
import { conventionsText } from "../skills/catalog";
import { asksResearchForCode, overrulesWithOtherReports, feedbackInScope, saysImpossible, nothingToRename, renameDoneInScope, revertsAccepted, onlyRunsOrChecks, withoutMootUndo, MAX_REVIEW_ROUNDS, ReviewOutcome, ReviewSkip, reviewSubAgentResult, ReviewVerdict } from "../coordinator/review";
import { AgentMonitor, Concern, CONCERN_LABEL, superviseAgent } from "../coordinator/monitor";
import { ChatHost, RunControl } from "./host";
import { ChatSession } from "./session";
import { clip } from "./helpers";
import { claimsChangeMade } from "./coordinatorChat";
import { matchesAny } from "../tools/paths";

/** A send-back because nothing was drafted. */
const NO_CHANGES = /\bno (?:code |file )?(?:changes?|drafts?|edits?|modifications?)\b|\bnothing (?:was |has been )?(?:changed|drafted|written|modified)\b|\b(?:did not|didn't|has not|hasn't|have not|haven't) (?:make|made|change|changed|modify|modified|write|written|draft|drafted)\b/i;
import { earlierAnswers, learnedSoFar, runScope, userMessagesOf } from "./scope";

/** A sentence that asks for a change ("Add …", "Please fix …", "Restore the original lines"). */
const IMPERATIVE = /^\W*(please\s+)?(add|fix|correct|change|update|remove|delete|use|make|write|move|restore|undo|revert|rename|replace|implement|put|include|return|handle|export|import|create|call|keep|drop|split|merge|wrap|set)\b/i;

/** The coordinator keeping tabs on the sub-agents of one run. */
export interface Supervision {
  conversationId: string;
  monitor: AgentMonitor;
  control?: RunControl;
  abort: AbortController;
  /** Sub-agents the coordinator is looking at right now. */
  inFlight: Set<string>;
}

/**
 * The coordinator overseeing sub-agents while they work: it watches every
 * step, checks on one that seems stuck or is due a progress look, answers
 * their questions, and reviews each result before it counts. How often is
 * set by the oversight level (agentic.delegation.oversight).
 */
export class Oversight {
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

  /** Runs whose sub-agents the coordinator is keeping tabs on, by run id. */
  readonly supervised = new Map<string, Supervision>();
  /** Sub-agents waiting for the coordinator's answer, by "runId:taskId", with their title. */
  readonly consulting = new Map<string, string>();
  /** Sub-agents the coordinator is checking on right now, by "runId:taskId", with their title. */
  readonly checkingOn = new Map<string, string>();
  /** Times the coordinator sent a sub-agent's result back, by "runId:taskId". */
  readonly reviewRounds = new Map<string, number>();
  /** How each sub-agent's latest result came out of review, by "runId:taskId". An unreviewed result is never auto-accepted. */
  readonly reviewOutcomes = new Map<string, ReviewOutcome>();

  /** The review outcome of each task of a run, for the team list the coordinator reads. */
  private reviewOf(runId: string): (taskId: string) => ReviewOutcome | undefined {
    return (taskId) => this.reviewOutcomes.get(`${runId}:${taskId}`);
  }
  /**
   * A run used its model-call budget. Its sub-agents are stopped as with
   * Stop (drafts kept for review, never written automatically), and the
   * coordinator stops looking at them. Research sub-agents fail on their next
   * step, and the answer is written from the reports so far.
   */
  budgetReached(runId: string, limit: number): void {
    this.host.log("warn", `Run ${runId} reached its limit of ${limit} model calls (agentic.delegation.maxModelCallsPerRun).`);
    this.supervised.get(runId)?.abort.abort();
    if (this.s.runningRunId === runId) this.host.cancelRun(runId);
    const conversationId = this.s.runOwner.get(runId);
    if (!conversationId) return;
    void this.s.append(conversationId, {
      author: "system",
      runId,
      tone: "warning",
      text: `This run reached its limit of ${limit} model calls (agentic.delegation.maxModelCallsPerRun in your user settings), so its sub-agents were stopped. Their drafts are kept under Changes for your review and are not written automatically. Raise the limit and retry the tasks to continue.`,
    }).catch((err) => this.host.log("warn", (err as Error).message));
  }

  /** Starts keeping tabs on a run's sub-agents. */
  supervise(runId: string, conversationId: string, maxTurns: number): void {
    this.supervised.get(runId)?.abort.abort();
    this.supervised.set(runId, { conversationId, monitor: new AgentMonitor({ maxTurns }), abort: new AbortController(), inFlight: new Set() });
  }

  endSupervision(runId: string): void {
    this.supervised.get(runId)?.abort.abort();
    this.supervised.delete(runId);
    this.s.budget.clear(runId);
    for (const map of [this.consulting, this.checkingOn, this.reviewRounds, this.reviewOutcomes]) for (const key of [...map.keys()]) if (key.startsWith(`${runId}:`)) map.delete(key);
  }

  /**
   * Every logged step of a supervised run passes through here. The monitor
   * counts steps without a model call; only a sign of trouble makes the
   * coordinator look at the sub-agent (at most the oversight level's check-ins
   * per sub-agent, one look at a time).
   */
  watch(event: RunEvent, run: Run): void {
    const s = this.supervised.get(event.runId);
    const task = event.taskId ? run.tasks.find((t) => t.id === event.taskId) : undefined;
    if (!s || !task) return;
    s.monitor.observe(event, task);
    // What it reported is news for the others: the coordinator looks at them soon after.
    if (event.type === "status" && event.message === "done") s.monitor.finished(task.id);
    if (event.type !== "tool_call" && event.type !== "denied" && event.type !== "checks") return;
    if (task.status !== "running" && task.status !== "verifying") return;
    if (s.inFlight.has(task.id) || s.abort.signal.aborted || this.s.budget.exhausted(run.id)) return;
    // Its last step was finishing: the review of its result is the next look.
    if (event.type === "tool_call" && event.message === "finish") return;
    const limits = this.host.delegationLimits();
    const limit = limits.checkIns ?? 2;
    let concern = limit > 0 && s.monitor.checkIns(task.id) < limit ? s.monitor.concerns(task.id)[0] : undefined;
    if (concern) s.monitor.markRaised(task.id, concern.kind);
    else if ((concern = s.monitor.progressDue(task.id, limits.progressEvery ?? 8))) s.monitor.markProgressCheck(task.id);
    if (!concern) return;
    s.inFlight.add(task.id);
    void this.checkOn(s, run, task, concern)
      .catch((err) => {
        if (!s.abort.signal.aborted) this.host.log("warn", `The coordinator could not check on "${task.title}": ${(err as Error).message}`);
      })
      .finally(() => {
        s.inFlight.delete(task.id);
        this.checkingOn.delete(`${run.id}:${task.id}`);
        this.s.changed();
      });
  }

  /**
   * A sub-agent's latest command, when it failed: the facts the coordinator must not talk it out of.
   * Run 9: a test sub-agent's node test.js showed median() returning undefined, and the coordinator,
   * trusting an earlier "tests passed", told it twice the function was correct and its test was wrong.
   */
  async lastFailedCommand(runId: string, taskId: string): Promise<string | undefined> {
    const events = await this.tasks.readLog(runId).catch(() => []);
    const last = [...events].reverse().find((e) => e.taskId === taskId && e.type === "command");
    if (!last || last.data?.passed !== false) return undefined;
    const output = String(last.data?.output ?? "");
    const fails = failureLines(output).slice(0, 6);
    return `$ ${last.message}\n${fails.length ? fails.join("\n") : output.split("\n").slice(-8).join("\n")}`.slice(0, 1200);
  }

  /** One look at a sub-agent that shows a sign of trouble: let it be, send it a note, or stop it. */
  async checkOn(s: Supervision, run: Run, task: Task, concern: Concern): Promise<void> {
    const key = `${run.id}:${task.id}`;
    this.checkingOn.set(key, task.title);
    this.s.changed();
    const c = await this.conversations.load(s.conversationId);
    const notesSent = s.monitor.notesSent(task.id);
    const scope = runScope(c.entries, run.id);
    const fresh = await this.tasks.load(run.id).catch(() => run);
    const decision = await superviseAgent(
      this.s.coordinatorProvider(c.workspaceRoot, run.id),
      {
        userMessages: userMessagesOf(scope),
        request: run.request,
        agent: task,
        concern,
        activity: s.monitor.describe(task.id),
        notesSent,
        learned: learnedSoFar(scope) ?? fresh.briefing,
        team: s.monitor.teamStatus(fresh.tasks, task.id, this.reviewOf(run.id)),
        failedCommand: await this.lastFailedCommand(run.id, task.id),
      },
      { signal: s.abort.signal },
    );
    const now = (await this.tasks.load(run.id)).tasks.find((t) => t.id === task.id);
    // It may have finished while the coordinator was looking.
    if (!now || (now.status !== "running" && now.status !== "verifying") || s.abort.signal.aborted) return;
    let { action, adjusted } = decision;
    let note = decision.message;
    if (action === "stop" && !s.control) {
      // Researchers run outside the orchestrator and cannot be stopped one by one; tell it to wrap up instead.
      action = "message";
      note = note || "Finish now with what you have found so far, and say what is still open.";
      adjusted = "This sub-agent cannot be stopped on its own, so it was told to finish instead.";
    }
    // Logged first, so the check-in is in the chat before the sub-agent acts on the note.
    await this.tasks.log({
      runId: run.id,
      taskId: task.id,
      type: "coordinator_checkin",
      message: action,
      data: { concern: concern.kind, detail: concern.detail, evidence: concern.evidence, note: action === "message" ? note : undefined, thought: decision.thought, thinking: clip(decision.thinking), adjusted },
    });
    if (action === "message") this.s.inboxes.set(key, [...(this.s.inboxes.get(key) ?? []), { from: "coordinator", text: note }]);
    this.host.log("info", `Coordinator checked on "${task.title}" (${CONCERN_LABEL[concern.kind]}) and chose "${action}".${adjusted ? ` ${adjusted}` : ""}`);
    if (action === "stop") s.control?.cancelTask(task.id);
  }

  /**
   * A sub-agent asked the coordinator something. The coordinator answers from
   * what it knows (the user's messages, research findings, the plan, the other
   * sub-agents). Only a decision its notes do not settle goes to the user.
   */
  async consultCoordinator(conversationId: string, runId: string, task: Task, question: string, signal: AbortSignal): Promise<CoordinatorReply> {
    const key = `${runId}:${task.id}`;
    this.consulting.set(key, task.title);
    this.s.changed();
    try {
      const c = await this.conversations.load(conversationId);
      const run = await this.tasks.load(runId);
      const team = this.supervised.get(runId)?.monitor.teamStatus(run.tasks, task.id, this.reviewOf(runId));
      // Only what belongs to this run: earlier, unrelated tasks in the same conversation stay out of reach.
      const scope = runScope(c.entries, runId);
      let result;
      try {
        result = await answerSubAgent(
          this.s.coordinatorProvider(c.workspaceRoot, runId),
          {
            userMessages: userMessagesOf(scope),
            request: run.request,
            agent: { title: task.title, instructions: task.instructions, fileScope: task.fileScope, research: run.kind === "research" },
            question,
            learned: learnedSoFar(scope),
            briefing: run.briefing,
            team,
            earlier: earlierAnswers(scope),
            fileTree: await this.host.fileTree(c.workspaceRoot, signal).catch(() => undefined),
            failedCommand: await this.lastFailedCommand(runId, task.id),
          },
          { signal },
        );
      } catch (err) {
        if (signal.aborted) throw err;
        this.host.log("warn", `The coordinator could not answer "${task.title}": ${(err as Error).message}`);
        await this.tasks.log({ runId, taskId: task.id, type: "coordinator_answer", message: "I could not answer this time (the model gave no usable reply), so it goes on with its best judgement.", data: { question, failed: true } });
        return { from: "coordinator", text: "The coordinator could not answer right now. Continue with your best judgement, and say what you assumed in your summary." };
      }
      if (!result.askUser) {
        await this.tasks.log({ runId, taskId: task.id, type: "coordinator_answer", message: result.answer, data: { question, thought: result.thought, thinking: clip(result.thinking) } });
        return { from: "coordinator", text: result.answer };
      }
      // Only the user can decide. The sub-agent's question is in the chat already; put the card after it.
      this.consulting.delete(key);
      await this.s.settle();
      const { decision } = await this.s.waitFor(conversationId, {
        author: "coordinator",
        kind: "question",
        runId,
        taskId: task.id,
        agentName: task.title,
        tag: "for a sub-agent",
        thought: result.thought,
        quote: question,
        text: `"${task.title}" asked me something only you can decide: ${result.answer}`,
      });
      if (decision?.kind === "answer") {
        await this.tasks.log({ runId, taskId: task.id, type: "coordinator_answer", message: decision.text, data: { question, from: "user" } });
        return { from: "user", text: decision.text };
      }
      return { from: "coordinator", text: "The user did not answer. Make a reasonable choice within your task and say which in your summary." };
    } finally {
      this.consulting.delete(key);
      this.s.changed();
    }
  }

  /**
   * A sub-agent called finish. Before its result counts, the coordinator
   * reads the report and the drafts and accepts them, or sends the sub-agent
   * back with feedback (at most as often as the oversight level allows).
   *
   * When it cannot be sent back (too few steps left, or sent back as often as
   * allowed), the result is still reviewed, and a "revise" goes to the user.
   * A review that cannot happen (the model call fails, the run used its
   * model-call budget) never counts as a pass. Either way the chat says so,
   * and the drafts wait for the user even when auto-approve is on.
   */
  async reviewResult(conversationId: string, runId: string, task: Task, summary: string, drafts: string, signal: AbortSignal, skip?: ReviewSkip): Promise<ReviewVerdict> {
    const key = `${runId}:${task.id}`;
    const limit = Math.min(MAX_REVIEW_ROUNDS, this.host.delegationLimits().reviewRounds ?? 1);
    const round = this.reviewRounds.get(key) ?? 0;
    const final: ReviewSkip | undefined = skip ?? (round >= limit ? "limit_reached" : undefined);
    const research = task.fileScope.length === 0;
    const unreviewed = async (reason: ReviewOutcome, extra: Record<string, unknown> = {}): Promise<ReviewVerdict> => {
      this.reviewOutcomes.set(key, reason);
      await this.tasks.log({ runId, taskId: task.id, type: "coordinator_review", message: "unavailable", data: { reason, research, ...extra } });
      this.host.log("warn", `The coordinator did not review "${task.title}" (${reason}). Its drafts wait for the user.`);
      return { accept: true, outcome: reason };
    };
    if (limit <= 0) {
      // The user turned review off in their own settings: nothing to flag.
      this.reviewOutcomes.set(key, "off");
      return { accept: true, outcome: "off" };
    }
    if (this.s.budget.exhausted(runId)) return unreviewed("over_budget");
    // Run 13, two-changes-in-a-row: researchers reported "Added 'away' mode ... tests now pass" and were accepted.
    // A read-only report that says it changed something is sent back by rule, once; after that it is flagged.
    if (research && claimsChangeMade(summary)) {
      if (!final && round < limit) {
        this.reviewRounds.set(key, round + 1);
        const feedback = "Checked by rule: you are a read-only researcher, so you changed nothing in the user's project, but your report says something was changed, added or fixed. Rewrite your report: say only what you found in the files, and what would have to change and where. Never say it was done.";
        await this.tasks.log({ runId, taskId: task.id, type: "coordinator_review", message: "revise", data: { feedback, research, byRule: true } });
        return { accept: false, feedback, outcome: "sent_back" };
      }
      return unreviewed("not_accepted", { byRule: true, why: "the report claims a change research cannot make" });
    }
    this.checkingOn.set(key, task.title);
    this.s.changed();
    try {
      const c = await this.conversations.load(conversationId);
      const run = await this.tasks.load(runId);
      const scope = runScope(c.entries, runId);
      let result;
      try {
        result = await reviewSubAgentResult(
          this.s.coordinatorProvider(c.workspaceRoot, runId),
          {
            userMessages: userMessagesOf(scope),
            request: run.request,
            agent: { title: task.title, instructions: task.instructions, fileScope: task.fileScope, research: run.kind === "research" || research },
            summary,
            drafts,
            learned: learnedSoFar(scope) ?? run.briefing,
            team: this.supervised.get(runId)?.monitor.teamStatus(run.tasks, task.id, this.reviewOf(runId)),
            conventions: conventionsText(await this.host.skills?.(c.workspaceRoot).catch(() => undefined)),
            declined: [...this.s.deniedFor(runId)],
            round,
            final,
          },
          { signal },
        );
      } catch (err) {
        if (signal.aborted) throw err;
        this.host.log("warn", `The coordinator could not review "${task.title}": ${(err as Error).message}`);
        return await unreviewed(this.s.budget.exhausted(runId) ? "over_budget" : "failed");
      }
      signal.throwIfAborted();
      // It asked for changes without saying which: that is no review at all, so the user decides.
      if (result.adjusted) return await unreviewed("unclear", { thought: result.thought, thinking: clip(result.thinking) });
      // Asking to undo what the drafts never changed cannot be done either (run 9): those sentences are left out.
      if (result.verdict === "revise") {
        const moot = withoutMootUndo(result.feedback, drafts);
        if (moot.dropped.length) {
          this.host.log("info", `Review of "${task.title}": left out a request to undo lines the drafts never changed: ${moot.dropped.join(" ")}`);
          result = moot.kept.length >= 10 ? { ...result, feedback: moot.kept } : { ...result, verdict: "accept", feedback: "Accepted: the review only asked to undo changes, but the drafts keep every original line." };
        }
      }
      // A researcher cannot write code, so asking it for code cannot be acted on (run 10, validate-input).
      // Another researcher's report is not evidence against this one (run 12, rename-everywhere).
      if (result.verdict === "revise" && research && overrulesWithOtherReports(result.feedback)) {
        this.host.log("info", `Review of "${task.title}": accepted by rule, it only disagreed with other reports: ${result.feedback}`);
        result = { ...result, verdict: "accept", feedback: "Accepted by rule: another report is not evidence against what this researcher read." };
      }
      if (result.verdict === "revise" && research && asksResearchForCode(result.feedback)) {
        this.host.log("info", `Review of "${task.title}": accepted by rule, it asked a research sub-agent for code changes it cannot make.`);
        result = { ...result, verdict: "accept", feedback: "Accepted by rule: research cannot change files; the change is a separate task." };
      }
      // A rename with nothing to rename (run 10): the old name is in none of the task's files, so no draft is right.
      if (result.verdict === "revise" && !research && (await this.nothingToRenameIn(c.workspaceRoot, task, drafts))) {
        this.host.log("info", `Review of "${task.title}": accepted by rule, the name to rename occurs in none of its files.`);
        result = { ...result, verdict: "accept", feedback: "Accepted by rule: the name to rename occurs in none of this task's files, so there is nothing to change." };
      }
      // A rename whose own files no longer use the old name is done: other files are other tasks' work (run 14).
      if (result.verdict === "revise" && !research && drafts.trim() && (await this.renameDoneIn(c.workspaceRoot, task, run, result.feedback))) {
        this.host.log("info", `Review of "${task.title}": accepted by rule, none of its files uses the old name any more: ${result.feedback}`);
        result = { ...result, verdict: "accept", feedback: "Accepted by rule: none of this task's files uses the old name any more. Other files belong to other tasks." };
      }
      // A send-back that asks to fix a function neither the user nor the task named is left out (run 12,
      // parallel-changes: "average() is wrong; the task only asked for median, so leave it. Fix average()").
      if (result.verdict === "revise" && !research) {
        const words = [...userMessagesOf(scope), task.title, task.instructions];
        const sentences = result.feedback.split(/(?<=[.!?])\s+/);
        const unasked = unaskedFixes(sentences, words);
        if (unasked.length) {
          const kept = sentences.filter((x) => !unasked.includes(x)).join(" ").trim();
          this.host.log("info", `Review of "${task.title}": left out a request to fix code nobody asked about: ${unasked.join(" ")}`);
          // What is left must still ask for something; "average() is wrong but should stay as it is" asks for nothing.
          const asks = kept.split(/(?<=[.!?])\s+/).some((x) => IMPERATIVE.test(x));
          result = kept.length >= 10 && asks ? { ...result, feedback: kept } : { ...result, verdict: "accept", feedback: `Accepted: the review only asked to fix code outside the task (${unasked.join(" ")})` };
        }
      }
      // Run 13, question-then-answer: the task's change was auto-accepted and written in an earlier attempt, so a
      // later attempt or fix-up had nothing left to draft, and every review sent it back for "no changes".
      if (result.verdict === "revise" && !research && !drafts.trim() && NO_CHANGES.test(result.feedback)) {
        const written = (run.changes ?? []).filter((x) => x.status === "accepted" && task.fileScope.some((g) => matchesAny(x.path, [g]))).map((x) => x.path);
        if (written.length) {
          this.host.log("info", `Review of "${task.title}": accepted by rule, its files were already changed and accepted earlier in this run (${written.join(", ")}).`);
          result = { ...result, verdict: "accept", feedback: `Accepted by rule: ${[...new Set(written)].join(", ")} already has an accepted change from earlier in this run, so there was nothing left to draft.` };
        }
      }
      // Run 14 repeat 2, python-project: a "Run tests to verify the fix" task had nothing to draft, and its
      // review sent it back for "no code changes". A task that only runs or checks is done without drafts.
      if (result.verdict === "revise" && !research && !drafts.trim() && NO_CHANGES.test(result.feedback) && onlyRunsOrChecks(task.instructions)) {
        this.host.log("info", `Review of "${task.title}": accepted by rule, it only runs or checks, so it has nothing to draft.`);
        result = { ...result, verdict: "accept", feedback: "Accepted by rule: this task only runs or checks something, so it has no drafts." };
      }
      // A draft that undoes a change the user asked for earlier in this run is never accepted (run 14 repeat 2).
      const accepted = (run.changes ?? []).filter((x) => x.status === "accepted" && x.taskId !== task.id);
      for (const d of (run.changes ?? []).filter((x) => x.taskId === task.id && x.status === "pending")) {
        const acc = accepted.filter((x) => x.path === d.path).at(-1);
        const back = acc && revertsAccepted(task.instructions, acc, d);
        if (back) {
          this.host.log("info", `Review of "${task.title}": sent back by rule, its draft of ${d.path} puts back "${back}", which an accepted change of this run replaced.`);
          result = {
            ...result,
            verdict: "revise",
            feedback: `Checked by rule: your draft of ${d.path} puts back \`${back.slice(0, 120)}\`, which the change the user asked for replaced earlier in this run, so it undoes the user's request. Keep the requested change. If a test still expects the old behaviour, update that test instead.`,
          };
          break;
        }
      }
      // A send-back for work in files the sub-agent may not change cannot be done: that part is left out.
      if (result.verdict === "revise" && !research) {
        const scoped = feedbackInScope(result.feedback, task.fileScope);
        if (scoped.dropped.length) {
          this.host.log("info", `Review of "${task.title}": left out a request for files outside its task: ${scoped.dropped.join(" ")}`);
          result = scoped.kept.length >= 10 ? { ...result, feedback: scoped.kept } : { ...result, verdict: "accept", feedback: `Accepted: the review only asked for work in other tasks' files (${scoped.dropped.join(" ")})` };
        }
      }
      // A draft that cannot load is never accepted, whatever the model said (run 4 and 5 accepted an ES import in a CommonJS file).
      const problems = draftProblemsOf(drafts);
      if (result.verdict === "accept" && problems.length) result = { ...result, verdict: "revise", feedback: problems.join("\n") };
      const revise = result.verdict === "revise";
      // A send-back that says the task cannot be done cannot help: the task ends, its drafts wait for the user,
      // and verification and the final reply say why (run 10, impossible-constraint).
      const impossible = revise && !problems.length && saysImpossible(result.feedback);
      if (impossible) this.host.log("info", `Review of "${task.title}": not sent back, the review says it cannot be done: ${result.feedback}`);
      const outcome: ReviewOutcome = !revise ? "accepted" : final || impossible ? "not_accepted" : "sent_back";
      if (outcome === "sent_back") this.reviewRounds.set(key, round + 1);
      this.reviewOutcomes.set(key, outcome);
      await this.tasks.log({
        runId,
        taskId: task.id,
        type: "coordinator_review",
        message: outcome === "not_accepted" ? "not_accepted" : result.verdict,
        data: { feedback: result.feedback, thought: result.thought, thinking: clip(result.thinking), final, research },
      });
      this.host.log("info", `Coordinator reviewed "${task.title}": ${outcome}.`);
      return outcome === "sent_back" ? { accept: false, feedback: result.feedback, outcome } : { accept: true, outcome };
    } finally {
      this.checkingOn.delete(key);
      this.s.changed();
    }
  }

  /** Reads a task's files (only plain paths, no patterns) and checks whether its rename has nothing to change. */
  private async nothingToRenameIn(workspaceRoot: string, task: Task, drafts: string): Promise<boolean> {
    if (drafts.trim() || task.fileScope.some((p) => /[*?[\]{}]/.test(p))) return false;
    try {
      const sandbox = await WorkspaceSandbox.create(workspaceRoot);
      const files = new Map<string, string | undefined>();
      for (const p of task.fileScope) files.set(p, await sandbox.readFile(p).catch(() => undefined));
      return nothingToRename(task.instructions, drafts, files);
    } catch {
      return false;
    }
  }

  /** Reads a task's files (only plain paths), with its own latest drafts applied, and checks its rename is done. */
  private async renameDoneIn(workspaceRoot: string, task: Task, run: Run, feedback: string): Promise<boolean> {
    if (task.fileScope.some((p) => /[*?[\]{}]/.test(p))) return false;
    try {
      const sandbox = await WorkspaceSandbox.create(workspaceRoot);
      const files = new Map<string, { before: string; after: string } | undefined>();
      for (const p of task.fileScope) {
        const disk = await sandbox.readFile(p).catch(() => undefined);
        const draft = (run.changes ?? []).filter((x) => x.taskId === task.id && x.path === p && x.status !== "rejected" && x.status !== "reverted").at(-1);
        const before = draft ? draft.original ?? "" : disk;
        const after = draft ? draft.proposed : disk;
        files.set(p, before === undefined || after === undefined ? undefined : { before, after });
      }
      return renameDoneInScope(task.instructions, feedback, files);
    } catch {
      return false;
    }
  }

  /** Stops looking at every run's sub-agents (Stop, dispose). */
  abortAll(): void {
    for (const s of this.supervised.values()) s.abort.abort();
  }
}
