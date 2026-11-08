/**
 * Scores a finished benchmark run's answers again with the current checks, without a model:
 * `AGENTIC_BENCH_RESCORE=e2e/results/<run>-bench npm run bench:rescore`. Only questions are scored again,
 * since they are judged on the saved answer alone; change tasks keep their score, because the project
 * they were judged on is gone. Writes scoreboard-rescored.md next to the original scoreboard.
 */
import { promises as fs } from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { Attempt, scoreboard } from "./bench/scoreboard";
import { BENCH_TASKS } from "./bench/tasks";

const dir = process.env.AGENTIC_BENCH_RESCORE ? path.resolve(process.env.AGENTIC_BENCH_RESCORE) : undefined;

/** The attempts with every question scored again from its saved answer, and what changed. */
export async function rescore(attempts: Attempt[]): Promise<{ attempts: Attempt[]; changed: string[] }> {
  const changed: string[] = [];
  const out: Attempt[] = [];
  for (const a of attempts) {
    const task = BENCH_TASKS.find((t) => t.name === a.task);
    if (!task || task.kind !== "question") {
      out.push(a);
      continue;
    }
    const parts = await task.score({ answer: a.answer, read: async () => undefined, sh: async () => ({ code: 1, output: "not available when scoring again" }) });
    const score = parts.length ? parts.filter((p) => p.ok).length / parts.length : 0;
    if (score !== a.score) changed.push(`${a.task} ${a.mode} #${a.repeat}: ${Math.round(a.score * 100)}% -> ${Math.round(score * 100)}%`);
    out.push({ ...a, score, parts });
  }
  return { attempts: out, changed };
}

describe.skipIf(!dir)("scoring a benchmark run again", () => {
  it("rescores the saved answers", async () => {
    const text = await fs.readFile(path.join(dir!, "attempts.jsonl"), "utf8");
    const attempts = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Attempt);
    const { attempts: again, changed } = await rescore(attempts);
    const board = scoreboard(again, { model: "rescored from attempts.jsonl", time: new Date().toISOString() });
    const note = changed.length ? `Scored again with the current checks:\n${changed.map((c) => `- ${c}`).join("\n")}\n\n` : "No score changed.\n\n";
    await fs.writeFile(path.join(dir!, "scoreboard-rescored.md"), note + board);
    console.log(`\n${note}${board}\n[bench] written: ${path.join(dir!, "scoreboard-rescored.md")}\n`);
    expect(again).toHaveLength(attempts.length);
  });
});
