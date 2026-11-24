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

/** Every `path:line: code` (also "path (line 9): code") in a report, one per line of the report. */
export function citationsIn(report: string): Citation[] {
  const out: Citation[] = [];
  for (const raw of report.split("\n")) {
    const m = CITED.exec(raw.trim());
    if (!m) continue;
    const quote = quoteOf(m[3]!);
    // A few characters ("}", "else") are in every file and prove nothing.
    if (squeeze(quote).length < 6) continue;
    out.push({ path: m[1]!.replace(/\\/g, "/").replace(/^\.\//, ""), line: Number(m[2]), quote });
  }
  return out;
}

/**
 * Looks each cited line up in its file, compared without white space. The line number is not held against a
 * finding: small models count lines badly, and the code being in the file is what matters.
 */
export async function checkCitations(report: string, read: (path: string) => Promise<string | undefined>): Promise<CitationCheck> {
  const files = new Map<string, string | undefined>();
  const result: CitationCheck = { found: [], missing: [] };
  for (const c of citationsIn(report)) {
    if (!files.has(c.path)) files.set(c.path, await read(c.path).then((t) => (t === undefined ? undefined : squeeze(t)), () => undefined));
    const text = files.get(c.path);
    (text !== undefined && text.includes(squeeze(c.quote)) ? result.found : result.missing).push(c);
  }
  return result;
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
