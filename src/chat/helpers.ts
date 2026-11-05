import { Run } from "../state/types";

/** Thinking can be long; keep enough to follow along. */
export function clip(text: string | undefined, max = 4000): string | undefined {
  text = text?.trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}\n[… cut]` : text;
}

export function title(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat || "New task";
}

export function describePlan(run: Run): string {
  return run.tasks.map((t, i) => `${i + 1}. ${t.title} (files: ${t.fileScope.join(", ")})`).join("\n");
}

export function isUnstarted(run: Run): boolean {
  return run.tasks.length > 0 && run.tasks.every((t) => t.status === "pending" && t.attempts === 0);
}

/** A model-written reason as a sentence of its own: capital first letter, full stop at the end. */
export function asSentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const s = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}
