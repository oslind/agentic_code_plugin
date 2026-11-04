import { ProviderError } from "./openaiCompatible";
import { ChatRequest, ChatResponse, ModelProvider } from "./types";

/** First wait after a gateway error (502, 503, 504). A busy local server needs longer than a second to free up. */
export const GATEWAY_DELAY_MS = 5000;

/**
 * Retries a request when the server is briefly unavailable, for example while
 * a local server is still loading the model. Waits double each time. After a
 * gateway error (502, 503, 504) the first wait is longer, since the server is
 * usually still busy with the request the proxy gave up on, and a
 * Retry-After from the server is honoured.
 */
export class RetryingProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly retries = 3,
    private readonly baseDelayMs = 1000,
    private readonly onRetry?: (attempt: number, delayMs: number, error: ProviderError) => void,
    private readonly gatewayDelayMs = GATEWAY_DELAY_MS,
  ) {}

  get model(): string {
    return this.inner.model;
  }

  get contextWindow(): number {
    return this.inner.contextWindow;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.inner.chat(request);
      } catch (err) {
        if (!(err instanceof ProviderError) || !err.retryable || attempt >= this.retries || request.signal?.aborted) throw err;
        const gateway = err.status === 502 || err.status === 503 || err.status === 504;
        const delay = Math.max(err.retryAfterMs ?? 0, (gateway ? this.gatewayDelayMs : this.baseDelayMs) * 2 ** attempt);
        this.onRetry?.(attempt + 1, delay, err);
        await wait(delay, request.signal);
      }
    }
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
