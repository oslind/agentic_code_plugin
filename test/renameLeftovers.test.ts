/** Run 12B: a rename left the call in src/index.js, and the review, verification and final reply said it was done. */
import { describe, expect, it } from "vitest";
import { draftProblemsOf } from "../src/changes/moduleStyle";
import { draftsForReview, leftoverRename, linesUsing, renameLeftovers } from "../src/coordinator/review";
import { loadWarning } from "../src/worker/tools";

const said = "Rename the function toCelsius to fahrenheitToCelsius everywhere in the project.";
const before = "const { toCelsius } = require('./convert');\n\nconsole.log(`${toCelsius(70).toFixed(1)}`);\n";
const half = before.replace("{ toCelsius }", "{ fahrenheitToCelsius }");

describe("a rename that is not finished", () => {
  it("finds the lines that still use the old name, not comments or longer names", () => {
    expect(linesUsing(half, "toCelsius")).toEqual([3]);
    expect(linesUsing("// toCelsius was renamed\n/* toCelsius\n toCelsius */\nfahrenheitToCelsius(1);\nobj.toCelsiusX;\n", "toCelsius")).toEqual([]);
  });
  it("only checks renames of names that look like code", () => {
    expect(leftoverRename(said)).toEqual({ from: "toCelsius", to: "fahrenheitToCelsius" });
    expect(leftoverRename("rename count to total in average()")).toBeUndefined();
    expect(leftoverRename("replace toCelsius with fahrenheitToCelsius")).toBeUndefined();
  });
  it("warns the sub-agent right after a write that left a use", () => {
    expect(loadWarning("src/index.js", before, half, "commonjs", said)).toMatch(/Warning: src\/index\.js still uses toCelsius \(line 3\).*"all": true/);
    expect(loadWarning("src/index.js", before, half.replace("${toCelsius(", "${fahrenheitToCelsius("), "commonjs", said)).not.toMatch(/still uses/);
  });
  it("is a rule-checked problem for the review and verification, also for files no draft touched", () => {
    const drafts = draftsForReview([{ path: "src/index.js", original: before, proposed: half }], undefined, "commonjs", undefined, said, renameLeftovers([{ path: "test.js", text: "toCelsius(1)\n" }], said));
    expect(draftProblemsOf(drafts)).toEqual([expect.stringMatching(/^src\/index\.js still uses toCelsius/), expect.stringMatching(/^test\.js still uses toCelsius \(line 1\)/)]);
  });
});
