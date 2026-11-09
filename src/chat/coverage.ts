/**
 * Questions about many files, split by rule. Benchmark pass 1, find-throwing: asked which of 100 modules throw,
 * the coordinator said it would check each module and sent one researcher, which opened 3 files; the answer then
 * claimed the other 97 "lack error-throwing logic" (42 of them throw). The bigger the question, the less a small
 * model split it. So the extension finds the files a question is about, gives each researcher a batch, sends more
 * rounds for files nobody opened, and tells the answer exactly how much was read.
 */
import { RunEvent } from "../state/types";
import { escapeRegExp } from "../context/outline";

/** Below this many files, the coordinator's own research questions are trusted to cover them. */
export const MIN_COVERAGE_FILES = 6;
/** Most project files listed to find the files of a question. A project with more is said to be cut, never silently. */
export const LIST_LIMIT = 5000;
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

const RANGE = /([\w./-]*?[A-Za-z_./-])(\d+)(\.\w+)?\s*(?:to|through|thru|until|\.\.|-|–|—)\s*(?:[\w./-]*?[A-Za-z_./-])?(\d+)(\.\w+)?\b/;

/** A numbered range of file names in the text ("mod_000.js to mod_099.js"), matched against the project. */
function rangeOf(text: string, files: string[]): string[] | undefined {
  const m = RANGE.exec(text);
  if (!m) return undefined;
  const parts = m[1]!.replace(/^\.\//, "").split("/");
  const stem = parts.pop()!;
  // A folder in the range ("shared/mod_000.js to ...") means that folder, from the project root, and no other
  // (audit of PR #54: src/mod_*.js used to answer for shared/mod_*.js).
  const dir = parts.filter(Boolean).join("/");
  const ext = m[3] ?? m[5] ?? "";
  const lo = Math.min(Number(m[2]), Number(m[4]));
  const hi = Math.max(Number(m[2]), Number(m[4]));
  if (!stem || hi - lo > 5000) return undefined;
  const re = new RegExp(`${dir ? `(^${escapeRegExp(dir)}/)` : "(^|/)"}${escapeRegExp(stem)}(\\d+)${escapeRegExp(ext)}$`);
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
  return [...dirs].filter((d) => new RegExp(`(^|[\\s"'\`(])${escapeRegExp(d)}/?(?=[\\s"'\`),.:;?!]|$)`).test(text)).sort((a, b) => b.length - a.length);
}

/**
 * The project files a question asks about one by one, when it asks about every file of a set: a numbered range
 * ("mod_000.js to mod_099.js"), or "which/all/every/each ... files/modules" in a named folder or the whole project.
 * Undefined for any other question, and for sets smaller than MIN_COVERAGE_FILES. Code files only, sorted.
 * Every file of the set is returned (audit of PR #54: it used to keep the first 400 without a word); the rounds
 * that cannot read them all leave the rest unread, and the answer says how many. `max` only stops a question
 * without a folder ("every file") in a big project from turning into file-by-file reading at all.
 */
export function filesAskedAbout(question: string, projectFiles: string[], max = 400): string[] | undefined {
  const a = askedScope(question, projectFiles, max);
  return "files" in a ? a.files : undefined;
}

/**
 * What a question asks about, file by file: the files, or, for a question about every file of a project too big
 * to read one by one, how many files that is. Audit of PR #54: such a question used to fall back to an ordinary
 * answer that never said not every file was read; `tooMany` lets the answer say so.
 */
export function askedScope(
  question: string,
  projectFiles: string[],
  max = 400,
  skippedLinks: readonly string[] = [],
): { files: string[]; skipped?: string[] } | { tooMany: number } | Record<string, never> {
  const files = projectFiles.filter((f) => !ignored(f));
  let set = rangeOf(question, files);
  // A range is matched against both before branching: one whose files are all skipped links is still a range.
  const skippedInRange = rangeOf(question, [...skippedLinks]);
  if (!set && skippedInRange) set = [];
  // Links the listing could not follow (outside the project, or into a skipped folder), in the asked scope.
  // Audit of PR #54: a numbered range found the other 99 files and called them the whole set, so the range is
  // matched against the skipped links too; a folder the question names that is itself such a link is one.
  let skipped: string[] = [];
  // A range or an every-file question about paths under a linked folder the listing could not follow
  // ("shared/mod_000.js to shared/mod_099.js"): nothing under it was listed, so the link is the whole answer.
  // Checked whether or not other files matched, so the link is never left out of the answer.
  const under =
    !ABOUT_THE_CHAT.test(question) && (RANGE.test(question) || EVERY.test(question))
      ? skippedLinks.filter((d) => new RegExp(`(^|[\\s"'\`(])${escapeRegExp(d)}/`).test(question)).sort((a, b) => b.length - a.length)[0]
      : undefined;
  if (!set && under) return { files: [], skipped: [under] };
  if (set) {
    skipped = [...new Set([...(skippedInRange ?? []), ...(under ? [under] : [])])];
  } else {
    if (!EVERY.test(question) || ABOUT_THE_CHAT.test(question)) return {};
    const listedFolder = foldersNamed(question, files)[0];
    const linkFolder = foldersNamed(question, skippedLinks.map((s) => `${s}/_`)).find((d) => skippedLinks.includes(d));
    if (linkFolder && (!listedFolder || linkFolder.length > listedFolder.length)) return { files: [], skipped: [linkFolder] };
    const folder = listedFolder;
    // Without a folder, only a question that says it is about the whole project ("every file in the project").
    if (!folder && !WHOLE_PROJECT.test(question)) return {};
    const pool = files.filter((f) => CODE.test(f) && (!folder || f.startsWith(`${folder}/`)));
    // "modules" in a project of .js files means the .js files: the most common code extension wins.
    const counts = new Map<string, number>();
    for (const f of pool) counts.set(f.slice(f.lastIndexOf(".")), (counts.get(f.slice(f.lastIndexOf("."))) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    set = top ? pool.filter((f) => f.endsWith(top)) : [];
    // Without a folder, "every file" in a big project is too vague to read file by file; the answer says so.
    if (!folder && set.length > max) return { tooMany: set.length };
    skipped = skippedLinks.filter((s) => !folder || s.startsWith(`${folder}/`));
  }
  const sorted = [...new Set(set)].sort();
  if (sorted.length + skipped.length < MIN_COVERAGE_FILES) return {};
  return skipped.length ? { files: sorted, skipped } : { files: sorted };
}

/**
 * "all 410 code files", or, when the listing stopped at LIST_LIMIT, "at least 410 code files (...)": audit of
 * PR #54, the count from a cut listing is only a lower bound.
 */
export function codeFiles(n: number, listCut = false): string {
  return listCut ? `at least ${n} code files (the project has more than ${LIST_LIMIT} files, so the total is not known)` : `all ${n} code files`;
}

/** What the answer to a question about every file of a big project says first: not every file was read. */
export function tooManyNote(n: number, listCut = false): string {
  return `Your question is about ${codeFiles(n, listCut)} of the project, too many to read one by one, so not every file was read: this answer rests on searches and the files the researchers chose to open. Name a folder to have every file in it read.`;
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

/** How much of one file the reads in a log showed. */
export interface ReadExtent {
  /** Lines shown, counted once however often they were read. */
  seen: number;
  /** Lines in the file (in the part that could be read, for a file too large to read to its end). */
  total: number;
  /** The first line not shown yet, if any. */
  firstGap?: number;
  /** The file is too large to be read to its end. */
  cut: boolean;
  complete: boolean;
}

/**
 * What researchers' reads showed of each file, from the "files_read" events a worker logs after a read worked.
 * Audit of PR #54: counting the read_file calls themselves counted reads that failed ("file not found") and
 * files of which only the first lines fit in the reply. A file is complete only when every line was shown.
 */
export function readExtents(events: RunEvent[]): Map<string, ReadExtent> {
  const spans = new Map<string, { ranges: [number, number][]; total: number; cut: boolean }>();
  for (const e of events) {
    if (e.type !== "files_read") continue;
    const reads = (e.data as { reads?: unknown } | undefined)?.reads;
    if (!Array.isArray(reads)) continue;
    for (const r of reads as Record<string, unknown>[]) {
      if (typeof r?.path !== "string" || typeof r.from !== "number" || typeof r.to !== "number" || typeof r.total !== "number" || r.to < r.from) continue;
      const path = r.path.trim().replace(/^\.\//, "");
      const s = spans.get(path) ?? { ranges: [], total: 0, cut: false };
      s.ranges.push([Math.max(1, r.from), r.to]);
      s.total = Math.max(s.total, r.total);
      s.cut ||= r.cut === true;
      spans.set(path, s);
    }
  }
  const out = new Map<string, ReadExtent>();
  for (const [path, s] of spans) {
    const merged: [number, number][] = [];
    for (const [a, b] of s.ranges.sort((x, y) => x[0] - y[0])) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    let seen = 0;
    let firstGap: number | undefined;
    let next = 1;
    for (const [a, b] of merged) {
      const to = Math.min(b, s.total);
      if (a > to) continue;
      if (a > next && firstGap === undefined) firstGap = next;
      seen += to - a + 1;
      next = to + 1;
    }
    if (firstGap === undefined && next <= s.total) firstGap = next;
    out.set(path, { seen, total: s.total, firstGap, cut: s.cut, complete: firstGap === undefined && !s.cut });
  }
  return out;
}

/** Files a researcher read completely, from the run logs. Only a file read to its end counts as checked. */
export function filesRead(events: RunEvent[]): Set<string> {
  return new Set([...readExtents(events)].filter(([, x]) => x.complete).map(([p]) => p));
}

export interface Coverage {
  /** Every file the question is about. */
  files: string[];
  /** Of those, the ones a researcher opened. */
  read: string[];
  /** Of those, the ones nobody opened. */
  unread: string[];
  /** The project had more files than could be listed, so the question may be about files not in `files`. */
  listCut?: boolean;
  /** Linked files or folders the listing could not follow, so files behind them are not in `files`. */
  skipped?: string[];
}

export function coverageOf(files: string[], read: Set<string>, listCut = false, skipped: readonly string[] = []): Coverage {
  const c: Coverage = { files, read: files.filter((f) => read.has(f)), unread: files.filter((f) => !read.has(f)) };
  if (listCut) c.listCut = true;
  if (skipped.length) c.skipped = [...skipped];
  return c;
}

/** What the answer says about links the listing could not follow (audit of PR #54). */
function skippedText(c: Coverage): string {
  return c.skipped?.length ? `Linked files or folders that could not be followed, so nothing behind them was read: ${fileList(c.skipped, 10)}.` : "";
}

const CUT = `The project has more than ${LIST_LIMIT} files, more than could be listed, so files beyond those listed were not considered at all.`;

/** A short list of file names: all of them up to `max`, then how many more. */
export function fileList(files: string[], max = 30): string {
  return files.length <= max ? files.join(", ") : `${files.slice(0, max).join(", ")} and ${files.length - max} more`;
}

/** What the answer step is told, as a fact checked by rule. */
export function coverageFact(c: Coverage): string {
  if (!c.files.length) return `Checked by rule: none of the files your question is about could be listed or read. ${skippedText(c)} Your first sentence says so; say nothing about what those files contain.`;
  const gaps = [c.listCut ? CUT : "", skippedText(c)].filter(Boolean).join(" ");
  const cut = gaps ? ` ${gaps} Say so in your first sentence.` : "";
  if (!c.unread.length) return `Checked by rule: the sub-agents read and reported on all ${c.files.length} files your question is about${c.listCut ? " that could be listed" : c.skipped?.length ? " that could be listed" : ""}. Answer for every one of them.${cut}`;
  return `Checked by rule: the sub-agents read to the end and reported on only ${c.read.length} of the ${c.files.length} files the question is about. Not checked: ${fileList(c.unread)}. Your first sentence says how many were checked. Say nothing about the files that were not read: never "the other files ..." or "the rest ...", because nobody read them.${cut}`;
}

/** Put in front of an answer that could not read every file, so the user sees the gap first whatever the model wrote. */
export function coverageNote(c: Coverage): string | undefined {
  const cut = [c.listCut ? CUT : "", skippedText(c)].filter(Boolean).join(" ");
  if (!c.unread.length) return cut || undefined;
  return `Checked ${c.read.length} of the ${c.files.length} files your question is about. The other ${c.unread.length} were not read to the end or not reported on, so this answer says nothing reliable about them${c.unread.length <= 10 ? ` (${c.unread.join(", ")})` : ""}.${cut ? ` ${cut}` : ""}`;
}

/** The files of a research question made by batchQuestion(), or undefined for any other question. */
export function batchFilesOf(question: string): string[] | undefined {
  if (!/^Answer the user's question for each of these \d+ file\(s\)/.test(question)) return undefined;
  const line = question.split("\n").find((l) => l.startsWith("Files: "));
  return line ? line.slice("Files: ".length).split(", ").map((f) => f.trim()).filter(Boolean) : undefined;
}

/** The path as a whole, so "src/a/index.js" is not found inside "lib/src/a/index.js". */
function pathMentioned(text: string, file: string): boolean {
  return new RegExp(`(^|[^\\w./-])(\\./)?${escapeRegExp(file)}(?![\\w])`).test(text);
}

/**
 * True when a report names a file, by its path or by its file name as a whole word. When another file of
 * `among` has the same file name, only the path counts (audit of PR #54: "index.js: ..." used to count as a
 * report on both src/a/index.js and src/b/index.js).
 */
export function mentionsFile(text: string, file: string, among: readonly string[] = []): boolean {
  const base = file.split("/").pop()!;
  if (among.some((o) => o !== file && o.split("/").pop() === base)) return pathMentioned(text, file);
  return text.includes(file) || new RegExp(`(^|[^\\w./-])${escapeRegExp(base)}(?![\\w])`).test(text);
}

/**
 * The review of a batch researcher, by rule instead of by a model. Benchmark check 2026-11-09: a model review told
 * a researcher with 2 files that "the task requires checking all 100 modules", and its widened report put 9 wrong
 * modules in the answer; another accepted "mod_002.js: file not found" from a wrong path. A batch is done when
 * every one of its files was opened and has a line in the report; anything else is sent back, naming the files.
 */
export function batchReview(
  batch: string[],
  read: Set<string>,
  report: string,
  extents: ReadonlyMap<string, ReadExtent> = new Map(),
): { accept: boolean; feedback?: string; unread: string[]; unreported: string[] } {
  const unread = batch.filter((f) => !read.has(f));
  const unreported = batch.filter((f) => !mentionsFile(report, f, batch));
  if (!unread.length && !unreported.length) return { accept: true, unread, unreported };
  const parts = [`Your files are only these ${batch.length}: ${batch.join(", ")}. Do not look at other files; other researchers have them.`];
  // A file read in part is told which lines are missing; one never read (or whose read failed) is told to open it.
  const partly = unread.filter((f) => (extents.get(f)?.seen ?? 0) > 0);
  const never = unread.filter((f) => !partly.includes(f));
  for (const f of partly) {
    const x = extents.get(f)!;
    parts.push(
      x.cut && x.firstGap === undefined
        ? `${f} is too large to read to its end; say in your report that only its first ${x.total} lines were read.`
        : `You have seen only ${x.seen} of the ${x.total} lines of ${f}. Read the rest with read_file and startLine=${x.firstGap ?? 1}.`,
    );
  }
  if (never.length) parts.push(`You have not opened ${never.join(", ")} (or reading ${never.length === 1 ? "it" : "them"} failed). Open ${never.length === 1 ? "it" : "them"} with read_files, using exactly these paths.`);
  if (unreported.length) parts.push(`Your report has no line for ${unreported.join(", ")}.`);
  parts.push("Then finish again with one line for each of your files: the path, then your finding for it.");
  return { accept: false, feedback: parts.join(" "), unread, unreported };
}
