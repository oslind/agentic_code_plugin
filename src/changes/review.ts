import { latestAccepted, TaskStore } from "../state/taskStore";
import { ConflictChoice, PendingChange } from "../state/types";
import { DISK_LABEL, draftLabel } from "./combine";
import { merge3 } from "./merge";
import { isProtectedPath } from "../tools/policy";
import { WorkspaceSandbox } from "../tools/sandbox";

export type AcceptResult =
  /** `combined`: the file had changed on disk, and the draft was combined with the newer version. */
  | { ok: true; change: PendingChange; combined?: boolean }
  /**
   * changed_on_disk: the file was removed on disk since the sub-agent read it; accept again with `overwrite` to write it anyway.
   * conflict: the draft and another version changed the same lines; the user resolves it first (see resolveConflict).
   */
  | { ok: false; reason: "changed_on_disk" | "conflict" | "not_pending" | "protected"; message: string };

/**
 * Writes one pending change to the project. This is the only place a
 * sub-agent's work reaches the user's files, and it goes through the same
 * workspace sandbox as everything else.
 */
export async function acceptChange(
  store: TaskStore,
  runId: string,
  filePath: string,
  workspaceRoot: string,
  opts: { overwrite?: boolean; auto?: boolean } = {},
): Promise<AcceptResult> {
  const run = await store.load(runId);
  const change = run.changes?.find((c) => c.path === filePath && c.status === "pending");
  if (!change) return { ok: false, reason: "not_pending", message: `${filePath} has no pending change.` };
  if (isProtectedPath(change.path)) return { ok: false, reason: "protected", message: `${filePath} is protected and is never written.` };
  if (change.conflict) return { ok: false, reason: "conflict", message: conflictMessage(change) };
  const sandbox = await WorkspaceSandbox.create(workspaceRoot);
  const onDisk = await sandbox.readFile(change.path).catch(() => null);
  let text = change.proposed;
  let combined = false;
  if (!opts.overwrite && onDisk !== change.original && onDisk !== change.proposed) {
    if (onDisk === null) {
      return {
        ok: false,
        reason: "changed_on_disk",
        message: `${filePath} was removed from disk after the sub-agent read it. Accepting again writes the draft anyway.`,
      };
    }
    // Someone changed the file since the sub-agent read it: you, another run's accepted draft, or a tool.
    // Both versions are combined; where they changed the same lines, the user decides.
    const title = run.tasks.find((t) => t.id === change.taskId)?.title ?? change.taskId;
    const m = merge3(change.original ?? "", onDisk, change.proposed, { a: DISK_LABEL, b: draftLabel(title) });
    if (!m.clean) {
      const held = await store.patchChange(runId, change.path, { conflict: { with: "disk", other: onDisk, base: change.original ?? "", markers: m.text, regions: m.conflicts } });
      await store.log({ runId, taskId: change.taskId, type: "disk_conflict", message: change.path, data: { path: change.path, regions: m.conflicts } });
      return { ok: false, reason: "conflict", message: conflictMessage(held ?? change) };
    }
    text = m.text;
    combined = true;
  }
  await sandbox.writeFile(change.path, text);
  // Read back before it is marked accepted, so "Accepted" always means the file on disk holds the draft.
  const written = await sandbox.readFile(change.path).catch((err: Error) => {
    throw new Error(`${filePath} could not be read back after writing it: ${err.message}`);
  });
  if (written !== text) throw new Error(`${filePath} was written, but the file on disk does not match the draft. The draft is still waiting for review.`);
  // What was written is what the change records, so its diff and "Open file" show the same text.
  if (combined) await store.patchChange(runId, change.path, { proposed: text, original: onDisk, combinedWithDisk: true });
  const done = await store.setChangeStatus(runId, change.path, "accepted", opts.auto);
  return { ok: true, change: done ?? change, combined };
}

/** Why a draft with a conflict cannot be accepted yet, and what to do. */
export function conflictMessage(change: Pick<PendingChange, "path" | "conflict">): string {
  const n = change.conflict?.regions ?? 1;
  const where = n === 1 ? "one place" : `${n} places`;
  return change.conflict?.with === "disk"
    ? `${change.path} changed on disk after the sub-agent read it, and both changed the same lines in ${where}. Under Drafts, keep your file, keep the draft, or keep both with conflict markers.`
    : `Two sub-agents changed the same lines of ${change.path} in ${where}. Under Drafts, keep one draft, or keep both with conflict markers.`;
}

/**
 * Settles a conflict the way the user picked. The result is an ordinary
 * draft again that waits for Accept, except "other" on a conflict with the
 * file on disk, which keeps the file as it is and rejects the draft.
 */
export async function resolveConflict(store: TaskStore, runId: string, filePath: string, choice: ConflictChoice): Promise<PendingChange | undefined> {
  const run = await store.load(runId);
  const change = run.changes?.find((c) => c.path === filePath && c.status === "pending");
  const conflict = change?.conflict;
  if (!change || !conflict) return undefined;
  const log = (kept: string) => store.log({ runId, taskId: change.taskId, type: "conflict_resolved", message: filePath, data: { path: filePath, choice, kept } });
  if (conflict.with === "disk") {
    if (choice === "other") {
      await store.patchChange(runId, filePath, { conflict: undefined });
      await log("disk");
      return rejectChange(store, runId, filePath);
    }
    // Compared with the file as it is now, so Accept writes it without another "changed on disk".
    const done = await store.patchChange(runId, filePath, { conflict: undefined, original: conflict.other, proposed: choice === "both" ? conflict.markers : change.proposed });
    await log(choice);
    return done;
  }
  const otherId = conflict.otherTaskId ?? change.taskId;
  const patch: Partial<PendingChange> =
    choice === "other"
      ? { conflict: undefined, proposed: conflict.other, taskId: otherId, combinedWith: undefined }
      : choice === "draft"
        ? { conflict: undefined }
        : { conflict: undefined, proposed: conflict.markers, combinedWith: [...new Set([...(change.combinedWith ?? []), otherId])].filter((id) => id !== change.taskId) };
  const done = await store.patchChange(runId, filePath, patch);
  await log(choice);
  return done;
}

export type RevertResult =
  | { ok: true; change: PendingChange; deleted: boolean }
  /** The file on disk is no longer the accepted draft. Revert again with `overwrite` to put the old version back anyway. */
  | { ok: false; reason: "changed_on_disk" | "not_accepted" | "protected"; message: string };

/**
 * Undoes an accept: puts the file back as it was before the sub-agent's
 * draft was written, or deletes it if the draft created it. Only the newest
 * accepted change of a file can be reverted, because that is the one on
 * disk; older accepts of the same file come back one at a time. Nothing
 * outside the project is touched, and git is not used.
 */
export async function revertChange(
  store: TaskStore,
  runId: string,
  filePath: string,
  workspaceRoot: string,
  opts: { overwrite?: boolean } = {},
): Promise<RevertResult> {
  const run = await store.load(runId);
  const change = latestAccepted(run.changes, filePath);
  if (!change) return { ok: false, reason: "not_accepted", message: `${filePath} has no accepted change to revert.` };
  if (isProtectedPath(change.path)) return { ok: false, reason: "protected", message: `${filePath} is protected and is never written.` };
  const sandbox = await WorkspaceSandbox.create(workspaceRoot);
  const onDisk = await sandbox.readFile(change.path).catch(() => null);
  if (!opts.overwrite && onDisk !== change.proposed && onDisk !== change.original) {
    return {
      ok: false,
      reason: "changed_on_disk",
      message:
        change.original === null
          ? `${filePath} changed on disk after it was accepted. Reverting again deletes it, with your newer edits.`
          : `${filePath} changed on disk after it was accepted. Reverting again puts back the version from before the accept, and your newer edits are lost.`,
    };
  }
  const deleted = change.original === null;
  const exists = () => sandbox.resolveExisting(change.path).then(() => true, () => false);
  if (deleted) {
    if (await exists()) await sandbox.deleteFile(change.path);
    if (await exists()) throw new Error(`${filePath} could not be deleted. The accept is not reverted.`);
  } else {
    await sandbox.writeFile(change.path, change.original!);
    const back = await sandbox.readFile(change.path).catch((err: Error) => {
      throw new Error(`${filePath} could not be read back after reverting it: ${err.message}`);
    });
    if (back !== change.original) throw new Error(`${filePath} was written, but the file on disk does not match the version from before the accept.`);
  }
  const done = await store.markReverted(runId, change.path);
  return { ok: true, change: done ?? change, deleted };
}

export async function rejectChange(store: TaskStore, runId: string, filePath: string): Promise<PendingChange | undefined> {
  return store.setChangeStatus(runId, filePath, "rejected");
}

/** "new" for a file that did not exist, "edit" for a change to an existing one. */
export function changeKind(change: Pick<PendingChange, "original">): "new" | "edit" {
  return change.original === null ? "new" : "edit";
}
