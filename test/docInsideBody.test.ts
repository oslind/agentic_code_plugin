/** Run 13, project-skill-trusted: a JSDoc put inside a function body was accepted as "added with JSDoc". */
import { describe, expect, it } from "vitest";
import { docInsideBody } from "../src/changes/moduleStyle";

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
