import { describe, expect, it } from "vitest";
import { buildSynthesisMessages, cleanAnswer, synthesizeFindings } from "../src/chat/synthesis";
import { ModelProvider } from "../src/providers/types";

const reports = [
  { title: "Structure", status: "done", text: "A Flask app in app.py." },
  { title: "Dead code", status: "done", text: "old_handler() in app.py is never called." },
];

function replying(content: string | Error, contextWindow = 32768): ModelProvider {
  return {
    model: "test",
    contextWindow,
    async chat() {
      if (content instanceof Error) throw content;
      return { content };
    },
  };
}

describe("combining research reports into one answer", () => {
  it("returns the model's plain-text answer, without its thinking", async () => {
    const r = await synthesizeFindings(replying("<think>Both reports matter.</think>It is a Flask app; old_handler() is dead code."), { question: "Find dead code", reports });
    expect(r).toEqual({ text: "It is a Flask app; old_handler() is dead code.", thinking: "Both reports matter.", fallback: false });
  });

  it("takes the reply field when a small model answers in JSON anyway", () => {
    expect(cleanAnswer('{"reply":"It is a Flask app with dead code in app.py.","action":"none"}')).toBe("It is a Flask app with dead code in app.py.");
  });

  it("shows every report when the model fails or says almost nothing", async () => {
    const errors: string[] = [];
    for (const provider of [replying(new Error("connection refused")), replying("Done.")]) {
      const r = await synthesizeFindings(provider, { question: "Find dead code", reports, draft: "Research complete." }, { onError: (m) => errors.push(m) });
      expect(r.fallback).toBe(true);
      expect(r.text).toMatch(/^Research complete\.\n\nWhat the sub-agents found:\n- Structure \(done\): A Flask app[\s\S]*old_handler/);
    }
    expect(errors).toHaveLength(2);
  });

  it("passes a stop on instead of answering", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(synthesizeFindings(replying(new Error("aborted")), { question: "q", reports }, { signal: abort.signal })).rejects.toThrow();
  });

  it("shares a small context window evenly, so no report is left out", () => {
    const long = Array.from({ length: 8 }, (_, i) => ({ title: `File ${i}`, status: "done", text: `Finding ${i}. `.repeat(800) }));
    const prompt = buildSynthesisMessages({ question: "Review every file", reports: long }, 8192).map((m) => m.content).join("\n");
    for (let i = 0; i < 8; i++) expect(prompt).toContain(`Report ${i + 1}: File ${i}`);
    expect(prompt.length / 3.5).toBeLessThan(8192);
  });
});
