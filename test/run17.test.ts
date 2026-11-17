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
