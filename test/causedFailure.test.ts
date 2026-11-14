/** Run 11, rename-everywhere: a failure only the drafts cause is missing work, whatever the verdict said. */
import { describe, expect, it } from "vitest";
import { guardVerification } from "../src/coordinator/verify";
import { overrulesWithOtherReports } from "../src/coordinator/review";
import { buildPlannerMessages, coverReferences } from "../src/coordinator/planner";
import { beforeTheRun } from "../src/chat/verifier";

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

describe("coverReferences", () => {
  const plan = {
    tasks: [
      { id: "convert", title: "Rename in convert.js", instructions: "Rename toCelsius in src/convert.js.", dependsOn: [], fileScope: ["src/convert.js"] },
      { id: "index", title: "Update index.js", instructions: "Use the new name in src/index.js.", dependsOn: [], fileScope: ["src/index.js"] },
    ],
  };
  const refs = { name: "toCelsius", files: ["src/convert.js", "src/index.js", "test.js"] };
  it("adds a task for a file the search found and the plan left out", () => {
    const r = coverReferences(plan, refs, "Rename the function toCelsius to fahrenheitToCelsius everywhere.", 12);
    expect(r.added).toEqual(["test.js"]);
    const t = r.plan.tasks.at(-1)!;
    expect(t.fileScope).toEqual(["test.js"]);
    expect(t.dependsOn).toEqual(["convert", "index"]);
    expect(t.instructions).toMatch(/Rename toCelsius to fahrenheitToCelsius in test\.js/);
  });
  it("leaves a plan that covers every file, or one that is not a rename, as it is", () => {
    expect(coverReferences(plan, { name: "toCelsius", files: ["src/convert.js"] }, "Rename toCelsius to x.", 12).added).toEqual([]);
    expect(coverReferences(plan, refs, "Add toKelvin.", 12).plan).toBe(plan);
  });
});

describe("beforeTheRun", () => {
  it("is each file's content before the run's first change, without new files", () => {
    const m = beforeTheRun([
      { path: "a.js", original: "v0" },
      { path: "a.js", original: "v1" },
      { path: "new.js", original: null },
    ]);
    expect([...m]).toEqual([["a.js", "v0"]]);
  });
});

describe("overrulesWithOtherReports", () => {
  it("spots a send-back that rests on other reports", () => {
    expect(overrulesWithOtherReports("The sub-agent incorrectly identified test.js. The correct files are src/convert.js and src/index.js as confirmed by earlier reports.")).toBe(true);
    expect(overrulesWithOtherReports("Another researcher found no uses in test.js.")).toBe(true);
    expect(overrulesWithOtherReports("Your report does not name the line in src/convert.js. Add it.")).toBe(false);
  });
});
