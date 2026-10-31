import { ChatRequest, ChatResponse, ModelProvider, StructuredOutputMode } from "./types";

export interface OpenAICompatibleConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  contextWindow: number;
  temperature: number;
  requestTimeoutMs: number;
  structuredOutput: StructuredOutputMode;
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
        return await this.send(request, mode);
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

  private async send(request: ChatRequest, mode: StructuredOutputMode): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: request.messages,
      temperature: request.temperature ?? this.config.temperature,
      stream: false,
    };
    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
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
      if (request.signal?.aborted) {
        throw new ProviderError("Request cancelled");
      }
      throw new ProviderError(`Could not reach ${this.config.baseUrl}: ${(err as Error).message}`, undefined, true);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      if (res.status === 404) {
        throw new ProviderError(
          `Model "${this.config.model}" was not found at ${this.config.baseUrl} (404). ` +
            `The name comes from ${this.config.source ?? "agentic.model.name"}. ` +
            `Set it to a model the server has, for example one listed by "ollama list". Server said: ${text.slice(0, 300)}`,
          404,
          false,
        );
      }
      throw new ProviderError(`Model server returned ${res.status}: ${text.slice(0, 500)}`, res.status, retryable, body.response_format !== undefined);
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new ProviderError("Model server returned no message content", res.status, true);
    }
    return {
      content,
      promptTokens: json.usage?.prompt_tokens,
      completionTokens: json.usage?.completion_tokens,
    };
  }
}

/** Errors that mean the server cannot produce the requested response format, rather than a general failure. */
export function rejectsFormat(err: ProviderError): boolean {
  if (!err.sentFormat || err.status === undefined || err.status === 404 || err.status === 429) return false;
  if (err.status === 400 || err.status === 422 || err.status === 501) return true;
  return /format|grammar|vocab|schema|response_format|json/i.test(err.message);
}
