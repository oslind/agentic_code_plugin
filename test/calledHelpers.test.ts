/** Run 17, big questions: a module that throws through a helper in another file was reported as not throwing. */
import { describe, expect, it } from "vitest";
import { functionSource, helpersUsed, localImports } from "../src/chat/calledHelpers";
import { batchFilesOf, batchQuestion } from "../src/chat/coverage";

const util = ["function roundCents(x) {", "  return Math.round(x * 100) / 100;", "}", "", "function assertNonNegative(n) {", "  if (n < 0) throw new RangeError('negative: ' + n);", "}", "", "module.exports = { roundCents, assertNonNegative };", ""].join("\n");
const project: Record<string, string> = {
  "src/util.js": util,
  "src/mod_007.js": "const { roundCents, assertNonNegative } = require('./util');\nfunction price(qty) {\n  assertNonNegative(qty);\n  return roundCents(qty * 2);\n}\nmodule.exports = { price };\n",
  "src/mod_008.js": "const { roundCents } = require('./util');\nmodule.exports = { price: (q) => roundCents(q) };\n",
  "src/mod_009.js": "const { assertNonNegative } = require('./util');\n// imported and never called\nmodule.exports = {};\n",
  "src/esm.mjs": 'import { assertNonNegative as check } from "./util.js";\nexport const f = (n) => check(n);\n',
};
const files = { readFile: async (p: string) => (p in project ? project[p]! : Promise.reject(new Error("no such file"))) };

describe("functions a batch's files call from other files", () => {
  it("reads destructured require and import names from relative modules only", () => {
    expect(localImports("const { a, b: c } = require('./m');\nconst fs = require('fs');\nimport { d as e } from \"../n\";\nimport { x } from 'pkg';")).toEqual([
      { names: ["a", "b"], from: "./m" },
      { names: ["d"], from: "../n" },
    ]);
  });

  it("cuts one function out of a file", () => {
    expect(functionSource(util, "assertNonNegative")).toBe("function assertNonNegative(n) {\n  if (n < 0) throw new RangeError('negative: ' + n);\n}");
    expect(functionSource("const twice = (n) => n * 2;\n", "twice")).toBe("const twice = (n) => n * 2;");
    expect(functionSource(util, "missing")).toBeUndefined();
  });

  it("shows the code of each helper that is called, with the files that call it", async () => {
    const text = (await helpersUsed(files, ["src/mod_007.js", "src/mod_008.js", "src/mod_009.js"]))!;
    expect(text).toMatch(/^Checked by rule: these files call functions that are defined in other files\./);
    expect(text).toContain("assertNonNegative in src/util.js, called by src/mod_007.js:");
    expect(text).toContain("throw new RangeError");
    expect(text).toContain("roundCents in src/util.js, called by src/mod_007.js, src/mod_008.js:");
    // Imported and never called is not a call.
    expect(text).not.toContain("src/mod_009.js");
    // The code is fenced as data.
    expect(text).toMatch(/<untrusted_data source="functions from other project files">/);
  });

  it("says nothing when no file calls a function from another file, or the file is in the batch itself", async () => {
    expect(await helpersUsed(files, ["src/util.js"])).toBeUndefined();
    expect(await helpersUsed(files, ["src/mod_009.js", "missing.js"])).toBeUndefined();
    expect(await helpersUsed(files, ["src/mod_007.js", "src/util.js"])).toBeUndefined();
  });

  it("keeps the batch's file list readable from the question", () => {
    const q = batchQuestion("Which modules can throw?", ["src/mod_007.js", "src/mod_008.js"], "Checked by rule: ...\nFiles: not/this.js");
    expect(batchFilesOf(q)).toEqual(["src/mod_007.js", "src/mod_008.js"]);
  });
});
