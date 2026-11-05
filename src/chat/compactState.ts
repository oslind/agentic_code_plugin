import { ChatEntry } from "./types";

/**
 * Where a conversation stands after its latest compaction. Kept apart from
 * compaction.ts so the coordinator prompt can read it without importing the
 * summarizing call.
 */
export interface Compaction {
  summary: string;
  /** Id of the first entry the coordinator still gets in full. */
  keepFrom: string;
}

/**
 * The latest compaction of a conversation, from its newest compaction note.
 * Undefined when it was never compacted.
 */
export function compactionOf(entries: ChatEntry[]): Compaction | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const c = entries[i]!.kind === "compact" ? entries[i]!.compaction : undefined;
    if (c?.summary.trim()) return { summary: c.summary, keepFrom: c.keepFrom };
  }
  return undefined;
}

/**
 * The entries from the first one kept in full: what the coordinator gets
 * after the summary. When that entry is gone, a long conversation was
 * trimmed from its oldest end (conversationStore keeps the note itself), so
 * every entry left came after it.
 */
export function liveEntries(entries: ChatEntry[], compaction: Compaction | undefined): ChatEntry[] {
  if (!compaction) return entries;
  const at = entries.findIndex((e) => e.id === compaction.keepFrom);
  return at < 0 ? entries : entries.slice(at);
}
