/** Run 13, project-skill-trusted: a JSDoc put inside a function body was accepted as "added with JSDoc". */
import { describe, expect, it } from "vitest";
import { docInsideBody, droppedCalls, duplicateDeclarations, duplicateFunctions, unaskedFunctionChanges } from "../src/changes/moduleStyle";

describe("docInsideBody", () => {
  it("finds a new doc comment right after a function's opening brace", () => {
    const proposed = "function toKelvin(celsius) {\n  /** Converts Celsius to Kelvin. */\n  return celsius + 273.15;\n}\n";
    expect(docInsideBody([{ path: "src/convert.js", original: "", proposed }])).toEqual([
      "In src/convert.js, the doc comment at line 2 is inside the body of toKelvin; a doc comment goes on the lines just above the function, not after its opening brace.",
    ]);
    expect(docInsideBody([{ path: "src/convert.js", original: "", proposed: "function f(x) { /** doc */ return x; }" }])).toHaveLength(1);
  });
  it("leaves a doc comment above the function, and one that was already there", () => {
    const above = "/**\n * Converts Celsius to Kelvin.\n */\nfunction toKelvin(celsius) {\n  return celsius + 273.15;\n}\n";
    expect(docInsideBody([{ path: "src/convert.js", original: "", proposed: above }])).toEqual([]);
    const old = "function a() {\n  /** old */\n}\n";
    expect(docInsideBody([{ path: "a.js", original: old, proposed: old + "\n" }])).toEqual([]);
    expect(docInsideBody([{ path: "README.md", original: "", proposed: "f() {\n/** x */" }])).toEqual([]);
  });
});

describe("unaskedFunctionChanges", () => {
  const original = "function average(a) {\n  return a.reduce((s, x) => s + x, 0) / 3;\n}\nmodule.exports = { average };\n";
  const proposed = "function average(a) {\n  return a.reduce((s, x) => s + x, 0) / a.length;\n}\nfunction median(a) {\n  return a[0];\n}\nmodule.exports = { average, median };\n";
  it("names an existing function the draft changed that nobody asked about (run 13, parallel-changes)", () => {
    const out = unaskedFunctionChanges([{ path: "src/stats.js", original, proposed }], "Add median(values) to src/stats.js and export it.");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^average\(\) in src\/stats\.js was changed, but neither the user nor the task names it/);
  });
  it("leaves functions the request names, and new ones", () => {
    expect(unaskedFunctionChanges([{ path: "src/stats.js", original, proposed }], "Fix average() and add median.")).toEqual([]);
    expect(unaskedFunctionChanges([{ path: "src/stats.js", original: null, proposed }], "Add median.")).toEqual([]);
  });
});

describe("duplicateFunctions (run 14, project-skill-trusted)", () => {
  it("names a function a draft declares a second time, and leaves existing duplicates alone", () => {
    const original = "function toCelsius(f) { return f; }\nmodule.exports = { toCelsius };\n";
    const proposed = "function toCelsius(f) { return f; }\nfunction toKelvin(c) { return c + 273.15; }\n\nfunction toKelvin(c) {\n  return c + 273.15;\n}\nmodule.exports = { toCelsius, toKelvin };\n";
    expect(duplicateFunctions([{ path: "src/convert.js", original, proposed }])).toEqual(["src/convert.js now declares toKelvin 2 times (lines 2, 4); keep one and delete the others."]);
    expect(duplicateFunctions([{ path: "src/convert.js", original: proposed, proposed }])).toEqual([]);
    expect(duplicateFunctions([{ path: "README.md", original: null, proposed }])).toEqual([]);
  });
  it("finds const arrow functions too", () => {
    expect([...duplicateDeclarations("const f = (x) => x;\nconst f = x => x;\n")]).toEqual([["f", [1, 2]]]);
  });
});

describe("droppedCalls (run 14, new-module-used)", () => {
  const original = "const { toCelsius } = require('./convert');\nconsole.log(`Target: ${toCelsius(70).toFixed(1)} C`);\n";
  it("names a call the draft took out when the request does not mention it", () => {
    const proposed = "const { formatTemp } = require('./format');\nconsole.log(`Target: ${formatTemp(70)} C`);\n";
    expect(droppedCalls([{ path: "src/index.js", original, proposed }], "Add src/format.js with formatTemp and use it to print the target.")).toEqual([
      expect.stringMatching(/^src\/index\.js no longer calls toCelsius\(\) \(it did once before\)/),
    ]);
  });
  it("is quiet when the call is kept or the request names it", () => {
    const wrapped = "const { toCelsius } = require('./convert');\nconst { formatTemp } = require('./format');\nconsole.log(`Target: ${formatTemp(toCelsius(70))}`);\n";
    expect(droppedCalls([{ path: "src/index.js", original, proposed: wrapped }], "use formatTemp to print the target")).toEqual([]);
    expect(droppedCalls([{ path: "src/index.js", original, proposed: "console.log(1);\n" }], "remove the toCelsius call")).toEqual([]);
  });
});
