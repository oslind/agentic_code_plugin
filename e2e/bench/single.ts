/**
 * The baseline: one plain conversation. The extension's own sub-agent loop
 * gets the user's request as its only task, may change any file in the
 * project, and has the same tools (read, search, write, run commands) and the
 * same model. There is no coordinator, planner, review or verification, and
 * the user's request is not split: what one chat with the model can do.
 *
 * Its writes are kept as drafts like a sub-agent's and applied to the project
 * when it ends (finished, failed or stopped), as the agentic run's drafts are
 * accepted, so both are scored on what they left.
 */
import { promises as fs } from "fs";
import * as path from "path";
import { ScratchCopy } from "../../src/changes/scratch";
import { OverlayFiles } from "../../src/changes/overlay";
import { ModelProvider } from "../../src/providers/types";
import { Task } from "../../src/state/types";
import { WorkspaceSandbox } from "../../src/tools/sandbox";
import { Worker } from "../../src/worker/worker";
import { RecordingProvider } from "../providers";
import { BenchTask, judge, Judged, writeProject } from "./tasks";
import { RecordedCall } from "../providers";

export interface SingleOptions {
  timeoutMs: number;
  /** Steps the one conversation may take. */
  maxTurns: number;
  log?: (message: string) => void;
  outDir?: string;
}

export interface RawAttempt {
  answer: string;
  /** Why it ended early, if it did (timed out, ran out of steps, an error). */
  ended?: string;
  judged: Judged;
  durationMs: number;
  calls: RecordedCall[];
}

/** What the answer is when the agent never said anything to the user. */
const NO_ANSWER = "";

export async function runSingle(task: BenchTask, model: ModelProvider, opts: SingleOptions): Promise<RawAttempt> {
  const log = opts.log ?? (() => {});
  const { root, tmp } = await writeProject(task.files, task.name);
  const provider = new RecordingProvider(model);
  const abort = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => abort.abort(new Error("timed out")), opts.timeoutMs);
  const events: string[] = [];
  const scratch = new ScratchCopy(root, ["bench", task.name], []);
  const overlay = new OverlayFiles(await WorkspaceSandbox.create(root));
  const now = new Date().toISOString();
  const t: Task = { id: "single", title: "The user's request", instructions: task.prompt, dependsOn: [], fileScope: ["**"], status: "running", attempts: 0, createdAt: now, updatedAt: now };
  let answer = NO_ANSWER;
  let ended: string | undefined;
  try {
    const worker = new Worker({
      provider,
      sandbox: overlay,
      checkDir: () => scratch.sync(overlay.allChanges()),
      task: t,
      checks: [],
      maxTurns: opts.maxTurns,
      compactSteps: true,
      signal: abort.signal,
      // A user who allows everything, as the agentic run's autopilot does.
      approve: async () => true,
      askUser: async () => "I have nothing to add to my request. Use your best judgment, check the project files yourself if something is unclear, and finish without asking me again.",
      log: (type, message) => {
        events.push(`[${type}] ${message}`);
        if (type === "command" || type === "tool") log(`${type}: ${message.slice(0, 160)}`);
      },
    });
    const result = await worker.run();
    answer = result.summary;
  } catch (err) {
    ended = abort.signal.aborted ? `timed out after ${Math.round((Date.now() - started) / 1000)} s` : (err as Error).message;
  } finally {
    clearTimeout(timer);
  }
  // Applied like accepted drafts, so a stopped attempt is scored on what it wrote.
  for (const [rel, text] of overlay.allChanges()) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  }
  const judged = await judge(task, root, answer);
  if (opts.outDir) {
    await fs.mkdir(opts.outDir, { recursive: true });
    await fs.writeFile(path.join(opts.outDir, "events.log"), events.join("\n") + "\n");
    await fs.writeFile(path.join(opts.outDir, "answer.md"), `${ended ? `Ended early: ${ended}\n\n` : ""}${answer}\n`);
  }
  await scratch.remove().catch(() => undefined);
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  return { answer, ended, judged, durationMs: Date.now() - started, calls: provider.calls };
}
