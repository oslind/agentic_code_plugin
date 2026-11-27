/** Fixes from runs 30 and 31 (2026-11-27). */
import { describe, expect, it } from "vitest";
import { ChatSession } from "../src/chat/session";
import { Verifier } from "../src/chat/verifier";
import { buildExpectationMessages, checkedExpectations, expectedOutput, quotesSomething, unmetExpectations } from "../src/coordinator/expectedOutput";
import { buildVerifyMessages, confirmedBy, guardVerification, stillUnknown, VerifyContext } from "../src/coordinator/verify";
import { ChatMessage, ModelProvider } from "../src/providers/types";

describe("an answer that says what it does not know (research-call-chain)", () => {
  it("reads the items under its own Still unknown heading", () => {
    expect(stillUnknown("targetTemp decides it.\n\nStill unknown: The exact value of `DEFAULT_TARGET` is not provided in the files referenced.")).toEqual(["The exact value of `DEFAULT_TARGET` is not provided in the files referenced."]);
    expect(stillUnknown("x\n\n**Still unknown:**\n- What DEFAULT_TARGET is\n- Which mode is the default\n\nThanks")).toEqual(["What DEFAULT_TARGET is", "Which mode is the default"]);
  });

  it("finds nothing when it says none, or has no such heading", () => {
    expect(stillUnknown("No spelling mistakes.\nStill unknown: None.")).toEqual([]);
    expect(stillUnknown("Still unknown: nothing")).toEqual([]);
    expect(stillUnknown("All found. Nothing is still unknown here.")).toEqual([]);
  });

  it("sends researchers after it although the answer check said it was answered", async () => {
    const session = {
      host: { log: () => undefined },
      tasks: {},
      conversations: {},
      verifierProvider: () => ({ model: "t", contextWindow: 8192, chat: async () => ({ content: JSON.stringify({ answered: "yes", missing: [] }) }) }),
    } as unknown as ChatSession;
    const v = new Verifier(session);
    const open = await v.checkResearchAnswer("/w", "What is printed?", "DEFAULT_TARGET - 3.\nStill unknown: the value of DEFAULT_TARGET.", new AbortController().signal);
    expect(open).toMatchObject({ answered: false, missing: ["the value of DEFAULT_TARGET."] });
    const done = await v.checkResearchAnswer("/w", "What is printed?", "18.\nStill unknown: None.", new AbortController().signal);
    expect(done).toMatchObject({ answered: true });
  });
});

describe("what the program must print, from the user's words (new-module-used)", () => {
  const WORDS = "Create src/format.js with formatTemp(celsius) that returns the number with one decimal followed by ' °C' (formatTemp(21) returns '21.0 °C'). Use it in src/index.js to print the target.";
  const RUNS = [{ line: "node src/index.js", before: "Target: 21 C (21.1 C is 70 F)", now: "Formatted Temp: 212.0 °C\nTarget: 21 C (21.1 C is 70 F)" }];
  const provider = (reply: unknown, seen?: ChatMessage[][]): ModelProvider => ({
    model: "t",
    contextWindow: 8192,
    chat: async (req) => (seen?.push(req.messages), { content: JSON.stringify(reply) }),
  });

  it("finds 212.0 °C does not show 21.0 °C, and accepts output that does", async () => {
    const seen: ChatMessage[][] = [];
    const found = await expectedOutput(provider({ expectations: [{ command: "node src/index.js", shows: "'21.0 °C'" }] }, seen), WORDS, RUNS);
    expect(found).toEqual([{ command: "node src/index.js", shows: "21.0 °C" }]);
    // The reader never sees the drafts or what the program printed with them.
    expect(seen[0]!.map((m) => m.content).join("\n")).not.toMatch(/212|Formatted/);
    expect(unmetExpectations(found, RUNS)).toHaveLength(1);
    expect(unmetExpectations(found, [{ ...RUNS[0]!, now: "Target: 21.0 °C" }])).toEqual([]);
  });

  it("drops text that is not in the user's words and commands that did not run", () => {
    expect(checkedExpectations([{ command: "node src/index.js", shows: "Target: 21.0 °C" }, { command: "node other.js", shows: "21.0 °C" }], WORDS, RUNS)).toEqual([]);
  });

  it("makes no call when the user's words quote nothing or no program ran", async () => {
    const seen: ChatMessage[][] = [];
    expect(await expectedOutput(provider({ expectations: [] }, seen), "Make night mode lower the target by 4 degrees instead of 3.", RUNS)).toEqual([]);
    expect(await expectedOutput(provider({ expectations: [] }, seen), WORDS, [])).toEqual([]);
    expect(seen).toHaveLength(0);
    expect(quotesSomething(WORDS)).toBe(true);
  });

  it("shows the output before the changes, fenced", () => {
    const [, user] = buildExpectationMessages(WORDS, RUNS);
    expect(user!.content).toMatch(/<untrusted_data[^>]*>[\s\S]*Output before the changes:\nTarget: 21 C/);
  });
});

describe("run 31: a rejected review is overruled only by parts shown in real text (fix-and-add-test)", () => {
  const drafts = "## src/stats.js\n+   if (readings.length === 0) {\n+     return 0;\n+   }";
  const tasks = [{ title: "Add average test", status: "done", summary: "The test was already present.", notAccepted: "No changes were made to files (no drafts)." }];
  const said = ["Fix average() in src/stats.js, and add a test to test.js that average([]) returns 0."];
  const fix = { asked: "Fix average() in src/stats.js", found: "+   if (readings.length === 0) {", met: true };

  it("sends the task back when a part's evidence is prose", () => {
    const prose = { asked: "add a test to test.js that average([]) returns 0", found: "The test for average([]) was already present in test.js and passes.", met: true };
    const v = guardVerification({ verdict: "done", verified: "ok", missing: [], parts: [fix, prose] }, { checks: [{ name: "tests", passed: true, output: "5 passed" }], tasks, drafts, userMessages: said });
    expect(v.verified).toBe(false);
    expect(v.missing[0]).toMatch(/Finish "Add average test": its review did not accept/);
  });

  it("still overrules it when every part quotes the drafts or an output", () => {
    const quoted = { asked: "add a test to test.js that average([]) returns 0", found: "ok   average of empty array", met: true };
    const v = guardVerification({ verdict: "done", verified: "ok", missing: [], parts: [fix, quoted] }, { checks: [{ name: "tests", passed: true, output: "ok   average of empty array\n5 passed" }], tasks, drafts, userMessages: said });
    expect(v.verified).toBe(true);
  });

  it("confirms a quote in backticks or as a +line, and not a sentence", () => {
    const real = confirmedBy(["const x = targetTemp('night');"]);
    expect(real("`targetTemp('night')` is called")).toBe(true);
    expect(real("+ const x = targetTemp('night');")).toBe(true);
    expect(real("It calls targetTemp for night mode.")).toBe(false);
  });
});

describe("run 31: the verifier is told when nothing a program prints changed (question-then-answer)", () => {
  it("says so when every run printed the same with and without the drafts", () => {
    const ctx = { userMessages: ["Make it 4 degrees instead of 3."], request: "x", round: 0, tasks: [], checks: [], programRuns: [{ line: "node src/index.js", before: "Target: 21 C", now: "Target: 21 C\n" }] } as unknown as VerifyContext;
    const text = buildVerifyMessages(ctx, 16384).map((m) => m.content).join("\n");
    expect(text).toMatch(/Checked by rule: with the drafts, `node src\/index\.js` printed exactly what it printed without them/);
    const changed = buildVerifyMessages({ ...ctx, programRuns: [{ line: "node src/index.js", before: "Target: 21 C", now: "Target: 17 C" }] }, 16384).map((m) => m.content).join("\n");
    expect(changed).not.toMatch(/printed exactly what/);
  });
});
