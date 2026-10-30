import { ProviderError } from "./openaiCompatible";
import { ChatRequest, ChatResponse, ModelProvider } from "./types";

/**
 * Retries a request when the server is briefly unavailable, for example while
 * a local server is still loading the model. Waits double each time.
 */
export class RetryingProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly retries = 3,
    private readonly baseDelayMs = 1000,
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
        const retryable = err instanceof ProviderError && err.retryable;
        if (!retryable || attempt >= this.retries || request.signal?.aborted) throw err;
        await wait(this.baseDelayMs * 2 ** attempt, request.signal);
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
