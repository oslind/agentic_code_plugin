import { planRequest } from "../coordinator/planner";
import * as path from "path";
import { AGENT_DIR, RunOutcome } from "../coordinator/orchestrator";
import { pendingBase } from "../changes/overlay";
import { ScratchCopy } from "../changes/scratch";
import { TaskStore } from "../state/taskStore";
import { PendingChange, Task } from "../state/types";
import { CheckConfig, CheckResult, runAllChecks } from "../checks/runner";
import { isCheckAutoApproved } from "../tools/policy";
import { ConversationStore } from "./conversationStore";
import { isReadOnlyPlan } from "./coordinatorChat";
import { commandEventData } from "../worker/worker";
import { draftsForReview } from "../coordinator/review";
import { AnswerCheck, checkAnswer, factsOnlyVerification, fixUpNotes, fixUpRequest, MANUAL_REVIEW, Verification, verifyRoundLimit, verifyRun, VerifyTask } from "../coordinator/verify";
import { ChatHost, RunHooks } from "./host";
import { ChatSession } from "./session";
import { clip } from "./helpers";
import { runScope, userMessagesOf, userRequestOf } from "./scope";

/**
 * The coordinator verifying a request before it calls it done: the approved
 * checks on all drafts together, a judge call, and fix-up rounds in the same
 * run for what is left. After research, a check that the answer covers the
 * question.
 */
export class Verifier {
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

  /** Does the combined answer cover the question? Undefined when the check itself failed; the answer is then sent as it is. */
  async checkResearchAnswer(workspaceRoot: string, question: string, answer: string, signal: AbortSignal): Promise<AnswerCheck | undefined> {
    try {
      const res = await checkAnswer(this.s.coordinatorProvider(workspaceRoot), question, answer, { signal });
      this.host.log("info", `Checked the research answer: ${res.answered ? "it answers the question" : res.missing.length ? `still open: ${res.missing.join(" | ")}` : "not confirmed, nothing named (manual review required)"}.`);
      return res;
    } catch (err) {
      if (signal.aborted) throw err;
      this.host.log("warn", `Could not check the research answer: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * The coordinator keeps going until it can verify the request is done.
   * After the sub-agents finish, it runs the approved checks on all drafts
   * together and reads the drafts against the request. If something is left,
   * it plans fix-up tasks for exactly that, runs them in the same run (so
   * they build on the drafts), and verifies again, at most
   * as many times as the oversight level allows. Every write and command still
   * needs the same approval as before, and drafts stay pending.
   */
  async verifyUntilDone(
    conversationId: string,
    workspaceRoot: string,
    runId: string,
    hooks: RunHooks,
    first: RunOutcome,
  ): Promise<{ outcome: RunOutcome; verification?: Verification }> {
    const limits = this.host.delegationLimits();
    if (!limits.verify) return { outcome: first };
    const maxRounds = verifyRoundLimit(limits.verifyRounds);
    let outcome = first;
    let verification: Verification | undefined;
    // Tasks of the latest round: one of them not finishing means the request is not done.
    let latest = new Set((await this.tasks.load(runId)).tasks.map((t) => t.id));
    for (let round = 0; ; round++) {
      if (this.s.stopping) return { outcome, verification };
      const abort = new AbortController();
      this.s.abort = abort;
      this.s.runningRunId = undefined;
      try {
        verification = await this.verifyOnce(conversationId, workspaceRoot, runId, hooks.checks, latest, round, abort.signal);
        if (verification.verified) return { outcome, verification };
        // Nothing specific to fix: no fix-up tasks are invented, the user reviews the work.
        if (verification.manualReview && verification.missing.length === 0) return { outcome, verification };
        if (round >= maxRounds) {
          await this.s.append(conversationId, {
            author: "coordinator",
            runId,
            tone: "warning",
            tag: "not verified",
            text: maxRounds
              ? `I sent sub-agents back ${maxRounds} time(s) and still cannot verify that the request is done, so I stopped here. Tell me how to go on, or set agentic.delegation.oversight to "thorough" to allow more rounds.`
              : "Fix-up rounds are off at this oversight level, so I did not send sub-agents back for what is left.",
          });
          return { outcome, verification };
        }
        if (verification.missing.length === 0) return { outcome, verification };
        if (this.s.budget.exhausted(runId)) {
          await this.s.append(conversationId, {
            author: "coordinator",
            runId,
            tone: "warning",
            tag: "not verified",
            text: "This run used its model-call limit (agentic.delegation.maxModelCallsPerRun), so I did not send sub-agents back for what is left. Raise the limit or tell me how to go on.",
          });
          return { outcome, verification };
        }
        const added = await this.planFixUp(conversationId, workspaceRoot, runId, verification, round + 1, abort.signal);
        if (added.length === 0) return { outcome, verification };
        latest = new Set(added.map((t) => t.id));
        await this.s.append(conversationId, {
          author: "coordinator",
          runId,
          tag: `fix-up ${round + 1} of ${maxRounds}`,
          text: `The work is not done yet, so I am sending ${added.length} sub-agent(s) back for what is left: ${added.map((t) => `"${t.title}"`).join(", ")}. They start from the drafts already made, and you still review every change.`,
        });
      } catch (err) {
        if (abort.signal.aborted || this.s.stopping) return { outcome, verification };
        throw err;
      } finally {
        if (this.s.abort === abort) this.s.abort = undefined;
      }
      this.s.busy = `Sub-agents are working on what is left (fix-up round ${round + 1})…`;
      this.s.runningRunId = runId;
      this.s.changed();
      outcome = (await this.host.runPlan(runId, hooks)) ?? outcome;
      await this.s.settle();
    }
  }

  /** One verification: the checks on all drafts together, then one model call. The result is shown in the chat. */
  async verifyOnce(
    conversationId: string,
    workspaceRoot: string,
    runId: string,
    checks: CheckConfig[],
    latest: ReadonlySet<string>,
    round: number,
    signal: AbortSignal,
  ): Promise<Verification> {
    this.s.busy = "Coordinator is verifying the work…";
    this.s.changed();
    await this.s.append(conversationId, {
      author: "coordinator",
      runId,
      tag: "verifying",
      text: checks.length
        ? `Verifying the work before I call it done: running ${checks.length} check(s) on a copy of the project with all drafts together, then reading the drafts against your request.`
        : "Verifying the work before I call it done: reading the drafts against your request. No checks are set up for this project, so nothing is run.",
    });
    const results = await this.runVerifyChecks(conversationId, workspaceRoot, runId, checks, signal);
    signal.throwIfAborted();
    const run = await this.tasks.load(runId);
    const c = await this.conversations.load(conversationId);
    const tasks: VerifyTask[] = run.tasks.map((t) => {
      const notStarted = t.status === "pending";
      return {
        title: t.title,
        status: notStarted ? "did not start" : t.status.replace("_", " "),
        summary: t.summary ?? (t.error ? `No report: ${t.error}` : ""),
        unfinished: latest.has(t.id) && t.status !== "done" ? (notStarted ? "a task it depends on did not finish" : (t.error ?? t.status)) : undefined,
      };
    });
    // The newest draft of each file that is not rejected: what the user would get.
    const newest = new Map<string, PendingChange>();
    for (const ch of run.changes ?? []) if (ch.status !== "rejected" && ch.status !== "reverted") newest.set(ch.path, ch);
    const ctx = {
      userMessages: userMessagesOf(runScope(c.entries, runId)),
      request: run.request,
      tasks,
      drafts: draftsForReview([...newest.values()]),
      checks: results,
      round,
    };
    let v: Verification;
    try {
      // Counted against the run's model-call budget, like every other coordinator call about its sub-agents.
      v = await verifyRun(this.s.coordinatorProvider(workspaceRoot, runId), ctx, { signal });
    } catch (err) {
      if (signal.aborted) throw err;
      this.host.log("warn", `The coordinator could not verify the run: ${(err as Error).message}`);
      v = factsOnlyVerification(ctx, "the model call failed");
    }
    signal.throwIfAborted();
    this.host.log("info", `Verification ${round + 1}: ${v.verified ? "verified" : "not verified"}.${v.adjusted ? ` ${v.adjusted}` : ""}`);
    const left = v.missing.length ? `\n\nStill left:\n${v.missing.map((m) => `- ${m}`).join("\n")}` : "";
    await this.s.append(conversationId, {
      author: "coordinator",
      runId,
      tag: v.verified ? "verified" : v.manualReview ? "manual review required" : "not verified",
      tone: v.verified ? "success" : "warning",
      text: `${v.verified ? "Verified: the request is done." : "Not verified yet."} ${v.evidence}${v.summary ? ` ${v.summary}` : ""}${left}${v.manualReview && !v.missing.length ? `\n\n${MANUAL_REVIEW}` : ""}`,
      thought: v.thought,
      thinking: clip(v.thinking),
    });
    return v;
  }

  /**
   * The run's approved checks, on a scratch copy of the project with every
   * pending draft of the run written in. Accepted drafts are already on disk.
   * Each one needs the same approval as a sub-agent's check.
   */
  async runVerifyChecks(conversationId: string, workspaceRoot: string, runId: string, checks: CheckConfig[], signal: AbortSignal): Promise<CheckResult[]> {
    if (checks.length === 0) return [];
    const root = await this.host.openFolder(workspaceRoot);
    if (!root) throw new Error(`${workspaceRoot} is not open in VS Code, so the work cannot be verified.`);
    const run = await this.tasks.load(runId);
    const scratch = new ScratchCopy(root, path.join(root, AGENT_DIR, "scratch", `verify-${runId.slice(0, 8)}`), this.host.scratchLinkDirs?.(workspaceRoot) ?? ["node_modules"]);
    const trusted = new Set(checks.map((c) => c.command));
    try {
      const dir = await scratch.sync(pendingBase(run.changes));
      const results = await runAllChecks(checks, dir, signal, (check) => this.approveVerifyCheck(conversationId, runId, check, trusted), this.host.terminal?.(workspaceRoot));
      for (const r of results) {
        const command = checks.find((k) => k.name === r.name)?.command;
        if (r.skipped || !command) continue;
        const data = commandEventData(command, r);
        await this.s.append(conversationId, {
          author: "coordinator",
          runId,
          kind: "command",
          tag: `check ${r.name}`,
          tone: r.passed ? "success" : "warning",
          text: `Check "${r.name}" on all drafts together: ${r.passed ? "passed" : r.timedOut ? "timed out" : "failed"}. The full output is in the Agentic Code terminal.`,
          command: { line: command, output: String(data.output ?? "") },
        });
      }
      return results;
    } finally {
      await scratch.remove().catch(() => undefined);
    }
  }

  /** Same rule as a sub-agent's checks: approved checks run when "Run commands" is on or allowed for this run, otherwise the user is asked. */
  async approveVerifyCheck(conversationId: string, runId: string, check: CheckConfig, trusted: ReadonlySet<string>): Promise<boolean> {
    if (isCheckAutoApproved(this.host.permissions().commands, trusted, check.command) || this.s.allowedFor(runId).has(check.command)) return true;
    const { decision } = await this.s.waitFor(conversationId, {
      author: "coordinator",
      kind: "approval",
      runId,
      rememberable: true,
      rememberLabel: "Allow for the rest of this run",
      text: `I'd like to run \`${check.command}\` (check "${check.name}") to verify the work with all drafts together. It runs in a copy of the project, so your files are not touched, but like any command it runs as you and can read files elsewhere or use the network, so only allow it if you trust it. Turn on "Run commands" to stop being asked.`,
    });
    if (decision?.kind !== "allow") return false;
    if (decision.remember) this.s.allowedFor(runId).add(check.command);
    return true;
  }

  /** Plans fix-up tasks for what verification found left, and adds them to the run. Returns the tasks added. */
  async planFixUp(conversationId: string, workspaceRoot: string, runId: string, v: Verification, round: number, signal: AbortSignal): Promise<Task[]> {
    this.s.busy = "Coordinator is planning what is left…";
    this.s.changed();
    const run = await this.tasks.load(runId);
    const fileTree = await this.host.fileTree(workspaceRoot, signal).catch(() => undefined);
    const reports: VerifyTask[] = run.tasks.map((t) => ({ title: t.title, status: t.status.replace("_", " "), summary: t.summary ?? t.error ?? "" }));
    // The user's own words are the instruction; the coordinator's model-written request only goes along fenced.
    const userRequest = userRequestOf(run, (await this.conversations.load(conversationId)).entries);
    let result;
    try {
      result = await planRequest(
        this.s.coordinatorProvider(workspaceRoot, runId),
        { request: fixUpRequest(userRequest, round), planned: run.request, fileTree, learned: fixUpNotes(v, v.checks ?? [], reports), maxTasks: Math.min(4, this.host.delegationLimits().maxTasks) },
        { signal, onAttempt: (n, err) => n > 0 && this.host.log("warn", `Fix-up plan retry ${n}: ${err}`) },
      );
    } catch (err) {
      if (signal.aborted) throw err;
      await this.s.append(conversationId, { author: "system", runId, tone: "warning", text: `I could not plan the fix-up tasks (${(err as Error).message}), so the work stays unverified.` });
      return [];
    }
    if (isReadOnlyPlan(result.plan.tasks)) {
      await this.s.append(conversationId, { author: "system", runId, tone: "warning", text: "The fix-up plan only read files and changed nothing, so it was not started. Say what should change to finish the request." });
      return [];
    }
    // New ids, so they never clash with the run's earlier tasks; dependencies point at the new ids.
    const taken = new Set(run.tasks.map((t) => t.id));
    const ids = new Map<string, string>();
    for (const t of result.plan.tasks) {
      let id = `fix${round}-${t.id}`;
      for (let n = 2; taken.has(id); n++) id = `fix${round}-${t.id}-${n}`;
      taken.add(id);
      ids.set(t.id, id);
    }
    const added = await this.tasks.addTasks(
      runId,
      result.plan.tasks.map((t) => ({ ...t, id: ids.get(t.id)!, dependsOn: t.dependsOn.map((d) => ids.get(d)!).filter(Boolean) })),
    );
    for (const r of result.repairs) {
      await this.tasks.log({ runId, taskId: ids.get(r.taskId), type: "plan_repair", message: `${ids.get(r.taskId)} now waits for ${ids.get(r.addedDependency)}: ${r.reason}` });
    }
    return added;
  }

}
