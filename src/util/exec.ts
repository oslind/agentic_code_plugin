import { ChildProcess, spawn } from "child_process";

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
    if (options.signal?.aborted) return reject(abortError());
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: options.shell ?? false,
      env: options.env ?? process.env,
      // Its own process group, so stopping also ends what a shell command started (npm -> node -> ...).
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, options.timeoutMs)
      : undefined;
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.stdout.on("data", (d: Buffer) => (stdout = cap(stdout + d.toString(), max)));
    child.stderr.on("data", (d: Buffer) => (stderr = cap(stderr + d.toString(), max)));
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      if (aborted) reject(abortError());
      else resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function abortError(): Error {
  const err = new Error("The command was stopped.");
  err.name = "AbortError";
  return err;
}

/** Ends a command and everything it started. */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => child.kill());
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
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
