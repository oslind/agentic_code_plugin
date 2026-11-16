/** Risks found when the run 16 fixes were reviewed (Oskar: "tread carefully", 2026-11-16), each with its rule. */
import { describe, expect, it } from "vitest";
import { asksToFixFailures, failureLines, pinsOldValue } from "../src/checks/failures";
import { fixIsTheRequest, withEntryPoints } from "../src/chat/verifier";
import { revertsAccepted } from "../src/coordinator/review";
import { unusedImports } from "../src/changes/moduleStyle";
import { loadWarning } from "../src/worker/tools";

describe("a failure from before the request is still the work when fixing it is the request", () => {
  it("knows a request to fix a failure, in English and Swedish, and not other fixes or test runs", () => {
    expect(asksToFixFailures("Fix the average function so the 'average of three' test passes.")).toBe(true);
    expect(asksToFixFailures("There is a bug in stats.js. Fix it.")).toBe(true);
    expect(asksToFixFailures("Fix the bug in average().")).toBe(true);
    expect(asksToFixFailures("Fixa det fallerande testet.")).toBe(true);
    expect(asksToFixFailures("Fix the typo in README.md.")).toBe(false);
    expect(asksToFixFailures("Rename toCelsius everywhere, then run the tests.")).toBe(false);
    expect(asksToFixFailures("Change night mode to lower the target by 4 degrees.")).toBe(false);
    expect(asksToFixFailures(undefined)).toBe(false);
  });

  it("counts a command that fails the old way as missing work then, and only then", () => {
    const compared = { failedCommands: [], preexistingFailures: [{ line: "npm test", output: "FAIL average of three" }], uncomparedFailures: [] };
    expect(fixIsTheRequest(compared, "Fix the failing test.").failedCommands).toEqual(compared.preexistingFailures);
    expect(fixIsTheRequest(compared, "Fix the failing test.").preexistingFailures).toEqual([]);
    expect(fixIsTheRequest(compared, "Add a median function.")).toBe(compared);
  });
});

describe("the way out for a test that pins an old value", () => {
  it("is only for a failed comparison, never for a crash", () => {
    expect(pinsOldValue("FAIL night is 3 lower\nExpected values to be strictly equal:\n17 !== 18")).toBe(true);
    expect(pinsOldValue("TypeError: toCelsius is not a function\n    at test.js:3")).toBe(false);
    expect(pinsOldValue("FAIL median\nTypeError: Cannot read properties of undefined")).toBe(false);
    expect(pinsOldValue("SyntaxError: Unexpected token")).toBe(false);
  });
});

describe("the revert block", () => {
  const first = { original: "const a = 1;\nconst b = 2;\n", proposed: "const a = 1;\nconst b = 3;\n" };
  const back = { original: first.proposed, proposed: first.original };
  it("lets a task through that is asked to remove or drop an earlier change", () => {
    expect(revertsAccepted("Remove the unrequested change to b.", first, back)).toBeUndefined();
    expect(revertsAccepted("Drop the average fix nobody asked for.", first, back)).toBeUndefined();
    expect(revertsAccepted("Make the failing test pass.", first, back)).toBe("const b = 2;");
  });
});

describe("the program run in verification", () => {
  it("comes before the sub-agents' failed commands, so it is never the one cut off", () => {
    const failed = ["a", "b", "c"].map((line) => ({ line, output: "x" }));
    expect(withEntryPoints(failed, ["node src/index.js"]).map((f) => f.line)).toEqual(["node src/index.js", "a", "b", "c"]);
  });
});

describe("an import that is not used yet", () => {
  const before = "console.log(1);\n";
  const after = 'const { formatTemp } = require("./format");\nconsole.log(1);\n';
  it("is a note to go on right after the write, and a problem only for the review", () => {
    const note = loadWarning("src/index.js", before, after, "commonjs");
    expect(note).toMatch(/imports formatTemp now and does not use it yet: call formatTemp/);
    expect(note).not.toMatch(/Warning|remove the import/);
    expect(unusedImports([{ path: "src/index.js", original: before, proposed: after }])[0]).toMatch(/never uses it/);
  });
});

describe("failure lines", () => {
  it("take an error line, and not a word that only ends in Error", () => {
    expect(failureLines("TypeError: x is not a function\nok 1 handlesError\npassed: throwsRangeError case")).toEqual(["TypeError: x is not a function"]);
  });
});
