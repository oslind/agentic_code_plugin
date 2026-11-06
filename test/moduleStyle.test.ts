import { describe, expect, it } from "vitest";
import { draftProblemsOf, moduleStyleProblems } from "../src/changes/moduleStyle";
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
