import { describe, expect, it } from "vitest";
import { filesMentioning, outlineOf, outlinesOfNamedFiles } from "../src/context/outline";

describe("outlineOf", () => {
  it("lists top-level functions, classes and exports", () => {
    const js = "'use strict';\nfunction targetTemp(mode) {\n  if (mode === 'night') return 17;\n  return 21;\n}\n\nmodule.exports = { targetTemp };\n";
    expect(outlineOf(js)).toEqual(["function targetTemp(mode)", "module.exports = { targetTemp };"]);
    expect(outlineOf("export class Thermostat {\n  get() {}\n}\nexport const f = (x) => x;\n")).toEqual(["export class Thermostat", "export const f = (x) => x;"]);
    expect(outlineOf("def total(xs):\n    return sum(xs)\n\nclass Cart:\n    pass\n")).toEqual(["def total(xs):", "class Cart:"]);
  });

  it("outlines only the project files the text names", async () => {
    const files = { readFile: async (p: string) => (p === "src/a.js" ? "function a() {}\n" : "function b() {}\n") };
    const tree = "src/\n  a.js\n  b.js";
    expect(await outlinesOfNamedFiles(files, tree, ["Change src/a.js"])).toBe("src/a.js:\n  function a() {}");
    expect(await outlinesOfNamedFiles(files, tree, ["Change nothing"])).toBeUndefined();
  });
});

describe("filesMentioning", () => {
  it("finds every file that uses a name as a whole word, root files included", async () => {
    const texts: Record<string, string> = {
      "src/convert.js": "function toCelsius(f) {}\nmodule.exports = { toCelsius };\n",
      "test.js": "const { toCelsius } = require('./src/convert');\n",
      "src/other.js": "const toCelsiusX = 1;\n",
      "README.md": "Use `toCelsius(f)`.\n",
    };
    const files = { listFiles: async () => Object.keys(texts), readFile: async (p: string) => texts[p]! };
    expect(await filesMentioning(files, "toCelsius")).toEqual({ files: ["src/convert.js", "test.js", "README.md"], incomplete: undefined });
  });

  it("searches past 400 files, and says when it could not search every file (audit of PR #54)", async () => {
    const texts: Record<string, string> = Object.fromEntries(Array.from({ length: 900 }, (_, i) => [`src/f${String(i).padStart(3, "0")}.js`, i === 850 ? "toCelsius(1);\n" : "x;\n"]));
    const files = { listFiles: async () => [...Object.keys(texts), "src/huge.js"], readFile: async (p: string) => (p in texts ? texts[p]! : Promise.reject(new Error("too large"))) };
    const r = await filesMentioning(files, "toCelsius");
    expect(r.files).toEqual(["src/f850.js"]);
    expect(r.incomplete).toMatch(/1 file\(s\) could not be read or are over 1 MB \(src\/huge\.js\)/);
    const many = { listFiles: async (_g: string, max: number) => Array.from({ length: max }, (_, i) => `f${i}.js`), readFile: async () => "x" };
    expect((await filesMentioning(many, "toCelsius")).incomplete).toMatch(/more than 5000 files/);
  });

  it("matches a name with regex characters only literally", async () => {
    const files = { listFiles: async () => ["a.js", "b.js"], readFile: async (p: string) => (p === "a.js" ? "a+b(1)" : "aab(1)") };
    expect((await filesMentioning(files, "a+b")).files).toEqual(["a.js"]);
  });
});
