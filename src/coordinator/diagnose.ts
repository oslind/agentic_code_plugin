import { z } from "zod";
import { estimateTokens, truncateToTokens } from "../context/budget";
import { dataBlock, DATA_REMINDER, DATA_RULE } from "../context/untrusted";
import { lineDiff } from "../changes/lineDiff";
import { callStructured, VERDICT_MAX_TOKENS } from "../llm/structured";
import { ChatMessage, ModelProvider } from "../providers/types";

/**
 * Before a fix-up round for something the drafts broke, one investigator call finds the cause from hard evidence
 * only: the failing command's output with the drafts and without them, and the diff of every drafted file. It must
 * name the changed line that causes the failure, quoted, and what that line should be. The quote is looked up by
 * code (in the draft, or among the lines the draft removed); a cause whose quote is not there is dropped. The fix-up
 * planner then gets the checked causes as its work.
 *
 * Oskar, 2026-11-26, after run 29 rename-everywhere (two fix-up rounds never restored a dropped import although the
 * error and the diff showed it): run the failing test on the original and the changed files, review what changed to
 * find the error, then delegate the fix with that result, instead of a rule per kind of mistake.
 */

export interface BrokenCommand {
  line: string;
  /** Output with all drafts. */
  output: string;
  /** Output on the project without the drafts, when it was run. */
  before?: string;
}

export interface DraftFile {
  path: string;
  original: string | null;
  proposed: string;
}

export interface Cause {
  path: string;
  /** The changed line as it is in the draft, or as it was before the draft removed it. */
  quote: string;
  removed: boolean;
  why: string;
  fix: string;
}

export const diagnosisSchema = z.object({
  causes: z
    .array(
      z.object({
        path: z.string().min(1).max(300).describe("The drafted file the cause is in"),
        quote: z.string().min(1).max(400).describe("The one changed line that causes the failure, copied exactly from the diff without its + or - sign"),
        removed: z.boolean().describe("true when the cause is a line the draft removed (a - line), false when it is a line the draft added or changed (a + line)"),
        why: z.string().min(1).max(400).describe("How this line causes the error in the output, in one sentence"),
        fix: z.string().min(1).max(400).describe("What the file needs instead, concretely: the line to put back, or what the line should say"),
      }),
    )
    .max(4)
    .describe("One entry per cause, most likely first. Empty when the diff does not show the cause."),
});

const SYSTEM = `You investigate why a command fails after code changes. You get the command's output with the changes and without them, and the diff of every changed file. Find the changed line that causes the new failure.
- Read the error in the output with the changes, and find where in the diff it comes from: a line that was added or changed (+), or a line that was removed (-) that the code still needs.
- Quote that one line exactly as it is in the diff, without the + or - sign, and say whether it was removed.
- Say what the file needs instead, concretely (for example the exact line to put back).
- Only use the diff and the outputs. If they do not show the cause, return no causes. A failure that is in the output without the changes too was there before: it is not a cause.

${DATA_RULE}`;

/** The diff of each drafted file, fenced, cut to fit. */
function diffs(files: DraftFile[], budget: number): string {
  const each = Math.max(300, Math.floor(budget / Math.max(1, files.length)));
  return files
    .map((f) => {
      const d = f.original === null ? f.proposed.split("\n").map((l) => `+ ${l}`).join("\n") : lineDiff(f.original, f.proposed);
      return dataBlock(`diff of ${f.path}${f.original === null ? " (new file)" : ""}`, truncateToTokens(d, each) ?? d.slice(0, each * 3));
    })
    .join("\n\n");
}

export function buildDiagnosisMessages(input: { userWords?: string; broken: BrokenCommand[]; files: DraftFile[] }, contextWindow: number): ChatMessage[] {
  const outputs = input.broken
    .slice(0, 3)
    .map((b) => dataBlock(`\`${b.line.slice(0, 120)}\``, `With the changes:\n${tail(b.output)}\n\nWithout the changes:\n${b.before === undefined ? "(not run)" : tail(b.before) || "(passed, no output)"}`))
    .join("\n\n");
  const head = `${input.userWords?.trim() ? `The user's request:\n${input.userWords.trim()}\n\n` : ""}The failing command(s):\n${outputs}`;
  const room = Math.max(1500, Math.floor(contextWindow * 0.6) - estimateTokens(SYSTEM) - estimateTokens(head) - VERDICT_MAX_TOKENS);
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: `${head}\n\nWhat the changes did:\n${diffs(input.files, room)}\n\n${DATA_REMINDER} Which changed line causes the new failure?` },
  ];
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-25).join("\n").slice(-2500);
}

const squeeze = (t: string) => t.replace(/\s+/g, "");

/** The causes whose quote is a line the draft has (or, for a removed line, a line the original had and the draft does not). */
export function checkedCauses(causes: Cause[], files: DraftFile[]): Cause[] {
  return causes.filter((c) => {
    const f = files.find((x) => x.path === c.path.replace(/^\.\//, "")) ?? files.find((x) => x.path.endsWith(`/${c.path}`));
    const q = squeeze(c.quote.replace(/^[+-]\s?/, ""));
    if (!f || q.length < 4) return false;
    const now = f.proposed.split("\n").map(squeeze);
    const was = (f.original ?? "").split("\n").map(squeeze);
    if (!c.removed) return now.some((l) => l.includes(q));
    const orig = was.find((w) => w.includes(q));
    return orig !== undefined && !now.includes(orig);
  });
}

/** One model call. Returns only causes whose quoted line was found by code. */
export async function diagnose(provider: ModelProvider, input: { userWords?: string; broken: BrokenCommand[]; files: DraftFile[] }, opts: { signal?: AbortSignal } = {}): Promise<Cause[]> {
  if (!input.broken.length || !input.files.length) return [];
  const res = await callStructured({ maxTokens: VERDICT_MAX_TOKENS, provider, messages: buildDiagnosisMessages(input, provider.contextWindow), schema: diagnosisSchema, schemaName: "diagnosis", signal: opts.signal });
  return checkedCauses(
    res.causes.map((c) => ({ ...c, path: c.path.trim() })),
    input.files,
  );
}

/** The fix-up planner's note: the checked causes, each with its fix and the command to run after it. */
export function diagnosisNote(causes: Cause[], broken: BrokenCommand[]): string {
  if (!causes.length) return "";
  const rerun = broken.slice(0, 2).map((b) => `\`${b.line.slice(0, 100)}\``).join(" and ");
  return [
    "Diagnosis of what the drafts broke (an investigator compared the output with and without the drafts and read the diffs; each quoted line was found in the drafts by code):",
    ...causes.map((c) => `- ${c.path}: the line \`${c.quote.trim().slice(0, 200)}\` ${c.removed ? "was removed" : "was added or changed"}. ${c.why.trim()} Fix: ${c.fix.trim()}`),
    `Plan one task per cause, on its file, with the fix in its instructions, and tell it to run ${rerun} afterwards to see the failure gone.`,
  ].join("\n");
}
