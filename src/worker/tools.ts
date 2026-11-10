import { docInsideBody, exportStyleHints, halfIndexHints, ModuleStyle, moduleStyleOf, importProblems, moduleStyleProblems, unexportedProblems } from "../changes/moduleStyle";
import { CommandSink } from "../checks/commandTerminal";
import { CheckConfig, CheckResult, runCheck } from "../checks/runner";
import { ProjectFiles } from "../tools/sandbox";
import { ToolCall } from "../tools/protocol";
import { isSecretPath } from "../tools/policy";
import { safeFileName } from "../context/untrusted";
import { renameLeftovers } from "../coordinator/review";

const MAX_READ_LINES = 300;
/** Characters read_files shows in all, shared out over its files. */
const MAX_READ_FILES_CHARS = 24_000;
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
  /** The task's instructions, for rule checks that compare a draft with what was asked. */
  said?: string;
}

/** The lines of a file a read actually showed the model, so coverage counts what was seen, not what was asked for. */
export interface FileRead {
  path: string;
  /** First and last line shown, from 1. */
  from: number;
  to: number;
  /** Lines in the part of the file that could be read. */
  total: number;
  /** True when the file was too large to read to its end, so no read of it is ever complete. */
  cut: boolean;
}

export interface ToolOutcome {
  ok: boolean;
  output: string;
  /** Set when the call changed a file. */
  wrote?: string;
  /** Set when the call showed (part of) files. */
  read?: FileRead[];
}

/** Runs an already policy-checked call. Every file access goes through the sandbox. */
export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  try {
    switch (call.tool) {
      case "read_file": {
        // Never more than MAX_READ_BYTES is read, however large the file is.
        const got = await ctx.sandbox.readHead(call.path, MAX_READ_BYTES).catch((err: Error) => ({ error: err.message }));
        if ("error" in got) return { ok: false, output: `${got.error}${await samePathHint(ctx, call.path)}` };
        const head = got;
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
        const read: FileRead[] = end >= start ? [{ path: call.path, from: start, to: end, total: lines.length, cut: head.truncated }] : [];
        return { ok: true, output: `${call.path} (${head.truncated ? `first ${lines.length}` : lines.length} lines)\n${body}${more}${big}`, read };
      }
      case "read_files": {
        // Benchmark pass 1, find-throwing: a researcher given 15 files spent a model call (about 30 s) on each.
        // One call reads them all, each cut to its share of a fixed budget so the reply stays small.
        const paths = call.paths.map((x) => x.trim()).filter(Boolean);
        const share = Math.max(400, Math.floor(MAX_READ_FILES_CHARS / Math.max(1, paths.length)));
        const parts: string[] = [];
        const read: FileRead[] = [];
        for (const p of paths) {
          const head = await ctx.sandbox.readHead(p, MAX_READ_BYTES).catch((err: Error) => ({ error: err.message }));
          if ("error" in head) {
            parts.push(`${p}: could not be read (${head.error}).${await samePathHint(ctx, p)}`);
            continue;
          }
          const lines = head.text.split("\n");
          if (head.truncated && lines.length > 1) lines.pop();
          const shown: string[] = [];
          let used = 0;
          for (const [i, l] of lines.slice(0, MAX_READ_LINES).entries()) {
            const line = `${String(i + 1).padStart(4)}| ${l}`;
            if (used + line.length > share && shown.length) break;
            shown.push(line);
            used += line.length + 1;
          }
          const more = shown.length < lines.length ? `\n[lines ${shown.length + 1}-${lines.length} not shown; read them with read_file and startLine=${shown.length + 1}]` : "";
          const big = head.truncated ? `\n[the file is too large to read to its end; only its first ${lines.length} lines can be read]` : "";
          parts.push(`${p} (${lines.length} lines)\n${shown.join("\n")}${more}${big}`);
          read.push({ path: p, from: 1, to: shown.length, total: lines.length, cut: head.truncated });
        }
        return { ok: true, output: parts.join("\n\n"), read };
      }
      case "list_files": {
        const files = await ctx.sandbox.listFiles(call.glob, MAX_LIST + 1);
        if (files.length === 0) {
          // Check 2026-11-09: list_files "mod_002.js" (no folder) found nothing, and the file was reported missing.
          const elsewhere = /[*?[{]/.test(call.glob) ? [] : await ctx.sandbox.listFiles(`**/${call.glob.split("/").pop()}`, 5).catch(() => [] as string[]);
          return { ok: true, output: elsewhere.length ? `No files match "${call.glob}" exactly, but the project has: ${elsewhere.map(safeFileName).join(", ")}. Paths start at the project root.` : "No files match." };
        }
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
        // Run 13, new-module-used: qwen wrote "\\n" in its JSON, so src/format.js became one line starting with
        // "//": the whole module was a comment, exported nothing, and the next task failed for 30 minutes.
        const { text: content, note } = realBreaks(call.content);
        await ctx.sandbox.writeFile(call.path, content);
        return { ok: true, output: draftNote(call.path, `${content.split("\n").length} lines`) + note + (await writeWarning(ctx, call.path, before, content)), wrote: call.path };
      }
      case "insert_lines": {
        // Run 11, use-strict-everywhere: "add a line at the top" was a fight with exact matching in every file.
        const text = await ctx.sandbox.readFile(call.path);
        const lines = text.split("\n");
        if (call.line > lines.length + 1) return { ok: false, output: `${call.path} has ${lines.length} lines; line must be between 1 and ${lines.length + 1}.` };
        const { text: inserted, note } = realBreaks(call.text);
        const added = inserted.replace(/\n$/, "").split("\n");
        lines.splice(call.line - 1, 0, ...added);
        const edited = lines.join("\n");
        await ctx.sandbox.writeFile(call.path, edited);
        return { ok: true, output: draftNote(call.path, `${added.length} line(s) inserted at line ${call.line}`) + note + (await writeWarning(ctx, call.path, text, edited)), wrote: call.path };
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
        return { ok: true, output: draftNote(call.path, every ? `${count} replacement(s)` : "edit") + note + (await writeWarning(ctx, call.path, text, edited)), wrote: call.path };
      }
      case "run_check": {
        const check = ctx.checks.find((c) => c.name === call.name);
        if (!check) return { ok: false, output: `Unknown check '${call.name}'.` };
        const res = await runCheck(check, ctx.checkDir ? await ctx.checkDir() : ctx.sandbox.root, ctx.signal, undefined, ctx.terminal);
        ctx.onCommand?.(check.command, res);
        if (res.notFound) return { ok: false, output: `${check.name}: could not run, its command does not exist in this project (${res.output}). It is not a check of your work; do not run it again.` };
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
 * Project files with the same name as a path that could not be read. Check 2026-11-09: a researcher looked for
 * mod_002.js without its folder, reported "file not found", and the answer repeated it as a fact.
 */
async function samePathHint(ctx: ToolContext, p: string): Promise<string> {
  const base = p.split("/").pop()!;
  const found = (await ctx.sandbox.listFiles(`**/${base}`, 5).catch(() => [] as string[])).filter((f) => f !== p);
  return found.length ? ` The project has ${found.join(", ")}: use that path. Never report a file as missing before you have tried it.` : "";
}

/** loadWarning(), plus names the draft takes from a project module that does not export them (read through the sandbox). */
async function writeWarning(ctx: ToolContext, path: string, before: string | null, after: string): Promise<string> {
  const imports = await importProblems([{ path, proposed: after }], (p) => ctx.sandbox.readFile(p));
  return loadWarning(path, before, after, await moduleStyleOf(ctx.sandbox.root), ctx.said) + (imports.length ? `\nWarning: ${imports.join(" ")}` : "");
}

/**
 * A warning when a JavaScript draft can no longer load and could before. Run 6 left half of an old
 * function after the closing brace of a replace_in_file edit; nothing told the sub-agent until review.
 */
export function loadWarning(path: string, before: string | null, after: string, style?: ModuleStyle, said?: string): string {
  const unexported = [...unexportedProblems([{ path, original: before, proposed: after }], said), ...docInsideBody([{ path, original: before, proposed: after }])];
  const problems = moduleStyleProblems([{ path, original: before, proposed: after }], style);
  const hints = halfIndexHints(path, after).filter((h) => !before || !halfIndexHints(path, before).includes(h));
  const exportsHint = exportStyleHints(path, before, after);
  const hint = `${hints.length ? `\nCheck: ${hints.join(" ")} Try the function on an odd-length input with run_command (node -e) before you finish.` : ""}${exportsHint.length ? `\nCheck: ${exportsHint.join(" ")}` : ""}`;
  const leftovers = renameLeftovers([{ path, text: after }], said);
  const exportNote = [...unexported, ...leftovers].length ? `\nWarning: ${[...unexported, ...leftovers].join(" ")}` : "";
  if (!problems.length) return hint + exportNote;
  // Run 6H: a 15-line stats.js got seven replace_in_file patches, each making it worse. A small file is easier to write whole.
  const small = after.split("\n").length <= 80;
  return `${hint}\nWarning: ${problems.join(" ")} ${small ? `Read the whole file with read_file, then write it again whole with write_file, correct from top to bottom, instead of patching it further.` : "Read the file and fix it before you finish."}${exportNote}`;
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

/**
 * Text for a whole file or new lines with its line breaks written out (two or more "\\n" and no real line
 * break) is read as having line breaks, and the model is told: a file of one line that holds "\\n" twice is far
 * more often a JSON slip than intended. Anything else is left as it is.
 */
export function realBreaks(text: string): { text: string; note: string } {
  if (!writtenOutBreaks(text) || (text.match(/\\n/g) ?? []).length < 2) return { text, note: "" };
  const fixed = unescapeBreaks(text);
  return {
    text: fixed,
    note: ` Your text had \\n written out instead of line breaks (one line in all), so they were read as line breaks: ${fixed.split("\n").length} lines. Next time put real line breaks in it (one \\n in the JSON string, not two). If you meant the two characters \\n inside a string, read the file and fix it.`,
  };
}

/** Turns written-out \\n, \\r\\n and \\t into the characters they stand for. */
export function unescapeBreaks(text: string): string {
  return text.replace(/\\r\\n|\\n/g, "\n").replace(/\\t/g, "\t");
}
