import { TaskStore } from "../state/taskStore";
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

export async function rejectChange(store: TaskStore, runId: string, filePath: string): Promise<PendingChange | undefined> {
  return store.setChangeStatus(runId, filePath, "rejected");
}

/** "new" for a file that did not exist, "edit" for a change to an existing one. */
export function changeKind(change: Pick<PendingChange, "original">): "new" | "edit" {
  return change.original === null ? "new" : "edit";
}
