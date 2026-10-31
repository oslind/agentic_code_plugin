import { beforeEach, describe, expect, it } from "vitest";
import { OpenAICompatibleConfig, OpenAICompatibleProvider, ProviderError } from "../src/providers/openaiCompatible";

const base: OpenAICompatibleConfig = {
  baseUrl: "http://localhost:11434/v1/",
  model: "qwen3.8:27b",
  contextWindow: 32768,
  temperature: 0.2,
  requestTimeoutMs: 1000,
  structuredOutput: "json_schema",
};

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("OpenAICompatibleProvider", () => {
  beforeEach(() => OpenAICompatibleProvider.resetFallbacks());

  it("falls back to json_object, then no format, when the server cannot do structured output", async () => {
    const bodies: Record<string, unknown>[] = [];
    const replies = [
      new Response(JSON.stringify({ error: { message: "failed to load model vocabulary required for format" } }), { status: 500 }),
      new Response("response_format json_object not supported", { status: 400 }),
      new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }),
    ];
    const fn = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return replies.shift()!;
    }) as unknown as typeof fetch;
    const fallbacks: string[] = [];
    const p = new OpenAICompatibleProvider(base, fn, (from, to) => fallbacks.push(`${from}->${to}`));
    const res = await p.chat({ messages: [], jsonSchema: { name: "s", schema: {} } });
    expect(res.content).toBe("{}");
    expect(bodies.map((b) => (b.response_format as { type?: string } | undefined)?.type ?? "none")).toEqual(["json_schema", "json_object", "none"]);
    expect(fallbacks).toEqual(["json_schema->json_object", "json_object->none"]);

    // Later providers for the same server and model skip straight to what works.
    const f = fakeFetch(200, { choices: [{ message: { content: "{}" } }] });
    await new OpenAICompatibleProvider(base, f.fn).chat({ messages: [], jsonSchema: { name: "s", schema: {} } });
    expect(JSON.parse(f.calls[0]!.init.body as string).response_format).toBeUndefined();
  });

  it("does not fall back on errors unrelated to the format", async () => {
    const f = fakeFetch(503, "server overloaded");
    const err = await new OpenAICompatibleProvider(base, f.fn).chat({ messages: [], jsonSchema: { name: "s", schema: {} } }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(f.calls).toHaveLength(1);
  });

  it("posts to chat/completions with a json_schema response format", async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 3 } });
    const p = new OpenAICompatibleProvider(base, f.fn);
    const res = await p.chat({ messages: [{ role: "user", content: "x" }], jsonSchema: { name: "s", schema: { type: "object" } } });
    expect(res).toMatchObject({ content: "hi", promptTokens: 3 });
    expect(f.calls[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    const sent = JSON.parse(f.calls[0]!.init.body as string);
    expect(sent.response_format.type).toBe("json_schema");
    expect(sent.model).toBe("qwen3.8:27b");
  });

  it("falls back to json_object when configured", async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: "{}" } }] });
    const p = new OpenAICompatibleProvider({ ...base, structuredOutput: "json_object" }, f.fn);
    await p.chat({ messages: [], jsonSchema: { name: "s", schema: {} } });
    expect(JSON.parse(f.calls[0]!.init.body as string).response_format).toEqual({ type: "json_object" });
  });

  it("marks 5xx errors as retryable", async () => {
    const p = new OpenAICompatibleProvider(base, fakeFetch(503, "busy").fn);
    const err = await p.chat({ messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
  });

  it("names the model, server and setting source on a 404", async () => {
    const f = fakeFetch(404, { error: { message: "model 'qwen3.8:27b' not found" } });
    const p = new OpenAICompatibleProvider({ ...base, source: "agentic.model.name from Workspace settings" }, f.fn);
    const err = await p.chat({ messages: [{ role: "user", content: "x" }] }).catch((e) => e as ProviderError);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/"qwen3\.8:27b" was not found at http:\/\/localhost:11434\/v1/);
    expect(err.message).toMatch(/from Workspace settings/);
  });

  it("marks 4xx errors as not retryable", async () => {
    const p = new OpenAICompatibleProvider(base, fakeFetch(400, "bad").fn);
    const err = await p.chat({ messages: [] }).catch((e) => e);
    expect(err.retryable).toBe(false);
  });
});
