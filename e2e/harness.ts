/**
 * Runs one scenario through the real chat controller, coordinator and
 * sub-agents, headless: no VS Code, a throwaway copy of a small project, and
 * an autopilot that answers every card the way the scenario says. Nothing is
 * faked but the user.
 */
import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { ChatController, ChatHost, ChatViewState, Decision, DoneBar } from "../src/chat/chatController";
import { ConversationStore } from "../src/chat/conversationStore";
import { ChatEntry, ChatMode } from "../src/chat/types";
import { CommandSink } from "../src/checks/commandTerminal";
import { CheckConfig } from "../src/checks/runner";
import { failedCommandsOf } from "../src/chat/synthesis";
import { fileTree } from "../src/context/budget";
import { Orchestrator } from "../src/coordinator/orchestrator";
import { ModelProvider } from "../src/providers/types";
import { TaskStore } from "../src/state/taskStore";
import { AutoApprove } from "../src/tools/policy";
import { WorkspaceSandbox } from "../src/tools/sandbox";
import { SkillService, TrustedFiles } from "../src/skills/service";
import { autoCompactFrom, autoRetriesFrom, compactSubAgentsFrom, oversightLimitsFrom, skillSettingsFrom } from "../src/userSettings";
import { RecordedCall, RecordingProvider } from "./providers";

/** What a scenario's own expectations can look at once the prompt is dealt with. */
export interface ScenarioRun {
  workspace: string;
  state: ChatViewState;
  entries: ChatEntry[];
  /** The last thing the coordinator said to the user. */
  lastCoordinator?: ChatEntry;
  /** Every card the autopilot answered, in order. */
  cards: { kind: string; text: string; answer: string }[];
  calls: RecordedCall[];
  /** A project file as it is on disk now, or undefined if it does not exist. */
  read(rel: string): Promise<string | undefined>;
  /** Runs a command in the project folder. */
  sh(command: string, args: string[]): Promise<{ code: number; output: string }>;
}

export interface Scenario {
  name: string;
  /** What it guards against, in a sentence. */
  description: string;
  mode: ChatMode;
  /** The project the agents work in, by relative path. */
  files: Record<string, string>;
  /** The user's prompt, and any later messages in the same conversation. */
  prompts: string[];
  /** Auto-approve switches. Default: all off, so every step shows a card the autopilot answers. */
  permissions?: Partial<AutoApprove>;
  /** Checks the user approved for the folder. Default none (and no checks card). */
  checks?: CheckConfig[];
  /** Coordinator verification of the request. Default on, as in the extension. */
  verify?: boolean;
  /** What the autopilot replies to a question. */
  answer?: string;
  /** Accept every pending draft once the prompt is dealt with, like a user who reviews and accepts. Default true. */
  acceptDrafts?: boolean;
  /** How the bottom bar may end. Default only "finished". */
  endStatus?: DoneBar["status"][];
  /** Whether the prompt must end with an answer from the coordinator (research answer or final reply). Default true. */
  endsWithAnswer?: boolean;
  /** Model settings for this scenario only, such as a small context to force compaction. Applied by the suite. */
  model?: { contextWindow?: number; maxOutputTokens?: number; structuredOutput?: "json_schema" | "json_object" | "none" };
  /** Answer "Yes, please go ahead." when the coordinator ends the last prompt with a question and started nothing. Default true. */
  confirm?: boolean;
  /** Deny every approval card (commands, sensitive files), like a cautious user. Default: allow. */
  deny?: boolean;
  /** Press Stop this long after sub-agents start working on the first prompt, then go on with the next prompt. */
  stopAfterMs?: number;
  /** agentic.chat.coordinatorHistoryTokens for this scenario. Default: the extension's 12000. */
  historyTokens?: number;
  /** Trust the project's own skill files, as a user pressing "Use project skills" would. Default: not trusted. */
  trustProjectSkills?: boolean;
  /** The scenario's own checks. Returns what went wrong; empty means it passed. */
  expect(run: ScenarioRun): Promise<string[]> | string[];
}

export interface HarnessOptions {
  /** Fail as stalled when no model call is running and nothing changed for this long. */
  stallMs: number;
  /**
   * Fail when one model request has sent nothing back (not even thinking) for
   * this long. The extension waits for ever by design, so a server that drops
   * a request would otherwise only end at the scenario timeout. Unset: off.
   */
  silenceMs?: number;
  /** Fail when the whole scenario takes longer than this. */
  timeoutMs: number;
  /** Sub-agents running at once. One GPU usually means 1. */
  maxParallel: number;
  /** Folder for the transcript, model calls and command log. Not written when unset. */
  outDir?: string;
  log?: (message: string) => void;
  /** Looks at the project once the drafts are accepted, even when the run was stopped or timed out (the benchmark scores it there). */
  inspect?: (run: ScenarioRun) => Promise<void>;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  failures: string[];
  durationMs: number;
  modelCalls: number;
  /** Seconds spent waiting for the model. */
  modelSeconds: number;
  done?: DoneBar;
  calls: RecordedCall[];
  transcript: string;
  /** The coordinator's last message to the user. */
  answer?: string;
}

const DEFAULT_ANSWER = "I have nothing to add to my request. Use your best judgment, check the project files yourself if something is unclear, and finish without asking me again.";
/** What the user says when the coordinator ends a prompt by asking whether to go ahead. Sent at most once per scenario. */
const CONFIRM = "Yes, please go ahead.";

function sh(cwd: string, command: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });
}

/** The chat as a readable Markdown transcript, for a person checking what the model did. */
export function transcriptOf(entries: ChatEntry[]): string {
  return entries
    .map((e) => {
      const who = e.agentName ? `${e.author} (${e.agentName})` : e.author;
      const label = [e.kind, e.tag, e.decided ? `decided: ${e.decided}` : undefined].filter(Boolean).join(", ");
      const lines = [`### ${who}${label ? ` [${label}]` : ""}`, "", e.text];
      if (e.thought) lines.push("", `> thought: ${e.thought}`);
      if (e.command) lines.push("", "```", `$ ${e.command.line}`, e.command.output.slice(-2000), "```");
      if (e.preview) lines.push("", "```diff", e.preview.slice(0, 2000), "```");
      return lines.join("\n");
    })
    .join("\n\n");
}

/** A card the autopilot answers like a cooperative user: approve, allow, and answer questions. */
function decisionFor(entry: ChatEntry, scenario: Scenario): { decision: Decision; label: string } {
  if (entry.kind === "checks") {
    const checks = scenario.checks ?? [];
    return checks.length ? { decision: { kind: "checks", checks, remember: false }, label: "approved checks" } : { decision: { kind: "skip" }, label: "no checks" };
  }
  if (entry.kind === "approval") return scenario.deny ? { decision: { kind: "deny" }, label: "denied" } : { decision: { kind: "allow" }, label: "allowed" };
  const text = scenario.answer ?? DEFAULT_ANSWER;
  return { decision: { kind: "answer", text }, label: text };
}

/** A user who has changed no settings: every user-only value is its default. */
const NO_USER_SETTINGS = { inspect: () => undefined };

/** A failure named in the reply, in the languages the scenarios use (run 11: a Swedish reply said "misslyckades"). */
export const FAILURE_WORDS = /fail|error|did not pass|not pass|misslyck|fel\b|felet|inte godk/i;

export async function runScenario(scenario: Scenario, model: ModelProvider, opts: HarnessOptions): Promise<ScenarioResult> {
  const log = opts.log ?? (() => {});
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `agentic-e2e-${scenario.name}-`));
  const stateDir = path.join(tmp, "state");
  const ws = path.join(tmp, "project");
  for (const [rel, text] of Object.entries(scenario.files)) {
    await fs.mkdir(path.dirname(path.join(ws, rel)), { recursive: true });
    await fs.writeFile(path.join(ws, rel), text);
  }
  const root = await fs.realpath(ws);
  const provider = new RecordingProvider(model);
  const tasks = new TaskStore(stateDir);
  const conversations = new ConversationStore(stateDir);
  const permissions: AutoApprove = { editFiles: false, sensitiveFiles: false, commands: false, ...scenario.permissions };
  const commandLog: string[] = [];
  const terminal: CommandSink = {
    start(command, cwd) {
      commandLog.push(`$ ${command}   (in ${path.relative(root, cwd) || "."})`);
      return {
        output: (chunk) => void commandLog.push(chunk.replace(/\s+$/, "")),
        end: (r) => void commandLog.push(`[exit ${r.code ?? "none"}${r.timedOut ? ", timed out" : ""}${r.error ? `, ${r.error}` : ""} after ${r.durationMs} ms]`),
      };
    },
  };
  // Built-in skills, no user skills, and the project's only if the scenario trusts them.
  const trusted = new Map<string, TrustedFiles>();
  const skills = new SkillService(path.join(tmp, "user-skills"), () => skillSettingsFrom(NO_USER_SETTINGS), {
    get: (r) => trusted.get(r),
    set: async (r, t) => void (t ? trusted.set(r, t) : trusted.delete(r)),
  });
  if (scenario.trustProjectSkills) await skills.trustProject(root);
  const runs = new Map<string, AbortController>();
  const maxTurns = 30;
  const host: ChatHost = {
    provider: () => provider,
    modelLabel: () => `${provider.model} (e2e)`,
    pickWorkspace: async () => root,
    fileTree: async () => {
      const sandbox = await WorkspaceSandbox.create(root);
      const paths = await sandbox.listFiles("**", 2000);
      return paths.length ? fileTree(paths) : undefined;
    },
    runPlan: async (runId, hooks) => {
      const abort = new AbortController();
      runs.set(runId, abort);
      const orchestrator = new Orchestrator({
        store: tasks,
        runId,
        provider,
        workspaceRoot: root,
        checks: hooks.checks,
        maxParallel: opts.maxParallel,
        maxTurns,
        maxFixRounds: 2,
        // The extension's defaults, as runCommands.ts passes them.
        autoRetries: autoRetriesFrom(NO_USER_SETTINGS),
        compactSteps: compactSubAgentsFrom(NO_USER_SETTINGS),
        skills: hooks.skills,
        linkDirs: [],
        signal: abort.signal,
        terminal,
        approveTool: hooks.approveTool,
        approveCommand: hooks.approveCommand,
        onChanges: hooks.onChanges,
        askUser: hooks.askUser,
        askCoordinator: hooks.askCoordinator,
        reviewResult: hooks.reviewResult,
        inbox: hooks.inbox,
        wrapProvider: hooks.wrapProvider,
      });
      hooks.attach?.({ cancelTask: (taskId) => orchestrator.cancelTask(taskId), maxTurns });
      try {
        return await orchestrator.run();
      } finally {
        runs.delete(runId);
      }
    },
    checksFor: async () => ({ saved: scenario.checks ?? [], defaults: [], detected: [] }),
    saveChecks: async () => {},
    permissions: () => permissions,
    setPermission: async (key, value) => {
      permissions[key] = value;
    },
    cancelRun: (runId) => runs.get(runId)?.abort(),
    defaultMode: () => scenario.mode,
    setDefaultMode: () => {},
    log: (level, message) => log(`[${level}] ${message}`),
    openFolder: async () => root,
    terminal: () => terminal,
    researchLimits: () => ({ maxTurns: 15, maxParallel: opts.maxParallel }),
    // The extension's defaults, so the suite tests what a user gets.
    delegationLimits: () => ({
      maxTasks: 12,
      maxResearchers: 8,
      maxResearchRounds: 3,
      ...oversightLimitsFrom(NO_USER_SETTINGS),
      ...(scenario.verify !== undefined ? { verify: scenario.verify } : {}),
    }),
    coordinatorHistoryTokens: () => scenario.historyTokens ?? 12000,
    autoCompact: () => autoCompactFrom(NO_USER_SETTINGS),
    compactSubAgents: () => compactSubAgentsFrom(NO_USER_SETTINGS),
    skills: (workspaceRoot) => skills.catalog(workspaceRoot),
    scratchLinkDirs: () => [],
    showChange: async () => {},
    closeChange: async () => {},
  };

  const controller = new ChatController(conversations, tasks, host);
  const cards: ScenarioRun["cards"] = [];
  const answered = new Set<string>();
  let lastChange = Date.now();
  let piloting = false;
  const pilot = async () => {
    if (piloting) return;
    piloting = true;
    try {
      const state = await controller.state();
      for (const id of state.waiting) {
        if (answered.has(id)) continue;
        const entry = state.current?.entries.find((e) => e.id === id);
        if (!entry) continue;
        answered.add(id);
        const { decision, label } = decisionFor(entry, scenario);
        cards.push({ kind: entry.kind ?? "message", text: entry.text, answer: label });
        log(`card (${entry.kind}): ${entry.text.slice(0, 160).replace(/\s+/g, " ")} -> ${label}`);
        await controller.decide(id, decision);
      }
    } finally {
      piloting = false;
    }
  };
  const stopListening = controller.onChange(() => {
    lastChange = Date.now();
    void pilot();
  });

  const failures: string[] = [];
  const started = Date.now();
  let stopped: string | undefined;
  /** What the chat showed when the watchdog stopped it, which is where it hung. */
  let stuckAt: ChatEntry | undefined;
  const stop = (why: string) => {
    stopped = why;
    void controller.state().then(
      (s) => {
        stuckAt = s.current?.entries.at(-1);
        controller.cancel();
      },
      () => controller.cancel(),
    );
  };
  const watchdog = setInterval(() => {
    void pilot();
    const now = Date.now();
    const quiet = now - Math.max(lastChange, provider.lastActivity);
    if (stopped) return;
    const silent = now - provider.lastActivity;
    if (provider.inFlight === 0 && quiet > opts.stallMs) stop(`stalled: no model call and no change in the chat for ${Math.round(quiet / 1000)} s`);
    else if (provider.inFlight > 0 && opts.silenceMs && silent > opts.silenceMs) stop(`model request silent: call ${provider.calls.length} sent nothing back for ${Math.round(silent / 1000)} s (the server may have dropped it)`);
    else if (now - started > opts.timeoutMs) stop(`timed out after ${Math.round((now - started) / 1000)} s`);
  }, 1000);

  let transcript = "";
  let answer: string | undefined;
  let done: DoneBar | undefined;
  try {
    let confirmed = false;
    for (const [i, prompt] of scenario.prompts.entries()) {
      log(`user: ${prompt}`);
      // A user who presses Stop while sub-agents work on the first prompt.
      let pressStop: ReturnType<typeof setInterval> | undefined;
      if (i === 0 && scenario.stopAfterMs) {
        let workingSince: number | undefined;
        pressStop = setInterval(() => {
          void controller.state().then((st) => {
            if (!st.runningRunId) return;
            workingSince ??= Date.now();
            if (Date.now() - workingSince < scenario.stopAfterMs!) return;
            clearInterval(pressStop);
            log("user pressed Stop");
            controller.cancel();
          });
        }, 1000);
      }
      try {
        await controller.send(prompt);
      } finally {
        if (pressStop) clearInterval(pressStop);
      }
      if (stopped) break;
      // A user answers "go ahead" when the coordinator ends the last prompt with a question and started nothing.
      if (i === scenario.prompts.length - 1 && !confirmed && scenario.confirm !== false) {
        const st = await controller.state();
        const last = [...(st.current?.entries ?? [])].reverse().find((e) => e.author === "coordinator");
        const ranSomething = Object.keys(st.plans).length > 0;
        if (last && last.kind !== "answer" && /\?\s*$/.test(last.text.trim()) && !ranSomething) {
          confirmed = true;
          log(`user: ${CONFIRM}`);
          cards.push({ kind: "confirm", text: last.text, answer: CONFIRM });
          await controller.send(CONFIRM);
          if (stopped) break;
        }
      }
    }
    let state = await controller.state();
    if (stopped) {
      const last = stuckAt;
      failures.push(`${stopped}. Last entry before it was stopped: ${last ? `${last.author} [${last.kind ?? "message"}] ${last.text.slice(0, 200)}` : "none"}`);
    }

    // A user who reviews the drafts and accepts them, so the scenario can look at the files.
    if (scenario.acceptDrafts !== false) {
      for (const [runId, plan] of Object.entries(state.plans)) {
        if (plan.changes.some((c) => c.status === "pending")) await controller.review(runId, "accept");
      }
      state = await controller.state();
    }

    const entries = state.current?.entries ?? [];
    transcript = transcriptOf(entries);
    done = state.done;
    const lastCoordinator = [...entries].reverse().find((e) => e.author === "coordinator");
    answer = lastCoordinator?.text;
    const run: ScenarioRun = {
      workspace: root,
      state,
      entries,
      lastCoordinator,
      cards,
      calls: provider.calls,
      read: (rel) => fs.readFile(path.join(root, rel), "utf8").catch(() => undefined),
      sh: (command, args) => sh(root, command, args),
    };
    if (opts.inspect) await opts.inspect(run);

    // What every scenario must do: end, end cleanly, and end with a clear answer.
    if (!stopped) {
      if (state.busy) failures.push(`the chat is still busy: ${state.busy}`);
      if (state.waiting.length) failures.push(`${state.waiting.length} card(s) still wait for the user`);
      const allowed = scenario.endStatus ?? ["finished"];
      if (!done) failures.push("no Finished bar: the prompt never counted as dealt with");
      else if (!allowed.includes(done.status)) failures.push(`ended as "${done.status}" (${done.text}), expected ${allowed.join(" or ")}`);
      for (const e of entries.filter((x) => x.kind === "error")) failures.push(`error in the chat: ${e.text.slice(0, 300)}`);
      // A command that failed the last time it ran must not be hidden from the user (qwen once said "No failures").
      // Only the last prompt's commands, as the final reply of a run only covers that run's own: run 3's
      // question-then-answer failed on a test failure from the first prompt, already reported there.
      const lastPrompt = entries.map((e) => e.author === "user" && e.text === scenario.prompts.at(-1)).lastIndexOf(true);
      const failedCommands = failedCommandsOf(entries.slice(Math.max(0, lastPrompt)));
      if (lastCoordinator?.kind === "answer" && failedCommands.length && !FAILURE_WORDS.test(lastCoordinator.text)) {
        failures.push(`the last answer does not mention that ${failedCommands.map((c) => `\`${c.line}\``).join(", ")} failed: ${lastCoordinator.text.slice(0, 300)}`);
      }
      if (scenario.endsWithAnswer !== false && lastCoordinator?.kind !== "answer") {
        failures.push(`the coordinator's last message is not an answer or final reply: [${lastCoordinator?.kind ?? "none"}] ${lastCoordinator?.text.slice(0, 200) ?? ""}`);
      }
      failures.push(...(await scenario.expect(run)));
    }
  } catch (err) {
    failures.push(`the harness failed: ${(err as Error).stack ?? (err as Error).message}`);
  } finally {
    clearInterval(watchdog);
    stopListening();
    controller.dispose();
  }

  const result: ScenarioResult = {
    name: scenario.name,
    passed: failures.length === 0,
    failures,
    durationMs: Date.now() - started,
    modelCalls: provider.calls.length,
    modelSeconds: Math.round(provider.calls.reduce((s, c) => s + c.ms, 0) / 1000),
    done,
    calls: provider.calls,
    transcript,
    answer,
  };
  if (opts.outDir) {
    await fs.mkdir(opts.outDir, { recursive: true });
    const header = [`# ${scenario.name}: ${result.passed ? "passed" : "FAILED"}`, "", scenario.description, "", ...failures.map((f) => `- ${f}`), ""].join("\n");
    await fs.writeFile(path.join(opts.outDir, "transcript.md"), `${header}\n${transcript}\n`);
    await fs.writeFile(path.join(opts.outDir, "commands.log"), commandLog.join("\n") + "\n");
  }
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  return result;
}
