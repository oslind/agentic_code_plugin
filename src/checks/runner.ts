import { exec, splitCommand, tail } from "../util/exec";
import { commandLeavesProject } from "../tools/commandGuard";

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
 * The environment a check runs with: yours, minus variables whose names look
 * like credentials (GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, OPENAI_API_KEY, ...).
 * This only lowers the chance of a leak; a command can still read files your
 * account can read.
 */
export function checkEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k) && !CREDENTIAL_ENV.has(k.toUpperCase())) out[k] = v;
  return out;
}

/** Asks whether a check may run now. Resolving false skips it. */
export type ApproveCommand = (check: CheckConfig) => Promise<boolean>;

export async function runCheck(check: CheckConfig, cwd: string, signal?: AbortSignal, maxChars = 4000): Promise<CheckResult> {
  const started = Date.now();
  const outside = commandLeavesProject(check.command);
  if (outside) return { name: check.name, passed: false, output: `Refused to run \`${check.command}\`: ${outside}`, durationMs: 0 };
  try {
    // Simple commands run directly, without a shell, so nothing in them is expanded or chained.
    // Pipes, `&&` and the like need a shell, and so does Windows, where npm and most tools are .cmd scripts.
    const argv = process.platform === "win32" ? undefined : splitCommand(check.command);
    const options = { cwd, timeoutMs: check.timeoutMs ?? 600_000, signal, env: checkEnv() };
    const res = argv ? await exec(argv[0]!, argv.slice(1), { ...options, shell: false }) : await exec(check.command, [], { ...options, shell: true });
    const combined = [res.stdout, res.stderr].filter(Boolean).join("\n");
    return {
      name: check.name,
      passed: res.code === 0 && !res.timedOut,
      output: res.timedOut ? `Timed out.\n${tail(combined, maxChars)}` : tail(combined, maxChars),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const output = e.code === "ENOENT" ? `Command not found: ${check.command.trim().split(/\s+/)[0]}` : e.message;
    return { name: check.name, passed: false, output, durationMs: Date.now() - started };
  }
}

export async function runAllChecks(checks: CheckConfig[], cwd: string, signal?: AbortSignal, approve?: ApproveCommand): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of checks) {
    if (signal?.aborted) break;
    if (approve && !(await approve(c))) {
      results.push({ name: c.name, passed: true, skipped: true, output: "Skipped: you did not approve running it.", durationMs: 0 });
      continue;
    }
    results.push(await runCheck(c, cwd, signal));
  }
  return results;
}
