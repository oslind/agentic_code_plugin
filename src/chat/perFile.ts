/**
 * Run 14, find-throwing-100: every file was opened and reported on, but the combined answer left out modules
 * that researchers had reported correctly ("src/mod_050.js (line 9): throws ..."), and said nothing about it.
 * One model call re-listing 40+ names from a dozen reports is lossy. So for a question that picks files out of
 * many ("which of the 100 modules ..."), each file's own report lines are sorted into matches / does not /
 * unclear in small batches, the answer is told the result, and any match it still leaves out is added by rule.
 */
import { z } from "zod";
import { callStructured } from "../llm/structured";
import { ModelProvider } from "../providers/types";
import { DATA_REMINDER, DATA_RULE, dataBlock } from "../context/untrusted";
import { fileList, mentionsFile } from "./coverage";

export type Sorted = "yes" | "no" | "unclear";

/** Fewest asked files for the sort (run 14 lost names from 20 files up; 5 files kept every one). */
export const SORT_MIN_FILES = 15;
/** Files per sorting call. */
export const SORT_BATCH = 25;
/** Longest report text kept per file. */
const PER_FILE_CHARS = 400;

/** A question that asks which of the files match something, rather than about each one ("what does each do"). */
export function picksFiles(question: string): boolean {
  return /\b(which|list|find|name)\b/i.test(question);
}

/** Each asked file's lines from the reports: the lines that name it, cut to size. Files no line names are left out. */
export function fileFindings(files: string[], reportTexts: string[]): Map<string, string> {
  const lines = reportTexts.flatMap((t) => t.split("\n")).map((l) => l.trim()).filter(Boolean);
  const out = new Map<string, string>();
  for (const f of files) {
    const own = lines.filter((l) => mentionsFile(l, f, files));
    if (own.length) out.set(f, own.join(" | ").slice(0, PER_FILE_CHARS));
  }
  return out;
}

const SortSchema = z.object({
  files: z.array(z.object({ path: z.string(), answer: z.enum(["yes", "no", "unclear"]) })),
});

const SORT_SYSTEM = `You sort files by what research sub-agents reported about each one. For each file, decide from its report lines alone whether the file matches the user's question:
- "yes": the report says it does.
- "no": the report says it does not.
- "unclear": the report hedges ("likely", "may", "depends on"), contradicts itself, or does not say.
Give every file listed, once, with its path exactly as written. Reply with JSON only, like {"files":[{"path":"src/a.js","answer":"yes"}]}.`;

/** Sorts each file's findings against the question, in batches. A file the model leaves out or misnames is "unclear". */
export async function sortFiles(
  provider: ModelProvider,
  question: string,
  findings: Map<string, string>,
  options: { signal?: AbortSignal; onError?: (m: string) => void } = {},
): Promise<Map<string, Sorted>> {
  const out = new Map<string, Sorted>();
  const entries = [...findings];
  for (let i = 0; i < entries.length; i += SORT_BATCH) {
    const batch = entries.slice(i, i + SORT_BATCH);
    const body = batch.map(([f, text]) => `${f}: ${text.replace(/\s+/g, " ")}`).join("\n");
    try {
      const sorted = await callStructured({
        provider,
        schema: SortSchema,
        schemaName: "file_sort",
        signal: options.signal,
        maxTokens: 4096,
        messages: [
          { role: "system", content: SORT_SYSTEM },
          { role: "user", content: `The user's question:\n${question.trim()}\n\n${DATA_RULE}\n${dataBlock("each file's report lines", body)}\n\n${DATA_REMINDER} Sort these ${batch.length} files.` },
        ],
      });
      const known = new Set(batch.map(([f]) => f));
      for (const s of sorted.files) if (known.has(s.path) && !out.has(s.path)) out.set(s.path, s.answer);
    } catch (err) {
      options.signal?.throwIfAborted();
      options.onError?.(`Could not sort ${batch.length} files by their reports: ${(err as Error).message}`);
    }
    for (const [f] of batch) if (!out.has(f)) out.set(f, "unclear");
  }
  return out;
}

const of = (sorted: Map<string, Sorted>, kind: Sorted) => [...sorted].filter(([, s]) => s === kind).map(([f]) => f);

/** What the combining call is told: the sort, as a fact it must keep. */
export function sortFact(sorted: Map<string, Sorted>): string {
  const yes = of(sorted, "yes");
  const unclear = of(sorted, "unclear");
  return [
    `Sorted file by file from the reports (each file's own report lines; checked separately from this call): ${yes.length} match${yes.length === 1 ? "es" : ""} the question, ${of(sorted, "no").length} do not, ${unclear.length} unclear.`,
    `Matches: ${yes.join(", ") || "none"}.`,
    unclear.length ? `Unclear (the reports hedge or do not say): ${unclear.join(", ")}.` : "",
    "Your answer names every file under Matches, and names the unclear ones as unclear.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The answer with any sorted match or unclear file it left out added at the end, by rule. */
export function withSortedFiles(answer: string, sorted: Map<string, Sorted>, files: string[]): string {
  const missing = (kind: Sorted) => of(sorted, kind).filter((f) => !mentionsFile(answer, f, files));
  const yes = missing("yes");
  const unclear = missing("unclear");
  const parts: string[] = [];
  if (yes.length) parts.push(`Also matching, from the reports file by file (left out above): ${fileList(yes, 100)}.`);
  if (unclear.length) parts.push(`Unclear from the reports (they hedge or do not say): ${fileList(unclear, 100)}.`);
  return parts.length ? `${answer}\n\nChecked by rule: ${parts.join(" ")}` : answer;
}
