import { ChatRequest, ChatResponse, ModelProvider, StructuredOutputMode } from "./types";

export interface OpenAICompatibleConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  contextWindow: number;
  temperature: number;
  requestTimeoutMs: number;
  structuredOutput: StructuredOutputMode;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
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
  ) {
    this.model = config.model;
    this.contextWindow = config.contextWindow;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: request.messages,
      temperature: request.temperature ?? this.config.temperature,
      stream: false,
    };
    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
    }
    if (request.jsonSchema && this.config.structuredOutput === "json_schema") {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: request.jsonSchema.name, schema: request.jsonSchema.schema, strict: true },
      };
    } else if (request.jsonSchema && this.config.structuredOutput === "json_object") {
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
      throw new ProviderError(`Model server returned ${res.status}: ${text.slice(0, 500)}`, res.status, retryable);
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
