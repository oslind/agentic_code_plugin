import { describe, expect, it } from "vitest";
import { LiveTracker, liveTail } from "../src/chat/live";
import { ChatProgress, ChatRequest, ChatResponse, ModelProvider } from "../src/providers/types";

/** A provider that streams the given progress steps, waiting for `step()` between them. */
function streaming(steps: ChatProgress[]) {
  const gates: (() => void)[] = [];
  const provider: ModelProvider = {
    model: "m",
    contextWindow: 1000,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      for (const p of steps) {
        req.onProgress?.(p);
        await new Promise<void>((r) => gates.push(r));
      }
      return { content: "done" };
    },
  };
  return { provider, step: () => gates.shift()?.() };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("live model output", () => {
  it("shows each request's phase, token count and latest thought under its agent, then clears it", async () => {
    let t = 1000;
    const live = new LiveTracker(0, () => t);
    let changes = 0;
    live.onChange(() => changes++);
    const { provider, step } = streaming([
      { phase: "waiting", reasoning: "", content: "" },
      { phase: "thinking", reasoning: "The user wants a toggle. I should look at settings.ts first.", content: "" },
      { phase: "writing", reasoning: "The user wants a toggle.", content: '{"reply":"On it"' },
    ]);
    const seen: ChatProgress[] = [];
    const call = live.wrap(provider, "run1:task1").chat({ messages: [], onProgress: (p) => seen.push(p) });
    await tick();
    expect(live.snapshot()["run1:task1"]).toMatchObject({ phase: "waiting", startedAt: 1000, tokens: 0, tail: "", calls: 1 });
    t = 4000;
    step();
    await tick();
    expect(live.snapshot()["run1:task1"]).toMatchObject({ phase: "thinking", updatedAt: 4000, tail: "The user wants a toggle. I should look at settings.ts first." });
    expect(live.snapshot()["run1:task1"]!.tokens).toBeGreaterThan(10);
    step();
    await tick();
    expect(live.snapshot()["run1:task1"]).toMatchObject({ phase: "writing", tail: '{"reply":"On it"' });
    step();
    await call;
    expect(live.snapshot()).toEqual({});
    // The caller's own listener still hears everything.
    expect(seen.map((p) => p.phase)).toEqual(["waiting", "thinking", "writing"]);
    expect(changes).toBeGreaterThanOrEqual(4);
  });

  it("clears the item when the request fails", async () => {
    const live = new LiveTracker(0);
    const failing: ModelProvider = { model: "m", contextWindow: 1, chat: async () => Promise.reject(new Error("down")) };
    await expect(live.wrap(failing, "coordinator").chat({ messages: [] })).rejects.toThrow("down");
    expect(live.snapshot()).toEqual({});
  });

  it("throttles updates while tokens stream, but always sends the last one", async () => {
    let t = 0;
    const live = new LiveTracker(250, () => t);
    let changes = 0;
    live.onChange(() => changes++);
    const { provider, step } = streaming(Array.from({ length: 20 }, (_, i) => ({ phase: "writing" as const, reasoning: "", content: "x".repeat(i + 1) })));
    const call = live.wrap(provider, "coordinator").chat({ messages: [] });
    for (let i = 0; i < 20; i++) {
      await tick();
      t += 10;
      step();
    }
    await tick();
    // Start + the phase change, then far fewer than one per token.
    expect(changes).toBeLessThan(6);
    await new Promise((r) => setTimeout(r, 300));
    await call;
    expect(live.snapshot()).toEqual({});
    live.dispose();
  });

  it("shows the end of the thinking, from the reasoning field or an open <think> block, without the tags", () => {
    expect(liveTail({ phase: "thinking", reasoning: "", content: "<think>Check the tests first" })).toBe("Check the tests first");
    expect(liveTail({ phase: "writing", reasoning: "", content: "<think>hmm</think>\nThe answer" })).toBe("The answer");
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const tail = liveTail({ phase: "thinking", reasoning: long, content: "" }, 100);
    expect(tail.startsWith("…line")).toBe(true);
    expect(tail.endsWith("line 199")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(101);
  });
});
