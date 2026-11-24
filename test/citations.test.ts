import { describe, expect, it } from "vitest";
import { checkCitations, citationFeedback, citationsIn, sourcesNote } from "../src/context/citations";

const files: Record<string, string> = {
  "src/stats.js": "function average(readings) {\n  let sum = 0;\n  for (const r of readings) sum += r;\n  return sum / 2;\n}\n",
  "src/thermostat.js": "const DEFAULT_TARGET = 21;\nfunction targetTemp(mode) {\n  if (mode === 'night') return DEFAULT_TARGET - 3;\n  return DEFAULT_TARGET;\n}\n",
};
const read = async (p: string) => files[p];

describe("sources of research findings are looked up by code", () => {
  it("reads path:line: code in the shapes a small model writes", () => {
    const report = [
      "The average is wrong.",
      "src/stats.js:4: return sum / 2;",
      "- `src/thermostat.js:1`: `const DEFAULT_TARGET = 21;`",
      "* src/thermostat.js (line 3): if (mode === 'night') return DEFAULT_TARGET - 3;",
      "- src/stats.js line 2 - the sum starts at zero: `let sum = 0;`",
      "See src/stats.js for details.",
      "src/stats.js:5: }",
    ].join("\n");
    expect(citationsIn(report)).toEqual([
      { path: "src/stats.js", line: 4, quote: "return sum / 2;" },
      { path: "src/thermostat.js", line: 1, quote: "const DEFAULT_TARGET = 21;" },
      { path: "src/thermostat.js", line: 3, quote: "if (mode === 'night') return DEFAULT_TARGET - 3;" },
      { path: "src/stats.js", line: 2, quote: "let sum = 0;" },
    ]);
  });

  it("finds real lines whatever the spacing or line number, and not made-up ones or unknown files", async () => {
    const report = ["src/stats.js:9:   return sum/2;", "src/stats.js:4: return sum / readings.length;", "src/nothere.js:1: module.exports = { average };"].join("\n");
    const check = await checkCitations(report, read);
    expect(check.found.map((c) => c.quote)).toEqual(["return sum/2;"]);
    expect(check.missing.map((c) => c.path)).toEqual(["src/stats.js", "src/nothere.js"]);
    expect(citationFeedback(check.missing)).toMatch(/^Checked by rule: 2 line\(s\) you gave as a source are not in the file named:\n- src\/stats\.js:4: return sum \/ readings\.length;/);
  });

  it("says under the answer how many were found, and nothing when no report quoted a line", async () => {
    const good = await checkCitations("src/stats.js:4: return sum / 2;", read);
    const bad = await checkCitations("src/stats.js:4: return total / count;", read);
    expect(sourcesNote([good, bad])).toBe(
      "Sources checked by rule: 1 of the 2 line(s) of code the sub-agents quoted are in the files they named. 1 could not be found, so what rests on them is not confirmed: `src/stats.js:4`. This shows the code is there, not that it was read correctly.",
    );
    expect(sourcesNote([good])).toMatch(/1 of the 1 line/);
    expect(sourcesNote([await checkCitations("The default is 21.", read)])).toBeUndefined();
  });
});
