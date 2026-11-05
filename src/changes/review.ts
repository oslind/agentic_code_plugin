import { latestAccepted, TaskStore } from "../state/taskStore";
import { PendingChange } from "../state/types";
import { isProtectedPath } from "../tools/policy";
import { WorkspaceSandbox } from "../tools/sandbox";

export type AcceptResult =
  | { ok: true; change: PendingChange }
  /** The file on disk is no longer what the sub-agent started from. Accept again with `overwrite` to replace it anyway. */
  | { ok: false; reason: "changed_on_disk" | "not_pending" | "protected"; message: string };

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
  const sandbox = await WorkspaceSandbox.create(workspaceRoot);
  const onDisk = await sandbox.readFile(change.path).catch(() => null);
  if (!opts.overwrite && onDisk !== change.original && onDisk !== change.proposed) {
    return {
      ok: false,
      reason: "changed_on_disk",
      message: `${filePath} changed on disk after the sub-agent read it. Accepting again replaces your newer version.`,
    };
  }
  await sandbox.writeFile(change.path, change.proposed);
  // Read back before it is marked accepted, so "Accepted" always means the file on disk holds the draft.
  const written = await sandbox.readFile(change.path).catch((err: Error) => {
    throw new Error(`${filePath} could not be read back after writing it: ${err.message}`);
  });
  if (written !== change.proposed) throw new Error(`${filePath} was written, but the file on disk does not match the draft. The draft is still waiting for review.`);
  const done = await store.setChangeStatus(runId, change.path, "accepted", opts.auto);
  return { ok: true, change: done ?? change };
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
