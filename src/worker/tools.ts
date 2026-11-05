import { CommandSink } from "../checks/commandTerminal";
import { CheckConfig, CheckResult, runCheck } from "../checks/runner";
import { ProjectFiles } from "../tools/sandbox";
import { ToolCall } from "../tools/protocol";
import { isSecretPath } from "../tools/policy";
import { safeFileName } from "../context/untrusted";

const MAX_READ_LINES = 300;
const MAX_LIST = 200;
const MAX_MATCHES = 40;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
/** Most bytes of a file read_file looks at. Larger files are read from the start only. */
const MAX_READ_BYTES = 2 * 1024 * 1024;
/** Most bytes one search reads across all files, so a search over a huge project stays cheap. */
const MAX_SEARCH_TOTAL_BYTES = 64 * 1024 * 1024;

export interface ToolContext {
  sandbox: ProjectFiles;
  checks: CheckConfig[];
  signal?: AbortSignal;
  /** Where checks run: a scratch copy that holds the pending changes. */
  checkDir?: () => Promise<string>;
  /** The extension's terminal, where commands are shown as they run. */
  terminal?: CommandSink;
  /** Called after a command ran, so the chat can show it with its output. */
  onCommand?: (command: string, result: CheckResult) => void;
}

export interface ToolOutcome {
  ok: boolean;
  output: string;
  /** Set when the call changed a file. */
  wrote?: string;
}

/** Runs an already policy-checked call. Every file access goes through the sandbox. */
export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  try {
    switch (call.tool) {
      case "read_file": {
        // Never more than MAX_READ_BYTES is read, however large the file is.
        const head = await ctx.sandbox.readHead(call.path, MAX_READ_BYTES);
        const lines = head.text.split("\n");
        // The last line of a cut file may be cut too.
        if (head.truncated && lines.length > 1) lines.pop();
        const start = Math.max(1, call.startLine ?? 1);
        const end = Math.min(lines.length, call.endLine ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
        const body = lines
          .slice(start - 1, end)
          .map((l, i) => `${String(start + i).padStart(4)}| ${l}`)
          .join("\n");
        const more = end < lines.length ? `\n[lines ${end + 1}-${lines.length} not shown; read again with startLine=${end + 1}]` : "";
        const big = head.truncated ? `\n[the file is ${Math.round(head.size / (1024 * 1024))} MB; only its first ${lines.length} lines can be read. Use search to find something further on]` : "";
        return { ok: true, output: `${call.path} (${head.truncated ? `first ${lines.length}` : lines.length} lines)\n${body}${more}${big}` };
      }
      case "list_files": {
        const files = await ctx.sandbox.listFiles(call.glob, MAX_LIST + 1);
        if (files.length === 0) return { ok: true, output: "No files match." };
        const more = files.length > MAX_LIST ? "\n[more files not shown; use a narrower glob]" : "";
        return { ok: true, output: files.slice(0, MAX_LIST).map(safeFileName).join("\n") + more };
      }
      case "search": {
        const files = await ctx.sandbox.listFiles(call.glob ?? "**", 5000);
        const hits: string[] = [];
        let scanned = 0;
        let stoppedEarly = false;
        for (const f of files) {
          if (hits.length >= MAX_MATCHES) break;
          if (scanned >= MAX_SEARCH_TOTAL_BYTES) {
            stoppedEarly = true;
            break;
          }
          // Secret files cannot be read, so they cannot be searched either.
          if (isSecretPath(f)) continue;
          let text: string;
          try {
            // Large files are skipped without being read: at most the limit plus one byte is read to find out.
            const head = await ctx.sandbox.readHead(f, MAX_SEARCH_FILE_BYTES);
            if (head.truncated) continue;
            text = head.text;
          } catch {
            continue;
          }
          scanned += Buffer.byteLength(text, "utf8");
          if (text.includes("\u0000")) continue;
          text.split("\n").forEach((line, i) => {
            if (hits.length < MAX_MATCHES && line.includes(call.query)) hits.push(`${safeFileName(f)}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        }
        const partial = stoppedEarly ? `\n[search stopped after reading ${MAX_SEARCH_TOTAL_BYTES / (1024 * 1024)} MB; use a narrower glob]` : "";
        return { ok: true, output: (hits.length ? hits.join("\n") : `No matches for '${call.query}'.`) + partial };
      }
      case "write_file":
        await ctx.sandbox.writeFile(call.path, call.content);
        return { ok: true, output: draftNote(call.path, `${call.content.split("\n").length} lines`), wrote: call.path };
      case "replace_in_file": {
        const text = await ctx.sandbox.readFile(call.path);
        const count = text.split(call.search).length - 1;
        if (count !== 1) {
          return {
            ok: false,
            output:
              count === 0
                ? `The search text was not found in ${call.path}. Read the file again and copy the text exactly, including indentation.`
                : `The search text occurs ${count} times in ${call.path}. Include more surrounding lines so it matches once.`,
          };
        }
        await ctx.sandbox.writeFile(call.path, text.replace(call.search, () => call.replace));
        return { ok: true, output: draftNote(call.path, "edit"), wrote: call.path };
      }
      case "run_check": {
        const check = ctx.checks.find((c) => c.name === call.name);
        if (!check) return { ok: false, output: `Unknown check '${call.name}'.` };
        const res = await runCheck(check, ctx.checkDir ? await ctx.checkDir() : ctx.sandbox.root, ctx.signal, undefined, ctx.terminal);
        ctx.onCommand?.(check.command, res);
        return { ok: res.passed, output: `${check.name}: ${res.passed ? "passed" : "FAILED"}\n${res.output}` };
      }
      case "finish":
        return { ok: true, output: call.summary };
      case "ask_user":
      case "ask_coordinator":
      case "request_check":
      case "run_command":
        // The worker handles these itself; they never reach here.
        return { ok: false, output: `${call.tool} is handled by the worker.` };
    }
  } catch (err) {
    return { ok: false, output: (err as Error).message };
  }
}

/**
 * What a sub-agent is told after a write. Small models repeat this back to the
 * user, so it must not say the file was written: it is only a draft.
 */
export function draftNote(filePath: string, what: string): string {
  return `Drafted ${filePath} (${what}). This is a draft, not in the project yet: the user reviews it and decides whether to accept it. Do not say the file was created or updated; say it is ready for review.`;
}
