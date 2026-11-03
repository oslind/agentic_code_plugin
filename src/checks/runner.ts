import { exec, tail } from "../util/exec";
import { commandLeavesProject } from "../tools/commandGuard";
import { CommandSink } from "./commandTerminal";

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
    const res = await exec(check.command, [], {
      cwd,
      shell: true,
      timeoutMs: check.timeoutMs ?? 600_000,
      signal: stop,
      onOutput: view && ((chunk) => view.output(chunk)),
    });
    view?.end({ code: res.code, timedOut: res.timedOut, durationMs: Date.now() - started });
    const combined = [res.stdout, res.stderr].filter(Boolean).join("\n");
    return {
      name: check.name,
      passed: res.code === 0 && !res.timedOut,
      output: res.timedOut ? `Timed out.\n${tail(combined, maxChars)}` : tail(combined, maxChars),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const stopped = (err as Error).name === "AbortError";
    view?.end({ code: null, stopped, error: stopped ? undefined : (err as Error).message, durationMs: Date.now() - started });
    // Stopped from the terminal only (Ctrl+C there): the check failed, but the run goes on.
    const output = stopped && !signal?.aborted ? "Stopped from the terminal." : (err as Error).message;
    return { name: check.name, passed: false, output, durationMs: Date.now() - started };
  }
}

export async function runAllChecks(
  checks: CheckConfig[],
  cwd: string,
  signal?: AbortSignal,
  approve?: ApproveCommand,
  terminal?: CommandSink,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of checks) {
    if (signal?.aborted) break;
    if (approve && !(await approve(c))) {
      results.push({ name: c.name, passed: true, skipped: true, output: "Skipped: you did not approve running it.", durationMs: 0 });
      continue;
    }
    results.push(await runCheck(c, cwd, signal, undefined, terminal));
  }
  return results;
}
