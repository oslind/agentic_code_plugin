import { describe, expect, it } from "vitest";
import { loadWarning, nearestMatch } from "../src/worker/tools";
import { draftProblemsOf, moduleStyleProblems, undefinedExports, unexportedProblems } from "../src/changes/moduleStyle";
import { draftsForReview } from "../src/coordinator/review";
import { guardVerification } from "../src/coordinator/verify";

const cjs = "const DEFAULT_TARGET = 21;\nfunction targetTemp() { return DEFAULT_TARGET - 3; }\nmodule.exports = { targetTemp, DEFAULT_TARGET };\n";
// What qwen3:8b drafted in e2e runs 4 and 5.
const mixed = cjs.replace("const DEFAULT_TARGET = 21;", "import { NIGHT_DROP, DEFAULT_TARGET } from './config';");

describe("module style of drafts", () => {
  it("flags a CommonJS file that a draft gave an ES import, and nothing else", () => {
    expect(moduleStyleProblems([{ path: "src/thermostat.js", original: cjs, proposed: mixed }])).toEqual([expect.stringMatching(/^src\/thermostat\.js uses both import\/export and require\/module\.exports/)]);
    expect(moduleStyleProblems([{ path: "src/thermostat.js", original: cjs, proposed: cjs.replace("21", "22") }])).toEqual([]);
    expect(moduleStyleProblems([{ path: "src/config.mjs", original: null, proposed: "export const A = 1;\n" }])).toEqual([]);
    // TypeScript compiles import to require, and a file that already mixed is not this draft's doing.
    expect(moduleStyleProblems([{ path: "src/a.ts", original: null, proposed: mixed }])).toEqual([]);
    expect(moduleStyleProblems([{ path: "src/b.js", original: mixed, proposed: `${mixed}\n// more` }])).toEqual([]);
  });

  it("flags a CommonJS draft with a syntax error, compiled but never run", () => {
    // Run 5: new tests pasted after the closing brace of the tests object.
    const tests = "const tests = {\n  a: () => 1,\n};\nmodule.exports = tests;\n";
    const broken = tests.replace("};", "};\n  'median of odd array': () => 3,\n};");
    expect(moduleStyleProblems([{ path: "test.js", original: tests, proposed: broken }])).toEqual([expect.stringMatching(/^test\.js has a syntax error/)]);
    expect(moduleStyleProblems([{ path: "test.js", original: tests, proposed: "#!/usr/bin/env node\n" + tests }])).toEqual([]);
    // Never run: a draft that would throw or loop when run still only compiles.
    expect(moduleStyleProblems([{ path: "x.js", original: null, proposed: "while (true) {}\nthrow new Error('x');\n" }])).toEqual([]);
  });

  it("puts the problem after the diffs, where review and verification read it, and verification is never done with it", () => {
    const drafts = draftsForReview([{ path: "src/thermostat.js", original: cjs, proposed: mixed }]);
    const problems = draftProblemsOf(drafts);
    expect(problems).toHaveLength(1);
    const v = guardVerification({ verdict: "done", verified: "All good.", missing: [] }, { checks: [], tasks: [], drafts });
    expect(v.verified).toBe(false);
    expect(v.missing[0]).toMatch(/src\/thermostat\.js uses both/);
    expect(draftProblemsOf(draftsForReview([{ path: "src/x.js", original: cjs, proposed: cjs }]))).toEqual([]);
  });
});

describe("warning a sub-agent right after a write that breaks a file", () => {
  it("warns when an edit leaves code after the closing brace, and not for files that already had the problem", () => {
    const before = "function toC(f) {\n  return ((f - 32) * 5) / 9;\n}\nmodule.exports = { toC };\n";
    const after = "function toC(f) {\n  return (f - 32) / 1.8;\n}\n  return ((f - 32) * 5) / 9;\n}\nmodule.exports = { toC };\n";
    expect(loadWarning("convert.js", before, after)).toMatch(/^\nWarning: convert\.js has a syntax error[\s\S]*write it again whole with write_file[\s\S]*instead of patching it further\.$/);
    expect(loadWarning("convert.js", after, after + "\n")).toBe("");
    expect(loadWarning("convert.js", null, before)).toBe("");
    expect(loadWarning("notes.md", null, "}")).toBe("");
    const big = "// line\n".repeat(100);
    expect(loadWarning("convert.js", big + before, big + after)).toMatch(/Read the file and fix it before you finish\.$/);
  });
});

describe("exports of names a file never defines", () => {
  it("finds a name in module.exports or export { } that is defined nowhere, and nothing else", () => {
    expect(undefinedExports("function toC(f) { return f; }\nmodule.exports = { toC, toKelvin };\n")).toEqual(["toKelvin"]);
    expect(undefinedExports("const toK = (c) => c + 273.15;\nfunction toC(f) { return f; }\nmodule.exports = { toC, toK };\n")).toEqual([]);
    expect(undefinedExports("const { a } = require('./x');\nmodule.exports = { a, b: a };\n")).toEqual([]);
    expect(undefinedExports("// toKelvin later\nmodule.exports = { toKelvin };\n")).toEqual(["toKelvin"]);
    expect(undefinedExports("function median(xs) {}\nexport { median, mode };\n")).toEqual(["mode"]);
    expect(undefinedExports("export { a } from './a.js';\n")).toEqual([]);
    expect(undefinedExports("obj.toKelvin = 1;\nmodule.exports = { toKelvin };\n")).toEqual(["toKelvin"]);
  });

  it("makes a draft that adds such an export a problem, and the write warns about it", () => {
    const before = "function toCelsius(f) {\n  return ((f - 32) * 5) / 9;\n}\nmodule.exports = { toCelsius };\n";
    const after = before.replace("{ toCelsius }", "{ toCelsius, toKelvin }");
    expect(moduleStyleProblems([{ path: "src/convert.js", original: before, proposed: after }])).toEqual([
      "src/convert.js exports toKelvin but never defines it, so loading it throws a ReferenceError. Write the missing code.",
    ]);
    expect(loadWarning("src/convert.js", before, after)).toMatch(/Warning: src\/convert\.js exports toKelvin but never defines it/);
    expect(moduleStyleProblems([{ path: "src/convert.js", original: after, proposed: after + "\n" }])).toEqual([]);
  });
});

describe("a search that was not found", () => {
  const file = "// The heating target.\nconst DEFAULT_TARGET = 21;\n\nfunction targetTemp(mode) {\n  return mode === 'night' ? DEFAULT_TARGET - 3 : DEFAULT_TARGET;\n}\n";
  it("shows where it nearly matches and the first line that differs", () => {
    const hint = nearestMatch(file, "function targetTemp(mode) {\n  return mode === 'night' ? DEFAULT_TARGET - 2 : DEFAULT_TARGET;\n}");
    expect(hint).toMatch(/Line 2 of your search differs/);
    expect(hint).toMatch(/DEFAULT_TARGET - 3/);
    expect(hint).toMatch(/line 4 on/);
  });
  it("says nothing when no line of the search is in the file", () => {
    expect(nearestMatch(file, "function other() {}")).toBeUndefined();
  });
});

describe("half-length array indexes", () => {
  const buggy = "function median(r) {\n  const sorted = [...r].sort((a, b) => a - b);\n  const mid = sorted.length / 2;\n  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;\n}\n";
  it("are pointed out after a write and under the drafts in a review", async () => {
    const { halfIndexHints } = await import("../src/changes/moduleStyle");
    const { draftsForReview } = await import("../src/coordinator/review");
    expect(halfIndexHints("src/stats.js", buggy)).toHaveLength(1);
    expect(halfIndexHints("src/stats.js", "return s[s.length / 2];")).toHaveLength(1);
    expect(halfIndexHints("src/stats.js", buggy.replace("sorted.length / 2", "Math.floor(sorted.length / 2)"))).toEqual([]);
    expect(halfIndexHints("README.md", buggy)).toEqual([]);
    expect(loadWarning("src/stats.js", "", buggy)).toMatch(/odd-length input/);
    expect(draftsForReview([{ path: "src/stats.js", original: "", proposed: buggy }])).toMatch(/Checked by rule, look at these before you accept/);
  });
});

describe("ES modules in a CommonJS project", () => {
  it("are a load problem even when no single file mixes the two", async () => {
    const { moduleStyleProblems } = await import("../src/changes/moduleStyle");
    const esmConfig = { path: "src/config.js", original: null, proposed: "export const NIGHT_DROP = 3;\nexport const DEFAULT_TARGET = 21;\n" };
    expect(moduleStyleProblems([esmConfig], "commonjs")[0]).toMatch(/this project uses CommonJS/);
    expect(moduleStyleProblems([esmConfig])).toEqual([]);
    expect(moduleStyleProblems([esmConfig], "module")).toEqual([]);
    expect(moduleStyleProblems([{ ...esmConfig, path: "src/config.mjs" }], "commonjs")).toEqual([]);
  });

  it("knows the project's style from package.json and its own files", async () => {
    const fs = await import("fs/promises");
    const os = await import("os");
    const path = await import("path");
    const { projectModuleStyle } = await import("../src/changes/moduleStyle");
    const { WorkspaceSandbox } = await import("../src/tools/sandbox");
    const make = async (files: Record<string, string>) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "style-"));
      for (const [rel, text] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await fs.writeFile(path.join(root, rel), text);
      }
      return projectModuleStyle(await WorkspaceSandbox.create(root));
    };
    expect(await make({ "package.json": "{}", "src/a.js": "module.exports = {};\n" })).toBe("commonjs");
    expect(await make({ "package.json": '{"type":"module"}', "src/a.js": "export const a = 1;\n" })).toBe("module");
    // A bundled front end: no "type", but its .js files use import. Not called CommonJS.
    expect(await make({ "package.json": "{}", "src/a.js": "import x from './x';\n", "src/b.js": "module.exports = 1;\n" })).toBeUndefined();
    expect(await make({ "src/a.js": "module.exports = {};\n" })).toBeUndefined();
  });
});

describe("unexportedProblems", () => {
  const before = "function average(r) {\n  return 0;\n}\n\nmodule.exports = { average };\n";
  const added = "function average(r) {\n  return 0;\n}\n\nfunction median(readings) {\n  return readings[0];\n}\n\nmodule.exports = { average };\n";
  it("flags a new function the request says to export when module.exports leaves it out (run 12B)", () => {
    const p = unexportedProblems([{ path: "src/stats.js", original: before, proposed: added }], "Add median(readings) to src/stats.js and export it.");
    expect(p).toEqual([expect.stringMatching(/defines median, which the request says to export/)]);
  });
  it("is quiet when the function is exported, in any common form", () => {
    const said = "add median(readings) and export it";
    for (const proposed of [
      added.replace("{ average }", "{ average, median }"),
      added + "module.exports.median = median;\n",
      "export function median(r) {\n  return r[0];\n}\n",
      "function median(r) {\n  return r[0];\n}\nexport { median };\n",
    ]) expect(unexportedProblems([{ path: "src/stats.js", original: before, proposed }], said)).toEqual([]);
  });
  it("leaves helpers alone that no exporting clause names, and requests that never say export", () => {
    const helper = added.replace(/median/g, "sortCopy");
    expect(unexportedProblems([{ path: "src/stats.js", original: before, proposed: helper }], "add median(readings) and export it")).toEqual([]);
    expect(unexportedProblems([{ path: "src/stats.js", original: before, proposed: added }], "add median(readings) to src/stats.js")).toEqual([]);
    expect(unexportedProblems([{ path: "src/stats.js", original: before, proposed: added }], "add median(readings); add toKelvin and export it")).toEqual([]);
  });
});

describe("an unexported function after a write and in the review", () => {
  const before = "function average(r) {\n  return 0;\n}\n\nmodule.exports = { average };\n";
  const after = before.replace("\nmodule", "\nfunction median(r) {\n  return r[0];\n}\n\nmodule");
  it("warns the sub-agent right after the write", () => {
    expect(loadWarning("src/stats.js", before, after, "commonjs", "Add median(readings) and export it")).toMatch(/Warning: .*does not export it/);
  });
  it("is a rule-checked problem in the drafts a review sees", () => {
    const drafts = draftsForReview([{ path: "src/stats.js", original: before, proposed: after }], undefined, "commonjs", undefined, "Add median(readings) and export it");
    expect(draftProblemsOf(drafts)).toEqual([expect.stringMatching(/does not export it/)]);
  });
});
