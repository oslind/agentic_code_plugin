import { exportStyleHints, halfIndexHints, ModuleStyle, moduleStyleOf, moduleStyleProblems } from "../changes/moduleStyle";
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
      case "write_file": {
        const before = /\.(c|m)?js$/i.test(call.path) ? await ctx.sandbox.readFile(call.path).catch(() => null) : null;
        await ctx.sandbox.writeFile(call.path, call.content);
        return { ok: true, output: draftNote(call.path, `${call.content.split("\n").length} lines`) + loadWarning(call.path, before, call.content, await moduleStyleOf(ctx.sandbox.root)), wrote: call.path };
      }
      case "insert_lines": {
        // Run 11, use-strict-everywhere: "add a line at the top" was a fight with exact matching in every file.
        const text = await ctx.sandbox.readFile(call.path);
        const lines = text.split("\n");
        if (call.line > lines.length + 1) return { ok: false, output: `${call.path} has ${lines.length} lines; line must be between 1 and ${lines.length + 1}.` };
        const added = call.text.replace(/\n$/, "").split("\n");
        lines.splice(call.line - 1, 0, ...added);
        const edited = lines.join("\n");
        await ctx.sandbox.writeFile(call.path, edited);
        return { ok: true, output: draftNote(call.path, `${added.length} line(s) inserted at line ${call.line}`) + loadWarning(call.path, text, edited, await moduleStyleOf(ctx.sandbox.root)), wrote: call.path };
      }
      case "replace_in_file": {
        const text = await ctx.sandbox.readFile(call.path);
        let { search, replace } = call;
        let count = occurrences(text, search);
        let note = "";
        // A rename: every occurrence at once (run 10: a rename cost 9 minutes of exact-match retries).
        const every = call.all === true;
        // Without structured output, qwen3:8b wrote "\\n" in its JSON, so the search had the two characters
        // backslash and n where the file has line breaks, and never matched (e2e run 5: 30 minutes of retries).
        if (count === 0 && writtenOutBreaks(search)) {
          const unescaped = unescapeBreaks(search);
          const found = occurrences(text, unescaped);
          if (found === 1 || (every && found > 0)) {
            search = unescaped;
            replace = unescapeBreaks(replace);
            count = found;
            note = " Your search and replace text had \\n written out instead of line breaks; they were read as line breaks.";
          }
        }
        if (count === 0 || (count > 1 && !every)) {
          // Run 10: the hint about written-out \n came three times although the text with real line breaks did
          // not match either; the hint now only comes when real line breaks would have matched.
          const unescaped = writtenOutBreaks(search) ? unescapeBreaks(search) : undefined;
          const breaksHint = unescaped && occurrences(text, unescaped) > 0 ? " Your search text has the two characters \\n where the file has line breaks: put real line breaks in it (one \\n in the JSON string, not two)." : "";
          return {
            ok: false,
            output:
              count === 0
                ? `The search text was not found in ${call.path}.${breaksHint}${nearestMatch(text, unescaped ?? search) ?? " Read the file again and copy the text exactly, including indentation."}${
                    // Run 10B, parallel-changes: the median task timed out re-reading a 20-line file to get a replace right.
                    text.split("\n").length <= 60 ? ` ${call.path} is short: you can also read it once and write it whole with write_file, keeping every line you do not need to change exactly as it is.` : ""
                  }`
                : `The search text occurs ${count} times in ${call.path}. Include more surrounding lines so it matches once, or add "all": true to replace every occurrence (for a rename).`,
          };
        }
        const edited = every ? text.split(search).join(replace) : text.replace(search, () => replace);
        await ctx.sandbox.writeFile(call.path, edited);
        return { ok: true, output: draftNote(call.path, every ? `${count} replacement(s)` : "edit") + note + loadWarning(call.path, text, edited, await moduleStyleOf(ctx.sandbox.root)), wrote: call.path };
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
      case "load_skill":
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
 * A warning when a JavaScript draft can no longer load and could before. Run 6 left half of an old
 * function after the closing brace of a replace_in_file edit; nothing told the sub-agent until review.
 */
export function loadWarning(path: string, before: string | null, after: string, style?: ModuleStyle): string {
  const problems = moduleStyleProblems([{ path, original: before, proposed: after }], style);
  const hints = halfIndexHints(path, after).filter((h) => !before || !halfIndexHints(path, before).includes(h));
  const exportsHint = exportStyleHints(path, before, after);
  const hint = `${hints.length ? `\nCheck: ${hints.join(" ")} Try the function on an odd-length input with run_command (node -e) before you finish.` : ""}${exportsHint.length ? `\nCheck: ${exportsHint.join(" ")}` : ""}`;
  if (!problems.length) return hint;
  // Run 6H: a 15-line stats.js got seven replace_in_file patches, each making it worse. A small file is easier to write whole.
  const small = after.split("\n").length <= 80;
  return `${hint}\nWarning: ${problems.join(" ")} ${small ? `Read the whole file with read_file, then write it again whole with write_file, correct from top to bottom, instead of patching it further.` : "Read the file and fix it before you finish."}`;
}

/**
 * What a sub-agent is told after a write. Small models repeat this back to the
 * user, so it must not say the file was written: it is only a draft.
 */
export function draftNote(filePath: string, what: string): string {
  return `Drafted ${filePath} (${what}). This is a draft, not in the project yet: the user reviews it and decides whether to accept it. Do not say the file was created or updated; say it is ready for review.`;
}

function occurrences(text: string, search: string): number {
  return search ? text.split(search).length - 1 : 0;
}

/**
 * Where a missed search nearly matches, and the first line that differs, so
 * the model copies the real text. Run 9: told only "not found", qwen kept
 * guessing at line breaks (and wrote that belief into its step notes) while
 * the real difference was a changed line.
 */
export function nearestMatch(text: string, search: string): string | undefined {
  const want = search.split("\n");
  const first = want.findIndex((l) => l.trim().length > 0);
  if (first < 0) return undefined;
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim() === want[first]!.trim());
  if (at < 0) return undefined;
  const start = at - first;
  const shown = lines.slice(Math.max(0, start), Math.max(0, start) + want.length);
  const differs = want.findIndex((l, i) => l !== (lines[start + i] ?? ""));
  const diff =
    differs >= 0
      ? ` Line ${differs + 1} of your search differs: you wrote ${JSON.stringify(want[differs]!.slice(0, 160))}, the file has ${lines[start + differs] === undefined ? "nothing (the file ends)" : JSON.stringify(lines[start + differs]!.slice(0, 160))}.`
      : "";
  return `${diff} The file has these lines there (line ${Math.max(0, start) + 1} on); copy them exactly:\n${shown.join("\n").slice(0, 2000)}`;
}

/** True when a text has line breaks written out as backslash-n and no real ones. */
export function writtenOutBreaks(text: string): boolean {
  return /\\n/.test(text) && !text.includes("\n");
}

/** Turns written-out \\n, \\r\\n and \\t into the characters they stand for. */
export function unescapeBreaks(text: string): string {
  return text.replace(/\\r\\n|\\n/g, "\n").replace(/\\t/g, "\t");
}
