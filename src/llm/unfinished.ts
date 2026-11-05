/**
 * Telling a finished reply from one that stopped partway, so a reply that
 * ends mid-answer is never shown as a complete answer.
 */

/**
 * Tokens a prompt leaves free for the reply. Thinking models (qwen3 and
 * others) spend their reply budget on thinking first, so a fixed 2048 left a
 * long research summary cut off after its first sentence. A quarter of the
 * window, between `min` and 8192 tokens, the default agentic.model.maxOutputTokens.
 */
export function replyReserve(contextWindow: number, min = 2048): number {
  const quarter = Math.floor((contextWindow > 0 ? contextWindow : 0) / 4);
  return Math.max(min, Math.min(8192, quarter));
}

/**
 * Whether a reply ends by announcing something that never comes: a line that
 * ends with ":" ("Here's what was changed:"), or a bare list marker. Small
 * models do this in a JSON field, and a reply stopped at a limit often ends
 * the same way. Looks only at the shape of the text, never at its words.
 */
export function endsInLeadIn(text: string): boolean {
  const last = text.replace(/\s+$/u, "").split("\n").pop()?.trim() ?? "";
  if (!last) return false;
  // "Here's what was changed:", also with a full-width colon (U+FF1A).
  if (/[:\uFF1A]$/u.test(last)) return true;
  // A list item with nothing after the marker: "-", "*", "1." or "2)".
  return /^([-*+•]|\d{1,3}[.)])$/u.test(last);
}
