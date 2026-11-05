/**
 * Model providers for the end-to-end suite: a real local server configured by
 * environment variables, a recorder that saves every call of a live run, and
 * a replayer that plays a saved run back without a model.
 */
import { promises as fs } from "fs";
import * as path from "path";
import { OpenAICompatibleProvider } from "../src/providers/openaiCompatible";
import { RetryingProvider } from "../src/providers/retrying";
import { ChatRequest, ChatResponse, ModelProvider, StructuredOutputMode } from "../src/providers/types";

/** How the suite reaches the model, from AGENTIC_E2E_* environment variables. */
export interface LiveConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  contextWindow: number;
  structuredOutput: StructuredOutputMode;
  temperature: number;
}

/**
 * The live model, or undefined when AGENTIC_E2E_MODEL is not set, so the suite
 * is skipped (in CI, and for anyone without a local server).
 */
export function liveConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LiveConfig | undefined {
  const model = env.AGENTIC_E2E_MODEL?.trim();
  if (!model) return undefined;
  return {
    baseUrl: (env.AGENTIC_E2E_BASE_URL?.trim() || "http://localhost:11434/v1").replace(/\/+$/, ""),
    model,
    apiKey: env.AGENTIC_E2E_API_KEY?.trim() || undefined,
    contextWindow: Number(env.AGENTIC_E2E_CONTEXT) || 16384,
    structuredOutput: (env.AGENTIC_E2E_STRUCTURED as StructuredOutputMode) || "json_schema",
    // Low, so runs are as repeatable as a local model allows.
    temperature: env.AGENTIC_E2E_TEMPERATURE !== undefined ? Number(env.AGENTIC_E2E_TEMPERATURE) : 0.2,
  };
}

/** The same provider the extension builds from its settings, with the same retries. */
export function liveProvider(c: LiveConfig, log: (message: string) => void): ModelProvider {
  const inner = new OpenAICompatibleProvider(
    {
      baseUrl: c.baseUrl,
      model: c.model,
      apiKey: c.apiKey,
      contextWindow: c.contextWindow,
      temperature: c.temperature,
      requestTimeoutMs: 0,
      silenceWarningMs: 120000,
      structuredOutput: c.structuredOutput,
      stream: true,
      maxConcurrentRequests: 1,
    },
    fetch,
    (from, to, error) => log(`server rejected structured output "${from}" (${error}); using "${to}"`),
    (e) => log(e.resumed ? `server answered again after ${Math.round(e.silentMs / 1000)} s` : `server silent for ${Math.round(e.silentMs / 1000)} s`),
  );
  return new RetryingProvider(inner, 3, 1000, (n, ms, err) => log(`model request failed (${err.message.slice(0, 200)}); retry ${n + 1} in ${Math.round(ms / 1000)} s`));
}

/** One model call as saved in a recording. */
export interface RecordedCall {
  n: number;
  /** The call's first system line, to tell coordinator, planner and sub-agent calls apart when reading a recording. */
  role: string;
  /** Hash of the request messages, so a replay can say where the flow changed. */
  hash: string;
  ms: number;
  request: { messages: ChatRequest["messages"]; schema?: string };
  response?: ChatResponse;
  error?: string;
}

function hashOf(messages: ChatRequest["messages"]): string {
  // FNV-1a is enough to notice a changed prompt; this is not security.
  let h = 0x811c9dc5;
  for (const m of messages) {
    const s = `${m.role}:${m.content}\n`;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function roleOf(req: ChatRequest): string {
  const system = req.messages.find((m) => m.role === "system")?.content ?? "";
  return (req.jsonSchema?.name ? `${req.jsonSchema.name}: ` : "") + system.split("\n")[0]!.slice(0, 120);
}

/**
 * Wraps a provider: records every call, reports activity (so the harness can
 * tell a slow model from a stall), and counts calls in flight.
 */
export class RecordingProvider implements ModelProvider {
  readonly calls: RecordedCall[] = [];
  inFlight = 0;
  lastActivity = Date.now();

  constructor(private readonly inner: ModelProvider) {}

  get model(): string {
    return this.inner.model;
  }

  get contextWindow(): number {
    return this.inner.contextWindow;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const call: RecordedCall = {
      n: this.calls.length + 1,
      role: roleOf(request),
      hash: hashOf(request.messages),
      ms: 0,
      request: { messages: request.messages.map((m) => ({ ...m })), schema: request.jsonSchema?.name },
    };
    this.calls.push(call);
    const started = Date.now();
    this.inFlight++;
    this.lastActivity = started;
    const onProgress = request.onProgress;
    try {
      call.response = await this.inner.chat({
        ...request,
        onProgress: (p) => {
          this.lastActivity = Date.now();
          onProgress?.(p);
        },
      });
      return call.response;
    } catch (err) {
      call.error = (err as Error).message;
      throw err;
    } finally {
      call.ms = Date.now() - started;
      this.inFlight--;
      this.lastActivity = Date.now();
    }
  }
}

/**
 * Plays a recorded run back, reply by reply, in the order they were recorded.
 * Prompts may change between versions, so only the order counts; a changed
 * prompt is noted in `drift`, and running out of replies means the flow
 * changed and the scenario needs a new recording.
 */
export class ReplayProvider implements ModelProvider {
  readonly drift: string[] = [];
  private next = 0;

  constructor(
    private readonly recorded: RecordedCall[],
    readonly model = "replay",
    readonly contextWindow = 16384,
  ) {}

  get used(): number {
    return this.next;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const call = this.recorded[this.next++];
    if (!call) throw new Error(`The recording has ${this.recorded.length} model call(s) and the run asked for more. The flow changed since it was recorded: record it again with a live model.`);
    if (call.hash !== hashOf(request.messages)) this.drift.push(`call ${call.n} (${call.role}): prompt differs from the recording`);
    if (call.error || !call.response) throw new Error(`Recorded failure: ${call.error ?? "no reply"}`);
    request.onProgress?.({ phase: "writing", reasoning: call.response.reasoning ?? "", content: call.response.content });
    return call.response;
  }
}

export async function saveRecording(file: string, calls: RecordedCall[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, calls.map((c) => JSON.stringify(c)).join("\n") + "\n");
}

export async function loadRecording(file: string): Promise<RecordedCall[] | undefined> {
  const text = await fs.readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RecordedCall);
}

/** The server's root (without /v1), for Ollama's own API. */
function serverRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

/** True when the server is Ollama (it answers /api/version). */
export async function isOllama(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverRoot(baseUrl)}/api/version`, { signal: AbortSignal.timeout(5000) });
    return res.ok && typeof ((await res.json()) as { version?: unknown }).version === "string";
  } catch {
    return false;
  }
}

/** Ollama's context length for the loaded model, from /api/ps, if it says. */
export async function ollamaContextLength(baseUrl: string, model: string): Promise<number | undefined> {
  try {
    const res = await fetch(`${serverRoot(baseUrl)}/api/ps`, { signal: AbortSignal.timeout(5000) });
    const body = (await res.json()) as { models?: { name?: string; model?: string; context_length?: number }[] };
    const m = body.models?.find((x) => x.name === model || x.model === model);
    return typeof m?.context_length === "number" ? m.context_length : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Unloads the model from Ollama (keep_alive 0), so it does not hold the GPU
 * after the suite. Other servers are left alone. Returns what happened.
 */
export async function unloadOllama(baseUrl: string, model: string): Promise<string> {
  if (!(await isOllama(baseUrl))) return "not Ollama, nothing to unload";
  try {
    const res = await fetch(`${serverRoot(baseUrl)}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(30000),
    });
    return res.ok ? `unloaded ${model}` : `unload answered ${res.status}`;
  } catch (err) {
    return `unload failed: ${(err as Error).message}`;
  }
}
