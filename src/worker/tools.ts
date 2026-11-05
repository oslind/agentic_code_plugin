import { CommandSink } from "../checks/commandTerminal";
import { CheckConfig, CheckResult, runCheck } from "../checks/runner";
import { ProjectFiles } from "../tools/sandbox";
import { ToolCall } from "../tools/protocol";
import { isSecretPath } from "../tools/policy";

const MAX_READ_LINES = 300;
const MAX_LIST = 200;
const MAX_MATCHES = 40;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;

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
        const lines = (await ctx.sandbox.readFile(call.path)).split("\n");
        const start = Math.max(1, call.startLine ?? 1);
        const end = Math.min(lines.length, call.endLine ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
        const body = lines
          .slice(start - 1, end)
          .map((l, i) => `${String(start + i).padStart(4)}| ${l}`)
          .join("\n");
        const more = end < lines.length ? `\n[lines ${end + 1}-${lines.length} not shown; read again with startLine=${end + 1}]` : "";
        return { ok: true, output: `${call.path} (${lines.length} lines)\n${body}${more}` };
      }
      case "list_files": {
        const files = await ctx.sandbox.listFiles(call.glob, MAX_LIST + 1);
        if (files.length === 0) return { ok: true, output: "No files match." };
        const more = files.length > MAX_LIST ? "\n[more files not shown; use a narrower glob]" : "";
        return { ok: true, output: files.slice(0, MAX_LIST).join("\n") + more };
      }
      case "search": {
        const files = await ctx.sandbox.listFiles(call.glob ?? "**", 5000);
        const hits: string[] = [];
        for (const f of files) {
          if (hits.length >= MAX_MATCHES) break;
          // Secret files cannot be read, so they cannot be searched either.
          if (isSecretPath(f)) continue;
          let text: string;
          try {
            text = await ctx.sandbox.readFile(f);
          } catch {
            continue;
          }
          if (text.length > MAX_SEARCH_FILE_BYTES || text.includes("\u0000")) continue;
          text.split("\n").forEach((line, i) => {
            if (hits.length < MAX_MATCHES && line.includes(call.query)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        }
        return { ok: true, output: hits.length ? hits.join("\n") : `No matches for '${call.query}'.` };
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
