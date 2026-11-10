import { SkillCatalog } from "../skills/catalog";
import { planRequest } from "../coordinator/planner";
import { RunOutcome } from "../coordinator/orchestrator";
import { removeScratchFolder, ScratchCopy } from "../changes/scratch";
import { TaskStore } from "../state/taskStore";
import { Run, Task } from "../state/types";
import { ConversationStore } from "./conversationStore";
import { untrustedSection } from "../context/untrusted";
import { CutOff, describeCutOff, failedCommandsOf, ResearchReport, summarizeRun, synthesizeFindings, withDeniedNotice, withoutModelWarnings } from "./synthesis";
import { compactConversation, compactionNote, planCompaction } from "./compaction";
import { asksForEdit, claimsChangeMade, continueChange, coordinatorHistoryBudget, coordinatorTurn, CoordinatorResult, isReadOnlyPlan, isGoAhead, researchQuestions, researchRoundLimit } from "./coordinatorChat";
import { WorkspaceSandbox } from "../tools/sandbox";
import { Worker } from "../worker/worker";
import { AnswerCheck, Verification, verifyRoundLimit } from "../coordinator/verify";
import { changedFilesOf, describeOutcome } from "./outcome";
import { Conversation } from "./types";
import { resumableTasks, resumeState } from "../state/resume";
import { ChatHost } from "./host";
import { ChatSession } from "./session";
import { DoneBar } from "./viewState";
import { clip, clipLine, describePlan, isUnstarted, plural, title } from "./helpers";
import { learnedSoFar, runScope, userMessagesOf, userRequestOf } from "./scope";
import { filesMentioning, outlinesOfNamedFiles } from "../context/outline";
import { renamedName, ReviewVerdict } from "../coordinator/review";
import { Oversight } from "./oversight";
import { Approvals } from "./approvals";
import { FollowUps } from "./followUps";
import { Verifier } from "./verifier";
import { batchesOf, batchFilesOf, mentionsFile, batchQuestion, batchReview, coverageFact, coverageNote, coverageOf, fileList, askedScope, filesRead, LIST_LIMIT, readExtents, tooManyNote, codeFiles } from "./coverage";

/**
 * The coordinator's run loop for one prompt: its turn (answer, research,
 * plan or run), the research rounds and the answer combined from them, a
 * plan's run with verification, and the final reply.
 */
export class RunLoop {
  private readonly host: ChatHost;
  private readonly tasks: TaskStore;
  private readonly conversations: ConversationStore;

  constructor(
    private readonly s: ChatSession,
    private readonly oversight: Oversight,
    private readonly approvals: Approvals,
    private readonly followUps: FollowUps,
    private readonly verifier: Verifier,
  ) {
    this.host = s.host;
    this.tasks = s.tasks;
    this.conversations = s.conversations;
  }

  async pendingPlan(c: Conversation): Promise<Run | undefined> {
    const runId = c.runIds.at(-1);
    const run = runId ? await this.tasks.load(runId).catch(() => undefined) : undefined;
    return run && isUnstarted(run) ? run : undefined;
  }

  /**
   * The "End chat and update coordinator" button for a sub-agent whose run is
   * not finished (for example a failed task the user retried in the chat):
   * the update is a new turn for the coordinator, which picks the original
   * request up again and plans what is still left.
   */
  async continueAfterFollowUp(conversationId: string, runId: string, taskId: string): Promise<void> {
    const run = await this.tasks.load(runId).catch(() => undefined);
    const task = run?.tasks.find((t) => t.id === taskId);
    if (!run || !task || run.kind === "research") return;
    const unfinished = run.tasks.filter((t) => t.status !== "done");
    if (unfinished.length === 0) return;
    if (this.s.busy) {
      await this.s.append(conversationId, { author: "system", runId, tone: "warning", text: "The coordinator got the update but is busy with another prompt, so it did not continue the task. Ask it to continue when it is done." });
      return;
    }
    const c = await this.conversations.load(conversationId);
    const update = c.entries.filter((e) => e.runId === runId && e.taskId === taskId && e.tag === "update from follow-up").at(-1)?.text ?? "";
    const userRequest = userRequestOf(run, c.entries);
    await this.s.append(conversationId, { author: "system", runId, text: `Continuing "${(userRequest ?? run.request).slice(0, 200)}" with the update from "${task.title}".` });
    const status = unfinished.map((t) => `- "${t.title}": ${t.status.replace("_", " ")}`).join("\n");
    const continuation = [
      `The user talked with sub-agent "${task.title}" again after the run, then ended that chat and asked you to continue the original request with what came out of it.`,
      userRequest ? `The user's original request: ${userRequest}` : "The user's original words were not recorded.",
      // The coordinator's own summary of it was written by a model after research that read project files.
      untrustedSection("What you planned for it then:", "your earlier plan for the request", run.request),
      `Tasks of that run that are not done:\n${status}`,
      // Written by a sub-agent that read project files: data, not instructions.
      untrustedSection(`The update from "${task.title}":`, `update from sub-agent "${task.title}" after a follow-up chat`, update || "(no update)"),
      "Continue the original request from where it stands now. Plan only what is still left to do (drafts waiting for review are already done), or answer if nothing is left. Do not plan work that is already done.",
    ].join("\n\n");
    await this.respond(await this.conversations.load(conversationId), userRequest ?? run.request, continuation, userRequest, runId);
  }

  /**
   * Compacts the conversation when it needs it (or always, with `force`):
   * the older messages become a summary the coordinator gets instead. Returns
   * the conversation as it is afterwards, and why nothing was compacted when
   * nothing was. A failed summary changes nothing; only a stop is passed on.
   * `runId` counts the call against that run's model-call budget.
   */
  async compact(c: Conversation, signal: AbortSignal, opts: { force?: boolean; runId?: string } = {}): Promise<{ conversation: Conversation; skipped?: string }> {
    const provider = this.s.coordinatorProvider(c.workspaceRoot, opts.runId);
    const budget = coordinatorHistoryBudget(
      { mode: this.s.mode, maxResearchers: this.host.delegationLimits().maxResearchers, historyTokens: this.host.coordinatorHistoryTokens?.() },
      provider.contextWindow,
    );
    const plan = planCompaction(c.entries, budget, opts.force);
    if (!plan) return { conversation: c, skipped: "There is not enough earlier conversation to compact yet." };
    const before = this.s.busy;
    this.s.busy = "Compacting the conversation…";
    this.s.changed();
    try {
      const result = await compactConversation(provider, plan, budget, signal);
      this.host.log("info", `Compacted ${result.messages} message(s) into a summary of about ${Math.ceil(result.summary.length / 3.5)} tokens (room for the conversation: ${budget} tokens).`);
      await this.s.append(c.id, compactionNote(result, !opts.force));
      return { conversation: await this.conversations.load(c.id) };
    } catch (err) {
      if (signal.aborted) throw err;
      const why = `Could not compact the conversation: ${(err as Error).message}. Nothing was changed; the coordinator gets as many recent messages as fit.`;
      this.host.log("warn", why);
      return { conversation: c, skipped: why };
    } finally {
      if (this.s.busy === "Compacting the conversation…") this.s.busy = before;
      this.s.changed();
    }
  }

  /**
   * The coordinator's turn on a message: answer, research, plan or run. `continuation` replaces a new user message.
   * `userRequest` is the user's own words a run started here keeps apart from the model's request; for a new message it is `text`.
   */
  async respond(c: Conversation, text: string, continuation?: string, userRequest: string | undefined = continuation ? undefined : text, runId?: string): Promise<void> {
    this.s.done = undefined;
    const waiting = !continuation && isGoAhead(text) ? await this.pendingPlan(await this.conversations.load(c.id)) : undefined;
    if (waiting && this.s.runOwner.has(waiting.id)) {
      // "go" with a plan waiting is the same as pressing Run it. No model call, nothing to misread.
      await this.s.append(c.id, { author: "coordinator", text: this.s.mode === "act" ? "Starting the plan." : "Starting the plan. This switches the chat to Act mode." });
      await this.runPlan(waiting.id);
      return;
    }

    const abort = new AbortController();
    this.s.abort = abort;
    this.s.busy = "Coordinator is thinking…";
    this.s.changed();
    let startRun: string | undefined;
    let ended: DoneBar = { status: "finished", text: "Finished" };
    // Every research round of this message, and the coordinator's last reply when it chose to answer.
    // Unless a plan follows, the prompt always ends with one answer that combines all the reports.
    const researchRuns: string[] = [];
    /** Research questions that do not ask again for a command the user declined in this message's runs. */
    const withoutDenied = (questions: string[]): string[] => {
      const denied = researchRuns.flatMap((id) => [...this.s.deniedFor(id)]);
      const kept = questions.filter((q) => !denied.some((d) => q.includes(d)));
      if (kept.length < questions.length) this.host.log("info", `Left out ${questions.length - kept.length} research question(s) that asked again for a command you declined.`);
      return kept;
    };
    let planned = false;
    // The files the user's question asks about one by one, when it is about many (found by rule, once).
    let asked: string[] | undefined | null = null;
    // True when the project had more files than were listed: the answer says so (audit of PR #54).
    let askedCut = false;
    // A question about every file of a project too big to read one by one: how many files (audit of PR #54).
    let tooMany: number | undefined;
    // Links the listing could not follow in the asked scope: the answer names them and is not verified (audit of PR #54).
    let askedSkipped: string[] = [];
    const askedFiles = async (): Promise<string[] | undefined> => {
      if (asked === null) {
        asked = await WorkspaceSandbox.create(c.workspaceRoot)
          .then(async (files) => {
            const skippedLinks: string[] = [];
            return { list: await files.listFiles("**", LIST_LIMIT + 1, (rel) => skippedLinks.push(rel)), skippedLinks };
          })
          .then(({ list: files, skippedLinks }) => {
            askedCut = files.length > LIST_LIMIT;
            const scope = askedScope(userRequest ?? text, files.slice(0, LIST_LIMIT), undefined, skippedLinks);
            if ("tooMany" in scope) tooMany = scope.tooMany;
            if ("skipped" in scope && scope.skipped) askedSkipped = scope.skipped;
            return "files" in scope ? scope.files : undefined;
          })
          .catch(() => undefined);
        if (asked) this.host.log("info", `The question is about ${asked.length} files${askedCut ? ` (the project has more than ${LIST_LIMIT} files; only those listed are included)` : ""}; research is split over them by rule.`);
      }
      return asked;
    };
    let draft: { reply: string; thought?: string; thinking?: string } | undefined;
    let limitReached = false;
    try {
      c = await this.conversations.load(c.id);
      // A long conversation is compacted before the coordinator reads it, so it keeps fitting a small context.
      if (this.host.autoCompact?.() ?? true) {
        c = (await this.compact(c, abort.signal, { runId })).conversation;
        this.s.busy = "Coordinator is thinking…";
        this.s.changed();
      }
      const provider = this.s.coordinatorProvider(c.workspaceRoot);
      this.host.log("info", `Coordinator using ${this.host.modelLabel(c.workspaceRoot)}`);
      const fileTree = await this.host.fileTree(c.workspaceRoot, abort.signal).catch(() => undefined);
      const pending = await this.pendingPlan(c);
      const turn = await coordinatorTurn(
        provider,
        {
          mode: this.s.mode,
          entries: c.entries,
          fileTree,
          pendingPlan: pending && describePlan(pending),
          maxResearchers: this.host.delegationLimits().maxResearchers,
          historyTokens: this.host.coordinatorHistoryTokens?.(),
          continuation,
        },
        { signal: abort.signal, onAttempt: (n, err) => n > 0 && this.host.log("warn", `Coordinator retry ${n}: ${err}`) },
      );
      this.host.log(
        "info",
        `Coordinator (${this.s.mode} mode) chose "${turn.modelAction ?? turn.action}"${turn.modelAction && turn.modelAction !== turn.action ? `, changed to "${turn.action}"` : ""}. Goal: ${turn.goal ?? "not given"}, complete: ${turn.complete ?? "not given"}.`,
      );
      // A full answer from the conversation alone ("What did you change?") is an answer like one from research:
      // shown as one, never folded away. A question back to the user is not (run 10, what-did-you-change).
      const direct = turn.action === "none" && turn.goal === "answer" && turn.complete === true && !/\?\s*$/.test(turn.reply.trim());
      await this.s.append(c.id, { author: "coordinator", ...(direct ? { kind: "answer" as const } : {}), text: turn.reply, thought: turn.thought || undefined, thinking: clip(turn.thinking) });
      if (turn.overridden) await this.s.append(c.id, { author: "system", text: turn.overridden, tone: "warning" });

      // Research can take several rounds: a broad first look, then narrower researchers
      // (for example one per file) when the reports are too general to answer from.
      const maxRounds = researchRoundLimit(this.host.delegationLimits().maxResearchRounds);
      let round = 0;
      const doResearch = async (t: CoordinatorResult): Promise<void> => {
        round++;
        // A question about many files: each researcher gets a batch of the files nobody opened yet, by rule.
        // Benchmark pass 1: asked about 100 modules, the coordinator sent one researcher, which opened 3.
        const files = await askedFiles();
        const unread = files && coverageOf(files, await this.filesReadIn(researchRuns)).unread;
        if (unread?.length) {
          const batches = batchesOf(unread, this.host.delegationLimits().maxResearchers);
          const covered = batches.reduce((n, b) => n + b.length, 0);
          await this.s.append(c.id, {
            author: "coordinator",
            text: `Your question is about ${files!.length} files${unread.length < files!.length ? `, and ${unread.length} of them have not been opened yet` : ""}. Splitting them over ${batches.length} researcher(s), up to ${batches[0]!.length} files each, so every file is read${covered < unread.length ? ` (${unread.length - covered} more wait for the next round)` : ""}.`,
          });
          t = { ...t, questions: batches.map((b) => batchQuestion(userRequest ?? text, b)) };
        } else if (tooMany && round === 1) {
          await this.s.append(c.id, { author: "coordinator", text: `Your question is about ${codeFiles(tooMany, askedCut)} of the project, too many to read one by one. The researchers will search instead, and the answer will say that not every file was read. Name a folder to have every file in it read.` });
          if (!t.questions?.length) t = { ...t, questions: [userRequest ?? text] };
        }
        researchRuns.push(await this.research(c, t, abort.signal, round > 1 ? learnedSoFar(c.entries) : undefined));
        c = await this.conversations.load(c.id);
        // Files still unopened get another round before the coordinator answers, while rounds are left.
        if (files && round < maxRounds && coverageOf(files, await this.filesReadIn(researchRuns)).unread.length) {
          await doResearch({ ...t, questions: [] });
          return;
        }
        this.s.busy = "Coordinator is reading the reports…";
        this.s.runningRunId = undefined;
        this.s.changed();
        let answer: CoordinatorResult;
        try {
          answer = await coordinatorTurn(
            provider,
            {
              mode: this.s.mode,
              entries: c.entries,
              fileTree,
              answerFromResearch: true,
              researchRoundsLeft: maxRounds - round,
              maxResearchers: this.host.delegationLimits().maxResearchers,
              historyTokens: this.host.coordinatorHistoryTokens?.(),
            },
            { signal: abort.signal, onAttempt: (n, err) => n > 0 && this.host.log("warn", `Coordinator retry ${n}: ${err}`) },
          );
        } catch (err) {
          // A small model that fails the JSON turn after research must not cost the user the answer:
          // the reports are there, so the answer is written from them below.
          if (abort.signal.aborted) throw err;
          this.host.log("warn", `The coordinator's reply after research round ${round} failed (${(err as Error).message}). Writing the answer from the reports instead.`);
          return;
        }
        this.host.log(
          "info",
          `Coordinator after research round ${round} of ${maxRounds} chose "${answer.modelAction ?? answer.action}"${answer.modelAction && answer.modelAction !== answer.action ? `, changed to "${answer.action}"` : ""}.`,
        );
        // The user asked for a change and research was the first step: answering now would leave it undone.
        // qwen3:8b researched a bug fix, then answered "I've fixed it" with nothing changed.
        answer = continueChange(answer, turn.goal, text);
        if (answer.action === "plan" || answer.action === "research") {
          await this.s.append(c.id, { author: "coordinator", text: answer.reply, thought: answer.thought || undefined, thinking: clip(answer.thinking) });
        }
        // The user asked for a change: the research was the first step, the plan is the next.
        if (answer.action === "plan") await makePlan(answer, true);
        // The reports were too general: send narrower researchers. Never to ask again for a command the user declined (run 9).
        else if (answer.action === "research" && withoutDenied(answer.questions ?? []).length) await doResearch({ ...answer, questions: withoutDenied(answer.questions ?? []) });
        else {
          // The coordinator's reply is only a draft: the answer combining every report is written below.
          draft = { reply: answer.reply, thought: answer.thought || undefined, thinking: clip(answer.thinking) };
          if (!answer.researchLimitReached) return;
          limitReached = true;
          await this.s.append(c.id, {
            author: "system",
            tone: "warning",
            text: `The coordinator wanted to dig deeper, but this message already used ${maxRounds} research round(s), so no more sub-agents were sent. Ask again to continue from what was found, or raise agentic.delegation.maxResearchRounds.`,
          });
        }
      };

      const makePlan = async (t: CoordinatorResult, afterResearch: boolean): Promise<void> => {
        this.s.busy = "Coordinator is splitting the work into sub-agent tasks…";
        this.s.changed();
        let planThinking: string | undefined;
        c = await this.conversations.load(c.id);
        const learned = learnedSoFar(c.entries);
        const result = await planRequest(
          provider,
          {
            request: t.request,
            userWords: userRequest,
            earlierUserWords: userMessagesOf(c.entries).filter((m) => m.trim() !== userRequest?.trim()).slice(-3),
            references: await this.renameReferences(c.workspaceRoot, userRequest ?? t.request),
            outlines: await WorkspaceSandbox.create(c.workspaceRoot)
              .then((files) => outlinesOfNamedFiles(files, fileTree, [t.request, userRequest ?? ""]))
              .catch(() => undefined),
            fileTree,
            learned,
            maxTasks: this.host.delegationLimits().maxTasks,
            skills: await this.skillsFor(c.workspaceRoot),
          },
          {
            signal: abort.signal,
            onAttempt: (n, err) => n > 0 && this.host.log("warn", `Plan retry ${n}: ${err}`),
            onThinking: (x) => (planThinking = x),
          },
        );
        // A request the coordinator called a change stays a plan, whatever the planner marked: run 4 sent
        // "Write docs/usage.md" as a read-only task (changes: false), which then claimed it created the file.
        if (isReadOnlyPlan(result.plan.tasks) && t.goal !== "change") {
          if (afterResearch && round >= maxRounds) {
            // Every research round for this message is used; reading again would only loop.
            await this.s.append(c.id, { author: "system", tone: "warning", text: "The plan only read files, which the research already did, so nothing was started. Say what should change, for example which file to edit." });
            limitReached = true;
            return;
          }
          // Every task only reads: that is research, which needs no Act mode and changes nothing.
          await this.s.append(c.id, {
            author: "system",
            tone: "warning",
            text: "These tasks only read the project, so they run now as read-only sub-agents instead of a plan. Nothing will be changed, and Plan mode is fine.",
          });
          // Tasks that only combine others' findings are left out: the coordinator combines the reports itself.
          const own = result.plan.tasks.filter((x) => x.dependsOn.length === 0);
          const questions = (own.length ? own : result.plan.tasks).map((x) => `${x.title}: ${x.instructions} (Start with: ${x.fileScope.join(", ")})`.slice(0, 500));
          await doResearch({ ...t, action: "research", request: "", questions });
          return;
        }
        const run = await this.tasks.createRun(t.request, c.workspaceRoot, undefined, learned, userRequest);
        planned = true;
        this.s.runOwner.set(run.id, c.id);
        await this.conversations.update(c.id, (x) => x.runIds.push(run.id));
        await this.tasks.addTasks(run.id, result.plan.tasks);
        for (const r of result.repairs) {
          await this.tasks.log({ runId: run.id, taskId: r.taskId, type: "plan_repair", message: `${r.taskId} now waits for ${r.addedDependency}: ${r.reason}` });
        }
        const n = result.plan.tasks.length;
        await this.s.append(c.id, {
          author: "coordinator",
          kind: "plan",
          runId: run.id,
          thinking: clip(planThinking),
          text:
            this.s.mode === "act"
              ? `Plan: ${n} task(s), each for one sub-agent. Starting now.`
              : `Proposed plan: ${n} task(s), each for one sub-agent. Press "Run it" (or say "go") to start, or tell me what to change.`,
        });
        if (result.droppedContext.length) this.host.log("warn", `Left out of the plan prompt: ${result.droppedContext.join(", ")}`);
        for (const x of result.snappedScopes ?? []) this.host.log("warn", `Plan task ${x.taskId}: the file "${x.from}" is not in the project; using "${x.to}".`);
        if (result.addedReferences?.length) this.host.log("warn", `The plan left out files that use the renamed name; added: ${result.addedReferences.join(", ")}.`);
        if (this.s.mode === "act") startRun = run.id;
      };

      if (turn.action === "plan") {
        await makePlan(turn, false);
      } else if (turn.action === "run" && pending) {
        startRun = pending.id;
      } else if (turn.action === "research") {
        await doResearch(turn);
      } else if (turn.action === "none" && turn.goal !== "change" && ((await askedFiles()) || tooMany)) {
        // A question about many files is never answered from memory: the files are read first.
        await doResearch({ ...turn, action: "research", questions: [] });
      }
      if (researchRuns.length && !planned) {
        // Before the answer goes out, the coordinator checks that it answers the question, and sends
        // researchers after what is still open while research rounds are left.
        const limits = this.host.delegationLimits();
        // Extra research rounds the check may start (from the oversight level), within the research round limit.
        let moreRounds = verifyRoundLimit(limits.verifyRounds);
        for (;;) {
          const review = limits.verify ? (answer: string) => this.verifier.checkResearchAnswer(c.workspaceRoot, text, answer, abort.signal) : undefined;
          const answered = await this.answerFromReports(c, text, researchRuns, draft, limitReached, abort.signal, review, moreRounds > 0 && round < maxRounds, (await askedFiles()) ?? undefined, askedCut, tooMany, askedSkipped);
          // A cut-off answer is not a finished one, and the bar says so.
          if (answered.cutOff) ended = { status: "partial", text: "Finished, but the answer was cut off before it was complete." };
          const open = answered.open && withoutDenied(answered.open);
          if (!open?.length) break;
          moreRounds--;
          await this.s.append(c.id, {
            author: "coordinator",
            tag: "not verified",
            tone: "warning",
            text: `I checked my answer against your question, and it does not cover everything yet. Sending researchers after what is still open:\n${open.map((q) => `- ${q}`).join("\n")}`,
          });
          round++;
          researchRuns.push(await this.research(c, { ...turn, action: "research", request: "", questions: open }, abort.signal, learnedSoFar(c.entries)));
          c = await this.conversations.load(c.id);
        }
      }
    } catch (err) {
      const message = abort.signal.aborted ? "Stopped." : (err as Error).message;
      ended = abort.signal.aborted ? { status: "stopped", text: "Stopped" } : { status: "failed", text: "Failed. See the message above." };
      this.host.log("error", message);
      await this.s.append(c.id, { author: "system", kind: "error", text: message, tone: abort.signal.aborted ? "warning" : "error" });
      // Research that finished before the failure still answers the question.
      if (!abort.signal.aborted && researchRuns.length && !planned) {
        await this.answerFromReports(c, text, researchRuns, draft, limitReached, abort.signal, undefined, false, asked ?? undefined, askedCut, tooMany, askedSkipped).catch((e) => this.host.log("warn", `Could not answer from the reports: ${(e as Error).message}`));
      }
    } finally {
      this.s.abort = undefined;
      this.s.busy = undefined;
      this.s.runningRunId = undefined;
      if (abort.signal.aborted) startRun = undefined;
      this.s.stopping = false;
      // A plan that starts now is still part of this prompt; runPlan shows the bar when it ends.
      if (!startRun) this.s.done = { ...ended, time: new Date().toISOString(), conversationId: c.id };
      this.s.changed();
    }
    if (startRun) await this.runPlan(startRun);
  }

  /**
   * Starts a proposed plan. Running only happens in Act mode; pressing Run in
   * Plan mode is the user switching to Act mode for this conversation.
   */
  /** For a rename request: the old name and every project file that mentions it, so the plan misses none. */
  private async renameReferences(workspaceRoot: string, request: string): Promise<{ name: string; files: string[]; incomplete?: string } | undefined> {
    const name = renamedName(request);
    if (!name) return undefined;
    const found = await WorkspaceSandbox.create(workspaceRoot)
      .then((sandbox) => filesMentioning(sandbox, name))
      .catch((err: Error) => ({ files: [] as string[], incomplete: err.message }));
    if (found.incomplete) this.host.log("warn", `The search for files that use ${name} was incomplete: ${found.incomplete}.`);
    return { name, files: found.files, incomplete: found.incomplete };
  }

  /** The skills for a folder. A folder whose skills cannot be read just gets none. */
  async skillsFor(workspaceRoot: string): Promise<SkillCatalog | undefined> {
    try {
      return await this.host.skills?.(workspaceRoot);
    } catch (err) {
      this.host.log("warn", `Could not read skills: ${(err as Error).message}`);
      return undefined;
    }
  }

  async runPlan(runId: string): Promise<void> {
    const conversationId = this.s.runOwner.get(runId);
    if (!conversationId) return;
    if (this.s.busy) {
      // Never ignored without a word: the button looks like it did nothing otherwise.
      await this.s.append(conversationId, { author: "system", tone: "warning", text: `The plan was not started because the chat is busy (${this.s.busy.replace(/…$/, "")}). Press "Run it" again when it is done.` });
      return;
    }
    const run = await this.tasks.load(runId);
    if (!isUnstarted(run)) {
      if (resumeState(run, process.pid)) return this.resumeRun(runId);
      await this.s.append(conversationId, { author: "system", text: "That plan has already run. Retry tasks from the Tasks view.", tone: "warning" });
      return;
    }
    await this.startRun(conversationId, run, false);
  }

  /**
   * Sends read-only sub-agents to answer the coordinator's questions about the
   * project. They read the open folder directly and their file scope is
   * empty, so the policy refuses every write.
   */
  /** One research round. `learned` is what earlier rounds found, so follow-up researchers build on it. */
  async research(c: Conversation, turn: CoordinatorResult, signal: AbortSignal, learned?: string): Promise<string> {
    const root = await this.host.openFolder(c.workspaceRoot);
    if (!root) throw new Error(`${c.workspaceRoot} is not open in VS Code, so the sub-agents cannot read it.`);
    const questions = researchQuestions(turn, this.host.delegationLimits().maxResearchers);
    const run = await this.tasks.createRun(turn.request.trim() || questions.join(" "), c.workspaceRoot, "research");
    this.s.runOwner.set(run.id, c.id);
    await this.conversations.update(c.id, (x) => x.runIds.push(run.id));
    const added = await this.tasks.addTasks(
      run.id,
      questions.map((q, i) => ({ id: `research-${i + 1}`, title: title(q), instructions: q, fileScope: [] })),
    );
    await this.s.append(c.id, {
      author: "coordinator",
      kind: "research",
      runId: run.id,
      text: `Sending ${added.length} read-only sub-agent(s) to look into the project. They can read files and run commands in a copy of the project, but not change anything.`,
    });
    this.s.busy = `${added.length} read-only sub-agent(s) are researching…`;
    this.s.runningRunId = run.id;
    this.s.changed();

    const sandbox = await WorkspaceSandbox.create(root);
    const skills = await this.skillsFor(c.workspaceRoot);
    const { maxTurns, maxParallel } = this.host.researchLimits();
    const terminal = this.host.terminal?.(c.workspaceRoot);
    // Researchers' commands run in their own copy of the project, made when the first one runs.
    const scratches: ScratchCopy[] = [];
    const provider = this.host.provider(c.workspaceRoot);
    const queue = [...added];
    this.oversight.supervise(run.id, c.id, maxTurns);
    const workerLoop = async () => {
      for (let task = queue.shift(); task; task = queue.shift()) {
        if (signal.aborted) {
          await this.tasks.setStatus(run.id, task.id, "cancelled", "Stopped");
          continue;
        }
        await this.tasks.setStatus(run.id, task.id, "running");
        let worker: Worker | undefined;
        // Nothing is copied until the first command runs.
        const scratch = new ScratchCopy(root, [`research-${run.id.slice(0, 8)}`, task.id], ["node_modules"]);
        scratches.push(scratch);
        try {
          worker = new Worker({
            provider: this.s.agentProvider(provider, run.id, task.id),
            sandbox,
            task,
            checks: [],
            maxTurns,
            signal,
            readOnly: true,
            compactSteps: this.host.compactSubAgents?.() ?? false,
            skills,
            terminal,
            checkDir: () => scratch.sync(new Map()),
            context: learned ? untrustedSection("What earlier researchers found (build on it, do not repeat it):", "earlier research and sub-agent reports", learned) : undefined,
            // Only commands reach this: a researcher's empty file scope refuses every write.
            approve: async (_reason, call) => call.tool === "run_command" && (await this.approvals.approveAgentCommand(c.id, run.id, task!, call)),
            inbox: () => this.s.drainInbox(run.id, task!.id),
            askCoordinator: (q) => this.oversight.consultCoordinator(c.id, run.id, task!, q, signal),
            reviewResult: batchFilesOf(task.instructions)
              ? (summary) => this.reviewBatch(run.id, task!, batchFilesOf(task!.instructions)!, summary)
              : (summary, skip) => this.oversight.reviewResult(c.id, run.id, task!, summary, "", signal, skip),
            log: (type, message, data) => void this.tasks.log({ runId: run.id, taskId: task!.id, type, message, data }),
          });
          const result = await worker.run();
          await this.tasks.updateTask(run.id, task.id, { summary: result.summary, changedFiles: [] });
          await this.tasks.saveHistory(run.id, task.id, worker.history()).catch(() => undefined);
          worker = undefined;
          await this.tasks.setStatus(run.id, task.id, "done");
        } catch (err) {
          const stopped = signal.aborted;
          await this.tasks.setStatus(run.id, task.id, stopped ? "cancelled" : "failed", stopped ? "Stopped" : (err as Error).message);
          if (!stopped) await this.tasks.log({ runId: run.id, taskId: task.id, type: "task_failed", message: (err as Error).message });
        }
        // Kept so the user can reopen this researcher later.
        if (worker) await this.tasks.saveHistory(run.id, task.id, worker.history()).catch(() => undefined);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(maxParallel, added.length)) }, workerLoop)).finally(async () => {
      this.oversight.endSupervision(run.id);
      for (const scratch of scratches) await scratch.remove().catch(() => undefined);
      await removeScratchFolder(root, `research-${run.id.slice(0, 8)}`).catch(() => undefined);
    });
    // Let queued sub-agent messages land before the summary.
    await this.s.settle();
    signal.throwIfAborted();
    await this.s.append(c.id, { author: "coordinator", runId: run.id, text: `Research finished.${await this.reports(run.id)}` });
    return run.id;
  }

  /** Send-backs per batch researcher, for reviewBatch. */
  private batchReviews = new Map<string, number>();

  /** A batch researcher's result, reviewed by rule (coverage.ts batchReview): at most two send-backs, then it is flagged. */
  private async reviewBatch(runId: string, task: Task, batch: string[], summary: string): Promise<ReviewVerdict> {
    const key = `${runId}:${task.id}`;
    const rounds = this.batchReviews.get(key) ?? 0;
    const extents = readExtents((await this.tasks.readLog(runId).catch(() => [])).filter((e) => e.taskId === task.id));
    const read = new Set([...extents].filter(([, x]) => x.complete).map(([p]) => p));
    const r = batchReview(batch, read, summary, extents);
    const final = !r.accept && rounds >= 2;
    if (!r.accept && !final) this.batchReviews.set(key, rounds + 1);
    const message = r.accept ? "accept" : final ? "not_accepted" : "revise";
    await this.tasks.log({ runId, taskId: task.id, type: "coordinator_review", message, data: { feedback: r.feedback ?? "Every file was opened and reported (checked by rule).", research: true, byRule: true, final: final ? "limit_reached" : undefined } });
    return r.accept ? { accept: true, outcome: "accepted" } : final ? { accept: true, outcome: "not_accepted" } : { accept: false, feedback: r.feedback, outcome: "sent_back" };
  }

  /** Files researchers read to their end in these runs. */
  private async filesReadIn(runIds: string[]): Promise<Set<string>> {
    const read = new Set<string>();
    for (const id of runIds) for (const f of filesRead(await this.tasks.readLog(id).catch(() => []))) read.add(f);
    return read;
  }

  /**
   * The guaranteed last step of research that ends in an answer: one model
   * call that combines every report from every round into a reply to the
   * user. Small models often end the JSON turn with "Research is done.", so
   * that reply is only used as a hint, and as the lead of the fallback.
   */
  async answerFromReports(
    c: Conversation,
    question: string,
    runIds: string[],
    draft: { reply: string; thought?: string; thinking?: string } | undefined,
    limitReached: boolean,
    signal: AbortSignal,
    review?: (answer: string) => Promise<AnswerCheck | undefined>,
    canResearchMore = false,
    asked?: string[],
    askedCut = false,
    tooMany?: number,
    askedSkipped: string[] = [],
  ): Promise<{ open?: string[]; cutOff?: CutOff }> {
    this.s.busy = "Coordinator is combining the reports into an answer…";
    this.s.changed();
    const reports: ResearchReport[] = [];
    for (const id of runIds) {
      const run = await this.tasks.load(id).catch(() => undefined);
      for (const t of run?.tasks ?? []) {
        reports.push({ title: t.title, status: t.status.replace("_", " "), text: t.summary ?? (t.error ? `No report: ${t.error}` : "") });
      }
    }
    // How much of a many-file question was read, counted from the logs: the answer must say so (benchmark pass 1).
    // A file counts as checked only when a researcher opened it and a report says something about it: a file read
    // but never reported on is as unknown to the answer as one never opened (check 2026-11-09: mod_042 was in no report).
    const opened = await this.filesReadIn(runIds);
    const reported = reports.map((r) => r.text).join("\n");
    const coverage = asked && coverageOf(asked, new Set([...opened].filter((f) => mentionsFile(reported, f, asked ?? []))), askedCut, askedSkipped);
    const result = await synthesizeFindings(
      this.s.coordinatorProvider(c.workspaceRoot),
      { question, reports, draft: draft?.reply, coverage: coverage ? coverageFact(coverage) : tooMany ? `Checked by rule: ${tooManyNote(tooMany, askedCut)} Your first sentence says that not every file was read.` : undefined, limitReached, failedCommands: runIds.length ? failedCommandsOf(runScope(c.entries, runIds[0]!)) : [], deniedCommands: [...new Set(runIds.flatMap((id) => [...this.s.deniedFor(id)]))] },
      { signal, onError: (m) => this.host.log("warn", m) },
    );
    this.host.log("info", `Combined ${reports.length} research report(s) into the answer${result.fallback ? " without the model (it gave no usable summary)" : ""}.`);
    // The raw reports (fallback) are not checked: there is no answer to check, only the reports.
    // Neither is a cut-off answer: it is unfinished whatever a check says, and the user is told so below.
    const falseChange = asksForEdit(question) && claimsChangeMade(result.text);
    let check: AnswerCheck | undefined;
    if (review && !result.fallback && !result.cutOff) {
      this.s.busy = "Coordinator is checking that the answer covers your question…";
      this.s.changed();
      check = await review(result.text);
      signal.throwIfAborted();
      // An answer about files nobody opened is not verified, whatever the check says.
      if (check && falseChange) check = { ...check, answered: false, missing: [...check.missing, "the request asks for a change, and research changed nothing"] };
      if (check && (coverage?.unread.length || coverage?.listCut || coverage?.skipped?.length || tooMany)) {
        const gaps = [
          coverage?.unread.length ? `${coverage.unread.length} of the ${coverage.files.length} files were not read: ${fileList(coverage.unread, 10)}` : "",
          coverage?.listCut ? `the project has more than ${LIST_LIMIT} files, and files beyond those were not considered` : "",
          coverage?.skipped?.length ? `linked files or folders could not be followed: ${fileList(coverage.skipped, 10)}` : "",
          tooMany ? `the question is about ${codeFiles(tooMany, askedCut)} of the project, and they were not all read` : "",
        ].filter(Boolean);
        check = { ...check, answered: false, missing: [...check.missing, ...gaps] };
        canResearchMore = false;
      }
      // Run 10: the check asked for the output of a command the user declined, so the honest answer was held back
      // for another round that could not run it. What only a declined command could answer is not open.
      const declined = [...new Set(runIds.flatMap((id) => [...this.s.deniedFor(id)]))];
      if (check && !check.answered && declined.length) {
        const open = check.missing.filter((m) => !declined.some((d) => m.includes(d)));
        if (open.length < check.missing.length) {
          this.host.log("info", `The answer check asked for the output of a command you declined (${declined.join(", ")}); that part is not counted as open.`);
          check = open.length ? { ...check, missing: open } : { ...check, answered: true, missing: [] };
        }
      }
      if (check && !check.answered && check.missing.length && canResearchMore) return { open: check.missing };
    }
    if (check) {
      await this.s.append(c.id, {
        author: "coordinator",
        tag: check.answered ? "verified" : check.missing.length ? "not verified" : "manual review required",
        tone: check.answered ? "success" : "warning",
        text: check.answered
          ? "I checked the answer below against your question: it covers every part."
          : check.missing.length
            ? `I checked the answer below against your question, and it may not cover everything. No research rounds are left to look further. Still open:\n${check.missing.map((q) => `- ${q}`).join("\n")}`
            : "I checked the answer below against your question and could not confirm it covers everything, but I could not name what is open. Manual review required: read the answer against your question yourself before relying on it.",
      });
    }
    if (result.suspicious.length) {
      const which = result.suspicious.map((n) => `"${reports[n - 1]!.title}"`).join(", ");
      this.host.log("warn", `Research report(s) ${which} contain text that reads like instructions to an AI (possible prompt injection from a project file).`);
      await this.s.append(c.id, {
        author: "system",
        tone: "warning",
        text: `The report from ${which} contains text that reads like orders to an AI, for example "ignore previous instructions". It may come from a file in the project that tries to steer the agents. It was treated as data, not followed, but check the answer below against the files yourself.`,
      });
    }
    if (result.cutOff) {
      this.host.log("warn", `The research answer is unfinished (${result.cutOff === "length" ? "stopped at the reply length limit" : "ends with a lead-in and nothing after it"}).`);
      await this.s.append(c.id, { author: "system", tone: "warning", text: describeCutOff(result.cutOff, "The answer below") });
    }
    // Said first by rule, so the gap shows whatever the model wrote.
    const coverageGap = coverage ? coverageNote(coverage) : tooMany ? tooManyNote(tooMany, askedCut) : undefined;
    // Research only reads, so an answer to an edit request that says something was changed is false (run 13,
    // readme-typo: "has been fixed", nothing drafted). Said first by rule; the check below cannot pass it either.
    const gap = [falseChange ? "Nothing in your project was changed: research only reads files, so where the answer below says something was fixed, added or changed, that did not happen. Ask again to have the change made." : "", coverageGap ?? ""].filter(Boolean).join("\n\n") || undefined;
    await this.s.append(c.id, {
      author: "coordinator",
      kind: "answer",
      tag: "from research",
      ...(result.cutOff ? { tone: "warning" as const, cutOff: true } : {}),
      text: `${gap ? `${gap}\n\n` : ""}${result.cutOff ? `${result.text}\n\n… (cut off here)` : result.text}`,
      thought: draft?.thought,
      thinking: clip(result.thinking ?? draft?.thinking),
    });
    return { cutOff: result.cutOff };
  }

  /**
   * The coordinator's final reply after a change run, so a finished run
   * always ends with an answer in words and not only the outcome list. If the
   * model gives nothing usable, the outcome above is the reply.
   */
  async answerFromRun(conversationId: string, workspaceRoot: string, run: Run, outcome: RunOutcome, verification?: Verification): Promise<CutOff | undefined> {
    this.s.busy = "Coordinator is writing its final reply…";
    // Stop ends this call too; the outcome above then stays the reply.
    const abort = new AbortController();
    this.s.abort = abort;
    this.s.changed();
    try {
      return await this.writeRunReply(conversationId, workspaceRoot, run, outcome, abort.signal, verification);
    } catch (err) {
      if (!abort.signal.aborted) throw err;
      return undefined;
    } finally {
      if (this.s.abort === abort) this.s.abort = undefined;
    }
  }

  /** Writes the final reply, and says whether it came out unfinished. */
  async writeRunReply(conversationId: string, workspaceRoot: string, run: Run, outcome: RunOutcome, signal: AbortSignal, verification?: Verification): Promise<CutOff | undefined> {
    const c = await this.conversations.load(conversationId);
    const question = [...runScope(c.entries, run.id)].reverse().find((e) => e.author === "user" && e.kind !== "direct")?.text ?? run.request;
    const changes = run.changes ?? [];
    const of = (status: string) => [...new Set(changes.filter((ch) => ch.status === status).map((ch) => ch.path))];
    const result = await summarizeRun(
      this.s.coordinatorProvider(workspaceRoot),
      {
        question,
        request: run.request,
        tasks: run.tasks.map((t) => ({
          title: t.title,
          status: outcome.blocked.includes(t.id) ? "did not start" : t.status.replace("_", " "),
          text: t.summary ?? (t.error ? `No report: ${t.error}` : ""),
          files: [...new Set(changes.filter((ch) => ch.taskId === t.id).map((ch) => ch.path))],
        })),
        drafts: { pending: of("pending"), accepted: of("accepted"), rejected: of("rejected") },
        failedCommands: failedCommandsOf(runScope(c.entries, run.id)),
        verification: verification && { verified: verification.verified, evidence: verification.evidence, summary: verification.summary, missing: verification.missing, manualReview: verification.manualReview },
      },
      { signal, onError: (m) => this.host.log("warn", m) },
    );
    if (!result || signal.aborted) return undefined;
    if (result.suspicious.length) {
      const which = result.suspicious.map((n) => `"${run.tasks[n - 1]!.title}"`).join(", ");
      await this.s.append(conversationId, {
        author: "system",
        tone: "warning",
        text: `The report from ${which} contains text that reads like orders to an AI. It was treated as data, not followed, but check the reply below against the drafts yourself.`,
      });
    }
    if (result.cutOff) await this.s.append(conversationId, { author: "system", tone: "warning", runId: run.id, text: describeCutOff(result.cutOff, "The final reply below") });
    await this.s.append(conversationId, {
      author: "coordinator",
      kind: "answer",
      tag: "final reply",
      ...(result.cutOff ? { tone: "warning" as const, cutOff: true } : {}),
      runId: run.id,
      text: result.cutOff ? `${result.text}\n\n… (cut off here)` : withDeniedNotice(withoutModelWarnings(result.text), [...this.s.deniedFor(run.id)].filter((d) => question.includes(d))),
      thinking: clip(result.thinking),
    });
    return result.cutOff;
  }

  /**
   * What each sub-agent reported back, added to the run summary. The summary
   * is a coordinator message, so the coordinator sees the reports next turn.
   */
  async reports(runId: string): Promise<string> {
    const run = await this.tasks.load(runId).catch(() => undefined);
    if (!run) return "";
    const lines = run.tasks.map((t) => {
      const said = t.summary ?? t.error ?? "no report";
      return `- ${t.title} (${t.status.replace("_", " ")}): ${said.replace(/\s+/g, " ").slice(0, 300)}`;
    });
    return `\n\nReports from the sub-agents:\n${lines.join("\n")}`;
  }

  /**
   * Continues a run that VS Code closed under, or that was stopped: the
   * stopped sub-agents pick up their own conversation and drafts where they
   * were, tasks that never started start now, and done tasks and every draft
   * stay as they are. The user approves the checks again, as for any run.
   */
  async resumeRun(runId: string): Promise<void> {
    const conversationId = this.s.runOwner.get(runId);
    if (!conversationId) return;
    if (this.s.busy) {
      await this.s.append(conversationId, { author: "system", tone: "warning", text: `The run was not resumed because the chat is busy (${this.s.busy.replace(/…$/, "")}). Press "Resume" again when it is done.` });
      return;
    }
    const run = await this.tasks.load(runId);
    const state = resumeState(run, process.pid);
    if (state === "elsewhere") {
      await this.s.append(conversationId, { author: "system", tone: "warning", text: "This run is still working in another VS Code window, so it was not resumed here." });
      return;
    }
    if (!state) {
      await this.s.append(conversationId, { author: "system", tone: "warning", text: "There is nothing left to resume in that run." });
      return;
    }
    if (this.s.currentId !== conversationId) {
      this.s.currentId = conversationId;
      this.s.mode = (await this.conversations.load(conversationId)).mode;
    }
    await this.startRun(conversationId, run, true);
  }

  /** Runs a plan's sub-agents, or resumes the ones left, then verifies and reports. */
  async startRun(conversationId: string, run: Run, resume: boolean): Promise<void> {
    const runId = run.id;
    if (this.s.mode !== "act") await this.s.setMode("act");
    // The plan's sub-agents may work on the same files; reopened conversations pass on what they found first.
    await this.followUps.endFollowUpsOf(conversationId);

    this.s.busy = "Waiting for you to approve the checks…";
    this.s.runningRunId = runId;
    this.s.done = undefined;
    this.s.changed();
    let ended: DoneBar = { status: "stopped", text: "The run was not started" };
    try {
      const workspaceRoot = run.workspaceRoot ?? (await this.conversations.load(conversationId)).workspaceRoot;
      const checks = await this.approvals.chooseChecks(conversationId, workspaceRoot);
      if (!checks) {
        await this.s.append(conversationId, { author: "system", text: "The run was not started.", tone: "warning" });
        return;
      }
      if (resume) {
        // Checked again: the user may have answered the checks card after something else changed the run.
        const left = resumableTasks(await this.tasks.load(runId));
        if (left.length === 0 || resumeState(await this.tasks.load(runId), process.pid) === "elsewhere") {
          await this.s.append(conversationId, { author: "system", text: "There is nothing left to resume in that run.", tone: "warning" });
          return;
        }
        const again = await this.tasks.prepareResume(runId);
        const current = await this.tasks.load(runId);
        const done = current.tasks.filter((t) => t.status === "done").length;
        const drafts = (current.changes ?? []).filter((c) => c.status === "pending").length;
        this.s.busy = `Sub-agents are working on ${left.length} task(s) left…`;
        this.s.changed();
        await this.s.append(conversationId, {
          author: "coordinator",
          runId,
          tag: "resumed",
          text: [
            `Resuming "${clipLine(run.request, 200)}": ${plural(left.length, "task")} left, ${done} of ${current.tasks.length} already done.`,
            again.length ? `Sub-agents that were cut off continue from their last step with their own drafts.` : "",
            drafts ? `${plural(drafts, "draft")} from before stay under Changes for your review.` : "",
            "Each may only change its own files, and you review every change before it is written.",
          ].filter(Boolean).join(" "),
        });
      } else {
        this.s.busy = `Sub-agents are working on ${run.tasks.length} task(s)…`;
        this.s.changed();
        await this.s.append(conversationId, {
          author: "coordinator",
          text: `Starting sub-agents for ${run.tasks.length} task(s). Each may only change its own files, and you review every change before it is written.`,
        });
      }
      this.oversight.supervise(runId, conversationId, this.host.researchLimits().maxTurns);
      const hooks = { ...this.approvals.hooksFor(conversationId, runId, checks, workspaceRoot), skills: await this.skillsFor(workspaceRoot) };
      let outcome = await this.host.runPlan(runId, hooks);
      // Let sub-agent messages that are still queued land before the summary.
      await this.s.settle();
      if (!outcome) {
        await this.s.append(conversationId, { author: "system", text: "The run was not started.", tone: "warning" });
        return;
      }
      // A sub-agent saying "done" is not the end: the coordinator verifies the request and sends sub-agents back for what is left.
      let verification: Verification | undefined;
      if (!this.s.stopping) ({ outcome, verification } = await this.verifier.verifyUntilDone(conversationId, workspaceRoot, runId, hooks, outcome));
      const ok = outcome.failed.length === 0 && outcome.blocked.length === 0;
      const finished = await this.tasks.load(runId);
      const waitingReview = (finished.changes ?? []).filter((ch) => ch.status === "pending").length;
      // The bar's live detail line counts the drafts; a count frozen in here would go stale after Accept.
      const review = waitingReview ? " Drafts are waiting for your review." : "";
      const notDone = outcome.failed.length + outcome.blocked.length;
      ended = this.s.stopping
        ? { status: "stopped", text: `Stopped.${review}` }
        : verification
          ? verification.verified
            ? { status: "finished", text: `Finished and verified.${review}` }
            : { status: "partial", text: `Finished, but not verified${verification.missing.length ? `: ${verification.missing.length} thing(s) still left` : verification.manualReview ? ": manual review required" : ""}.${review}` }
          : ok
            ? { status: "finished", text: `Finished.${review}` }
            : { status: "partial", text: `Finished, but ${notDone} of ${finished.tasks.length} task(s) did not complete.${review}` };
      await this.s.append(conversationId, {
        author: "coordinator",
        kind: "outcome",
        runId,
        tone: ok ? "success" : "warning",
        text: describeOutcome(finished, outcome, this.s.stopping),
        outcome: { changedFiles: changedFilesOf(finished), failed: outcome.failed.length + outcome.blocked.length },
      });
      // The outcome lists what happened; the coordinator's own reply says what it means. A stop skips it.
      if (!this.s.stopping && (await this.answerFromRun(conversationId, workspaceRoot, finished, outcome, verification))) {
        // The work itself is as the outcome says; only the reply about it is unfinished, and the bar must not call it complete.
        ended = { status: ended.status === "finished" ? "partial" : ended.status, text: `${ended.text} The final reply was cut off.` };
      }
    } catch (err) {
      this.host.log("error", (err as Error).message);
      ended = { status: "failed", text: "Failed. See the message above." };
      await this.s.append(conversationId, { author: "system", kind: "error", text: (err as Error).message, tone: "error" });
    } finally {
      this.oversight.endSupervision(runId);
      this.s.runningRunId = undefined;
      this.s.busy = undefined;
      this.s.stopping = false;
      this.s.done = { ...ended, time: new Date().toISOString(), conversationId };
      this.s.changed();
    }
  }

}
