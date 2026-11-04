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
  /** Receives output as it arrives, for example to show it in a terminal. */
  onOutput?: (chunk: string) => void;
  /** How many characters of both streams together go to onOutput; after that, one notice and nothing more. */
  maxStreamed?: number;
}

/** Default for how much output one command may stream to the terminal (about 1 MB). */
export const MAX_STREAMED = 1_000_000;

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
    const streamMax = options.maxStreamed ?? MAX_STREAMED;
    let streamed = 0;
    const stream = (text: string) => {
      if (!options.onOutput || streamed > streamMax) return;
      const room = streamMax - streamed;
      streamed += text.length;
      if (text.length <= room) return options.onOutput(text);
      if (room > 0) options.onOutput(text.slice(0, room));
      options.onOutput(
        `\n[... more output not shown: this command printed over ${streamMax.toLocaleString("en-US")} characters. It keeps running, and its result and the end of its output are still checked ...]\n`,
      );
      streamed = streamMax + 1;
    };
    // Decoded as UTF-8 by the stream, so a character split between two chunks is not garbled.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout = cap(stdout + d, max);
      stream(d);
    });
    child.stderr.on("data", (d: string) => {
      stderr = cap(stderr + d, max);
      stream(d);
    });
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

/**
 * Splits a simple command line such as `npm test` or `pytest -q "tests/a b.py"`
 * into a program and its arguments, so it can run without a shell. Returns
 * undefined when the line uses anything only a shell understands (pipes,
 * `&&`, redirects, variables, globs, `VAR=x` prefixes, backslashes); such
 * commands still need a shell.
 */
export function splitCommand(command: string): string[] | undefined {
  const args: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (quote === '"' && /[$`\\!]/.test(ch)) return undefined;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) args.push(current);
      current = "";
      inWord = false;
    } else if (/[|&;<>()$`*?[\]{}~!#\\\r\n]/.test(ch)) {
      return undefined;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (quote) return undefined;
  if (inWord) args.push(current);
  if (args.length === 0 || args[0]!.includes("=")) return undefined;
  return args;
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
