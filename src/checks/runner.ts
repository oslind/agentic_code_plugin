import { exec, tail } from "../util/exec";
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
    const res = await exec(check.command, [], { cwd, shell: true, timeoutMs: check.timeoutMs ?? 600_000, signal });
    const combined = [res.stdout, res.stderr].filter(Boolean).join("\n");
    return {
      name: check.name,
      passed: res.code === 0 && !res.timedOut,
      output: res.timedOut ? `Timed out.\n${tail(combined, maxChars)}` : tail(combined, maxChars),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return { name: check.name, passed: false, output: (err as Error).message, durationMs: Date.now() - started };
  }
}

export async function runAllChecks(checks: CheckConfig[], cwd: string, signal?: AbortSignal, approve?: ApproveCommand): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of checks) {
    if (approve && !(await approve(c))) {
      results.push({ name: c.name, passed: true, skipped: true, output: "Skipped: you did not approve running it.", durationMs: 0 });
      continue;
    }
    results.push(await runCheck(c, cwd, signal));
  }
  return results;
}
