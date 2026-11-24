/** Run 17 (2026-11-17): typo-please-correct asked the same question twice; old-test-pins-value threw the user's change away 18 times. */
import { describe, expect, it } from "vitest";
import { askedBefore, routeTurn } from "../src/chat/coordinatorChat";

const QUESTION = "Which word in README.md would you like corrected?";
const entries = [
  { author: "user" as const, text: "Please correct the misspelled word in README.md." },
  { author: "coordinator" as const, text: QUESTION },
  { author: "user" as const, text: "Yes, please go ahead." },
];
const again = { reply: QUESTION, action: "none" as const, request: "", goal: "answer" as const, complete: true };

describe("a question the user already answered is not asked twice", () => {
  it("finds the last question and the request it was about", () => {
    expect(askedBefore(entries)).toEqual({ question: QUESTION, request: "Please correct the misspelled word in README.md." });
    expect(askedBefore(entries.slice(0, 2))).toBeUndefined();
    expect(askedBefore([entries[0]!, { author: "coordinator", text: "Done." }, entries[2]!])).toBeUndefined();
    // Sub-agent and system entries in between do not hide it.
    expect(askedBefore([entries[0]!, entries[1]!, { author: "system" as never, text: "note" }, entries[2]!])?.question).toBe(QUESTION);
  });

  it("plans an edit request instead of the same question: research cannot edit (run 18, pass 2)", () => {
    const out = routeTurn(again, { userText: "Yes, please go ahead.", afterResearch: false, canResearch: true, asked: askedBefore(entries) });
    expect(out).toMatchObject({ action: "plan", goal: "change" });
    expect(out.request).toMatch(/^Please correct the misspelled word in README\.md\./);
    expect(out.reply).toMatch(/already asked/);
    // Small differences in punctuation and case are the same question.
    expect(routeTurn({ ...again, reply: "which word in README.md would you like corrected ?" }, { userText: "go", afterResearch: false, canResearch: true, asked: askedBefore(entries) }).action).toBe("plan");
  });

  it("sends read-only sub-agents to the files when the request was a question", () => {
    const asked = { question: "Which function do you mean?", request: "Which function sets the default target?" };
    const out = routeTurn({ ...again, reply: asked.question }, { userText: "The one in the thermostat.", afterResearch: false, canResearch: true, asked });
    expect(out.action).toBe("research");
    expect(out.questions?.[0]).toMatch(/^Which function sets the default target\?/);
  });

  it("leaves a first question, a different question, and a question after research alone", () => {
    expect(routeTurn(again, { userText: "Please correct the misspelled word in README.md.", afterResearch: false, canResearch: true })).toBe(again);
    const other = { ...again, reply: "Should I also fix the heading?" };
    expect(routeTurn(other, { userText: "Yes, please go ahead.", afterResearch: false, canResearch: true, asked: askedBefore(entries) })).toBe(other);
    expect(routeTurn(again, { userText: "Yes, please go ahead.", afterResearch: true, canResearch: true, asked: askedBefore(entries) }).action).toBe("none");
  });
});

import { breakCycles, findCycle, mergeSameFileTasks } from "../src/coordinator/plan";

describe("a fix-up plan whose merge leaves a dependency cycle (run 18, rename-then-run-tests)", () => {
  const t = (id: string, fileScope: string[], dependsOn: string[] = []) => ({ id, title: id, instructions: `Do ${id}`, fileScope, dependsOn });

  it("breaks the cycle by listing order when two tasks on one file are merged around a third", () => {
    const merged = mergeSameFileTasks([t("fix-convert-js", ["src/convert.js"]), t("update-test-js", ["test.js"], ["fix-convert-js"]), t("finish-convert-js", ["src/convert.js"], ["update-test-js"])]);
    expect(merged.map((x) => x.id)).toEqual(["fix-convert-js", "update-test-js"]);
    expect(findCycle(merged)).toBeUndefined();
    expect(merged[0]!.dependsOn).toEqual([]);
    expect(merged[1]!.dependsOn).toEqual(["fix-convert-js"]);
  });

  it("leaves a plan without a cycle exactly as it is", () => {
    const plan = [t("b", ["b.js"], ["a"]), t("a", ["a.js"])];
    expect(breakCycles(plan)).toBe(plan);
  });
});

import { buildVerifyMessages } from "../src/coordinator/verify";
import { outputTail, printedEvidence } from "../src/chat/verifier";

describe("what a program printed on the drafts is evidence (run 18, new-module-used)", () => {
  const printed = { line: "node src/index.js", before: "Target: 21 C (21.1 C is 70 F)", now: "Target: 21 C (21.1 C is 70 F) (212.0 °C °C)" };

  it("shows verification the output with and without the drafts, fenced", () => {
    const messages = buildVerifyMessages({ userMessages: ["Add formatTemp and use it in index.js."], request: "add formatTemp", tasks: [], drafts: "", checks: [], round: 0, programOutputs: [printed] }, 16000);
    const text = messages.map((m) => m.content).join("\n");
    expect(text).toContain("Checked by rule: program 1 runs without crashing on all drafts together, and what it prints changed with the drafts.");
    expect(text).toContain("With the drafts:\nTarget: 21 C (21.1 C is 70 F) (212.0 °C °C)");
    expect(text).toContain("Without the drafts:\nTarget: 21 C (21.1 C is 70 F)");
  });

  it("puts the real output in the evidence the user and the final reply see", () => {
    expect(printedEvidence([printed])).toBe(' With the drafts, `node src/index.js` printed: "Target: 21 C (21.1 C is 70 F) (212.0 °C °C)".');
    expect(printedEvidence(undefined)).toBe("");
    expect(outputTail("a\n\u001b[31mb\u001b[0m\n")).toBe("a\nb");
  });
});

import { aboutOldFailures, guardVerification } from "../src/coordinator/verify";

describe("a failure from before the request is not left to fix (run 18, rename-then-run-tests)", () => {
  const old = { name: "tests", passed: false, output: "FAIL average of three: 30 !== 20\n4 passed, 1 failed", failedBefore: "before" as const };
  const decision = { verdict: "not_done" as const, verified: "The rename is complete in all three files.", missing: ["Fix the 'average of three' test failure"] };

  it("finds missing items that name an old failure", () => {
    expect(aboutOldFailures(["Fix the 'average of three' test failure", "Rename toCelsius in test.js"], ["FAIL average of three: 30 !== 20"])).toEqual(["Fix the 'average of three' test failure"]);
    expect(aboutOldFailures(["Fix the error"], ["TypeError: x is not a function"])).toEqual([]);
  });

  it("calls the request done when the old failure is all the model named, and says so", () => {
    const v = guardVerification(decision, { checks: [old], tasks: [], userMessages: ["Rename toCelsius to fahrenheitToCelsius everywhere, then run the tests to check nothing broke."] });
    expect(v.verified).toBe(true);
    expect(v.missing).toEqual([]);
    expect(v.adjusted).toMatch(/failed the same way before your request/);
  });

  it("keeps other missing work, and keeps the old failure when fixing it is the request", () => {
    const more = guardVerification({ ...decision, missing: [...decision.missing, "Rename toCelsius in src/index.js"] }, { checks: [old], tasks: [], userMessages: ["Rename toCelsius everywhere."] });
    expect(more.verified).toBe(false);
    expect(more.missing).toEqual(["Rename toCelsius in src/index.js"]);
    const asked = guardVerification(decision, { checks: [old], tasks: [], userMessages: ["Fix the failing 'average of three' test."] });
    expect(asked.verified).toBe(false);
    expect(asked.missing).toEqual(decision.missing);
  });
});

describe("a fix-up task that only chases an old failure (run 19, rename-everywhere)", () => {
  it("is recognised from its title and instructions", () => {
    const old = ["FAIL average of three: Expected values to be strictly equal:"];
    const task = "Fix average test\n1. Update src/stats.js to correctly calculate the average of three numbers as (a + b + c) / 3. 2. Run npm test to ensure the 'average of three' test passes";
    expect(aboutOldFailures([task], old)).toHaveLength(1);
    expect(aboutOldFailures(["Update index.js import\nRename toCelsius in src/index.js and keep console.log as it was."], old)).toEqual([]);
  });
});

import { verifySchema } from "../src/coordinator/verify";

describe("each part of the request is checked against a line that shows it (run 19)", () => {
  const user = ["Create src/format.js with formatTemp(celsius) that returns the number with one decimal followed by ' °C'. Use it in src/index.js to print the target."];
  const parts = [
    { asked: "src/format.js with formatTemp(celsius)", found: "+ function formatTemp(celsius) {", met: true },
    { asked: "use it in src/index.js to print the target", found: "+ console.log(formatTemp(212));", met: false },
  ];

  it("turns 'done' with an unmet part into not done, naming the part", () => {
    const v = guardVerification({ verdict: "done", verified: "Both files are there.", missing: [], parts }, { checks: [], tasks: [], userMessages: user });
    expect(v.verified).toBe(false);
    expect(v.missing).toEqual(["Not as asked: use it in src/index.js to print the target (the drafts have: + console.log(formatTemp(212));)."]);
    expect(v.adjusted).toMatch(/marked a part of your request as not met/);
  });

  it("uses the unmet parts when 'not_done' names nothing to do", () => {
    const v = guardVerification({ verdict: "not_done", verified: "The list is short.", missing: [], parts: [{ asked: "list each mode with its target temperature", found: "", met: false }] }, { checks: [], tasks: [], userMessages: ["Add a section called 'Modes' to README.md that lists each mode with its target temperature."] });
    expect(v.manualReview).toBeUndefined();
    expect(v.missing).toEqual(["Not as asked: list each mode with its target temperature (nothing in the drafts shows it)."]);
  });

  it("leaves a verdict with all parts met, or with no parts, as it was", () => {
    expect(guardVerification({ verdict: "done", verified: "ok", missing: [], parts: [parts[0]!] }, { checks: [], tasks: [], userMessages: user }).verified).toBe(true);
    expect(guardVerification({ verdict: "done", verified: "ok", missing: [] }, { checks: [], tasks: [], userMessages: user }).verified).toBe(true);
    // A model that leaves the field out still gives a valid decision.
    expect(verifySchema.parse({ verdict: "done", verified: "ok" }).parts).toEqual([]);
  });

  it("does not count an unmet part about a failure from before the request", () => {
    const old = { name: "tests", passed: false, output: "FAIL average of three: 30 !== 20", failedBefore: "before" as const };
    const v = guardVerification({ verdict: "done", verified: "ok", missing: [], parts: [{ asked: "the 'average of three' test passes", found: "", met: false }] }, { checks: [old], tasks: [], userMessages: ["Rename toCelsius everywhere."] });
    expect(v.verified).toBe(true);
  });
});

import { notInDrafts } from "../src/coordinator/verify";

describe("run 20: what the parts list got wrong, each with its rule", () => {
  const drafts = "## src/stats.js\n- return sum / 2;\n+ if (readings.length === 0) return 0;\n+ return sum / readings.length;\n\n## test.js\n+ \n\nThe whole file with the change:\nconst assert = require('assert');";
  const fix = { asked: "Fix average() in src/stats.js", found: "+   if (readings.length === 0) {...return sum / readings.length;", met: true };
  const test = { asked: "add a test to test.js that average([]) returns 0", found: "+  'average of empty array': () => assert.strictEqual(average([]), 0),", met: true };

  it("finds a quoted added line that is not in the drafts", () => {
    expect(notInDrafts(test.found, drafts)).toHaveLength(1);
    expect(notInDrafts(test.found, drafts)[0]).toContain("'average of empty array': () => assert.strictEqual(average([]");
    expect(notInDrafts(fix.found, drafts)).toEqual([]);
    // A removed line does not count as being there; a quote without "+" and cut drafts are not judged.
    expect(notInDrafts("+ return sum / 2;", drafts)).toEqual(["return sum / 2"]);
    expect(notInDrafts("README.md already has the section", drafts)).toEqual([]);
    expect(notInDrafts(test.found, `${drafts}\n[… cut, 900 more characters]`)).toEqual([]);
    expect(notInDrafts(test.found, "")).toEqual([]);
  });

  it("turns 'done' into not done when a met part quotes a line that is not in the drafts (fix-and-add-test)", () => {
    const v = guardVerification({ verdict: "done", verified: "Both are there.", missing: [], parts: [fix, test] }, { checks: [], tasks: [], drafts, userMessages: ["Fix average() in src/stats.js and add a test to test.js that average([]) returns 0."] });
    expect(v.verified).toBe(false);
    expect(v.missing).toHaveLength(1);
    expect(v.missing[0]).toMatch(/^Not as asked: add a test to test\.js that average\(\[\]\) returns 0 \(the line quoted for it is not in the drafts/);
  });

  const old = { name: "tests", passed: false, output: "FAIL average of three: 30 !== 20\n4 passed, 1 failed", failedBefore: "before" as const };
  const renamed = { asked: "Rename toCelsius to fahrenheitToCelsius everywhere", found: "+ function fahrenheitToCelsius(f) {", met: true };
  const renameDrafts = "## src/convert.js\n- function toCelsius(f) {\n+ function fahrenheitToCelsius(f) {";
  const said = ["Rename toCelsius to fahrenheitToCelsius in src/convert.js and everywhere it is used, then run the tests to check nothing broke."];

  it("does not count 'run the tests' as unmet when the only failure was there before (rename-then-run-tests)", () => {
    const ran = { asked: "run the tests to check nothing broke", found: "Tests: 4 passed, 1 failed", met: false };
    const v = guardVerification({ verdict: "not_done", verified: "Renamed.", missing: ["Fix the 'average of three' test failure in src/stats.js"], parts: [renamed, ran] }, { checks: [old], tasks: [], drafts: renameDrafts, userMessages: said });
    expect(v.verified).toBe(true);
    expect(v.missing).toEqual([]);
    // With a new failure, the same part is missing work.
    const broke = { name: "tests", passed: false, output: "FAIL freezing point: toCelsius is not a function", failedBefore: "new" as const, newFailures: ["FAIL freezing point: toCelsius is not a function"] };
    expect(guardVerification({ verdict: "done", verified: "Renamed.", missing: [], parts: [renamed, ran] }, { checks: [broke], tasks: [], drafts: renameDrafts, userMessages: said }).verified).toBe(false);
  });

  it("does not let a review that did not accept overrule a request whose every part is shown (rename-everywhere)", () => {
    const tasks = [{ title: "Fix test.js reference", status: "done", summary: "test.js already uses the new name.", notAccepted: "Your report says test.js was updated but no drafts show any changes" }];
    const v = guardVerification({ verdict: "done", verified: "All three files use the new name.", missing: [], parts: [renamed] }, { checks: [old], tasks, drafts: renameDrafts, userMessages: said });
    expect(v.verified).toBe(true);
    expect(v.summary).toMatch(/A review did not accept the drafts of "Fix test\.js reference", but every part of your request is shown/);
    // Without parts, or with an unmet part, the review still counts (run 6D).
    expect(guardVerification({ verdict: "done", verified: "ok", missing: [] }, { checks: [], tasks, drafts: renameDrafts, userMessages: said }).verified).toBe(false);
    expect(guardVerification({ verdict: "done", verified: "ok", missing: [], parts: [{ ...renamed, met: false }] }, { checks: [], tasks, drafts: renameDrafts, userMessages: said }).verified).toBe(false);
  });
});

describe("run 21: a correct quote written on one line is not called missing (readme-section)", () => {
  const drafts = "## README.md\n+ ## Modes\n+ \n+ - Night mode: 18°C\n+ - Default mode: 21°C\n";

  it("reads a written-out \\n as a line break", () => {
    expect(notInDrafts("+ ## Modes\\n+ - Night mode: 18°C\\n+ - Default mode: 21°C", drafts)).toEqual([]);
    expect(notInDrafts("\"+ ## Modes\\n+ - Night mode: 18°C\"", drafts)).toEqual([]);
    expect(notInDrafts("+ ## Modes\\n+ - Night mode: 19°C", drafts)).toEqual(["- Night mode: 19°C"]);
  });

  it("accepts lines joined with ' + ' when each one is in the drafts", () => {
    expect(notInDrafts("+ ## Modes + - Night mode: 18°C + - Default mode: 21°C", drafts)).toEqual([]);
    expect(notInDrafts("+ ## Modes + - Night mode: 19°C + - Default mode: 21°C", drafts)).toHaveLength(1);
  });

  it("still turns 'done' into not done for a line that is nowhere in the drafts", () => {
    const v = guardVerification({ verdict: "done", verified: "ok", missing: [], parts: [{ asked: "Add a Modes section", found: "+ ## Modes\\n+ - Eco mode: 16°C", met: true }] }, { checks: [], tasks: [], drafts, userMessages: ["Add a Modes section to README.md"] });
    expect(v.verified).toBe(false);
  });
});

import { namesFile } from "../src/chat/coordinatorChat";

describe("run 22: an edit request in a named file is not answered with a request for details and no question", () => {
  const turn = (reply: string, goal: "answer" | "change" | undefined = "answer") => ({ reply, action: "none" as const, request: "", goal, complete: true });
  const ctx = (userText: string) => ({ userText, afterResearch: false, canResearch: true });

  it("plans the change, so a sub-agent reads the file (typo-please-correct)", () => {
    const out = routeTurn(turn("Please provide the specific misspelled word you'd like to correct in README.md."), ctx("Please correct the misspelled word in README.md."));
    expect(out.action).toBe("plan");
    expect(out.goal).toBe("change");
    expect(out.request).toContain("Please correct the misspelled word in README.md.");
    expect(out.overridden).toBeTruthy();
  });

  it("leaves a real question, a request with no file, and a question from the user alone", () => {
    expect(routeTurn(turn("Which word do you mean?"), ctx("Please correct the misspelled word in README.md.")).action).toBe("none");
    expect(routeTurn(turn("Tell me by how much."), ctx("Change how much the night mode lowers the target.")).action).toBe("none");
    expect(routeTurn(turn("It divides by 2."), ctx("What does src/stats.js do?")).action).toBe("none");
    expect(namesFile("Rätta stavfelet i README.md.")).toBe(true);
    expect(namesFile("Fix average() in src/stats.js")).toBe(true);
    expect(namesFile("Make it 4 degrees instead of 3.")).toBe(false);
    expect(namesFile("Lower it by 0.5 degrees, e.g. at night.")).toBe(false);
  });
});

import { filesNotToChange, isKept } from "../src/context/userRules";
import { checkToolCall } from "../src/tools/policy";

describe("run 24: a file the user said not to change cannot be drafted (impossible-constraint)", () => {
  const said = "Make every test in `node test.js` pass, but do not change src/stats.js or test.js.";

  it("reads the files from the user's own words", () => {
    expect(filesNotToChange(said).sort()).toEqual(["src/stats.js", "test.js"]);
    expect(filesNotToChange("Fix average() in src/stats.js. Don't touch the tests in test.js!")).toEqual(["test.js"]);
    expect(filesNotToChange("Rename toCelsius everywhere without changing README.md")).toEqual(["README.md"]);
    expect(filesNotToChange("Fixa testerna, men ändra inte src/stats.js.")).toEqual(["src/stats.js"]);
    // The file a request is about, and a rule about something else, are not kept files.
    expect(filesNotToChange("Change src/stats.js so the tests pass.")).toEqual([]);
    expect(filesNotToChange("Add toKelvin to src/convert.js. Do not change the behaviour.")).toEqual([]);
    expect(filesNotToChange("Update README.md. The API must not change. Then fix src/a.js")).toEqual([]);
  });

  it("refuses the write, also to a bare name in another folder, and leaves other files alone", () => {
    const keep = filesNotToChange(said);
    const ctx = { fileScope: ["**"], allowedChecks: [], keep };
    const denied = checkToolCall({ tool: "replace_in_file", path: "src/stats.js", search: "a", replace: "b" }, ctx);
    expect(denied.verdict).toBe("deny");
    expect(denied.verdict === "deny" && denied.reason).toMatch(/user said not to change 'src\/stats\.js'/);
    expect(checkToolCall({ tool: "write_file", path: "./test.js", content: "x" }, ctx).verdict).toBe("deny");
    expect(checkToolCall({ tool: "write_file", path: "src/convert.js", content: "x" }, ctx).verdict).toBe("allow");
    expect(checkToolCall({ tool: "read_file", path: "src/stats.js" }, ctx).verdict).toBe("allow");
    expect(isKept("lib/test.js", ["test.js"])).toBe(true);
    expect(isKept("src/stats.json", ["src/stats.js"])).toBe(false);
  });
});
