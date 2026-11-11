/** Run 10, rename-everywhere: a rename task whose files never had the old name is accepted by rule. */
import { describe, expect, it } from "vitest";
import { nothingToRename, onlyRunsOrChecks, renamedName, renameDoneInScope, revertsAccepted } from "../src/coordinator/review";

describe("renamedName", () => {
  it("reads the old name from rename and replace wording", () => {
    expect(renamedName("Rename toCelsius to fahrenheitToCelsius in src/convert.js.")).toBe("toCelsius");
    expect(renamedName("Rename the function `toCelsius` to `fToC` everywhere.")).toBe("toCelsius");
    expect(renamedName("Replace every use of oldName with newName.")).toBe("oldName");
    expect(renamedName("Replace config.port by config.httpPort")).toBe("config.port");
  });

  it("names nothing when the task is not a rename or names no code", () => {
    expect(renamedName("Add a function toKelvin to src/convert.js.")).toBeUndefined();
    expect(renamedName("Rename it to something clearer.")).toBeUndefined();
  });
});

describe("nothingToRename", () => {
  const task = "Rename toCelsius to fahrenheitToCelsius in its files.";
  it("is true only with no drafts and the name in none of the files", () => {
    expect(nothingToRename(task, "", new Map([["a.js", "const x = 1;\n"]]))).toBe(true);
    expect(nothingToRename(task, "", new Map([["a.js", "toCelsius(5)\n"]]))).toBe(false);
    expect(nothingToRename(task, "## a.js\n- x", new Map([["a.js", "const x = 1;\n"]]))).toBe(false);
  });

  it("is false when a file could not be read, there are no files, or it is not a rename", () => {
    expect(nothingToRename(task, "", new Map([["a.js", undefined]]))).toBe(false);
    expect(nothingToRename(task, "", new Map())).toBe(false);
    expect(nothingToRename("Add toKelvin to a.js", "", new Map([["a.js", "const x = 1;\n"]]))).toBe(false);
  });
});

describe("renameDoneInScope (run 14, rename-everywhere)", () => {
  const task = "Rename toCelsius to fahrenheitToCelsius in src/convert.js.";
  const done = new Map([["src/convert.js", { before: "function toCelsius(f) {}\nmodule.exports = { toCelsius };\n", after: "function fahrenheitToCelsius(f) {}\nmodule.exports = { fahrenheitToCelsius };\n" }]]);
  it("accepts a send-back about the rename when the task's own files no longer use the old name", () => {
    expect(renameDoneInScope(task, "The drafts only show the function renamed in src/convert.js; rename every use in the project.", done)).toBe(true);
  });
  it("keeps a send-back about something else, or when the old name is still used", () => {
    expect(renameDoneInScope(task, "The new function returns the wrong value for 212.", done)).toBe(false);
    const left = new Map([["src/convert.js", { before: "toCelsius(1);\n", after: "fahrenheitToCelsius(1);\ntoCelsius(2);\n" }]]);
    expect(renameDoneInScope(task, "Rename the remaining call.", left)).toBe(false);
  });
  it("never counts unreadable files or files that never had the name", () => {
    expect(renameDoneInScope(task, "rename it", new Map([["src/convert.js", undefined]]))).toBe(false);
    expect(renameDoneInScope(task, "rename it", new Map([["src/convert.js", { before: "x\n", after: "x\n" }]]))).toBe(false);
    expect(renameDoneInScope("Add toKelvin to a.js", "rename it", done)).toBe(false);
  });
});

describe("run 14 repeat 2 review rules", () => {
  it("knows a task that only runs or checks", () => {
    expect(onlyRunsOrChecks("Run tests to verify mean function fix")).toBe(true);
    expect(onlyRunsOrChecks("Verify that python3 -m unittest passes.")).toBe(true);
    expect(onlyRunsOrChecks("Run the tests and fix any failure.")).toBe(false);
    expect(onlyRunsOrChecks("Fix mean() in src/calc.py.")).toBe(false);
  });
  it("finds a draft that puts back what an accepted change of the run replaced", () => {
    const accepted = { original: "const NIGHT_DROP = 3;\nexport { NIGHT_DROP };\n", proposed: "const NIGHT_DROP = 4;\nexport { NIGHT_DROP };\n" };
    const revert = { original: accepted.proposed, proposed: accepted.original };
    expect(revertsAccepted("Make the failing test pass.", accepted, revert)).toBe("const NIGHT_DROP = 3;");
    expect(revertsAccepted("Revert the night drop to 3.", accepted, revert)).toBeUndefined();
    const other = { original: accepted.proposed, proposed: "const NIGHT_DROP = 4;\nconst DAY = 1;\nexport { NIGHT_DROP };\n" };
    expect(revertsAccepted("Add DAY.", accepted, other)).toBeUndefined();
  });
});
