import { isTestPath } from "../worker/roles";

/**
 * Lines that check something in a test: assertions in the common frameworks, and the lines that declare a
 * test case. A changed or removed one can weaken what the tests prove.
 */
const ASSERTION =
  /\b(?:assert\w*|expect|should|toBe\w*|toEqual|toMatch\w*|toThrow\w*|toHave\w*|assertEqual|assertTrue|assertFalse|assertRaises|assertIn|pytest\.raises|EXPECT_\w+|ASSERT_\w+|REQUIRE\w*|CHECK\w*)\s*[.(]|\bt\.(?:is|not|deepEqual|equal|true|false|throws)\s*\(|^\s*assert\s/;
const TEST_CASE = /^\s*(?:(?:it|test|describe)(?:\.\w+)?\s*\(|def\s+test_\w*|func\s+Test\w*|TEST(?:_F)?\s*\(|#\[test\])/;

export interface TestWeakening {
  /** Assertion or test-case lines of the original that the draft no longer has, as they were (trimmed). */
  removed: string[];
}

/**
 * Whether a draft of a test file removes or changes lines that assert or declare tests. Adding tests never
 * counts. A heuristic that cannot judge whether a change is right: it only decides that the user sees the draft
 * before it is written (security audit of PR #55: "never bend a test" was a prompt rule only).
 */
export function testWeakening(path: string, original: string | null, proposed: string): TestWeakening | undefined {
  if (original === null || !isTestPath(path)) return undefined;
  const left = new Map<string, number>();
  for (const l of proposed.split("\n")) {
    const t = l.trim();
    if (t) left.set(t, (left.get(t) ?? 0) + 1);
  }
  const removed: string[] = [];
  for (const l of original.split("\n")) {
    const t = l.trim();
    if (!t || !(ASSERTION.test(t) || TEST_CASE.test(l))) continue;
    const n = left.get(t) ?? 0;
    if (n > 0) left.set(t, n - 1);
    else removed.push(t);
  }
  return removed.length ? { removed } : undefined;
}

