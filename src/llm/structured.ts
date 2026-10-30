import { z } from "zod";
import { ChatMessage, ModelProvider } from "../providers/types";

/**
 * Pulls a JSON value out of a model reply. Small models often wrap JSON in
 * reasoning blocks, code fences or prose, so this strips those before parsing.
 */
export function extractJson(raw: string): unknown {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // An unclosed <think> means the model ran out of tokens while reasoning.
  if (/<think>/i.test(text)) {
    throw new SyntaxError("Reply ended inside a <think> block");
  }

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    text = fence[1].trim();
  }

  try {
    return JSON.parse(text);
  } catch {
    // Fall back to the outermost object or array in the text.
  }
  const start = text.search(/[{[]/);
  if (start === -1) {
    throw new SyntaxError("No JSON found in reply");
  }
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  const end = text.lastIndexOf(close);
  if (end <= start) {
    throw new SyntaxError("Unterminated JSON in reply");
  }
  return JSON.parse(text.slice(start, end + 1));
}

export interface StructuredCallOptions<T> {
  provider: ModelProvider;
  messages: ChatMessage[];
  schema: z.ZodType<T>;
  schemaName: string;
  /** Extra attempts after the first one. Each retry tells the model what was wrong. */
  maxRetries?: number;
  signal?: AbortSignal;
  onAttempt?: (attempt: number, error?: string) => void;
}

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly lastReply: string,
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

/**
 * Asks the model for JSON matching `schema`, validates it, and retries with
 * the validation error as feedback. This is the main guard that lets small
 * models drive tools reliably.
 */
export async function callStructured<T>(options: StructuredCallOptions<T>): Promise<T> {
  const { provider, schema, schemaName, signal } = options;
  const maxRetries = options.maxRetries ?? 2;
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  const messages = [...options.messages];
  let lastReply = "";
  let lastError = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    options.onAttempt?.(attempt, attempt > 0 ? lastError : undefined);
    const reply = await provider.chat({ messages, jsonSchema: { name: schemaName, schema: jsonSchema }, signal });
    lastReply = reply.content;

    try {
      const parsed = schema.safeParse(extractJson(reply.content));
      if (parsed.success) {
        return parsed.data;
      }
      lastError = z.prettifyError(parsed.error);
    } catch (err) {
      lastError = (err as Error).message;
    }

    messages.push(
      { role: "assistant", content: reply.content },
      {
        role: "user",
        content: `Your reply was not valid. Problem:\n${lastError}\n\nReply again with only the corrected JSON object. No prose, no code fences.`,
      },
    );
  }

  throw new StructuredOutputError(
    `Model did not return valid ${schemaName} after ${maxRetries + 1} attempts: ${lastError}`,
    maxRetries + 1,
    lastReply,
  );
}
