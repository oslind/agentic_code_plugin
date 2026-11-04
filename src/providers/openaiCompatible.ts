import { ChatRequest, ChatResponse, ModelProvider, StructuredOutputMode } from "./types";

export interface OpenAICompatibleConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  contextWindow: number;
  temperature: number;
  requestTimeoutMs: number;
  structuredOutput: StructuredOutputMode;
  /**
   * Ask the server to stream the reply. Bytes then arrive while the model
   * thinks and writes, so a proxy in front of the server does not give up on
   * a silent connection (the usual cause of a 504). Default true.
   */
  stream?: boolean;
  /** Most requests sent to this server at the same time. Others wait their turn. Default 1. */
  maxConcurrentRequests?: number;
  /** Longest reply, in tokens, sent as max_tokens. 0 or unset means no limit. */
  maxOutputTokens?: number;
  /** Where the model name came from, named in errors so a wrong setting is easy to find. */
  source?: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    /** True when the failed request asked for a response format. */
    readonly sentFormat = false,
    /** How long the server asked us to wait before trying again (Retry-After), in ms. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

type FetchFn = typeof fetch;

/**
 * Talks to any server that implements the OpenAI chat completions API.
 * Ollama, LM Studio, vLLM and llama.cpp all do.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly model: string;
  readonly contextWindow: number;

  constructor(
    private readonly config: OpenAICompatibleConfig,
    private readonly fetchFn: FetchFn = fetch,
    /** Called when the server rejects a structured output mode and a weaker one is used. */
    private readonly onFallback?: (from: StructuredOutputMode, to: StructuredOutputMode, error: string) => void,
  ) {
    this.model = config.model;
    this.contextWindow = config.contextWindow;
  }

  /** Structured output modes from strongest to none. A server that rejects one gets the next. */
  private static readonly FALLBACK: StructuredOutputMode[] = ["json_schema", "json_object", "none"];

  /**
   * Modes found not to work, per server and model, shared by every provider
   * in this session so the failing request is not repeated on each call.
   * Cleared when the settings change, since the user may have fixed the server.
   */
  private static readonly degraded = new Map<string, StructuredOutputMode>();

  static resetFallbacks(): void {
    OpenAICompatibleProvider.degraded.clear();
  }

  /**
   * One queue per server, shared by every provider in this session, so the
   * coordinator, sub-agents and check-ins never send more requests at once
   * than the server is set to take. A local server that runs one request at a
   * time would otherwise queue the rest itself, and the time spent waiting
   * there counts against any proxy timeout in front of it.
   */
  private static readonly queues = new Map<string, Limiter>();

  private get queue(): Limiter {
    const key = this.config.baseUrl.replace(/\/+$/, "");
    let q = OpenAICompatibleProvider.queues.get(key);
    if (!q) OpenAICompatibleProvider.queues.set(key, (q = new Limiter()));
    q.limit = Math.max(1, Math.floor(this.config.maxConcurrentRequests ?? 1));
    return q;
  }

  private get key(): string {
    return `${this.config.baseUrl}|${this.config.model}`;
  }

  /** The configured mode, or a weaker one if the server already rejected it. */
  get structuredOutput(): StructuredOutputMode {
    const order = OpenAICompatibleProvider.FALLBACK;
    const degraded = OpenAICompatibleProvider.degraded.get(this.key);
    const configured = this.config.structuredOutput;
    return degraded && order.indexOf(degraded) > order.indexOf(configured) ? degraded : configured;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const order = OpenAICompatibleProvider.FALLBACK;
    for (let mode = this.structuredOutput; ; ) {
      try {
        const release = await this.queue.acquire(request.signal);
        try {
          return await this.send(request, mode);
        } finally {
          release();
        }
      } catch (err) {
        const next = order[order.indexOf(mode) + 1];
        // Some servers and models (for example Ollama with certain GGUFs) cannot
        // constrain output to a schema. The reply is validated by callStructured
        // anyway, so ask again with a weaker format instead of failing.
        if (!(err instanceof ProviderError) || !request.jsonSchema || !next || !rejectsFormat(err)) throw err;
        OpenAICompatibleProvider.degraded.set(this.key, next);
        this.onFallback?.(mode, next, err.message);
        mode = next;
      }
    }
  }

  private networkError(err: unknown, signal: AbortSignal | undefined, timeout: AbortSignal): ProviderError {
    return describeNetworkError(this.config.baseUrl, this.config.requestTimeoutMs, err, !!signal?.aborted, timeout.aborted);
  }

  private async send(request: ChatRequest, mode: StructuredOutputMode): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: request.messages,
      temperature: request.temperature ?? this.config.temperature,
      stream: this.config.stream ?? true,
    };
    if (body.stream) body.stream_options = { include_usage: true };
    const limit = this.config.maxOutputTokens && this.config.maxOutputTokens > 0 ? this.config.maxOutputTokens : undefined;
    const maxTokens = request.maxTokens !== undefined && limit !== undefined ? Math.min(request.maxTokens, limit) : (request.maxTokens ?? limit);
    if (maxTokens !== undefined) {
      body.max_tokens = maxTokens;
    }
    if (request.jsonSchema && mode === "json_schema") {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: request.jsonSchema.name, schema: request.jsonSchema.schema, strict: true },
      };
    } else if (request.jsonSchema && mode === "json_object") {
      body.response_format = { type: "json_object" };
    }

    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    let res: Response;
    try {
      res = await this.fetchFn(`${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw this.networkError(err, request.signal, timeout);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      const hint =
        res.status === 504 || res.status === 502
          ? " Something between the extension and the model (a proxy or gateway) gave up waiting. Raise its timeout, or make prompts smaller (agentic.chat.coordinatorHistoryTokens)."
          : "";
      if (res.status === 404) {
        throw new ProviderError(
          `Model "${this.config.model}" was not found at ${this.config.baseUrl} (404). ` +
            `The name comes from ${this.config.source ?? "agentic.model.name"}. ` +
            `Set it to a model the server has, for example one listed by "ollama list". Server said: ${text.slice(0, 300)}`,
          404,
          false,
        );
      }
      throw new ProviderError(
        `Model server returned ${res.status}: ${text.slice(0, 500)}${hint}`,
        res.status,
        retryable,
        body.response_format !== undefined,
        retryAfter(res.headers.get("retry-after")),
      );
    }

    // A server that ignores "stream" answers with plain JSON, which is read as before.
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream") && res.body) {
      try {
        return await readStream(res.body, res.status);
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw this.networkError(err, request.signal, timeout);
      }
    }

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw this.networkError(err, request.signal, timeout);
    }
    if (/^\s*data:/.test(text)) return parseEvents(text.split(/\r?\n/), new StreamResult(), res.status).finish(res.status);
    let json: Json;
    try {
      json = JSON.parse(text) as Json;
    } catch {
      throw new ProviderError(`Model server returned a reply that is not JSON: ${text.slice(0, 200)}`, res.status, true);
    }
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new ProviderError("Model server returned no message content", res.status, true);
    }
    const message = json.choices?.[0]?.message;
    const reasoning = message?.reasoning ?? message?.reasoning_content ?? undefined;
    return {
      content,
      reasoning: reasoning || undefined,
      promptTokens: json.usage?.prompt_tokens,
      completionTokens: json.usage?.completion_tokens,
    };
  }
}

/** Why a request could not finish: the user stopped it, our own timeout, or the server could not be reached. */
function describeNetworkError(baseUrl: string, timeoutMs: number, err: unknown, cancelled: boolean, timedOut: boolean): ProviderError {
  if (cancelled) return new ProviderError("Request cancelled");
  // Our own limit. Sending the same request again would most likely time out again, so it is not retried.
  if (timedOut) {
    return new ProviderError(`The model did not finish within ${Math.round(timeoutMs / 1000)} s (agentic.model.requestTimeoutMs).`, undefined, false);
  }
  return new ProviderError(`Could not reach ${baseUrl}: ${(err as Error)?.message ?? String(err)}`, undefined, true);
}

/** Retry-After in seconds or as a date, in ms. Capped at two minutes. */
export function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 120_000) : undefined;
}

type Json = {
  choices?: { message?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

type StreamChunk = {
  choices?: { delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string } | string;
};

class StreamResult {
  content = "";
  reasoning = "";
  sawContent = false;
  usage?: { prompt_tokens?: number; completion_tokens?: number };

  finish(status: number): ChatResponse {
    if (!this.sawContent) throw new ProviderError("Model server returned no message content", status, true);
    return {
      content: this.content,
      reasoning: this.reasoning || undefined,
      promptTokens: this.usage?.prompt_tokens,
      completionTokens: this.usage?.completion_tokens,
    };
  }
}

/** Adds server-sent event lines ("data: {...}") to the result. */
function parseEvents(lines: string[], out: StreamResult, status: number): StreamResult {
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(data) as StreamChunk;
    } catch {
      continue;
    }
    if (chunk.error) {
      const msg = typeof chunk.error === "string" ? chunk.error : (chunk.error.message ?? "unknown error");
      throw new ProviderError(`Model server failed while answering: ${msg.slice(0, 500)}`, status, true);
    }
    const delta = chunk.choices?.[0]?.delta;
    if (typeof delta?.content === "string") {
      out.content += delta.content;
      out.sawContent = true;
    }
    const thought = delta?.reasoning ?? delta?.reasoning_content;
    if (typeof thought === "string") out.reasoning += thought;
    if (chunk.usage) out.usage = chunk.usage;
  }
  return out;
}

/** Reads a streamed reply as it arrives. */
async function readStream(body: ReadableStream<Uint8Array>, status: number): Promise<ChatResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const out = new StreamResult();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : (lines.pop() ?? "");
    parseEvents(lines, out, status);
    if (done) break;
  }
  return out.finish(status);
}

/** Lets at most `limit` callers run at once; the rest wait in order. */
export class Limiter {
  limit = 1;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new ProviderError("Request cancelled"));
    return new Promise((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.next();
        });
      };
      const onAbort = () => {
        const i = this.waiting.indexOf(start);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new ProviderError("Request cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(start);
      this.next();
    });
  }

  private next(): void {
    while (this.active < this.limit && this.waiting.length > 0) this.waiting.shift()!();
  }
}

/** Errors that mean the server cannot produce the requested response format, rather than a general failure. */
export function rejectsFormat(err: ProviderError): boolean {
  if (!err.sentFormat || err.status === undefined || err.status === 404 || err.status === 429) return false;
  if (err.status === 400 || err.status === 422 || err.status === 501) return true;
  return /format|grammar|vocab|schema|response_format|json/i.test(err.message);
}
