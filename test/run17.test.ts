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

  it("sends read-only sub-agents to the files instead of the same question", () => {
    const out = routeTurn(again, { userText: "Yes, please go ahead.", afterResearch: false, canResearch: true, asked: askedBefore(entries) });
    expect(out.action).toBe("research");
    expect(out.questions?.[0]).toMatch(/^Please correct the misspelled word in README\.md\./);
    expect(out.reply).toMatch(/already asked/);
    // Small differences in punctuation and case are the same question.
    expect(routeTurn({ ...again, reply: "which word in README.md would you like corrected ?" }, { userText: "go", afterResearch: false, canResearch: true, asked: askedBefore(entries) }).action).toBe("research");
  });

  it("leaves a first question, a different question, and a question after research alone", () => {
    expect(routeTurn(again, { userText: "Please correct the misspelled word in README.md.", afterResearch: false, canResearch: true })).toBe(again);
    const other = { ...again, reply: "Should I also fix the heading?" };
    expect(routeTurn(other, { userText: "Yes, please go ahead.", afterResearch: false, canResearch: true, asked: askedBefore(entries) })).toBe(other);
    expect(routeTurn(again, { userText: "Yes, please go ahead.", afterResearch: true, canResearch: true, asked: askedBefore(entries) }).action).toBe("none");
  });
});
