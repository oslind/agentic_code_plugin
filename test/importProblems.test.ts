/** Run 12B, new-module-used: index.js took { formatTemp } from a module that is the function itself. */
import { describe, expect, it } from "vitest";
import { exportsProperty, importProblems } from "../src/changes/moduleStyle";

const read = (files: Record<string, string>) => async (p: string) => files[p];

describe("names taken from a project module", () => {
  it("flags { x } = require of a module that is a single function", async () => {
    const changes = [
      { path: "src/format.js", proposed: "module.exports = function formatTemp(c) {\n  return `${c.toFixed(1)} °C`;\n};\n" },
      { path: "src/index.js", proposed: "const { formatTemp } = require('./format');\nconsole.log(formatTemp(21));\n" },
    ];
    expect(await importProblems(changes, read({}))).toEqual([expect.stringMatching(/^src\/index\.js takes formatTemp from \.\/format, but src\/format\.js does not export it \(src\/format\.js sets module\.exports to a single value/)]);
  });
  it("accepts the shapes that do export the name, and reads files no draft touched", async () => {
    for (const target of ["function formatTemp() {}\nmodule.exports = { formatTemp };\n", "exports.formatTemp = () => 1;\n", "module.exports = { formatTemp: (c) => c };\n", "module.exports = { ...other };\n"]) {
      expect(await importProblems([{ path: "src/index.js", proposed: "const { formatTemp } = require('./format.js');\n" }], read({ "src/format.js": target }))).toEqual([]);
    }
    expect(await importProblems([{ path: "src/index.js", proposed: "const { nope } = require('../lib/x');\n" }], read({}))).toEqual([]);
  });
  it("checks ES module imports too", async () => {
    const p = await importProblems([{ path: "src/a.js", proposed: "import { add, sub as minus } from './math.js';\n" }], read({ "src/math.js": "export function add(a, b) {\n  return a + b;\n}\n" }));
    expect(p).toEqual([expect.stringMatching(/takes sub from \.\/math\.js/)]);
  });
  it("says when a shape cannot be read by rule", () => {
    expect(exportsProperty("module.exports = { ...x };\n", "a")).toBeUndefined();
    expect(exportsProperty("console.log(1);\n", "a")).toBeUndefined();
    expect(exportsProperty("module.exports = { a, b };\n", "b")).toBe(true);
  });
});

describe("a whole-module require called as a function (run 16 repeat 1, new-module-used)", () => {
  const format = "function formatTemp(c) {\n  return `${c.toFixed(1)} °C`;\n}\nmodule.exports = { formatTemp };\n";
  const read = async (p: string) => (p === "src/format.js" ? format : undefined);
  it("is a problem when the module exports an object with that name", async () => {
    const index = "const formatTemp = require('./format');\nconsole.log(formatTemp(21));\n";
    const out = await importProblems([{ path: "src/index.js", proposed: index }], read);
    expect(out).toEqual([expect.stringMatching(/takes the whole module \.\/format as formatTemp.*const \{ formatTemp \} = require/)]);
  });
  it("is fine when it is destructured, used as an object, or the module exports the function itself", async () => {
    expect(await importProblems([{ path: "src/index.js", proposed: "const { formatTemp } = require('./format');\nformatTemp(1);\n" }], read)).toEqual([]);
    expect(await importProblems([{ path: "src/index.js", proposed: "const format = require('./format');\nformat.formatTemp(1);\n" }], read)).toEqual([]);
    const single = async (p: string) => (p === "src/format.js" ? "module.exports = function formatTemp(c) { return c; };\n" : undefined);
    expect(await importProblems([{ path: "src/index.js", proposed: "const formatTemp = require('./format');\nformatTemp(1);\n" }], single)).toEqual([]);
  });
});
