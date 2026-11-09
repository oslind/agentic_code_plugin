/**
 * Questions about many files, split by rule. Benchmark pass 1, find-throwing: asked which of 100 modules throw,
 * the coordinator said it would check each module and sent one researcher, which opened 3 files; the answer then
 * claimed the other 97 "lack error-throwing logic" (42 of them throw). The bigger the question, the less a small
 * model split it. So the extension finds the files a question is about, gives each researcher a batch, sends more
 * rounds for files nobody opened, and tells the answer exactly how much was read.
 */
import { RunEvent } from "../state/types";

/** Below this many files, the coordinator's own research questions are trusted to cover them. */
export const MIN_COVERAGE_FILES = 6;
/** Most files one researcher is given: it opens each one, so this has to fit its step limit. */
export const MAX_BATCH = 15;

const CODE = /\.(c|m)?[jt]sx?$|\.py$|\.rb$|\.go$|\.rs$|\.java$|\.kt$|\.cs$|\.php$|\.swift$|\.c$|\.cc$|\.cpp$|\.h$|\.hpp$/i;
const UNITS = "files?|modules?|scripts?|sources?|source files|classes|components|handlers|services|plugins|pages";
/** Words that make a question about every one of a set of files, not about one of them. */
const EVERY = new RegExp(
  `\\b(which|what)\\s+(?:of\\s+)?(?:the\\s+)?(?:\\d+\\s+)?(${UNITS})\\b|\\bwhich of (?:the|these|those|all)\\b|\\b(all|every|each|any)\\s+(?:of\\s+the\\s+)?(?:\\d+\\s+)?(${UNITS})\\b|\\bthe \\d+ (${UNITS})\\b|\\b(?:list|find|name)\\s+(?:all|every|the)\\s+(${UNITS})\\b`,
  "i",
);

/** A question about the whole project, not just some files in it. */
const WHOLE_PROJECT = /\b(?:in|across|of|throughout)\s+(?:the|this|my|our)\s+(?:whole\s+|entire\s+)?(?:project|code\s?base|repo(?:sitory)?|workspace)\b|\b(?:every|each|all(?: the)?)\s+(?:source\s+)?files?\b/i;
/** A question about what the agents did ("which files did you change?"), answered from the chat, not by reading. */
const ABOUT_THE_CHAT = /\b(?:did|have|has)\s+(?:you|the\s+(?:sub-?)?agents?)\b|\byou\s+(?:changed|edited|created|wrote|touched|modified)\b/i;

const ignored = (p: string) => /(^|\/)(node_modules|\.git|dist|out|build|coverage|vendor|\.venv|venv|__pycache__)\//.test(p);

/** A numbered range of file names in the text ("mod_000.js to mod_099.js"), matched against the project. */
function rangeOf(text: string, files: string[]): string[] | undefined {
  const m = /([\w./-]*?[A-Za-z_./-])(\d+)(\.\w+)?\s*(?:to|through|thru|until|\.\.|-|–|—)\s*(?:[\w./-]*?[A-Za-z_./-])?(\d+)(\.\w+)?\b/.exec(text);
  if (!m) return undefined;
  const stem = m[1]!.split("/").pop()!;
  const ext = m[3] ?? m[5] ?? "";
  const lo = Math.min(Number(m[2]), Number(m[4]));
  const hi = Math.max(Number(m[2]), Number(m[4]));
  if (!stem || hi - lo > 5000) return undefined;
  const re = new RegExp(`(^|/)${stem.replace(/[.$]/g, (c) => `\\${c}`)}(\\d+)${ext.replace(/\./g, "\\.")}$`);
  const hit = files.filter((f) => {
    const n = re.exec(f);
    return n !== null && Number(n[2]) >= lo && Number(n[2]) <= hi;
  });
  return hit.length ? hit : undefined;
}

/** The folders the text names that hold project files ("src/", "in src", "lib/handlers"). Longest first. */
function foldersNamed(text: string, files: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return [...dirs].filter((d) => new RegExp(`(^|[\\s"'\`(])${d.replace(/[.$]/g, (c) => `\\${c}`)}/?(?=[\\s"'\`),.:;?!]|$)`).test(text)).sort((a, b) => b.length - a.length);
}

/**
 * The project files a question asks about one by one, when it asks about every file of a set: a numbered range
 * ("mod_000.js to mod_099.js"), or "which/all/every/each ... files/modules" in a named folder or the whole project.
 * Undefined for any other question, and for sets smaller than MIN_COVERAGE_FILES. Code files only, sorted.
 */
export function filesAskedAbout(question: string, projectFiles: string[], max = 400): string[] | undefined {
  const files = projectFiles.filter((f) => !ignored(f));
  let set = rangeOf(question, files);
  if (!set) {
    if (!EVERY.test(question) || ABOUT_THE_CHAT.test(question)) return undefined;
    const folder = foldersNamed(question, files)[0];
    // Without a folder, only a question that says it is about the whole project ("every file in the project").
    if (!folder && !WHOLE_PROJECT.test(question)) return undefined;
    const pool = files.filter((f) => CODE.test(f) && (!folder || f.startsWith(`${folder}/`)));
    // "modules" in a project of .js files means the .js files: the most common code extension wins.
    const counts = new Map<string, number>();
    for (const f of pool) counts.set(f.slice(f.lastIndexOf(".")), (counts.get(f.slice(f.lastIndexOf("."))) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    set = top ? pool.filter((f) => f.endsWith(top)) : [];
    // Without a folder, "every file" in a big project is too vague to read file by file.
    if (!folder && set.length > max) return undefined;
  }
  const sorted = [...new Set(set)].sort();
  return sorted.length >= MIN_COVERAGE_FILES ? sorted.slice(0, max) : undefined;
}

/** Splits files into at most `researchers` batches of at most MAX_BATCH each, in order. What does not fit waits for a later round. */
export function batchesOf(files: string[], researchers: number): string[][] {
  const n = Math.max(1, researchers);
  const size = Math.min(MAX_BATCH, Math.max(1, Math.ceil(files.length / n)));
  const out: string[][] = [];
  for (let i = 0; i < files.length && out.length < n; i += size) out.push(files.slice(i, i + size));
  return out;
}

/** The research question for one batch: the user's own question, these files only, every one opened. */
export function batchQuestion(question: string, batch: string[]): string {
  return [
    `Answer the user's question for each of these ${batch.length} file(s), and only these: "${question.replace(/\s+/g, " ").trim().slice(0, 600)}"`,
    `Open every one of them, all at once with read_files (a search alone can miss things). Report one line per file: the path, then your finding for that file and the line it rests on. Say "not opened" for any file you could not read.`,
    `Files: ${batch.join(", ")}`,
  ].join("\n");
}

/** Files researchers opened with read_file or read_files, from the run logs. Only an opened file counts as checked. */
export function filesRead(events: RunEvent[]): Set<string> {
  const read = new Set<string>();
  for (const e of events) {
    if (e.type !== "tool_call" || (e.message !== "read_file" && e.message !== "read_files")) continue;
    const call = (e.data as { call?: { path?: unknown; paths?: unknown } } | undefined)?.call;
    const paths = Array.isArray(call?.paths) ? call.paths : [call?.path];
    for (const p of paths) if (typeof p === "string") read.add(p.replace(/^\.\//, ""));
  }
  return read;
}

export interface Coverage {
  /** Every file the question is about. */
  files: string[];
  /** Of those, the ones a researcher opened. */
  read: string[];
  /** Of those, the ones nobody opened. */
  unread: string[];
}

export function coverageOf(files: string[], read: Set<string>): Coverage {
  return { files, read: files.filter((f) => read.has(f)), unread: files.filter((f) => !read.has(f)) };
}

/** A short list of file names: all of them up to `max`, then how many more. */
export function fileList(files: string[], max = 30): string {
  return files.length <= max ? files.join(", ") : `${files.slice(0, max).join(", ")} and ${files.length - max} more`;
}

/** What the answer step is told, as a fact checked by rule. */
export function coverageFact(c: Coverage): string {
  if (!c.unread.length) return `Checked by rule: the sub-agents opened and reported on all ${c.files.length} files your question is about. Answer for every one of them.`;
  return `Checked by rule: the sub-agents opened and reported on only ${c.read.length} of the ${c.files.length} files the question is about. Not checked: ${fileList(c.unread)}. Your first sentence says how many were checked. Say nothing about the files that were not opened: never "the other files ..." or "the rest ...", because nobody read them.`;
}

/** Put in front of an answer that could not read every file, so the user sees the gap first whatever the model wrote. */
export function coverageNote(c: Coverage): string | undefined {
  if (!c.unread.length) return undefined;
  return `Checked ${c.read.length} of the ${c.files.length} files your question is about. The other ${c.unread.length} were not opened or not reported on, so this answer says nothing reliable about them${c.unread.length <= 10 ? ` (${c.unread.join(", ")})` : ""}.`;
}

/** The files of a research question made by batchQuestion(), or undefined for any other question. */
export function batchFilesOf(question: string): string[] | undefined {
  if (!/^Answer the user's question for each of these \d+ file\(s\)/.test(question)) return undefined;
  const line = question.split("\n").find((l) => l.startsWith("Files: "));
  return line ? line.slice("Files: ".length).split(", ").map((f) => f.trim()).filter(Boolean) : undefined;
}

/** True when a report names a file, by its path or by its file name as a whole word. */
export function mentionsFile(text: string, file: string): boolean {
  const base = file.split("/").pop()!;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.includes(file) || new RegExp(`(^|[^\\w./-])${esc(base)}(?![\\w])`).test(text);
}

/**
 * The review of a batch researcher, by rule instead of by a model. Benchmark check 2026-11-09: a model review told
 * a researcher with 2 files that "the task requires checking all 100 modules", and its widened report put 9 wrong
 * modules in the answer; another accepted "mod_002.js: file not found" from a wrong path. A batch is done when
 * every one of its files was opened and has a line in the report; anything else is sent back, naming the files.
 */
export function batchReview(batch: string[], read: Set<string>, report: string): { accept: boolean; feedback?: string; unread: string[]; unreported: string[] } {
  const unread = batch.filter((f) => !read.has(f));
  const unreported = batch.filter((f) => !mentionsFile(report, f));
  if (!unread.length && !unreported.length) return { accept: true, unread, unreported };
  const parts = [`Your files are only these ${batch.length}: ${batch.join(", ")}. Do not look at other files; other researchers have them.`];
  if (unread.length) parts.push(`You have not opened ${unread.join(", ")}. Open ${unread.length === 1 ? "it" : "them"} with read_files, using exactly these paths.`);
  if (unreported.length) parts.push(`Your report has no line for ${unreported.join(", ")}.`);
  parts.push("Then finish again with one line for each of your files: the path, then your finding for it.");
  return { accept: false, feedback: parts.join(" "), unread, unreported };
}
