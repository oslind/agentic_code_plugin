import { safeFileName } from "./untrusted";

/**
 * Rough token estimate. Real tokenizers vary by model; for code and English
 * about 3.5 characters per token is a safe overestimate for Qwen-family models.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export interface ContextSection {
  name: string;
  text: string;
  /** Higher is kept first. Sections with `required` are never dropped. */
  priority: number;
  required?: boolean;
  /**
   * Puts the text in its frame, such as an untrusted-data fence. A section
   * that must be cut is cut inside the frame, so the fence always closes.
   */
  wrap?: (text: string) => string;
}

export interface FittedContext {
  text: string;
  tokens: number;
  dropped: string[];
  truncated: string[];
}

/**
 * Packs sections into a token budget. Required sections always go in.
 * Others are added by priority; the first one that doesn't fit is cut at a
 * line boundary, and the rest are dropped. Output keeps the original order.
 */
export function fitToBudget(sections: ContextSection[], budgetTokens: number): FittedContext {
  const order = new Map(sections.map((s, i) => [s, i]));
  const kept = new Map<ContextSection, string>();
  let used = 0;
  const framed = (s: ContextSection, text: string) => (s.wrap ? s.wrap(text) : text);
  for (const s of sections.filter((x) => x.required)) {
    kept.set(s, framed(s, s.text));
    used += estimateTokens(framed(s, s.text));
  }
  const dropped: string[] = [];
  const truncated: string[] = [];
  const optional = sections.filter((x) => !x.required).sort((a, b) => b.priority - a.priority);
  for (const s of optional) {
    const full = framed(s, s.text);
    const cost = estimateTokens(full);
    if (used + cost <= budgetTokens) {
      kept.set(s, full);
      used += cost;
      continue;
    }
    const room = budgetTokens - used - (s.wrap ? estimateTokens(s.wrap("")) : 0);
    const cut = truncateToTokens(s.text, room);
    if (cut) {
      kept.set(s, framed(s, cut));
      used += estimateTokens(framed(s, cut));
      truncated.push(s.name);
    } else {
      dropped.push(s.name);
    }
  }
  const text = [...kept]
    .sort(([a], [b]) => order.get(a)! - order.get(b)!)
    .map(([, t]) => t)
    .join("\n\n");
  return { text, tokens: used, dropped, truncated };
}

const MARKER = "\n[... truncated to fit the context window]";

export function truncateToTokens(text: string, tokens: number): string | undefined {
  const maxChars = Math.floor(tokens * 3.5) - MARKER.length;
  if (maxChars < 80) return undefined;
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastLine = slice.lastIndexOf("\n");
  return (lastLine > maxChars / 2 ? slice.slice(0, lastLine) : slice) + MARKER;
}

/** A compact, indented listing of workspace files, cheaper in tokens than full paths. */
export function fileTree(files: string[]): string {
  const sorted = [...files].sort();
  const lines: string[] = [];
  let prev: string[] = [];
  for (const f of sorted) {
    const parts = f.split("/");
    let common = 0;
    while (common < parts.length - 1 && common < prev.length - 1 && parts[common] === prev[common]) common++;
    for (let i = common; i < parts.length; i++) {
      // Names are escaped: a name with a line break must not start a line of its own.
      lines.push("  ".repeat(i) + safeFileName(parts[i]!) + (i < parts.length - 1 ? "/" : ""));
    }
    prev = parts;
  }
  return lines.join("\n");
}
