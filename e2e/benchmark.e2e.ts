/**
 * The benchmark: each task done by one plain conversation and by the agentic
 * chat, with the same model, project and time limit, scored by hidden checks.
 * Opt-in and live only: `npm run bench` with AGENTIC_E2E_MODEL set (see
 * docs/e2e.md). Attempts are saved one by one, so an interrupted run can be
 * continued with AGENTIC_BENCH_RESUME.
 */
import { promises as fs } from "fs";
import * as path from "path";
import { describe, it } from "vitest";
import { runScenario } from "./harness";
import { isOllama, liveConfigFromEnv, liveProvider, unloadOllama } from "./providers";
import { Attempt, Mode, scoreboard, usageOf } from "./bench/scoreboard";
import { runSingle } from "./bench/single";
import { BENCH_TASKS, BenchTask, judge, Judged } from "./bench/tasks";

const env = process.env;
const live = env.AGENTIC_BENCH === "1" ? liveConfigFromEnv(env) : undefined;
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const only = list(env.AGENTIC_BENCH_ONLY);
const tasks = BENCH_TASKS.filter((t) => !only.length || only.includes(t.name));
const modes = (list(env.AGENTIC_BENCH_MODES).length ? list(env.AGENTIC_BENCH_MODES) : ["single", "agentic"]) as Mode[];
const repeats = Number(env.AGENTIC_BENCH_REPEATS) || 3;
const timeoutMs = (Number(env.AGENTIC_BENCH_TIMEOUT_MIN) || 30) * 60000;
const singleTurns = Number(env.AGENTIC_BENCH_SINGLE_TURNS) || 60;

const RESULTS = path.join(__dirname, "results");
const runDir = env.AGENTIC_BENCH_RESUME ? path.resolve(env.AGENTIC_BENCH_RESUME) : path.join(RESULTS, `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-bench`);
const attemptsFile = path.join(runDir, "attempts.jsonl");
const log = (message: string) => console.log(`[bench] ${message}`);

async function loadAttempts(): Promise<Attempt[]> {
  const text = await fs.readFile(attemptsFile, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Attempt);
}

async function runAgentic(task: BenchTask, outDir: string): Promise<{ answer: string; ended?: string; judged: Judged; durationMs: number; calls: Parameters<typeof usageOf>[0] }> {
  let judged: Judged | undefined;
  const result = await runScenario(
    {
      name: task.name,
      description: `benchmark task ${task.name}`,
      mode: "act",
      files: task.files,
      prompts: [task.prompt],
      endStatus: ["finished", "partial", "failed", "stopped"],
      endsWithAnswer: false,
      expect: () => [],
    },
    liveProvider(live!, log),
    {
      stallMs: 3 * 60000,
      silenceMs: 5 * 60000,
      timeoutMs,
      maxParallel: Number(env.AGENTIC_E2E_PARALLEL) || 1,
      outDir,
      log: (m) => log(`${task.name} agentic: ${m}`),
      inspect: async (run) => {
        judged = await judge(task, run.workspace, run.lastCoordinator?.text ?? "");
      },
    },
  );
  const ended = result.failures.length ? result.failures.join("; ").slice(0, 500) : undefined;
  return { answer: result.answer ?? "", ended, judged: judged ?? judgeNothing(), durationMs: result.durationMs, calls: result.calls };
}

/** When the harness failed before the project could be looked at: nothing counts. */
function judgeNothing(): Judged {
  return { score: 0, parts: [{ name: "the run could not be scored", ok: false }], collateral: [], deleted: [], created: [], falseDone: false };
}

describe.skipIf(!live)(`benchmark with ${live?.model ?? "no model"}`, () => {
  it("runs every task in every mode", { timeout: 0 }, async () => {
    if (!live) return;
    await fs.mkdir(runDir, { recursive: true });
    const done = await loadAttempts();
    const ollama = await isOllama(live.baseUrl);
    log(`model ${live.model}, ${tasks.length} task(s) x ${modes.join("+")} x ${repeats}, results in ${runDir}${done.length ? ` (continuing: ${done.length} attempt(s) already done)` : ""}`);
    const started = Date.now();
    try {
      // Modes take turns on every task, so a slower or faster hour of the GPU affects both alike.
      for (let repeat = 1; repeat <= repeats; repeat++) {
        for (const task of tasks) {
          for (const mode of modes) {
            if (done.some((a) => a.task === task.name && a.mode === mode && a.repeat === repeat)) continue;
            log(`${task.name} ${mode} #${repeat}: starting`);
            const outDir = path.join(runDir, `${task.name}-${mode}-${repeat}`);
            const raw = mode === "single" ? await runSingle(task, liveProvider(live, log), { timeoutMs, maxTurns: singleTurns, outDir, log: (m) => log(`${task.name} single: ${m}`) }) : await runAgentic(task, outDir);
            const attempt: Attempt = {
              task: task.name,
              group: task.group,
              kind: task.kind,
              files: task.size.files,
              asks: task.size.asks,
              mode,
              repeat,
              score: raw.judged.score,
              parts: raw.judged.parts,
              collateral: raw.judged.collateral,
              deleted: raw.judged.deleted,
              created: raw.judged.created,
              falseDone: raw.judged.falseDone,
              minutes: Math.round(raw.durationMs / 6000) / 10,
              ...usageOf(raw.calls),
              ended: raw.ended,
              answer: raw.answer.slice(0, 4000),
            };
            done.push(attempt);
            await fs.appendFile(attemptsFile, JSON.stringify(attempt) + "\n");
            log(`${task.name} ${mode} #${repeat}: score ${Math.round(attempt.score * 100)}% in ${attempt.minutes} min, ${attempt.modelCalls} calls${attempt.falseDone ? ", FALSE DONE" : ""}${attempt.collateral.length ? `, collateral: ${attempt.collateral.join(", ")}` : ""}${attempt.ended ? `, ended: ${attempt.ended.slice(0, 120)}` : ""}`);
          }
        }
      }
    } finally {
      const time = new Date().toISOString();
      const board = scoreboard(done, { model: live.model, time });
      await fs.writeFile(path.join(runDir, "scoreboard.md"), board);
      await fs.writeFile(path.join(runDir, "summary.json"), JSON.stringify({ time, model: live.model, modes, repeats, tasks: tasks.map((t) => t.name), attempts: done }, null, 2) + "\n");
      console.log(`\n${board}\n[bench] results: ${runDir}\n`);
      if (ollama && env.AGENTIC_E2E_KEEP_LOADED !== "1") {
        const unload = await unloadOllama(live.baseUrl, live.model);
        log(unload);
        if (env.AGENTIC_E2E_NO_LOG !== "1") {
          const file = path.join(__dirname, "..", "docs", "local-llm", "offload-log.md");
          const minutes = ((Date.now() - started) / 60000).toFixed(1);
          await fs.appendFile(file, `| ${time.slice(0, 16).replace("T", " ")} | ${live.model} | benchmark: ${tasks.length} task(s) x ${modes.join("+")} x ${repeats} | ${done.length} attempt(s), ${minutes} min, ${unload} |\n`);
        }
      }
    }
  });
});
