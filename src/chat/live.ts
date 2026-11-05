import { estimateTokens } from "../context/budget";
import { ChatPhase, ChatProgress, ChatRequest, ChatResponse, ModelProvider } from "../providers/types";

/**
 * What a model call is doing right now, for the chat to show while the
 * coordinator or a sub-agent "thinks": how long it has waited, how much it
 * has written, and the end of its train of thought as it streams in.
 */
export interface LiveItem {
  /** "coordinator", or "runId:taskId" for a sub-agent. */
  key: string;
  phase: ChatPhase;
  /** When this request started, in ms since the epoch. */
  startedAt: number;
  /** When anything last arrived, in ms since the epoch. */
  updatedAt: number;
  /** Rough count of the tokens received so far. */
  tokens: number;
  /** The last part of the thinking or the reply, whichever is arriving. */
  tail: string;
  /** Model calls this agent made so far in this session. */
  calls: number;
}

/** Characters of the latest thought shown live. Enough for a few lines in a 350px sidebar. */
export const LIVE_TAIL_CHARS = 600;

/** The end of the text that is arriving, without <think> tags, cut at a line or word start where possible. */
export function liveTail(progress: Pick<ChatProgress, "phase" | "reasoning" | "content">, max = LIVE_TAIL_CHARS): string {
  let text: string;
  if (progress.phase === "thinking") {
    // Thinking comes in the reasoning field, or inline as an open <think> block in the reply.
    const inline = /<think>([\s\S]*?)(?:<\/think>|$)/i.exec(progress.content.slice(progress.content.lastIndexOf("<think>")))?.[1];
    text = progress.reasoning || inline || "";
  } else {
    text = progress.content.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "");
  }
  text = text.replace(/\r/g, "").trimEnd();
  if (text.length <= max) return text.trimStart();
  let cut = text.slice(-max);
  const nl = cut.indexOf("\n");
  if (nl >= 0 && nl < max / 3) cut = cut.slice(nl + 1);
  else {
    const sp = cut.indexOf(" ");
    if (sp >= 0 && sp < 40) cut = cut.slice(sp + 1);
  }
  return `…${cut.trimStart()}`;
}

/**
 * Keeps one live item per agent and tells a listener about changes, at most
 * every `throttleMs`, so a fast stream of tokens does not flood the webview.
 */
export class LiveTracker {
  private readonly items = new Map<string, Omit<LiveItem, "tail"> & { id: number; last?: ChatProgress }>();
  private readonly listeners = new Set<() => void>();
  private readonly calls = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private lastNotify = 0;
  private nextId = 0;

  constructor(
    private readonly throttleMs = 250,
    private readonly now: () => number = Date.now,
  ) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every request in flight, by agent key. */
  snapshot(): Record<string, LiveItem> {
    const out: Record<string, LiveItem> = {};
    // The tail is cut here, not on every token, so a long stream costs nothing until it is shown.
    for (const [k, item] of this.items) {
      out[k] = { key: item.key, phase: item.phase, startedAt: item.startedAt, updatedAt: item.updatedAt, tokens: item.tokens, calls: item.calls, tail: item.last ? liveTail(item.last) : "" };
    }
    return out;
  }

  /**
   * The provider, reporting what each of its requests does under `key`. A
   * listener the caller passed on the request still gets every update.
   */
  wrap(provider: ModelProvider, key: string): ModelProvider {
    const chat = async (request: ChatRequest): Promise<ChatResponse> => {
      const id = this.start(key);
      const theirs = request.onProgress;
      try {
        return await provider.chat({
          ...request,
          onProgress: (p) => {
            this.update(key, id, p);
            theirs?.(p);
          },
        });
      } finally {
        this.end(key, id);
      }
    };
    return {
      get model() {
        return provider.model;
      },
      get contextWindow() {
        return provider.contextWindow;
      },
      chat,
    };
  }

  private start(key: string): number {
    const id = ++this.nextId;
    const t = this.now();
    const calls = (this.calls.get(key) ?? 0) + 1;
    this.calls.set(key, calls);
    this.items.set(key, { id, key, phase: "queued", startedAt: t, updatedAt: t, tokens: 0, calls });
    this.notify(true);
    return id;
  }

  private update(key: string, id: number, p: ChatProgress): void {
    const item = this.items.get(key);
    if (!item || item.id !== id) return;
    const phaseChanged = item.phase !== p.phase;
    item.phase = p.phase;
    item.updatedAt = this.now();
    // "queued" and "waiting" carry no text; keep what arrived before a retry's new request.
    if (p.reasoning || p.content) {
      item.tokens = estimateTokens(p.reasoning) + estimateTokens(p.content);
      item.last = { phase: p.phase, reasoning: p.reasoning, content: p.content };
    }
    this.notify(phaseChanged);
  }

  private end(key: string, id: number): void {
    const item = this.items.get(key);
    // A newer request of the same agent may have started meanwhile; only the request's own item goes.
    if (!item || item.id !== id) return;
    this.items.delete(key);
    this.notify(true);
  }

  private notify(now: boolean): void {
    const t = this.now();
    if (now || t - this.lastNotify >= this.throttleMs) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.lastNotify = t;
      for (const l of this.listeners) l();
      return;
    }
    // Inside the window: one update when it ends, with whatever arrived last.
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.lastNotify = this.now();
      for (const l of this.listeners) l();
    }, this.throttleMs - (t - this.lastNotify));
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
  }
}
