export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

/** How the provider asks the server for JSON. Servers differ in what they accept. */
export type StructuredOutputMode = "json_schema" | "json_object" | "none";

export interface ChatRequest {
  messages: ChatMessage[];
  /** JSON Schema for the reply. Sent only when the mode allows it. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  temperature?: number;
  maxTokens?: number;
  /**
   * Ask the server to answer without thinking. Sent as the fields local servers read for that (Ollama's
   * reasoning_effort "none" and think false, vLLM's chat_template_kwargs.enable_thinking false); a server that
   * rejects them is asked again without them.
   */
  noThinking?: boolean;
  /**
   * Most characters of thinking before any answer: past it the reply is stopped and returned cut off
   * (truncated, thinkingStopped), so the caller can ask again without thinking. Streamed replies only.
   */
  thinkingBudget?: number;
  signal?: AbortSignal;
  /**
   * Called while the reply is on its way, so the user can see the model is
   * working: when the request waits its turn, once it is sent, and with every
   * piece of thinking or reply text that streams in. Never changes the reply.
   */
  onProgress?: (progress: ChatProgress) => void;
}

/**
 * Where one request is. "queued": waiting for the server's request slot.
 * "waiting": sent, nothing back yet (the server is reading the prompt).
 * "thinking": thinking text is arriving. "writing": the reply is arriving.
 */
export type ChatPhase = "queued" | "waiting" | "thinking" | "writing";

export interface ChatProgress {
  phase: ChatPhase;
  /** Thinking received so far (the server's reasoning field). */
  reasoning: string;
  /** Reply text received so far, which may hold a <think> block. */
  content: string;
}

export interface ChatResponse {
  content: string;
  /** The model's thinking, when the server returns it separately (Ollama, vLLM and others call it reasoning). */
  reasoning?: string;
  promptTokens?: number;
  completionTokens?: number;
  /**
   * True when the server stopped the reply at its length limit (finish_reason
   * "length"): max_tokens, the context window, or the server's own cap. The
   * text then ends mid-answer and must never be shown as a finished one.
   */
  truncated?: boolean;
  /** True when the extension stopped the reply because it thought past ChatRequest.thinkingBudget. */
  thinkingStopped?: boolean;
}

export interface ModelProvider {
  readonly model: string;
  readonly contextWindow: number;
  chat(request: ChatRequest): Promise<ChatResponse>;
}
