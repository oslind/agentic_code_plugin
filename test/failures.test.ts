import { describe, expect, it } from "vitest";
import { failedBefore, failureLines, splitFailures } from "../src/checks/failures";

const before = "PASS night is 3 lower\nFAIL average of three (2 ms)\n  30 !== 20\n4 passed, 1 failed\n";

describe("failures with and without the drafts", () => {
  it("finds failure lines and drops timings", () => {
    expect(failureLines(before)).toEqual(["FAIL average of three"]);
  });

  it("tells a failure that was there before from one the drafts caused", () => {
    // Run 6: "average of three" failed before any draft, and verification kept sending fix-ups after it.
    expect(failedBefore("FAIL average of three (5 ms)\n4 passed, 1 failed", { passed: false, output: before })).toBe("before");
    expect(failedBefore("FAIL night is 3 lower\nFAIL average of three", { passed: false, output: before })).toBe("new");
    expect(failedBefore("FAIL average of three", { passed: true, output: "5 passed" })).toBe("new");
    expect(failedBefore("exit code 1", { passed: false, output: before })).toBe("unknown");
  });
});

describe("splitFailures", () => {
  it("says which failure is new with the drafts and which was there before (run 13, question-then-answer)", () => {
    const before = "FAIL average of three (4 ms)\n3 passed, 1 failed";
    const now = "FAIL average of three (5 ms)\nFAIL night is 3 lower: expected 18, got 17\n2 passed, 2 failed";
    expect(splitFailures(now, { passed: false, output: before })).toEqual({ added: ["FAIL night is 3 lower: expected 18, got 17"], before: ["FAIL average of three"] });
    expect(splitFailures(now, { passed: true, output: "" }).before).toEqual([]);
  });
});
