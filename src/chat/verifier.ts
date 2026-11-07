import { planRequest } from "../coordinator/planner";
import { RunOutcome } from "../coordinator/orchestrator";
import { pendingBase } from "../changes/overlay";
import { ScratchCopy } from "../changes/scratch";
import { TaskStore } from "../state/taskStore";
import { PendingChange, Task } from "../state/types";
import { CheckConfig, CheckResult, runAllChecks } from "../checks/runner";
import { isCheckAutoApproved } from "../tools/policy";
import { ConversationStore } from "./conversationStore";
import { mergeSameFileTasks, offTargetTasks } from "../coordinator/plan";
import { isReadOnlyPlan } from "./coordinatorChat";
import { commandEventData } from "../worker/worker";
import { draftsForReview } from "../coordinator/review";
import { AnswerCheck, checkAnswer, factsOnlyVerification, fixUpNotes, fixUpRequest, MANUAL_REVIEW, Verification, VerifyContext, verifyRoundLimit, verifyRun, VerifyTask } from "../coordinator/verify";
import { ChatHost, RunHooks } from "./host";
import { ChatSession } from "./session";
import { clip } from "./helpers";
import { FailedCommand, failedCommandsOf } from "./synthesis";
import { failedBefore } from "../checks/failures";
import { runScope, userMessagesOf, userRequestOf } from "./scope";
import { promises as fs } from "fs";
import * as path from "path";
import { normalizeWorkspacePath } from "../tools/paths";

/** Whether a workspace-relative file exists. Never looks outside the workspace. */
async function fileExists(root: string, rel: string): Promise<boolean> {
  const p = normalizeWorkspacePath(rel);
  if (!p) return false;
  return fs.stat(path.join(root, p)).then((st) => st.isFile(), () => false);
}

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
    // The latest review of each task: one that ended "not accepted" (sent back as often as allowed) holds "done".
    const reviews = new Map<string, string>();
    for (const e of await this.tasks.readLog(runId).catch(() => [])) {
      if (e.type !== "coordinator_review" || !e.taskId) continue;
      if (e.message === "not_accepted") reviews.set(e.taskId, typeof e.data?.feedback === "string" ? e.data.feedback : "");
      else reviews.delete(e.taskId);
    }
    const tasks: VerifyTask[] = run.tasks.map((t) => {
      const notStarted = t.status === "pending";
      return {
        title: t.title,
        status: notStarted ? "did not start" : t.status.replace("_", " "),
        summary: t.summary ?? (t.error ? `No report: ${t.error}` : ""),
        unfinished: latest.has(t.id) && t.status !== "done" ? (notStarted ? "a task it depends on did not finish" : (t.error ?? t.status)) : undefined,
        // Only drafts that wait for the user can be wrong: a task that was not accepted but changed nothing
        // (run 8: its file did not exist) leaves nothing behind to fix.
        notAccepted: latest.has(t.id) && (run.changes ?? []).some((ch) => ch.taskId === t.id && ch.status !== "rejected" && ch.status !== "reverted") ? reviews.get(t.id) : undefined,
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
      fileTree: await this.host.fileTree(workspaceRoot, signal).catch(() => undefined),
      ...(await this.compareWithProject(conversationId, workspaceRoot, runId, failedCommandsOf(runScope(c.entries, runId)), checks, signal)),
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
    const scratch = new ScratchCopy(root, [`verify-${runId.slice(0, 8)}`], this.host.scratchLinkDirs?.(workspaceRoot) ?? ["node_modules"]);
    const trusted = new Set(checks.map((c) => c.command));
    try {
      // The copy is made only once a check is approved, so nothing is copied for a check the user rejects.
      const results = await runAllChecks(checks, () => scratch.sync(pendingBase(run.changes)), signal, (check) => this.approveVerifyCheck(conversationId, runId, check, trusted), this.host.terminal?.(workspaceRoot));
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

  /**
   * Commands the sub-agents ran that failed, split by whether the drafts caused the failure. Each one runs
   * again on a copy of the project without the drafts (with the same approval as a check): the failures that
   * show there too were there before the request. Run 6 sent fix-ups after a test that had always failed,
   * outside the request, until it timed out. Commands that are also checks are left out: the checks cover them.
   */
  async compareWithProject(
    conversationId: string,
    workspaceRoot: string,
    runId: string,
    failed: FailedCommand[],
    checks: CheckConfig[],
    signal: AbortSignal,
  ): Promise<Pick<VerifyContext, "failedCommands" | "preexistingFailures" | "uncomparedFailures">> {
    const own = failed.filter((f) => !checks.some((k) => k.command === f.line)).slice(0, 2);
    if (!own.length) return {};
    const root = await this.host.openFolder(workspaceRoot);
    if (!root) return { uncomparedFailures: own };
    const scratch = new ScratchCopy(root, [`baseline-${runId.slice(0, 8)}`], this.host.scratchLinkDirs?.(workspaceRoot) ?? ["node_modules"]);
    const caused: FailedCommand[] = [];
    const preexisting: FailedCommand[] = [];
    const uncompared: FailedCommand[] = [];
    try {
      const base = await runAllChecks(
        own.map((f, i) => ({ name: `baseline ${i + 1}`, command: f.line })),
        () => scratch.sync(new Map()),
        signal,
        (check) => this.approveVerifyCheck(conversationId, runId, check, new Set(), "to see whether it failed already before the drafts (a failure that was there before is not this request's to fix)"),
        this.host.terminal?.(workspaceRoot),
      );
      own.forEach((f, i) => {
        const b = base[i];
        const verdict = !b || b.skipped ? "unknown" : failedBefore(f.output, b);
        (verdict === "before" ? preexisting : verdict === "new" ? caused : uncompared).push(f);
      });
    } catch (err) {
      if (signal.aborted) throw err;
      this.host.log("warn", `Could not run the failed commands on the project without the drafts: ${(err as Error).message}`);
      uncompared.push(...own.filter((f) => !caused.includes(f) && !preexisting.includes(f)));
    } finally {
      await scratch.remove().catch(() => undefined);
    }
    if (preexisting.length) this.host.log("info", `Failed already without the drafts, so not this request's to fix: ${preexisting.map((f) => f.line).join(", ")}.`);
    return { failedCommands: caused, preexistingFailures: preexisting, uncomparedFailures: uncompared };
  }

  /** Same rule as a sub-agent's checks: approved checks run when "Run commands" is on or allowed for this run, otherwise the user is asked. */
  async approveVerifyCheck(conversationId: string, runId: string, check: CheckConfig, trusted: ReadonlySet<string>, purpose?: string): Promise<boolean> {
    if (isCheckAutoApproved(this.host.permissions().commands, trusted, check.command) || this.s.allowedFor(runId).has(check.command)) return true;
    const { decision } = await this.s.waitFor(conversationId, {
      author: "coordinator",
      kind: "approval",
      runId,
      rememberable: true,
      rememberLabel: "Allow for the rest of this run",
      text: `I'd like to run \`${check.command}\` ${purpose ? `on the project without the drafts, ${purpose}` : `(check "${check.name}") to verify the work with all drafts together`}. It runs in a copy of the project, so your files are not touched, but like any command it runs as you and can read files elsewhere or use the network, so only allow it if you trust it. Turn on "Run commands" to stop being asked.`,
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
    // Each task's drafts with their state, so the planner sees what is finished and what still needs work.
    const draftsOf = (id: string) => (run.changes ?? []).filter((c) => c.taskId === id).map((c) => `${c.path} ${c.status}`);
    const reports: VerifyTask[] = run.tasks.map((t) => {
      const drafts = draftsOf(t.id);
      return { title: t.title, status: `${t.status.replace("_", " ")}${drafts.length ? `; drafts: ${drafts.join(", ")}` : "; no drafts"}`, summary: t.summary ?? t.error ?? "" };
    });
    // The user's own words are the instruction; the coordinator's model-written request only goes along fenced.
    const userRequest = userRequestOf(run, (await this.conversations.load(conversationId)).entries);
    let result;
    try {
      result = await planRequest(
        this.s.coordinatorProvider(workspaceRoot, runId),
        { request: fixUpRequest(userRequest, round, v.missing.length), planned: run.request, fileTree, learned: fixUpNotes(v, v.checks ?? [], reports), maxTasks: Math.min(4, Math.max(1, v.missing.length), this.host.delegationLimits().maxTasks), skills: await this.host.skills?.(workspaceRoot).catch(() => undefined) },
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
    // One sub-agent per file: two fix-up tasks on the same file undid each other's work in run 6E.
    // Run 8: verification named test/thermostat.test.js, which does not exist (the tests are in test.js), and two
    // fix-up rounds were scoped to it. A task scoped only to files that do not exist, that no earlier task of the run
    // was planned for and that the user never named, is left out.
    const said = (userRequest ?? "").toLowerCase();
    const invented = new Set<string>();
    for (const t of result.plan.tasks) {
      const literal = t.fileScope.filter((f) => !/[*?[{]/.test(f));
      if (!literal.length || literal.length !== t.fileScope.length) continue;
      const planned0 = new Set(run.tasks.flatMap((x) => x.fileScope));
      const exists = await Promise.all(literal.map(async (f) => planned0.has(f) || !!run.changes?.some((c) => c.path === f) || (await fileExists(workspaceRoot, f))));
      if (exists.some(Boolean) || literal.some((f) => said.includes(f.toLowerCase()))) continue;
      invented.add(t.id);
    }
    if (invented.size) {
      await this.s.append(conversationId, {
        author: "system",
        runId,
        tone: "warning",
        text: `I left out ${invented.size} fix-up task(s) for files that do not exist in the project and that you did not ask for: ${result.plan.tasks.filter((t) => invented.has(t.id)).flatMap((t) => t.fileScope).join(", ")}.`,
      });
    }
    const offTarget = new Set([...invented, ...offTargetTasks(result.plan.tasks, v.missing).map((t) => t.id)]);
    if (offTarget.size) this.host.log("info", `Fix-up plan: left out ${offTarget.size} task(s) whose files the missing work does not name.`);
    if (result.plan.tasks.every((t) => offTarget.has(t.id))) return [];
    const planned = mergeSameFileTasks(result.plan.tasks.filter((t) => !offTarget.has(t.id)).map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => !offTarget.has(d)) })));
    // New ids, so they never clash with the run's earlier tasks; dependencies point at the new ids.
    const taken = new Set(run.tasks.map((t) => t.id));
    const ids = new Map<string, string>();
    for (const t of planned) {
      let id = `fix${round}-${t.id}`;
      for (let n = 2; taken.has(id); n++) id = `fix${round}-${t.id}-${n}`;
      taken.add(id);
      ids.set(t.id, id);
    }
    const added = await this.tasks.addTasks(
      runId,
      planned.map((t) => ({ ...t, id: ids.get(t.id)!, dependsOn: t.dependsOn.map((d) => ids.get(d)!).filter(Boolean) })),
    );
    for (const r of result.repairs.filter((x) => ids.has(x.taskId) && ids.has(x.addedDependency))) {
      await this.tasks.log({ runId, taskId: ids.get(r.taskId), type: "plan_repair", message: `${ids.get(r.taskId)} now waits for ${ids.get(r.addedDependency)}: ${r.reason}` });
    }
    return added;
  }

}
