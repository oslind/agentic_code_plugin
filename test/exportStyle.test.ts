/** Run 10, esm-project: a default export where the file had named ones, and "tests passed" for a function no test calls. */
import { describe, expect, it } from "vitest";
import { exportStyleHints, isTestPath, newFunctionNames, untestedFunctions } from "../src/changes/moduleStyle";
import { draftsForReview } from "../src/coordinator/review";
import { loadWarning } from "../src/worker/tools";

const before = "export function add(a, b) {\n  return a + b;\n}\n";
const withDefault = `${before}\nexport default function multiply(a, b) {\n  return a * b;\n}\n`;
const withNamed = `${before}\nexport function multiply(a, b) {\n  return a * b;\n}\n`;

describe("exportStyleHints", () => {
  it("flags a default export added to a file with only named exports", () => {
    expect(exportStyleHints("src/math.js", before, withDefault)[0]).toMatch(/only had named exports/);
    expect(exportStyleHints("src/math.js", before, withNamed)).toEqual([]);
    expect(exportStyleHints("src/math.js", null, withDefault)).toEqual([]);
    expect(exportStyleHints("src/math.js", "export default 1;\n", "export default 2;\n")).toEqual([]);
    expect(loadWarning("src/math.js", before, withDefault)).toMatch(/Check: .*default export/);
  });
});

describe("untestedFunctions", () => {
  it("names new functions no test mentions", () => {
    expect(newFunctionNames(before, withNamed)).toEqual(["multiply"]);
    expect(newFunctionNames(null, "const f = (x) => x;\nlet g = async function () {};\ndef h(x):\n  pass\n")).toEqual(["f", "g", "h"]);
    const change = [{ path: "src/math.js", original: before, proposed: withNamed }];
    expect(untestedFunctions(change, "assert.equal(add(1, 2), 3);")).toEqual(["multiply"]);
    expect(untestedFunctions(change, "assert.equal(multiply(3, 4), 12);")).toEqual([]);
    expect(isTestPath("test.js")).toBe(true);
    expect(isTestPath("src/__tests__/a.ts")).toBe(true);
    expect(isTestPath("tests/test_a.py")).toBe(true);
    expect(isTestPath("src/testing.js")).toBe(false);
  });

  it("is said under the drafts only when the project has tests", () => {
    const change = [{ path: "src/math.js", original: before, proposed: withNamed }];
    expect(draftsForReview(change, 6000, undefined, "add(1, 2)")).toMatch(/No test file mentions multiply/);
    expect(draftsForReview(change, 6000, undefined, "")).not.toMatch(/No test file mentions/);
    expect(draftsForReview(change)).not.toMatch(/No test file mentions/);
  });
});
