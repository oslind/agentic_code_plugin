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
    // "TypeError: x" counts too (run 16: a crash's error line was not seen as a failure line).
    .filter((l) => /\b(FAIL|FAILED|failing|not ok|AssertionError)\b|(^|\s)\w*Error:|[✗✖×]/.test(l))
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

/**
 * Node's assert output says "17 !== 18": the value the code gave first, the value the test expects second. Run 15,
 * question-then-answer: the coordinator read it the other way round and told a fix-up to make the test "expect 18
 * instead of 17". Each such line after "Expected values to be ..." is labelled by rule.
 */
export function withAssertNotes(text: string): string {
  if (!/Expected values to be (?:strictly |loosely )?(?:deep-)?equal/i.test(text)) return text;
  return text.replace(/^(\s*)(\S.{0,60}?) (!==|!=) (\S.{0,60}?)\s*$/gm, (line, pad: string, actual: string, op: string, expected: string) =>
    /^[+-]\s/.test(actual) ? line : `${pad}${actual} ${op} ${expected}   [checked by rule: the code gave ${actual}; the test expects ${expected}]`,
  );
}


/**
 * True when the words ask to fix failing tests, a failure or a bug, in one sentence ("Fix the bug in average so the
 * tests pass", "fixa det fallerande testet"). Review of the run 16 fixes: a failure that was there before the request
 * is not missing work, unless fixing it is the request; otherwise a fix that does not work would be called done.
 */
export function asksToFixFailures(words: string | undefined): boolean {
  if (!words) return false;
  const FAILURE = /\b(tests?|testet|testerna|failing|fails?|failure|failed|bugs?|buggen|bugg|errors?|felet|crash(es)?|kraschar)\b|\bpass(es)?\b/i;
  // "There is a bug in stats.js. Fix it." names the failure one sentence before the fix.
  if (/\b(fix|repair|solve|resolve|correct|fixa|laga|rätta|åtgärda)\s+(it|them|this|that|den|det|dem)\b/i.test(words) && FAILURE.test(words)) return true;
  return words
    .split(/(?<=[.!?])\s+|\n+/)
    .some(
      (sentence) =>
        /\b(fix|fixes|repair|debug|solve|resolve|correct|fixa|laga|rätta|åtgärda)\b/i.test(sentence) &&
        FAILURE.test(sentence),
    );
}

/** A check output that fails on a comparison of values and has no crash in it: the kind a test that pins an old value gives. */
export function pinsOldValue(output: string): boolean {
  const plain = toPlainText(output);
  if (/\b(TypeError|ReferenceError|SyntaxError|RangeError)\b|is not a function|is not defined|Cannot find module|Cannot read propert/.test(plain)) return false;
  return /Expected values to be|\S+ !==? \S+|\bexpected\b.*\b(to (be|equal)|got|but)\b|AssertionError/i.test(plain);
}

/** Names a failure says are missing: "x is not a function", "x is not defined", a missing export or member. */
export function missingNames(output: string): string[] {
  const plain = toPlainText(output);
  const found = [
    ...plain.matchAll(/([A-Za-z_$][\w$]*) is not (?:a function|defined|a constructor)/g),
    ...plain.matchAll(/(?:no exported member|export named|has no attribute|cannot import name) ['"`]?([A-Za-z_$][\w$]*)/g),
  ].map((m) => m[1]!);
  return [...new Set(found)].filter((n) => n.length >= 3).slice(0, 5);
}
