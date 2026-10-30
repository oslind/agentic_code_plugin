import { spawn } from "child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Run through the platform shell. Only for commands the user configured. */
  shell?: boolean;
  /** Output beyond this many characters per stream is dropped from the middle. */
  maxOutput?: number;
  env?: NodeJS.ProcessEnv;
}

export function exec(command: string, args: string[], options: ExecOptions): Promise<ExecResult> {
  const max = options.maxOutput ?? 200_000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: options.shell ?? false,
      env: options.env ?? process.env,
      signal: options.signal,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : undefined;
    child.stdout.on("data", (d: Buffer) => (stdout = cap(stdout + d.toString(), max)));
    child.stderr.on("data", (d: Buffer) => (stderr = cap(stderr + d.toString(), max)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n[... output cut ...]\n${text.slice(-half)}`;
}

/** Keeps the end of long output, where test runners print failures and summaries. */
export function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `[... ${text.length - maxChars} chars cut ...]\n${text.slice(-maxChars)}`;
}
