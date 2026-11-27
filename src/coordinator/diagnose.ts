import { z } from "zod";
import { estimateTokens, truncateToTokens } from "../context/budget";
import { dataBlock, DATA_REMINDER, DATA_RULE } from "../context/untrusted";
import { lineDiff } from "../changes/lineDiff";
import { callStructured, VERDICT_MAX_TOKENS } from "../llm/structured";
import { ChatMessage, ModelProvider } from "../providers/types";

/**
 * Before a fix-up round for something the drafts broke, one investigator call finds the cause from hard evidence
 * only: the failing command's output with the drafts and without them, and the diff of every drafted file. It must
 * name the line that causes the failure, quoted, and what that line should be: a changed line, a removed line, or an
 * unchanged one (such as a test) that still expects the old behaviour. The quote is looked up by code; a cause whose
 * quote is not there is dropped. The fix-up
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

export type CauseKind = "added" | "removed" | "unchanged";

export interface Cause {
  path: string;
  /** The changed line as it is in the draft, as it was before the draft removed it, or a line no draft changed. */
  quote: string;
  /**
   * added: a line the drafts added or changed. removed: a line they removed that the code still needs. unchanged: a
   * line no draft touched that still expects the old behaviour (run 30, old-test-pins-value: the test pinning the
   * value the user asked to change, where the investigator blamed the requested change and the fix-up undid it).
   */
  kind: CauseKind;
  why: string;
  fix: string;
}

export const diagnosisSchema = z.object({
  causes: z
    .array(
      z.object({
        path: z.string().min(1).max(300).describe("The drafted file the cause is in"),
        quote: z.string().min(1).max(400).describe("The one line that causes the failure, copied exactly (from the diff without its + or - sign, or from the file)"),
        kind: z
          .enum(["added", "removed", "unchanged"])
          .describe("added: a line the changes added or changed (+). removed: a line the changes removed (-) that the code still needs. unchanged: a line the changes did not touch that still expects the old behaviour the user asked to change, such as a test of the old value"),
        why: z.string().min(1).max(400).describe("How this line causes the error in the output, in one sentence"),
        fix: z.string().min(1).max(400).describe("What the file needs instead, concretely: the line to put back, or what the line should say"),
      }),
    )
    .max(4)
    .describe("One entry per cause, most likely first. Empty when the diff does not show the cause."),
});

const SYSTEM = `You investigate why a command fails after code changes. You get the command's output with the changes and without them, and the diff of every changed file. Find the changed line that causes the new failure.
- Read the error in the output with the changes, and find where it comes from: a line that was added or changed (+), a line that was removed (-) that the code still needs, or a line the changes did not touch that still expects the old behaviour (for example a test that checks the old value).
- The user asked for the changes. A line that does what the user asked is never the cause, and the fix is never to undo what the user asked: when a test or other code still expects the old behaviour, that line is the cause (unchanged), and its fix is to make it expect what the user asked for.
- Quote that one line exactly, without a + or - sign, and say which kind it is.
- Say what the file needs instead, concretely (for example the exact line to put back, or the new expected value).
- Only use the diff, the outputs and the files shown. If they do not show the cause, return no causes. A failure that is in the output without the changes too was there before: it is not a cause.

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

/** A project file no draft changed that the failure names (a test file, say), shown so a stale line can be found. */
export interface RelatedFile {
  path: string;
  text: string;
}

export interface DiagnosisInput {
  userWords?: string;
  broken: BrokenCommand[];
  files: DraftFile[];
  related?: RelatedFile[];
}

export function buildDiagnosisMessages(input: DiagnosisInput, contextWindow: number): ChatMessage[] {
  const outputs = input.broken
    .slice(0, 3)
    .map((b) => dataBlock(`\`${b.line.slice(0, 120)}\``, `With the changes:\n${tail(b.output)}\n\nWithout the changes:\n${b.before === undefined ? "(not run)" : tail(b.before) || "(passed, no output)"}`))
    .join("\n\n");
  const head = `${input.userWords?.trim() ? `The user's request:\n${input.userWords.trim()}\n\n` : ""}The failing command(s):\n${outputs}`;
  const room = Math.max(1500, Math.floor(contextWindow * 0.6) - estimateTokens(SYSTEM) - estimateTokens(head) - VERDICT_MAX_TOKENS);
  const related = (input.related ?? []).slice(0, 3);
  // The diffs come first; files the changes did not touch get at most a third of the room.
  const relatedRoom = related.length ? Math.floor(room / 3) : 0;
  const each = Math.max(200, Math.floor(relatedRoom / Math.max(1, related.length)));
  const unchanged = related.length
    ? `\n\nFiles the changes did not touch that the failure names:\n${related.map((r) => dataBlock(`${r.path} (not changed)`, truncateToTokens(r.text, each) ?? r.text.slice(0, each * 3))).join("\n\n")}`
    : "";
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: `${head}\n\nWhat the changes did:\n${diffs(input.files, room - relatedRoom)}${unchanged}\n\n${DATA_REMINDER} Which line causes the new failure?` },
  ];
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-25).join("\n").slice(-2500);
}

const squeeze = (t: string) => t.replace(/\s+/g, "");

const byPath = <T extends { path: string }>(list: T[], path: string): T | undefined => {
  const p = path.replace(/^\.\//, "");
  return list.find((x) => x.path === p) ?? list.find((x) => x.path.endsWith(`/${p}`));
};

/**
 * The causes whose quote code finds: an added line in its draft; a removed line in the original and not in the
 * draft; an unchanged line in a file no draft changed (from `related`), or in a draft both before and after it.
 */
export function checkedCauses(causes: Cause[], files: DraftFile[], related: RelatedFile[] = []): Cause[] {
  return causes.filter((c) => {
    const q = squeeze(c.quote.replace(/^[+-]\s?/, ""));
    if (q.length < 4) return false;
    const f = byPath(files, c.path);
    if (c.kind === "unchanged") {
      if (f) {
        const was = (f.original ?? "").split("\n").map(squeeze);
        return f.proposed.split("\n").map(squeeze).some((l) => l.includes(q) && was.includes(l));
      }
      const r = byPath(related, c.path);
      return !!r && r.text.split("\n").some((l) => squeeze(l).includes(q));
    }
    if (!f) return false;
    const now = f.proposed.split("\n").map(squeeze);
    const was = (f.original ?? "").split("\n").map(squeeze);
    if (c.kind === "added") return now.some((l) => l.includes(q));
    const orig = was.find((w) => w.includes(q));
    return orig !== undefined && !now.includes(orig);
  });
}

/** Paths of project files a failing command or its output names, for the investigator to see unchanged. */
export function namedPaths(broken: BrokenCommand[]): string[] {
  const seen = new Set<string>();
  for (const b of broken) {
    for (const m of `${b.line}\n${b.output}`.matchAll(/(?:^|[\s('"`])(?:\.\/)?((?:[\w.-]+\/)*[\w-]+(?:\.[\w-]+)*\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|cs|php|json))(?=[\s:)'"`,]|$)/gm)) {
      const p = m[1]!;
      if (!p.startsWith("node_modules/") && !p.includes("..")) seen.add(p);
    }
  }
  return [...seen];
}

/** One model call. Returns only causes whose quoted line was found by code. */
export async function diagnose(provider: ModelProvider, input: DiagnosisInput, opts: { signal?: AbortSignal } = {}): Promise<Cause[]> {
  if (!input.broken.length || !input.files.length) return [];
  const res = await callStructured({ maxTokens: VERDICT_MAX_TOKENS, provider, messages: buildDiagnosisMessages(input, provider.contextWindow), schema: diagnosisSchema, schemaName: "diagnosis", signal: opts.signal });
  return checkedCauses(
    res.causes.map((c) => ({ ...c, path: c.path.trim() })),
    input.files,
    input.related,
  );
}

/** How a cause's line is described to the planner and in the chat. */
export function causeLine(c: Cause, max = 200): string {
  const what = c.kind === "removed" ? "was removed" : c.kind === "added" ? "was added or changed" : "was not changed and still expects the old behaviour";
  return `${c.path}: the line \`${c.quote.trim().slice(0, max)}\` ${what}. ${c.why.trim()} Fix: ${c.fix.trim()}`;
}

/** The fix-up planner's note: the checked causes, each with its fix and the command to run after it. */
export function diagnosisNote(causes: Cause[], broken: BrokenCommand[]): string {
  if (!causes.length) return "";
  const rerun = broken.slice(0, 2).map((b) => `\`${b.line.slice(0, 100)}\``).join(" and ");
  return [
    "Diagnosis of what the drafts broke (an investigator compared the output with and without the drafts and read the diffs; each quoted line was found in the files by code):",
    ...causes.map((c) => `- ${causeLine(c)}`),
    `Plan one task per cause, on its file, with the fix in its instructions, and tell it to run ${rerun} afterwards to see the failure gone. Keep what the user asked for: a fix never undoes the requested change.`,
  ].join("\n");
}
