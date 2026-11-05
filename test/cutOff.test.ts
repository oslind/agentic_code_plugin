import { describe, expect, it } from "vitest";
import { z } from "zod";
import { routeTurn } from "../src/chat/coordinatorChat";
import { cutOffOf, describeCutOff, summarizeRun, synthesizeFindings } from "../src/chat/synthesis";
import { callStructured } from "../src/llm/structured";
import { endsInLeadIn, replyReserve } from "../src/llm/unfinished";
import { cutOff, OpenAICompatibleConfig, OpenAICompatibleProvider } from "../src/providers/openaiCompatible";
import { ChatResponse, ModelProvider } from "../src/providers/types";

// Oskar's report (2026-11-05): the coordinator's reply read "Yes, the implementation is now complete!
// Here's what was changed:" and then nothing. A reply that stops partway must never look finished.

const base: OpenAICompatibleConfig = { baseUrl: "http://localhost:11434/v1/", model: "qwen3:8b", contextWindow: 32768, temperature: 0.2, requestTimeoutMs: 1000, structuredOutput: "none" };

function sse(events: unknown[]): Response {
  const text = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const fetching = (res: () => Response) => (async () => res()) as unknown as typeof fetch;

function replying(...replies: (string | ChatResponse)[]): ModelProvider {
  return {
    model: "test",
    contextWindow: 32768,
    async chat() {
      const r = replies.shift() ?? "";
      return typeof r === "string" ? { content: r } : r;
    },
  };
}

describe("a reply stopped at the length limit", () => {
  it("is marked truncated when the stream ends with finish_reason length", async () => {
    const p = new OpenAICompatibleProvider(base, fetching(() => sse([{ choices: [{ delta: { content: "Yes, it is complete! Here's what was changed:" } }] }, { choices: [{ delta: {}, finish_reason: "length" }] }, "[DONE]"])));
    const res = await p.chat({ messages: [{ role: "user", content: "done?" }] });
    expect(res).toMatchObject({ content: "Yes, it is complete! Here's what was changed:", truncated: true });
  });

  it("is not marked when the model stopped on its own", async () => {
    const p = new OpenAICompatibleProvider(base, fetching(() => sse([{ choices: [{ delta: { content: "All done." } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"])));
    expect((await p.chat({ messages: [] })).truncated).toBeUndefined();
  });

  it("is marked in a reply that is not streamed too", async () => {
    const p = new OpenAICompatibleProvider(base, fetching(() => new Response(JSON.stringify({ choices: [{ message: { content: "Here is" }, finish_reason: "length" }] }), { status: 200 })));
    expect(await p.chat({ messages: [] })).toMatchObject({ content: "Here is", truncated: true });
  });

  it("that spent the whole limit thinking fails with a clear message, and is not retried", async () => {
    const p = new OpenAICompatibleProvider(base, fetching(() => sse([{ choices: [{ delta: { reasoning: "Let me think about every file…" } }] }, { choices: [{ delta: {}, finish_reason: "length" }] }, "[DONE]"])));
    const err = await p.chat({ messages: [] }).catch((e) => e);
    expect(err.message).toMatch(/reply length limit before it wrote any answer \(it spent the limit thinking\)[\s\S]*agentic\.model\.maxOutputTokens/);
    expect(err.retryable).toBe(false);
  });

  it("knows the finish reasons servers use for a length stop", () => {
    for (const r of ["length", "max_tokens", "MAX_OUTPUT_TOKENS"]) expect(cutOff(r)).toBe(true);
    for (const r of ["stop", "tool_calls", "", null, undefined]) expect(cutOff(r)).toBe(false);
  });

  it("is never used as JSON, even when what arrived parses, and the retry says why", async () => {
    const schema = z.object({ reply: z.string() });
    const sent: string[] = [];
    const provider: ModelProvider = {
      model: "t",
      contextWindow: 8192,
      async chat(req) {
        sent.push(req.messages.at(-1)!.content);
        return sent.length === 1 ? { content: '{"reply":"Here\'s what was changed:"}', truncated: true } : { content: '{"reply":"Two files changed: a.ts and b.ts."}' };
      },
    };
    const out = await callStructured({ provider, messages: [{ role: "user", content: "x" }], schema, schemaName: "t" });
    expect(out.reply).toBe("Two files changed: a.ts and b.ts.");
    expect(sent[1]).toMatch(/cut off at the length limit/);
  });
});

describe("telling an unfinished reply by its shape", () => {
  it("catches a lead-in with nothing after it", () => {
    expect(endsInLeadIn("Yes, the implementation is now complete! Here's what was changed:")).toBe(true);
    expect(endsInLeadIn("Here's what was changed:\n\n\n\n")).toBe(true);
    expect(endsInLeadIn("Changes：")).toBe(true);
    expect(endsInLeadIn("The changes:\n- a.ts\n-")).toBe(true);
    expect(endsInLeadIn("The changes:\n1.")).toBe(true);
  });

  it("leaves finished replies alone", () => {
    expect(endsInLeadIn("Here's what was changed:\n- src/a.ts: added the toggle")).toBe(false);
    expect(endsInLeadIn("Which file should I change: a.ts or b.ts?")).toBe(false);
    expect(endsInLeadIn("Done. See https://example.com")).toBe(false);
    expect(endsInLeadIn("")).toBe(false);
  });

  it("keeps a quarter of the context free for the reply, between 2048 and 8192 tokens", () => {
    expect(replyReserve(32768)).toBe(8192);
    expect(replyReserve(16384)).toBe(4096);
    expect(replyReserve(4096)).toBe(2048);
    expect(replyReserve(131072)).toBe(8192);
    expect(replyReserve(4096, 1024)).toBe(1024);
  });
});

describe("plain-text answers that stop partway", () => {
  const reports = [{ title: "Status", status: "done", text: "src/a.ts and src/b.ts were changed; the tests pass." }];

  it("research answers say why they are unfinished", async () => {
    const cut = await synthesizeFindings(replying({ content: "Yes, the implementation is complete. The changes are in src/a.ts and", truncated: true }), { question: "done?", reports });
    expect(cut).toMatchObject({ fallback: false, cutOff: "length" });
    const lead = await synthesizeFindings(replying("Yes, the implementation is now complete! Here's what was changed:\n\n\n"), { question: "done?", reports });
    expect(lead.cutOff).toBe("lead-in");
    const whole = await synthesizeFindings(replying("Yes, it is complete.\n- src/a.ts and src/b.ts were changed"), { question: "done?", reports });
    expect(whole.cutOff).toBeUndefined();
  });

  it("an answer cut off before it said anything shows the reports instead", async () => {
    const errors: string[] = [];
    const r = await synthesizeFindings(replying({ content: "<think>Let me go through", truncated: true }), { question: "done?", reports }, { onError: (m) => errors.push(m) });
    expect(r.fallback).toBe(true);
    expect(r.text).toMatch(/src\/a\.ts and src\/b\.ts were changed/);
    expect(errors.join("\n")).toMatch(/length limit/);
  });

  it("the final reply of a run says when it is unfinished", async () => {
    const input = { question: "add users", request: "Add users.", tasks: [{ title: "Add model", status: "done", text: "Drafted src/model.ts.", files: ["src/model.ts"] }], drafts: { pending: ["src/model.ts"], accepted: [], rejected: [] } };
    expect((await summarizeRun(replying({ content: "The model was drafted in src/model.ts, and", truncated: true }), input))?.cutOff).toBe("length");
    expect((await summarizeRun(replying("The users feature is drafted. Here's what was changed:"), input))?.cutOff).toBe("lead-in");
    expect((await summarizeRun(replying("The users feature is drafted in src/model.ts. Review it under Changes."), input))?.cutOff).toBeUndefined();
  });

  it("names the cause and what helps", () => {
    expect(cutOffOf({ truncated: true }, "anything")).toBe("length");
    expect(describeCutOff("length", "The answer below")).toMatch(/^The answer below was cut off[\s\S]*not a complete answer[\s\S]*maxOutputTokens/);
    expect(describeCutOff("lead-in", "The answer below")).toMatch(/not a complete answer/);
  });
});

describe("the coordinator's JSON reply that announces more and stops", () => {
  const dangling = { thought: "Let me summarize what was done:", reply: "Yes, the implementation is now complete! Here's what was changed:\n\n\n", action: "none" as const, goal: "answer" as const, complete: true, request: "" };

  it("is not shown as the answer: read-only sub-agents check, and the answer is written from their reports", () => {
    const out = routeTurn(dangling, { userText: "Is the implementation complete now? what has to be changed?", afterResearch: false, canResearch: true });
    expect(out.action).toBe("research");
    expect(out.questions).toEqual(["Is the implementation complete now? what has to be changed?"]);
    expect(out.reply).not.toMatch(/Here's what was changed/);
    expect(out.reply).toMatch(/stopped before it was complete/);
  });

  it("for a change, becomes a plan from the user's own words", () => {
    const out = routeTurn({ ...dangling, goal: "change", reply: "I'll make these changes:" }, { userText: "Add a dark mode toggle", afterResearch: false, canResearch: true });
    expect(out).toMatchObject({ action: "plan", request: "Add a dark mode toggle" });
  });

  it("after research stays a draft, since the answer is written from the reports anyway", () => {
    const out = routeTurn(dangling, { userText: "done?", afterResearch: true, canResearch: true });
    expect(out).toBe(dangling);
  });

  it("leaves a finished reply alone", () => {
    const done = { ...dangling, reply: "Yes, it is complete: src/a.ts and src/b.ts were changed." };
    expect(routeTurn(done, { userText: "done?", afterResearch: false, canResearch: true })).toBe(done);
  });
});
