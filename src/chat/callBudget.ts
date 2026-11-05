import { ChatRequest, ChatResponse, ModelProvider } from "../providers/types";

/** Thrown instead of a model call once a run has used its budget. Never retried. */
export class ModelCallBudgetError extends Error {
  constructor(readonly limit: number) {
    super(`This run reached its limit of ${limit} model calls (agentic.delegation.maxModelCallsPerRun), so it was stopped.`);
    this.name = "ModelCallBudgetError";
  }
}

/**
 * Counts the model calls each run makes: its sub-agents' steps and the
 * coordinator's own calls about it (check-ins, progress looks, reviews,
 * answers to sub-agents). The limit comes from user settings only, so a
 * project cannot make a run call the model without bound (for example by
 * raising agentic.worker.maxTurns in its own settings).
 *
 * The coordinator's chat replies, plans and final answers are not counted:
 * they happen once per message, not in a loop.
 */
export class CallBudget {
  private readonly used = new Map<string, number>();
  private readonly tripped = new Set<string>();

  /** `limit` is read on every call, so a settings change applies to the next one. 0 means no limit. */
  constructor(
    private readonly limit: () => number,
    private readonly onExhausted: (runId: string, limit: number) => void = () => {},
  ) {}

  count(runId: string): number {
    return this.used.get(runId) ?? 0;
  }

  /** True once the run has no calls left. */
  exhausted(runId: string): boolean {
    const limit = this.limit();
    return limit > 0 && this.count(runId) >= limit;
  }

  /**
   * Takes one call from the run's budget. Throws once it is used up; the
   * first time, `onExhausted` runs first, so the caller can stop the run.
   */
  take(runId: string): void {
    const limit = this.limit();
    if (limit > 0 && this.count(runId) >= limit) {
      if (!this.tripped.has(runId)) {
        this.tripped.add(runId);
        this.onExhausted(runId, limit);
      }
      throw new ModelCallBudgetError(limit);
    }
    this.used.set(runId, this.count(runId) + 1);
  }

  /** Forgets a finished run, so a retry later starts with a full budget. */
  clear(runId: string): void {
    this.used.delete(runId);
    this.tripped.delete(runId);
  }

  /** The provider, with every request counted against the run. */
  wrap(provider: ModelProvider, runId: string): ModelProvider {
    const chat = async (request: ChatRequest): Promise<ChatResponse> => {
      this.take(runId);
      return provider.chat(request);
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
}
