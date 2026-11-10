import { exec, splitCommand, tail } from "../util/exec";
import { commandLeavesProject } from "../tools/commandGuard";
import { CommandSink } from "./commandTerminal";
import { scratchCopyOf } from "../changes/scratch";

/**
 * The user's isolation wrapper (agentic.commands.isolation), such as a
 * container or bubblewrap command. When set, every command runs inside it.
 */
let isolation: string[] | undefined;

export function setCommandIsolation(argv: string[] | undefined): void {
  isolation = argv?.length ? [...argv] : undefined;
}

/**
 * The wrapper's arguments with ${command} (the whole command line, as one
 * argument), ${folder} (where it runs: the scratch copy or the project) and
 * ${project} (the real project folder, which linked folders such as
 * node_modules in the copy point into) filled in. Nothing is parsed by a shell here.
 */
export function isolatedArgv(wrapper: readonly string[], command: string, folder: string): string[] {
  const project = scratchCopyOf(folder)?.project ?? folder;
  return wrapper.map((a) => a.split("${command}").join(command).split("${folder}").join(folder).split("${project}").join(project));
}

/** A check's result in a few words, for the chat and prompts. */
export function checkStatus(c: Pick<CheckResult, "passed" | "skipped" | "timedOut" | "notFound">): string {
  if (c.notFound) return "could not run (command not found)";
  if (c.skipped) return "skipped (not approved)";
  return c.passed ? "passed" : c.timedOut ? "timed out" : "failed";
}

/** A check the user configured, such as `npm test`. Workers can only run these by name. */
export interface CheckConfig {
  name: string;
  command: string;
  timeoutMs?: number;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  /** The end of the combined output, sized for a small model's context. */
  output: string;
  durationMs: number;
  /** Not run, because the user did not approve it. */
  skipped?: boolean;
  /** The exit code, when the command ran to the end. */
  code?: number | null;
  timedOut?: boolean;
  /** The command's program does not exist here (ENOENT), so it never ran. */
  notFound?: boolean;
}

/** Names of environment variables that usually hold credentials. */
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|SESSION_?KEY|COOKIE|(^|_)AUTH(_|$))/i;

/** Variables that point to credential files, agents or helpers rather than holding a secret themselves. */
const CREDENTIAL_ENV = new Set([
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_CONFIG",
  "KUBECONFIG",
  "DOCKER_CONFIG",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SUDO_ASKPASS",
  "GPG_AGENT_INFO",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_PROFILE",
  "AZURE_CONFIG_DIR",
  "NETRC",
  "NPM_CONFIG_USERCONFIG",
  "PIP_CONFIG_FILE",
  "VAULT_ADDR",
]);

/**
 * Handles to VS Code itself: its git credential helper (which can hand out
 * your GitHub sign-in), the `code` command channel into this window, and the
 * extension host's own IPC. A check never needs them.
 */
const EDITOR_CHANNEL_ENV = /^(VSCODE_GIT_|VSCODE_IPC_HOOK|VSCODE_HANDLES_|VSCODE_PID$|VSCODE_CODE_CACHE_PATH$|VSCODE_CRASH_REPORTER|ELECTRON_RUN_AS_NODE$)/i;

/**
 * The environment a check runs with: yours, minus variables whose names look
 * like credentials (GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, OPENAI_API_KEY, ...).
 * This only lowers the chance of a leak; a command can still read files your
 * account can read.
 */
export function checkEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!SECRET_ENV.test(k) && !CREDENTIAL_ENV.has(k.toUpperCase()) && !EDITOR_CHANNEL_ENV.test(k)) out[k] = v;
  }
  return out;
}

/** Asks whether a check may run now. Resolving false skips it. */
export type ApproveCommand = (check: CheckConfig) => Promise<boolean>;

/**
 * Runs one check. The process always starts in `cwd`, a folder inside the
 * project, never in whatever folder a terminal happens to be in. With a
 * `terminal`, the command and its output are shown there as it runs.
 */
export async function runCheck(check: CheckConfig, cwd: string, signal?: AbortSignal, maxChars = 4000, terminal?: CommandSink): Promise<CheckResult> {
  const started = Date.now();
  const view = terminal?.start(check.command, cwd);
  const outside = commandLeavesProject(check.command);
  if (outside) {
    const output = `Refused to run \`${check.command}\`: ${outside}`;
    view?.end({ code: null, error: output, durationMs: 0 });
    return { name: check.name, passed: false, output, durationMs: 0 };
  }
  const stop = view?.signal ? (signal ? AbortSignal.any([signal, view.signal]) : view.signal) : signal;
  try {
    // Simple commands run directly, without a shell, so nothing in them is expanded or chained.
    // Pipes, `&&` and the like need a shell, and so does Windows, where npm and most tools are .cmd scripts.
    const argv = process.platform === "win32" ? undefined : splitCommand(check.command);
    const options = {
      cwd,
      timeoutMs: check.timeoutMs ?? 600_000,
      signal: stop,
      env: checkEnv(),
      onOutput: view && ((chunk: string) => view.output(chunk)),
    };
    let res;
    if (isolation) {
      // The user's own wrapper starts the command; it is never given to a shell by the extension.
      const wrapped = isolatedArgv(isolation, check.command, cwd);
      view?.output(`[isolated: ${wrapped[0]}, from agentic.commands.isolation]\n`);
      res = await exec(wrapped[0]!, wrapped.slice(1), { ...options, shell: false });
    } else {
      res = argv ? await exec(argv[0]!, argv.slice(1), { ...options, shell: false }) : await exec(check.command, [], { ...options, shell: true });
    }
    view?.end({ code: res.code, timedOut: res.timedOut, durationMs: Date.now() - started });
    const combined = [res.stdout, res.stderr].filter(Boolean).join("\n");
    return {
      name: check.name,
      passed: res.code === 0 && !res.timedOut,
      code: res.code,
      timedOut: res.timedOut || undefined,
      output: res.timedOut ? `Timed out.\n${tail(combined, maxChars)}` : tail(combined, maxChars),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const stopped = e.name === "AbortError";
    // Stopped from the terminal only (Ctrl+C there): the check failed, but the run goes on.
    const output = stopped
      ? signal?.aborted
        ? e.message
        : "Stopped from the terminal."
      : e.code === "ENOENT"
        ? `Command not found: ${isolation ? `${isolation[0]} (from agentic.commands.isolation)` : check.command.trim().split(/\s+/)[0]}`
        : e.message;
    view?.end({ code: null, stopped, error: stopped ? undefined : output, durationMs: Date.now() - started });
    // A program that does not exist here never ran: it is reported as not run, never as a failure that the
    // sub-agents could fix (run 13, python-project: "python -m pytest" in a Node project gated five attempts).
    if (!stopped && e.code === "ENOENT") return { name: check.name, passed: true, skipped: true, notFound: true, output: `Could not run: ${output}`, durationMs: Date.now() - started };
    return { name: check.name, passed: false, output, durationMs: Date.now() - started };
  }
}

export async function runAllChecks(
  checks: CheckConfig[],
  /** The folder, or a function that makes it; it is called only once the first check is approved. */
  cwd: string | (() => Promise<string>),
  signal?: AbortSignal,
  approve?: ApproveCommand,
  terminal?: CommandSink,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  let folder = typeof cwd === "string" ? cwd : undefined;
  for (const c of checks) {
    if (signal?.aborted) break;
    if (approve && !(await approve(c))) {
      results.push({ name: c.name, passed: true, skipped: true, output: "Skipped: you did not approve running it.", durationMs: 0 });
      continue;
    }
    folder ??= await (cwd as () => Promise<string>)();
    results.push(await runCheck(c, folder, signal, undefined, terminal));
  }
  return results;
}
