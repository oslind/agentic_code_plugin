import { TaskStore } from "../state/taskStore";
import { Run, RunEvent, Task } from "../state/types";
import { ConversationStore } from "./conversationStore";
import { CoordinatorReply } from "../worker/worker";
import { answerSubAgent } from "../coordinator/consult";
import { MAX_REVIEW_ROUNDS, ReviewOutcome, ReviewSkip, reviewSubAgentResult, ReviewVerdict } from "../coordinator/review";
import { AgentMonitor, Concern, CONCERN_LABEL, superviseAgent } from "../coordinator/monitor";
import { ChatHost, RunControl } from "./host";
import { ChatSession } from "./session";
import { clip } from "./helpers";
import { earlierAnswers, learnedSoFar, runScope, userMessagesOf } from "./scope";

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
        team: s.monitor.teamStatus(fresh.tasks, task.id),
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
      const team = this.supervised.get(runId)?.monitor.teamStatus(run.tasks, task.id);
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
            team: this.supervised.get(runId)?.monitor.teamStatus(run.tasks, task.id),
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
      const revise = result.verdict === "revise";
      const outcome: ReviewOutcome = !revise ? "accepted" : final ? "not_accepted" : "sent_back";
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

  /** Stops looking at every run's sub-agents (Stop, dispose). */
  abortAll(): void {
    for (const s of this.supervised.values()) s.abort.abort();
  }
}
