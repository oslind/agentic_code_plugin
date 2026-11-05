/**
 * End-to-end scenarios against a real model. Opt-in: `npm run e2e` with
 * AGENTIC_E2E_MODEL set (see docs/e2e.md), or `npm run e2e:replay` to play
 * back saved recordings without a model. Skipped otherwise, so CI and
 * `npm test` never need a model server.
 */
import { promises as fs } from "fs";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScenario, ScenarioResult } from "./harness";
import { isOllama, liveConfigFromEnv, liveProvider, loadRecording, ollamaContextLength, ReplayProvider, saveRecording, unloadOllama } from "./providers";
import { SCENARIOS } from "./scenarios";

const env = process.env;
const live = liveConfigFromEnv(env);
const replay = !live && env.AGENTIC_E2E_REPLAY === "1";
const only = (env.AGENTIC_E2E_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const scenarios = SCENARIOS.filter((s) => !only.length || only.includes(s.name));
const minutes = (name: string, fallback: number) => (Number(env[name]) || fallback) * 60000;
const stallMs = minutes("AGENTIC_E2E_STALL_MIN", 3);
const silenceMs = minutes("AGENTIC_E2E_SILENCE_MIN", 5);
const timeoutMs = minutes("AGENTIC_E2E_TIMEOUT_MIN", replay ? 2 : 30);

const E2E_DIR = __dirname;
const RECORDINGS = path.join(E2E_DIR, "recordings");
const RESULTS = path.join(E2E_DIR, "results");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = path.join(RESULTS, `${stamp}-${replay ? "replay" : "live"}`);
const results: ScenarioResult[] = [];
const log = (message: string) => {
  if (env.AGENTIC_E2E_QUIET !== "1") console.log(`[e2e] ${message}`);
};

interface Summary {
  time: string;
  mode: "live" | "replay";
  model: string;
  scenarios: { name: string; passed: boolean; minutes: number; modelCalls: number; failures: string[] }[];
}

/** One line per run in docs/local-llm/offload-log.md, as Oskar logs every local model job. */
async function appendOffloadLog(summary: Summary, unload: string): Promise<void> {
  const file = path.join(E2E_DIR, "..", "docs", "local-llm", "offload-log.md");
  const passed = summary.scenarios.filter((s) => s.passed).length;
  const total = summary.scenarios.reduce((n, s) => n + s.minutes, 0);
  const line = `| ${summary.time.slice(0, 16).replace("T", " ")} | ${summary.model} | e2e: ${summary.scenarios.map((s) => s.name).join(", ")} | ${passed}/${summary.scenarios.length} passed, ${total.toFixed(1)} min, ${unload} |\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, line);
}

describe.skipIf(!live && !replay)(`end-to-end with ${live ? live.model : "recorded replies"}`, () => {
  beforeAll(async () => {
    if (!live) return;
    log(`model ${live.model} at ${live.baseUrl}, context ${live.contextWindow}, scenarios: ${scenarios.map((s) => s.name).join(", ")}`);
    const res = await fetch(`${live.baseUrl}/models`, { headers: live.apiKey ? { authorization: `Bearer ${live.apiKey}` } : {}, signal: AbortSignal.timeout(10000) }).catch((err: Error) => err);
    if (res instanceof Error || !res.ok) throw new Error(`The model server at ${live.baseUrl} does not answer (${res instanceof Error ? res.message : res.status}). Start it, or set AGENTIC_E2E_BASE_URL.`);
    if (await isOllama(live.baseUrl)) log("Ollama detected: the model is unloaded (keep_alive 0) when the suite ends.");
  });

  afterAll(async () => {
    if (!results.length) return;
    const summary: Summary = {
      time: new Date().toISOString(),
      mode: replay ? "replay" : "live",
      model: live?.model ?? "replay",
      scenarios: results.map((r) => ({ name: r.name, passed: r.passed, minutes: Math.round(r.durationMs / 6000) / 10, modelCalls: r.modelCalls, failures: r.failures })),
    };
    // Compared with the previous run of the same kind, so a regression stands out.
    const latestFile = path.join(RESULTS, `latest-${summary.mode}.json`);
    const previous = await fs
      .readFile(latestFile, "utf8")
      .then((t) => JSON.parse(t) as Summary)
      .catch(() => undefined);
    const lines = summary.scenarios.map((s) => {
      const before = previous?.scenarios.find((p) => p.name === s.name);
      const change = !before ? "" : before.passed && !s.passed ? "  REGRESSED" : !before.passed && s.passed ? "  fixed" : "";
      return `${s.passed ? "PASS" : "FAIL"}  ${s.name.padEnd(20)} ${String(s.minutes).padStart(5)} min  ${String(s.modelCalls).padStart(4)} calls${change}`;
    });
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    await fs.writeFile(latestFile, JSON.stringify(summary, null, 2) + "\n");
    console.log(`\n[e2e] ${summary.mode} run with ${summary.model}\n${lines.join("\n")}\n[e2e] transcripts: ${runDir}\n`);
    if (live) {
      const unload = env.AGENTIC_E2E_KEEP_LOADED === "1" ? "model left loaded" : await unloadOllama(live.baseUrl, live.model);
      log(unload);
      if (env.AGENTIC_E2E_NO_LOG !== "1") await appendOffloadLog(summary, unload);
    }
  });

  for (const scenario of scenarios) {
    it(scenario.name, { timeout: timeoutMs + 120000 }, async () => {
      const outDir = path.join(runDir, scenario.name);
      const recordingFile = path.join(RECORDINGS, `${scenario.name}.jsonl`);
      let provider;
      if (live) {
        provider = liveProvider({ ...live, ...scenario.model }, log);
        const ctx = await ollamaContextLength(live.baseUrl, live.model);
        if (ctx && ctx < live.contextWindow) log(`warning: Ollama runs ${live.model} with a ${ctx}-token context, below AGENTIC_E2E_CONTEXT=${live.contextWindow}. Long prompts are cut off; see docs/e2e.md.`);
      } else {
        const recorded = await loadRecording(recordingFile);
        if (!recorded) return void log(`${scenario.name}: no recording in e2e/recordings, skipped`);
        provider = new ReplayProvider(recorded);
      }
      log(`${scenario.name}: starting`);
      const result = await runScenario(scenario, provider, { stallMs, silenceMs, timeoutMs, maxParallel: Number(env.AGENTIC_E2E_PARALLEL) || 1, outDir, log: (m) => log(`${scenario.name}: ${m}`) });
      results.push(result);
      await saveRecording(path.join(outDir, "model-calls.jsonl"), result.calls);
      if (provider instanceof ReplayProvider && provider.drift.length) log(`${scenario.name}: ${provider.drift.length} prompt(s) changed since the recording (replies still played in order)`);
      // A passing live run can become the recording that replays use.
      if (live && result.passed && env.AGENTIC_E2E_RECORD === "1") await saveRecording(recordingFile, result.calls);
      log(`${scenario.name}: ${result.passed ? "passed" : "FAILED"} in ${Math.round(result.durationMs / 1000)} s, ${result.modelCalls} model calls`);
      expect(result.failures, `${scenario.name} failed; transcript in ${outDir}`).toEqual([]);
    });
  }
});
