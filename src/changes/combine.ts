import { DraftConflict, PendingChange } from "../state/types";
import { merge3 } from "./merge";

export type CombineOutcome = "replaced" | "combined" | "conflict";

/** Marker labels: the sub-agent's name, kept short. */
export const draftLabel = (title: string) => `Draft by ${title}`;
export const DISK_LABEL = "Your file on disk";

function withoutTask(ids: string[] | undefined, taskId: string): string[] | undefined {
  const out = [...new Set((ids ?? []).filter((id) => id !== taskId))];
  return out.length ? out : undefined;
}

/** A conflict with its markers worked out again for a new version of the draft. */
function refreshConflict(conflict: DraftConflict, draft: string, labels: { other: string; draft: string }): DraftConflict | undefined {
  const m = merge3(conflict.base, conflict.other, draft, { a: labels.other, b: labels.draft });
  // The new version may have taken the other side's changes on board, so there is nothing left to pick.
  return m.clean ? undefined : { ...conflict, markers: m.text, regions: m.conflicts };
}

/**
 * Two drafts of one file in the same run: `existing` waits for review, and
 * `incoming` just came from a sub-agent. If `incoming` was built on
 * `existing` it replaces it, as before. If not (two sub-agents worked on the
 * file without seeing each other's draft), the drafts are combined line by
 * line, and where both changed the same lines the draft holds a conflict for
 * the user. Either way, no sub-agent's work is dropped.
 */
export function combineDrafts(existing: PendingChange, incoming: PendingChange, titleOf: (taskId: string) => string): { change: PendingChange; outcome: CombineOutcome } {
  const label = (taskId: string) => draftLabel(titleOf(taskId));
  const kept = { original: existing.original, status: "pending" as const };
  const conflict = existing.conflict;
  const others = (also?: string) => withoutTask([...(existing.combinedWith ?? []), ...(also ? [also] : [])], incoming.taskId);

  // The other side of an open conflict sent a newer version of its own draft: the conflict is about that now.
  if (conflict?.with === "draft" && conflict.otherTaskId === incoming.taskId && incoming.basis === conflict.other) {
    const next = refreshConflict({ ...conflict, other: incoming.proposed }, existing.proposed, { other: label(incoming.taskId), draft: label(existing.taskId) });
    if (next) return { change: { ...existing, conflict: next }, outcome: "conflict" };
    const merged = merge3(conflict.base, incoming.proposed, existing.proposed);
    return { change: { ...existing, proposed: merged.text, conflict: undefined, combinedWith: withoutTask([...(existing.combinedWith ?? []), incoming.taskId], existing.taskId) }, outcome: "combined" };
  }

  // Built on the draft that waits (or nothing is known about what it was built on): it replaces it.
  if (incoming.basis === undefined || incoming.basis === existing.proposed) {
    const next = conflict && refreshConflict(conflict, incoming.proposed, { other: conflict.otherTaskId ? label(conflict.otherTaskId) : DISK_LABEL, draft: label(incoming.taskId) });
    return {
      change: { ...incoming, ...kept, combinedWith: others(existing.taskId !== incoming.taskId ? existing.taskId : undefined), conflict: next },
      outcome: next ? "conflict" : "replaced",
    };
  }

  const base = incoming.basis ?? "";
  const m = merge3(base, existing.proposed, incoming.proposed, { a: label(existing.taskId), b: label(incoming.taskId) });
  if (m.clean) {
    const next = conflict && refreshConflict(conflict, m.text, { other: conflict.otherTaskId ? label(conflict.otherTaskId) : DISK_LABEL, draft: label(incoming.taskId) });
    return {
      change: { ...incoming, ...kept, proposed: m.text, combinedWith: others(existing.taskId), conflict: next },
      outcome: next ? "conflict" : "combined",
    };
  }
  // The pending draft already had a conflict: keep every version by making the other side the
  // earlier conflict's text with its markers, so nothing is dropped.
  const other = conflict ? conflict.markers : existing.proposed;
  return {
    change: {
      ...incoming,
      ...kept,
      combinedWith: withoutTask(existing.combinedWith, existing.taskId),
      conflict: {
        with: "draft",
        otherTaskId: existing.taskId,
        base,
        other,
        markers: conflict ? merge3(base, other, incoming.proposed, { a: label(existing.taskId), b: label(incoming.taskId) }).text : m.text,
        regions: m.conflicts,
      },
    },
    outcome: "conflict",
  };
}
