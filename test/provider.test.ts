import { beforeEach, describe, expect, it } from "vitest";
import {
  isTransientStreamError,
  Limiter,
  MAX_ERROR_BYTES,
  MAX_EVENT_CHARS,
  MAX_REPLY_CHARS,
  MAX_STREAM_BYTES,
  OpenAICompatibleConfig,
  OpenAICompatibleProvider,
  ProviderError,
  retryAfter,
} from "../src/providers/openaiCompatible";

const base: OpenAICompatibleConfig = {
  baseUrl: "http://localhost:11434/v1/",
  model: "qwen3.8:27b",
  contextWindow: 32768,
  temperature: 0.2,
  requestTimeoutMs: 1000,
  structuredOutput: "json_schema",
};

/** A reply streamed as server-sent events, split into small byte chunks to test line joining. */
function sse(events: unknown[], chunkSize = 7): Response {
  const text = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

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

  it("returns the server's separate reasoning field", async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: "{}", reasoning: "Think first." } }] });
    const res = await new OpenAICompatibleProvider(base, f.fn).chat({ messages: [] });
    expect(res.reasoning).toBe("Think first.");
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

  it("streams by default and joins content, reasoning and usage from the events", async () => {
    let sent: Record<string, unknown> = {};
    const fn = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return sse([
        { choices: [{ delta: { reasoning: "Think " } }] },
        { choices: [{ delta: { reasoning_content: "first." } }] },
        { choices: [{ delta: { content: '{"a":' } }] },
        { choices: [{ delta: { content: "1}" } }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } },
        "[DONE]",
      ]);
    }) as unknown as typeof fetch;
    const res = await new OpenAICompatibleProvider(base, fn).chat({ messages: [] });
    expect(sent.stream).toBe(true);
    expect(res).toEqual({ content: '{"a":1}', reasoning: "Think first.", promptTokens: 12, completionTokens: 5 });
  });

  it("reads a plain JSON reply from a server that ignores stream, and can turn streaming off", async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: "hi" } }] });
    expect((await new OpenAICompatibleProvider(base, f.fn).chat({ messages: [] })).content).toBe("hi");
    await new OpenAICompatibleProvider({ ...base, stream: false }, f.fn).chat({ messages: [] });
    const body = JSON.parse(f.calls[1]!.init.body as string);
    expect(body.stream).toBe(false);
    expect(body.stream_options).toBeUndefined();
  });

  it("fails a stream that carries an error or no content, retrying only temporary errors", async () => {
    const withError = (async () => sse([{ error: { message: "server overloaded, try again" } }])) as unknown as typeof fetch;
    const e1 = await new OpenAICompatibleProvider(base, withError).chat({ messages: [] }).catch((e) => e as ProviderError);
    expect(e1.message).toMatch(/overloaded/);
    expect(e1.retryable).toBe(true);
    const permanent = (async () => sse([{ error: { message: "prompt exceeds the context length", type: "invalid_request_error" } }])) as unknown as typeof fetch;
    const e3 = await new OpenAICompatibleProvider(base, permanent).chat({ messages: [] }).catch((e) => e as ProviderError);
    expect(e3.retryable).toBe(false);
    const empty = (async () => sse(["[DONE]"])) as unknown as typeof fetch;
    const e2 = await new OpenAICompatibleProvider(base, empty).chat({ messages: [] }).catch((e) => e as ProviderError);
    expect(e2.message).toMatch(/no message content/);
  });

  it("sends max_tokens from the setting, keeping a smaller per-request limit", async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: "{}" } }] });
    await new OpenAICompatibleProvider({ ...base, maxOutputTokens: 4000 }, f.fn).chat({ messages: [] });
    await new OpenAICompatibleProvider({ ...base, maxOutputTokens: 4000 }, f.fn).chat({ messages: [], maxTokens: 500 });
    await new OpenAICompatibleProvider(base, f.fn).chat({ messages: [] });
    expect(f.calls.map((c) => JSON.parse(c.init.body as string).max_tokens)).toEqual([4000, 500, undefined]);
  });

  it("explains a 504 and carries Retry-After", async () => {
    const fn = (async () => new Response("model server timed out", { status: 504, headers: { "retry-after": "3" } })) as unknown as typeof fetch;
    const err = await new OpenAICompatibleProvider(base, fn).chat({ messages: [] }).catch((e) => e as ProviderError);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(3000);
    expect(err.message).toMatch(/proxy or gateway/);
    expect(retryAfter("999")).toBe(120_000);
    expect(retryAfter("soon")).toBeUndefined();
  });

  it("reports its own timeout plainly and does not mark it retryable", async () => {
    const fn = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const err = await new OpenAICompatibleProvider({ ...base, requestTimeoutMs: 20 }, fn).chat({ messages: [] }).catch((e) => e as ProviderError);
    expect(err.message).toMatch(/sent nothing for/);
    expect(err.retryable).toBe(false);
  });

  it("sends one request at a time to a server by default", async () => {
    let active = 0;
    let peak = 0;
    const fn = (async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }) as unknown as typeof fetch;
    const cfg = { ...base, baseUrl: "http://queue-test:1/v1" };
    await Promise.all([1, 2, 3].map(() => new OpenAICompatibleProvider(cfg, fn).chat({ messages: [] })));
    expect(peak).toBe(1);
    peak = 0;
    await Promise.all([1, 2, 3, 4].map(() => new OpenAICompatibleProvider({ ...cfg, maxConcurrentRequests: 2 }, fn).chat({ messages: [] })));
    expect(peak).toBe(2);
  });
});

describe("Limiter", () => {
  it("drops a waiting caller that is cancelled", async () => {
    const l = new Limiter();
    const release = await l.acquire();
    const ac = new AbortController();
    const waiting = l.acquire(ac.signal);
    ac.abort();
    await expect(waiting).rejects.toThrow("Request cancelled");
    release();
    const next = await l.acquire();
    next();
  });
});

describe("stream errors and size limits", () => {
  it("retries only overload, rate limits and timeouts", () => {
    expect(isTransientStreamError({ code: 503, message: "x" })).toBe(true);
    expect(isTransientStreamError({ code: 429 })).toBe(true);
    expect(isTransientStreamError({ code: 600, message: "x" })).toBe(false);
    expect(isTransientStreamError({ code: 400, message: "timeout" })).toBe(false);
    expect(isTransientStreamError({ type: "rate_limit_error" })).toBe(true);
    expect(isTransientStreamError("request timed out")).toBe(true);
    expect(isTransientStreamError({ message: "model not found" })).toBe(false);
    expect(isTransientStreamError({ message: "context length exceeded" })).toBe(false);
  });

  /** A stream that keeps sending the given text until it is cancelled, and says whether it was. */
  function endless(piece: string) {
    const state = { cancelled: false };
    const bytes = new TextEncoder().encode(piece);
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(bytes);
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { state, response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }) };
  }

  it("stops a streamed reply that grows too large, and cancels the download", async () => {
    const event = `data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(100_000) } }] })}\n\n`;
    const { state, response } = endless(event);
    const err = await new OpenAICompatibleProvider(base, (async () => response) as unknown as typeof fetch).chat({ messages: [] }).catch((e) => e as ProviderError);
    expect(err.message).toMatch(/more than 4 million characters/);
    expect(err.retryable).toBe(false);
    expect(state.cancelled).toBe(true);
    expect(MAX_REPLY_CHARS).toBe(4_000_000);
  });

  it("stops one event that never ends", async () => {
    const { state, response } = endless("data: " + "y".repeat(64_000));
    const err = await new OpenAICompatibleProvider(base, (async () => response) as unknown as typeof fetch).chat({ messages: [] }).catch((e) => e as ProviderError);
    expect(err.message).toMatch(/one event longer than/);
    expect(state.cancelled).toBe(true);
    expect(MAX_EVENT_CHARS).toBe(1_000_000);
  });

  it("stops a plain reply that grows too large", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new TextEncoder().encode("z".repeat(500_000)));
      },
    });
    const fn = (async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const err = await new OpenAICompatibleProvider(base, fn).chat({ messages: [] }).catch((e) => e as ProviderError);
    expect(err.message).toMatch(/more than 4 million characters/);
  });

  it("counts everything the server sends, so endless heartbeats or comments are stopped", async () => {
    const { state, response } = endless(`: heartbeat ${"h".repeat(60_000)}\n\n`);
    const err = await new OpenAICompatibleProvider(base, (async () => response) as unknown as typeof fetch).chat({ messages: [] }).catch((e) => e as ProviderError);
    expect(err.message).toMatch(new RegExp(`more than ${MAX_STREAM_BYTES / 1_000_000} MB`));
    expect(err.retryable).toBe(false);
    expect(state.cancelled).toBe(true);
  });

  it("limits one event made of many lines, not only each line", async () => {
    const { state, response } = endless(`data: ${"d".repeat(10_000)}\n`);
    const err = await new OpenAICompatibleProvider(base, (async () => response) as unknown as typeof fetch).chat({ messages: [] }).catch((e) => e as ProviderError);
    expect(err.message).toMatch(/one event longer than/);
    expect(state.cancelled).toBe(true);
  });

  it("reads only the start of a huge error reply and stops the download", async () => {
    const state = { cancelled: false, sent: 0 };
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        state.sent += 16_000;
        c.enqueue(new TextEncoder().encode("e".repeat(16_000)));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    const fn = (async () => new Response(body, { status: 500 })) as unknown as typeof fetch;
    const err = await new OpenAICompatibleProvider(base, fn).chat({ messages: [] }).catch((e) => e as ProviderError);
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/^Model server returned 500: e+$/);
    expect(err.message.length).toBeLessThan(600);
    expect(state.cancelled).toBe(true);
    expect(state.sent).toBeLessThanOrEqual(MAX_ERROR_BYTES + 32_000);
  });
});

describe("request timeout", () => {
  /** A stream that sends one content event every `everyMs`, `count` times, then ends. */
  function slowStream(count: number, everyMs: number, silentAfter = Infinity) {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (sent >= count) return c.close();
        await new Promise((r) => setTimeout(r, sent >= silentAfter ? 10_000 : everyMs));
        sent++;
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`));
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  /** Passes the abort signal on to the body, as real fetch does. */
  function fetchWith(make: () => Response) {
    return (async (_url: string, init: RequestInit) => {
      const res = make();
      const reader = res.body!.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          const aborted = new Promise<never>((_r, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
          const { done, value } = await Promise.race([reader.read(), aborted]);
          if (done) c.close();
          else c.enqueue(value);
        },
      });
      return new Response(body, { status: res.status, headers: res.headers });
    }) as unknown as typeof fetch;
  }

  it("never cuts off a reply that keeps arriving, however long it takes in total", async () => {
    // 12 events, 20 ms apart: about 240 ms in total, with a 60 ms silence limit.
    const res = await new OpenAICompatibleProvider({ ...base, requestTimeoutMs: 60 }, fetchWith(() => slowStream(12, 20))).chat({ messages: [] });
    expect(res.content).toBe("x".repeat(12));
  });

  it("stops a reply when the server goes silent part way", async () => {
    const started = Date.now();
    const err = await new OpenAICompatibleProvider({ ...base, requestTimeoutMs: 60 }, fetchWith(() => slowStream(12, 10, 3)))
      .chat({ messages: [] })
      .catch((e) => e as ProviderError);
    expect(err.message).toMatch(/sent nothing for/);
    expect(err.retryable).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("has no limit when set to 0", async () => {
    const res = await new OpenAICompatibleProvider({ ...base, requestTimeoutMs: 0 }, fetchWith(() => slowStream(3, 30))).chat({ messages: [] });
    expect(res.content).toBe("xxx");
  });

  it("by default never stops: warns once when the server goes silent, and again when it answers", async () => {
    const events: { silentMs: number; resumed: boolean }[] = [];
    // Three events, then 150 ms of silence before the rest, with a 50 ms warning.
    let sent = 0;
    const make = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(c) {
            if (sent >= 6) return c.close();
            await new Promise((r) => setTimeout(r, sent === 3 ? 150 : 5));
            sent++;
            c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const p = new OpenAICompatibleProvider({ ...base, requestTimeoutMs: 0, silenceWarningMs: 50 }, fetchWith(make), undefined, (e) => events.push(e));
    const res = await p.chat({ messages: [] });
    expect(res.content).toBe("xxxxxx");
    expect(events.map((e) => e.resumed)).toEqual([false, true]);
    expect(events[0]!.silentMs).toBeGreaterThanOrEqual(45);
    expect(events[1]!.silentMs).toBeGreaterThanOrEqual(events[0]!.silentMs);
  });
});
