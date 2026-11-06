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

  // A reply that is already valid JSON may itself contain ``` inside a string.
  try {
    return JSON.parse(text);
  } catch {
    // Not plain JSON; look for a fenced block next.
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
  // The first complete value, so text or stray closing braces after it do not matter: run 6 without
  // structured output got a valid plan followed by one "}" too many, four times in a row.
  const first = firstValueEnd(text, start);
  if (first !== undefined) {
    try {
      return JSON.parse(text.slice(start, first + 1));
    } catch {
      // Not valid after all; try the widest span below.
    }
  }
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  const end = text.lastIndexOf(close);
  if (end <= start) {
    throw new SyntaxError("Unterminated JSON in reply");
  }
  return JSON.parse(text.slice(start, end + 1));
}

/** Index of the bracket that closes the JSON value opening at `start`, skipping strings; undefined if it never closes. */
function firstValueEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

/** The model's thinking: what the server returned separately, or the text of <think> blocks in the reply. */
export function extractThinking(content: string, reasoning?: string): string | undefined {
  if (reasoning?.trim()) return reasoning.trim();
  const blocks = [...content.matchAll(/<think>([\s\S]*?)(?:<\/think>|$)/gi)].map((m) => m[1]!.trim()).filter(Boolean);
  return blocks.length ? blocks.join("\n\n") : undefined;
}

const CUT_OFF = "Your reply was cut off at the length limit before the JSON was complete. Think briefly and keep every field short.";

export interface StructuredCallOptions<T> {
  provider: ModelProvider;
  messages: ChatMessage[];
  schema: z.ZodType<T>;
  schemaName: string;
  /** Extra attempts after the first one. Each retry tells the model what was wrong. */
  maxRetries?: number;
  signal?: AbortSignal;
  onAttempt?: (attempt: number, error?: string) => void;
  /** Called with the model's thinking for each reply that has any. */
  onThinking?: (thinking: string) => void;
  /** Longest reply, in tokens, for this call (the provider's own caps still apply). */
  maxTokens?: number;
}

/**
 * Token cap for the coordinator's short verdicts (review, supervision, verification, consults). Their JSON
 * is a few hundred tokens; in e2e runs 5 and 6, qwen3:8b sometimes thought until the 8192-token cap
 * (about 6 minutes) and gave nothing. With this cap such a call ends sooner and is retried without thinking.
 */
export const VERDICT_MAX_TOKENS = 4096;

/** Token cap for plans: a plan's JSON can be a few thousand tokens, so more room than a verdict (run 6E: a plan call thought for 354 s and gave nothing). */
export const PLAN_MAX_TOKENS = 6144;

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
    const reply = await provider.chat({ messages, jsonSchema: { name: schemaName, schema: jsonSchema }, signal, maxTokens: options.maxTokens });
    lastReply = reply.content;
    const thinking = extractThinking(reply.content, reply.reasoning);
    if (thinking) options.onThinking?.(thinking);

    try {
      // A reply stopped at the length limit is never used, even if what arrived happens to parse:
      // a string in it (the reply to the user) may end mid-sentence.
      if (reply.truncated) throw new SyntaxError(CUT_OFF);
      const parsed = schema.safeParse(extractJson(reply.content));
      if (parsed.success) {
        return parsed.data;
      }
      lastError = z.prettifyError(parsed.error);
    } catch (err) {
      lastError = (err as Error).message;
    }

    messages.push(
      // A cut-off reply is long by definition; sent back whole it would leave even less room for the next one.
      { role: "assistant", content: reply.truncated ? `${reply.content.slice(0, 1000)} …(cut off)` : reply.content },
      {
        role: "user",
        // After a cut-off, "/no_think" asks Qwen3 models to answer without thinking (other models read it as plain text).
        // In the e2e runs, qwen3:8b sometimes thought until the 8192-token cap (about 6 minutes on Oskar's GPU) and gave nothing.
        content: `Your reply was not valid. Problem:\n${lastError}\n\nReply again with only the corrected JSON object. No prose, no code fences.${reply.truncated ? " /no_think" : ""}`,
      },
    );
  }

  throw new StructuredOutputError(
    `Model did not return valid ${schemaName} after ${maxRetries + 1} attempts: ${lastError}`,
    maxRetries + 1,
    lastReply,
  );
}
