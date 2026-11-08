/** Run 11, rename-everywhere: a failure only the drafts cause is missing work, whatever the verdict said. */
import { describe, expect, it } from "vitest";
import { guardVerification } from "../src/coordinator/verify";
import { buildPlannerMessages } from "../src/coordinator/planner";

describe("guardVerification with a command the drafts broke", () => {
  it("is not done, and names the new failure", () => {
    const g = guardVerification(
      { verdict: "done", verified: "Renamed; test failures are existing issues.", missing: [] },
      { checks: [], tasks: [], failedCommands: [{ line: "npm test", output: "FAIL freezing point: toCelsius is not a function\n" }] },
    );
    expect(g.verified).toBe(false);
    expect(g.missing[0]).toMatch(/Make `npm test` pass again: it fails with the drafts and not without them: .*toCelsius is not a function/);
    expect(g.adjusted).toMatch(/a command fails because of the drafts/);
  });
});

describe("the planner for a rename", () => {
  it("gets every file that mentions the old name", () => {
    const text = buildPlannerMessages({ request: "Rename toCelsius to fahrenheitToCelsius.", references: { name: "toCelsius", files: ["src/convert.js", "test.js"] } }, 16384)
      .messages.map((m) => m.content)
      .join("\n");
    expect(text).toMatch(/Every project file that mentions toCelsius[\s\S]*test\.js/);
  });
});
