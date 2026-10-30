import { estimateTokens } from "../context/budget";
import { ChatMessage } from "../providers/types";

const REMOVED = "[older tool output removed to save context]";

/**
 * Keeps a worker conversation inside its token budget. The system prompt, the
 * task and the most recent turns are kept whole. Older tool output is blanked
 * first, then the oldest turns are dropped.
 */
export function compactHistory(messages: ChatMessage[], budgetTokens: number, keepHead = 2, keepRecent = 6): ChatMessage[] {
  const out = messages.map((m) => ({ ...m }));
  const total = () => out.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
  if (total() <= budgetTokens) return out;

  for (let i = keepHead; i < out.length - keepRecent && total() > budgetTokens; i++) {
    const m = out[i]!;
    if (m.role === "user" && m.content !== REMOVED) m.content = REMOVED;
  }
  while (total() > budgetTokens && out.length > keepHead + keepRecent) {
    // Drop an assistant/user pair so roles keep alternating.
    out.splice(keepHead, 2);
  }
  return out;
}
