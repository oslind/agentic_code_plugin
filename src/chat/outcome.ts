import { RunOutcome } from "../coordinator/orchestrator";
import { Run } from "../state/types";

/** Files changed by the run's finished tasks, without duplicates. */
export function changedFilesOf(run: Run): string[] {
  return [...new Set(run.tasks.filter((t) => t.status === "done").flatMap((t) => t.changedFiles ?? []))].sort();
}

/**
 * The run summary in plain words: what each sub-agent did, which files
 * changed, and what happens next. It is also a coordinator message, so the
 * coordinator reads the sub-agents' reports from it on its next turn.
 */
export function describeOutcome(run: Run, outcome: RunOutcome): string {
  const total = run.tasks.length;
  const done = outcome.done.length;
  const files = changedFilesOf(run);
  const head =
    done === total
      ? `All ${total} task(s) are done.`
      : `${done} of ${total} task(s) are done.${outcome.failed.length ? ` ${outcome.failed.length} failed.` : ""}${
          outcome.blocked.length ? ` ${outcome.blocked.length} could not start because a task they depend on failed.` : ""
        }`;
  const lines = run.tasks.map((t) => {
    const said = (t.summary ?? t.error ?? (outcome.blocked.includes(t.id) ? "did not start" : "no report")).replace(/\s+/g, " ").slice(0, 300);
    const mark = outcome.done.includes(t.id) || t.status === "done" ? "✓" : outcome.failed.includes(t.id) || t.status === "failed" || t.status === "cancelled" ? "✕" : "○";
    return `${mark} ${t.title}: ${said}`;
  });
  const next = files.length
    ? [
        `Changed files: ${files.join(", ")}.`,
        "These changes are saved on a separate branch, so your own files are untouched. Press \"Show changes\" to review them, and \"Apply to my branch\" to bring them into the branch you have checked out.",
      ]
    : ["No files were changed, so there is nothing to apply."];
  return [head, "", "What the sub-agents did:", ...lines, "", ...next].join("\n");
}
