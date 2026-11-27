/**
 * Sources of research findings, looked up by code. A report is text a small model wrote, so a finding counts for
 * more when it names where it comes from as `path:line: the line of code`, and the extension finds that line in
 * that file. This catches code that was made up, a wrong file, and a file that was never opened, without reading
 * anything again with a model (Oskar, 2026-11-24: "verify that what it states seems legit, without having to
 * re-analyse the files completely"). It does not catch a real line that was misread.
 */

export interface Citation {
  path: string;
  line: number;
  /** The code as the report quoted it. */
  quote: string;
  /** Everything the report wrote after `path:line:`, when that is more than the quote (a quote in backticks). */
  said?: string;
}

export interface CitationCheck {
  found: Citation[];
  /** Quoted lines that are not in the file named, or whose file could not be read. */
  missing: Citation[];
}

const CITED = /(?:^|[\s(`"'*>-])`?((?:[\w.-]+[\\/])*[\w-]+(?:\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]{0,5})`?(?::|\s*,?\s*\(?\s*lines?\s+)(\d{1,6})(?:\s*-\s*\d{1,6})?\)?`?\s*(?::|-|–|—)\s*(\S.*)$/;

const squeeze = (t: string) => t.replace(/\s+/g, "");

/** The quoted code of a cited line: the longest part in backticks, or else all of it without wrapping quote marks. */
function quoteOf(rest: string): string {
  const ticks = [...rest.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).sort((a, b) => b.length - a.length);
  return (ticks[0] ?? rest).trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
}

/** Where a citation starts: a file name followed by ":9" or " (line 9)". */
const START = /(?:^|[\s(`"'*>-])`?(?:[\w.-]+[\\/])*[\w-]+(?:\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]{0,5}`?(?::|\s*,?\s*\(?\s*lines?\s+)\d{1,6}/g;

/** A line of a report cut where each citation starts, so two citations on one line are read as two (run 26). */
function pieces(line: string): string[] {
  const starts = [...line.matchAll(START)].map((m) => m.index!);
  if (starts.length < 2) return [line];
  return starts.map((at, i) => line.slice(at, starts[i + 1]).trim());
}

/** Every `path:line: code` (also "path (line 9): code") in a report, also several on one line. */
export function citationsIn(report: string): Citation[] {
  const out: Citation[] = [];
  // Run 28: line breaks written out ("\\n", "/n/n") glued words onto paths: `function./n/nsrc/thermostat.js:4`.
  const text = report.replace(/\\n/g, "\n").replace(/(?:\/n){2,}/g, "\n").replace(/(?<=\p{L})\.\/n(?=\p{L})/gu, ".\n");
  for (const raw of text.split("\n").flatMap((l) => pieces(l.trim()))) {
    const m = CITED.exec(raw.trim());
    if (!m) continue;
    const quote = quoteOf(m[3]!);
    // A few characters ("}", "else") are in every file and prove nothing.
    if (squeeze(quote).length < 6) continue;
    const said = m[3]!.trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
    out.push({ path: m[1]!.replace(/\\/g, "/").replace(/^\.\//, ""), line: Number(m[2]), quote, ...(said.replace(/`/g, "").trim() !== quote ? { said } : {}) });
  }
  return out;
}

/**
 * Looks each cited line up in its file, compared without white space. The line number is not held against a
 * finding: small models count lines badly, and the code being in the file is what matters.
 */
export async function checkCitations(report: string, read: (path: string) => Promise<string | undefined>, list?: () => Promise<string[]>): Promise<CitationCheck> {
  const files = new Map<string, Source | undefined>();
  const result: CitationCheck = { found: [], missing: [] };
  let all: string[] | undefined;
  for (const c of citationsIn(report)) {
    if (!files.has(c.path)) {
      let text = await read(c.path).catch(() => undefined);
      // Run 28: `thermostat.js:4` for src/thermostat.js. A path not in the project is looked up by its end, when
      // exactly one file of the project ends that way.
      if (text === undefined && list) {
        all ??= await list().catch(() => []);
        const end = `/${c.path.replace(/^\/+/, "")}`;
        const matches = all.filter((f) => `/${f}`.endsWith(end));
        if (matches.length === 1) text = await read(matches[0]!).catch(() => undefined);
      }
      files.set(c.path, sourceOf(text));
    }
    const file = files.get(c.path);
    (file !== undefined && quoted(file, c.quote) && !misquoted(file, c.said, c.quote) ? result.found : result.missing).push(c);
  }
  return result;
}

interface Source {
  /** The whole file without white space. */
  all: string;
  /** Each line of it without white space. */
  lines: string[];
}

const sourceOf = (t: string | undefined): Source | undefined => (t === undefined ? undefined : { all: squeeze(t), lines: t.split("\n").map(squeeze) });

/**
 * Whether a quote is code from the file: part of the file, or a whole line of it with words added after it (a
 * full stop, "(the average is wrong)"). Run 26: `const DEFAULT_TARGET = 21;.` and `return sum / 2; (the average
 * function …)` were real lines reported as not found, and the researchers argued with the check.
 */
function quoted(file: Source, quote: string): boolean {
  const q = squeeze(quote);
  if (file.all.includes(q)) return true;
  const trimmed = q.replace(/[.,:;!?]+$/, "");
  if (trimmed.length >= 6 && file.all.includes(trimmed)) return true;
  return file.lines.some((l) => l.length >= 6 && q.startsWith(l));
}

const plain = (t: string) => squeeze(t.replace(/`/g, "")).replace(/[.,:;!?]+$/, "");

/**
 * Whether the whole text after `path:line:` starts like a line of the file and then says something else. Run 30,
 * research-sed: `README.md:3: A small heating controller. Run the tests with \`node test.js\`.` was found by its
 * backticked part, though the file says "controler": the report had quoted the line with the typo corrected. Words
 * after a whole line ("… (returns the sum)") and part of a line are still fine.
 */
function misquoted(file: Source, said: string | undefined, quote: string): boolean {
  if (!said) return false;
  const s = plain(said);
  // The quoted code comes first and words about it follow: "`A small heating controler.` (the typo)".
  if (s.length < 12 || s.startsWith(plain(quote))) return false;
  return file.lines.some((raw) => {
    const l = raw.replace(/`/g, "").replace(/[.,:;!?]+$/, "");
    if (l.length < 12 || s.startsWith(l) || l.includes(s)) return false;
    let n = 0;
    while (n < s.length && s[n] === l[n]) n++;
    return n >= 12;
  });
}

const show = (c: Citation) => `${c.path}:${c.line}: ${c.quote.replace(/\s+/g, " ").slice(0, 100)}`;

/** What a researcher is told when lines it quoted are not in the files. Fixed wording around its own quotes. */
export function citationFeedback(missing: Citation[]): string {
  return `Checked by rule: ${missing.length} line(s) you gave as a source are not in the file named:\n${missing.slice(0, 6).map((c) => `- ${show(c)}`).join("\n")}\nOpen the file again and copy the line exactly as it is there, or take the finding out of your report. Do not guess what a line says.`;
}

/** One line for the answer: how many quoted sources the extension found in the files. Undefined when no report gave any. */
export function sourcesNote(checks: CitationCheck[]): string | undefined {
  const found = checks.reduce((n, c) => n + c.found.length, 0);
  const missing = checks.flatMap((c) => c.missing);
  if (!found && !missing.length) return undefined;
  const not = missing.length ? ` ${missing.length} could not be found, so what rests on them is not confirmed: ${missing.slice(0, 5).map((c) => `\`${c.path}:${c.line}\``).join(", ")}.` : "";
  return `Sources checked by rule: ${found} of the ${found + missing.length} line(s) of code the sub-agents quoted are in the files they named.${not} This shows the code is there, not that it was read correctly.`;
}
