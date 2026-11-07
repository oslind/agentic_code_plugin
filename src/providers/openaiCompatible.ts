import { estimateTokens } from "../context/budget";
import { ChatPhase, ChatProgress, ChatRequest, ChatResponse, ModelProvider, StructuredOutputMode } from "./types";

/** Reports a request's phase to its listener, if it has one. Display only, so a listener's error is ignored. */
function report(request: ChatRequest, phase: ChatPhase): void {
  try {
    request.onProgress?.({ phase, reasoning: "", content: "" });
  } catch {
    // Only for display.
  }
}

/** Whether reply text has started outside a <think> block, i.e. the model is writing its answer, not thinking. */
export function liveContent(content: string): boolean {
  const open = content.lastIndexOf("<think>");
  if (open === -1) return content.trim().length > 0;
  const close = content.indexOf("</think>", open);
  return close !== -1 && content.slice(close + 8).trim().length > 0;
}

export interface OpenAICompatibleConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  contextWindow: number;
  temperature: number;
  /**
   * How long the server may stay silent, in ms, before the request is
   * stopped. The clock restarts with every piece of the reply that arrives,
   * so a long reply that keeps streaming is never cut off. 0 (the default)
   * means never: the user is warned instead and can press Stop.
   */
  requestTimeoutMs: number;
  /** Silence, in ms, after which the user is told the server may have dropped the request. 0 means no warning. */
  silenceWarningMs?: number;
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

export interface SilenceEvent {
  /** How long nothing has arrived, in ms. */
  silentMs: number;
  /** False when the silence is first noticed, true when data arrives again after a warning. */
  resumed: boolean;
  baseUrl: string;
}

/** The request fields that ask local servers for a reply without thinking. Servers ignore fields they do not know. */
export const NO_THINKING_FIELDS: Record<string, unknown> = { reasoning_effort: "none", think: false, chat_template_kwargs: { enable_thinking: false } };

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

/** Tokens kept free besides the prompt estimate, since token counts are only estimated. */
const CONTEXT_MARGIN = 256;
/** A reply is never limited below this, even when the prompt estimate says the context is nearly full. */
const MIN_REPLY_TOKENS = 512;

/**
 * Most reply tokens that still fit in the context window after the prompt,
 * so a long thinking run stops at the window instead of overflowing it after
 * minutes of work. Undefined without a context window.
 */
export function replyRoom(messages: ChatRequest["messages"], contextWindow: number): number | undefined {
  if (!(contextWindow > 0)) return undefined;
  const prompt = messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
  return Math.max(MIN_REPLY_TOKENS, contextWindow - prompt - CONTEXT_MARGIN);
}

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
    /** Called when the server has been silent for silenceWarningMs, and again if it answers after that. Nothing is stopped. */
    private readonly onSilence?: (event: SilenceEvent) => void,
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
  /** Servers that refused the no-thinking fields: they are not sent there again. */
  private static readonly noThinkRefused = new Set<string>();

  static resetFallbacks(): void {
    OpenAICompatibleProvider.degraded.clear();
    OpenAICompatibleProvider.noThinkRefused.clear();
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
        report(request, "queued");
        const release = await this.queue.acquire(request.signal);
        try {
          report(request, "waiting");
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

  private networkError(err: unknown, signal: AbortSignal | undefined, idle: IdleTimer): ProviderError {
    return describeNetworkError(this.config.baseUrl, this.config.requestTimeoutMs, err, !!signal?.aborted, idle.fired);
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
    const caps = [request.maxTokens, limit, replyRoom(request.messages, this.config.contextWindow)].filter((n): n is number => n !== undefined);
    const maxTokens = caps.length ? Math.min(...caps) : undefined;
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

    // Run 7B: qwen3 on Ollama 0.40 ignored a "/no_think" in the prompt and thought until the cap three times in a row.
    const noThink = !!request.noThinking && !OpenAICompatibleProvider.noThinkRefused.has(this.key);
    if (noThink) Object.assign(body, NO_THINKING_FIELDS);

    const timeout = new IdleTimer(
      this.config.requestTimeoutMs,
      this.config.silenceWarningMs ?? 0,
      this.onSilence && ((ms) => this.onSilence?.({ silentMs: ms, resumed: false, baseUrl: this.config.baseUrl })),
      this.onSilence && ((ms) => this.onSilence?.({ silentMs: ms, resumed: true, baseUrl: this.config.baseUrl })),
    );
    try {
      try {
        return await this.exchange(request, body, timeout);
      } catch (err) {
        if (!noThink || !(err instanceof ProviderError) || (err.status !== 400 && err.status !== 422)) throw err;
        OpenAICompatibleProvider.noThinkRefused.add(this.key);
        for (const k of Object.keys(NO_THINKING_FIELDS)) delete body[k];
        return await this.exchange(request, body, timeout);
      }
    } finally {
      timeout.stop();
    }
  }

  private async exchange(request: ChatRequest, body: Record<string, unknown>, timeout: IdleTimer): Promise<ChatResponse> {
    const signal = request.signal ? AbortSignal.any([request.signal, timeout.signal]) : timeout.signal;
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

    timeout.touch();
    if (!res.ok) {
      const text = await errorText(res);
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
        return await readStream(res.body, res.status, timeout.touch, request.onProgress);
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw this.networkError(err, request.signal, timeout);
      }
    }

    let text: string;
    try {
      text = res.body ? await readLimited(res.body, MAX_REPLY_CHARS, res.status, false, timeout.touch) : await res.text();
    } catch (err) {
      if (err instanceof ProviderError) throw err;
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
      ...(cutOff(json.choices?.[0]?.finish_reason) ? { truncated: true } : {}),
    };
  }
}

/** Why a request could not finish: the user stopped it, our own timeout, or the server could not be reached. */
function describeNetworkError(baseUrl: string, timeoutMs: number, err: unknown, cancelled: boolean, timedOut: boolean): ProviderError {
  if (cancelled) return new ProviderError("Request cancelled");
  // Our own limit. Sending the same request again would most likely time out again, so it is not retried.
  if (timedOut) {
    return new ProviderError(
      `The model server sent nothing for ${Math.round(timeoutMs / 1000)} s (agentic.model.requestTimeoutMs), so the request was stopped. ` +
        `A reply that keeps arriving is never cut off; this means the server was silent, for example stuck, overloaded, or still reading a very long prompt. ` +
        `Raise the setting, or set it to 0 to never stop and only be warned.`,
      undefined,
      false,
    );
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
  choices?: { message?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

type StreamChunk = {
  choices?: { delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string; type?: string; code?: string | number; status?: number } | string;
};

/**
 * Most characters of reply (content and thinking together) read from the
 * server, and the longest single event. A broken or hostile server could
 * otherwise send data until the extension runs out of memory. Far above any
 * real reply: 32k tokens are roughly 130k characters.
 */
export const MAX_REPLY_CHARS = 4_000_000;
export const MAX_EVENT_CHARS = 1_000_000;
/**
 * Most bytes received for one streamed reply, counting everything the server
 * sends (event framing, comments, fields that are ignored). Each token comes
 * in its own event of a few hundred bytes, so this is set well above
 * MAX_REPLY_CHARS.
 */
export const MAX_STREAM_BYTES = 32_000_000;
/** Most bytes of an error reply read for its message. */
export const MAX_ERROR_BYTES = 64_000;

function tooLarge(status: number): ProviderError {
  return new ProviderError(`Model server sent more than ${MAX_REPLY_CHARS / 1_000_000} million characters. The reply was stopped.`, status, false);
}

/**
 * Whether an error the server reports inside a stream is worth trying
 * again. Only overload, rate limits and timeouts are; context too long, an
 * unknown model or a bad request would fail the same way again.
 */
export function isTransientStreamError(error: StreamChunk["error"]): boolean {
  if (!error) return false;
  if (typeof error === "string") return TRANSIENT.test(error);
  const code = Number(error.code ?? error.status);
  if (Number.isFinite(code) && code > 0) return code === 429 || (code >= 500 && code <= 599);
  return TRANSIENT.test(`${error.type ?? ""} ${error.message ?? ""}`);
}
const TRANSIENT = /overload|unavailable|busy|capacity|rate.?limit|too many requests|timed? ?out|timeout|try again|temporar/i;

class StreamResult {
  content = "";
  reasoning = "";
  sawContent = false;
  /** The last finish_reason the server sent. */
  finishReason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };

  constructor(private readonly onProgress?: (p: ChatProgress) => void) {}

  /** Tells the listener what has arrived. A listener that throws never breaks the reply. */
  progress(): void {
    if (!this.onProgress || (!this.content && !this.reasoning)) return;
    try {
      this.onProgress({ phase: liveContent(this.content) ? "writing" : "thinking", reasoning: this.reasoning, content: this.content });
    } catch {
      // Only for display.
    }
  }

  finish(status: number): ChatResponse {
    if (!this.sawContent && cutOff(this.finishReason)) {
      // Asking again with the same limit ends the same way, so this is not retried.
      throw new ProviderError(
        `The model reached its reply length limit before it wrote any answer${this.reasoning ? " (it spent the limit thinking)" : ""}. Raise agentic.model.maxOutputTokens or agentic.model.contextWindow (and the server's context size to match), or ask for less at once.`,
        status,
        false,
      );
    }
    if (!this.sawContent) throw new ProviderError("Model server returned no message content", status, true);
    return {
      content: this.content,
      reasoning: this.reasoning || undefined,
      promptTokens: this.usage?.prompt_tokens,
      completionTokens: this.usage?.completion_tokens,
      ...(cutOff(this.finishReason) ? { truncated: true } : {}),
    };
  }
}

/**
 * Whether a finish_reason means the reply was stopped at a length limit.
 * OpenAI, Ollama, vLLM and LM Studio send "length"; llama.cpp and some
 * proxies send "max_tokens" or "max_output_tokens".
 */
export function cutOff(reason: string | null | undefined): boolean {
  return typeof reason === "string" && /^(length|max_tokens|max_output_tokens)$/i.test(reason.trim());
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
      throw new ProviderError(`Model server failed while answering: ${msg.slice(0, 500)}`, status, isTransientStreamError(chunk.error));
    }
    const delta = chunk.choices?.[0]?.delta;
    if (typeof delta?.content === "string") {
      out.content += delta.content;
      out.sawContent = true;
    }
    const thought = delta?.reasoning ?? delta?.reasoning_content;
    if (typeof thought === "string") out.reasoning += thought;
    const reason = chunk.choices?.[0]?.finish_reason;
    if (typeof reason === "string" && reason) out.finishReason = reason;
    if (chunk.usage) out.usage = chunk.usage;
    if (out.content.length + out.reasoning.length > MAX_REPLY_CHARS) throw tooLarge(status);
  }
  return out;
}

/** Reads a streamed reply as it arrives. */
async function readStream(
  body: ReadableStream<Uint8Array>,
  status: number,
  onData: () => void = () => undefined,
  onProgress?: (p: ChatProgress) => void,
): Promise<ChatResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const out = new StreamResult(onProgress);
  let buffer = "";
  let bytes = 0;
  // Size of the event being received: all its lines up to the blank line that ends it.
  let eventChars = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      onData();
      // Everything received counts, before parsing, so comments, heartbeats and
      // fields the parser ignores cannot keep the download going without limit.
      bytes += value?.byteLength ?? 0;
      if (bytes > MAX_STREAM_BYTES) throw streamTooLarge(status);
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        eventChars = line === "" ? 0 : eventChars + line.length;
        if (eventChars > MAX_EVENT_CHARS) throw eventTooLarge(status);
      }
      if (eventChars + buffer.length > MAX_EVENT_CHARS) throw eventTooLarge(status);
      parseEvents(lines, out, status);
      out.progress();
      if (done) return out.finish(status);
    }
  } catch (err) {
    // Stop the download, so a failed reply does not keep the connection and the server busy.
    await reader.cancel().catch(() => undefined);
    throw err;
  }
}

function eventTooLarge(status: number): ProviderError {
  return new ProviderError(`Model server sent one event longer than ${MAX_EVENT_CHARS / 1_000_000} million characters. The reply was stopped.`, status, false);
}

function streamTooLarge(status: number): ProviderError {
  return new ProviderError(`Model server sent more than ${MAX_STREAM_BYTES / 1_000_000} MB. The reply was stopped.`, status, false);
}

/**
 * Reads a whole reply body as text, at most `maxBytes` bytes. Past the limit
 * the download is cancelled and the body is either refused (`truncate`
 * false) or cut off there (`truncate` true, for error messages).
 */
async function readLimited(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  status: number,
  truncate = false,
  onData: () => void = () => undefined,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      onData();
      if (value && bytes + value.byteLength > maxBytes) {
        if (!truncate) throw tooLarge(status);
        text += decoder.decode(value.subarray(0, maxBytes - bytes));
        await reader.cancel().catch(() => undefined);
        return text;
      }
      bytes += value?.byteLength ?? 0;
      text += decoder.decode(value, { stream: !done });
      if (done) return text;
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }
}

/** The start of an error reply, for the message. Never more than MAX_ERROR_BYTES is read. */
async function errorText(res: Response): Promise<string> {
  try {
    return res.body ? await readLimited(res.body, MAX_ERROR_BYTES, res.status, true) : "";
  } catch {
    return "";
  }
}

/**
 * Watches for silence from the server. Every piece of the reply calls
 * touch(), which restarts the clock. After `warnMs` of silence onSilent is
 * called once (and onResumed if data arrives again later); after `stopMs`
 * of silence the request is aborted. 0 or less turns either off.
 */
export class IdleTimer {
  private readonly controller = new AbortController();
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private warnTimer: ReturnType<typeof setTimeout> | undefined;
  private lastData = Date.now();
  private warned = false;
  fired = false;

  constructor(
    private readonly stopMs: number,
    private readonly warnMs = 0,
    private readonly onSilent?: (silentMs: number) => void,
    private readonly onResumed?: (silentMs: number) => void,
  ) {
    this.touch();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  readonly touch = (): void => {
    this.clear();
    if (this.fired) return;
    const now = Date.now();
    if (this.warned) {
      this.warned = false;
      this.onResumed?.(now - this.lastData);
    }
    this.lastData = now;
    if (this.warnMs > 0 && this.onSilent) {
      this.warnTimer = setTimeout(() => {
        this.warned = true;
        this.onSilent?.(Date.now() - this.lastData);
      }, this.warnMs);
    }
    if (this.stopMs > 0) {
      this.stopTimer = setTimeout(() => {
        this.fired = true;
        this.controller.abort(new DOMException("The model server sent nothing in time", "TimeoutError"));
      }, this.stopMs);
    }
  };

  stop(): void {
    this.clear();
  }

  private clear(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    if (this.warnTimer) clearTimeout(this.warnTimer);
    this.stopTimer = this.warnTimer = undefined;
  }
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
