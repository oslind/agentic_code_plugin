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
