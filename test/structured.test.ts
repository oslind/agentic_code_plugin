import { describe, expect, it } from "vitest";
import { z } from "zod";
import { callStructured, extractJson, StructuredOutputError } from "../src/llm/structured";
import { ChatRequest, ModelProvider } from "../src/providers/types";

function scripted(replies: string[]): ModelProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    model: "test",
    contextWindow: 8192,
    requests,
    async chat(req) {
      requests.push({ ...req, messages: [...req.messages] });
      const content = replies.shift();
      if (content === undefined) throw new Error("no more replies");
      return { content };
    },
  };
}

describe("extractJson", () => {
  it("parses plain JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("strips qwen-style think blocks", () => {
    expect(extractJson('<think>let me see {nope}</think>\n{"a":1}')).toEqual({ a: 1 });
  });
  it("reads JSON inside a code fence", () => {
    expect(extractJson('Here you go:\n```json\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] });
  });
  it("finds JSON surrounded by prose", () => {
    expect(extractJson('Sure! {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });
  it("rejects a reply cut off while thinking", () => {
    expect(() => extractJson("<think>still going")).toThrow(/think/);
  });
  it("rejects a reply with no JSON", () => {
    expect(() => extractJson("no idea")).toThrow(/No JSON/);
  });
});

describe("callStructured", () => {
  const schema = z.object({ files: z.array(z.string()).min(1) });

  it("returns the first valid reply and sends the schema", async () => {
    const p = scripted(['{"files":["a.ts"]}']);
    const out = await callStructured({ provider: p, messages: [{ role: "user", content: "go" }], schema, schemaName: "x" });
    expect(out).toEqual({ files: ["a.ts"] });
    expect(p.requests[0]?.jsonSchema?.schema).toMatchObject({ type: "object" });
  });

  it("feeds the validation error back and retries", async () => {
    const p = scripted(['{"files":[]}', '{"files":["b.ts"]}']);
    const out = await callStructured({ provider: p, messages: [{ role: "user", content: "go" }], schema, schemaName: "x" });
    expect(out).toEqual({ files: ["b.ts"] });
    const retry = p.requests[1]!.messages;
    expect(retry.at(-1)?.role).toBe("user");
    expect(retry.at(-1)?.content).toMatch(/not valid/);
  });

  it("gives up after maxRetries", async () => {
    const p = scripted(["nope", "still nope"]);
    await expect(
      callStructured({ provider: p, messages: [], schema, schemaName: "x", maxRetries: 1 }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
  });
});
