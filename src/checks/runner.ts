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
    const options = { cwd, timeoutMs: check.timeoutMs ?? 600_000, signal };
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
