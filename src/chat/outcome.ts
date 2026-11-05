import { RunOutcome } from "../coordinator/orchestrator";
import { Run } from "../state/types";

/** Files changed by the run's finished tasks, without duplicates. */
export function changedFilesOf(run: Run): string[] {
  const fromTasks = run.tasks.filter((t) => t.status === "done").flatMap((t) => t.changedFiles ?? []);
  return [...new Set([...fromTasks, ...(run.changes ?? []).map((c) => c.path)])].sort();
}

/**
 * The run summary in plain words: what each sub-agent did, which files
 * changed, and what happens next. It is also a coordinator message, so the
 * coordinator reads the sub-agents' reports from it on its next turn.
 */
export function describeOutcome(run: Run, outcome: RunOutcome, stopped = false): string {
  const total = run.tasks.length;
  const done = outcome.done.length;
  const files = changedFilesOf(run);
  const head = stopped
    ? `You stopped the run. ${done} of ${total} task(s) had finished.`
    : done === total
      ? `All ${total} task(s) are done.`
      : `${done} of ${total} task(s) are done.${outcome.failed.length ? ` ${outcome.failed.length} failed.` : ""}${
          outcome.blocked.length ? ` ${outcome.blocked.length} could not start because a task they depend on failed.` : ""
        }`;
  const lines = run.tasks.map((t) => {
    const said = (t.summary ?? t.error ?? (outcome.blocked.includes(t.id) ? "did not start" : "no report")).replace(/\s+/g, " ").slice(0, 300);
    const mark = outcome.done.includes(t.id) || t.status === "done" ? "✓" : outcome.failed.includes(t.id) || t.status === "failed" || t.status === "cancelled" ? "✕" : "○";
    return `${mark} ${t.title}: ${said}`;
  });
  const changes = run.changes ?? [];
  const waiting = changes.filter((c) => c.status === "pending").length;
  const accepted = changes.filter((c) => c.status === "accepted").length;
  const rejected = changes.filter((c) => c.status === "rejected").length;
  const next = files.length
    ? [
        `Files with drafts: ${files.join(", ")}.`,
        waiting
          ? `${waiting} draft(s) wait for your review under Changes. Nothing is written to your project until you press Accept.${accepted ? ` ${accepted} already accepted and written.` : ""}`
          : `${accepted} draft(s) accepted and written to your project.${rejected ? ` ${rejected} rejected.` : ""}`,
      ]
    : ["No files were drafted."];
  return [head, "", "What the sub-agents did:", ...lines, "", ...next].join("\n");
}
