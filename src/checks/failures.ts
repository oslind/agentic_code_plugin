import { toPlainText } from "./terminalText";

/**
 * The lines of a command's output that report a failure (a failing test, an error), normalized so two runs
 * can be compared: timings and colors are dropped.
 */
export function failureLines(output: string): string[] {
  return toPlainText(output)
    .split("\n")
    .map((l) =>
      l
        .replace(/\(\s*\d+(\.\d+)?\s*m?s\s*\)/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((l) => /\b(FAIL|FAILED|failing|not ok|AssertionError|Error:)\b|[✗✖×]/.test(l))
    .filter((l, i, all) => l.length > 0 && all.indexOf(l) === i);
}

/**
 * Whether a command that failed with the drafts failed the same way without them. "before": every failure
 * line it printed with the drafts shows without them too, so the request did not cause it. "new": it passed
 * without the drafts, or printed failures there that it did not print before. "unknown": no failure lines
 * to compare.
 */
export function failedBefore(withDrafts: string, without: { passed: boolean; output: string }): "before" | "new" | "unknown" {
  if (without.passed) return "new";
  const now = failureLines(withDrafts);
  if (!now.length) return "unknown";
  const base = new Set(failureLines(without.output));
  return now.every((l) => base.has(l)) ? "before" : "new";
}

/**
 * For a command that fails with the drafts in a new way, which failure lines are new and which were there
 * before. Run 13, question-then-answer: verification's "still left" named the old "average of three" failure
 * (there before the request) instead of the new one, and a fix-up chased a file outside its task.
 */
export function splitFailures(withDrafts: string, without: { passed: boolean; output: string }): { added: string[]; before: string[] } {
  const now = failureLines(withDrafts);
  if (without.passed) return { added: now, before: [] };
  const base = new Set(failureLines(without.output));
  return { added: now.filter((l) => !base.has(l)), before: now.filter((l) => base.has(l)) };
}
