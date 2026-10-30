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
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
}

export interface ModelProvider {
  readonly model: string;
  readonly contextWindow: number;
  chat(request: ChatRequest): Promise<ChatResponse>;
}
