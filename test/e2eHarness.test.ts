/**
 * Keeps the real-model harness working in CI, where there is no model: a fake
 * model that answers by request kind drives one scenario through the harness,
 * a recording of it replays, and a model that never answers is caught.
 */
import { spawnSync } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runScenario } from "../e2e/harness";
import { liveConfigFromEnv, RecordingProvider, ReplayProvider } from "../e2e/providers";
import { SCENARIOS } from "../e2e/scenarios";
import { ChatRequest, ModelProvider } from "../src/providers/types";

/** Answers like a model that does the research scenario right, whatever order the calls come in. */
function fakeModel(): ModelProvider {
  let turns = 0;
  return {
    model: "fake",
    contextWindow: 16384,
    async chat(req: ChatRequest) {
      switch (req.jsonSchema?.name) {
        case "coordinator_turn":
          return turns++ === 0
            ? { content: JSON.stringify({ reply: "I'll have a sub-agent read the project.", action: "research", request: "", questions: ["Which file sets the heating target, and what is the default?"] }) }
            : { content: JSON.stringify({ reply: "src/thermostat.js sets it; the default is 21.", action: "none", request: "" }) };
        case "worker_turn":
          return { content: JSON.stringify({ thought: "Found it.", call: { tool: "finish", summary: "src/thermostat.js sets the target: DEFAULT_TARGET = 21, 18 at night." } }) };
        case "answer_check":
          return { content: JSON.stringify({ answered: "yes", missing: [] }) };
        case undefined:
          return { content: "The heating target is set in src/thermostat.js. The default target is 21 degrees (18 in night mode)." };
        default:
          throw new Error(`unexpected request kind ${req.jsonSchema?.name}`);
      }
    },
  };
}

const research = SCENARIOS.find((s) => s.name === "research-answer")!;
let out: string;
beforeEach(async () => {
  out = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-e2e-self-"));
});
afterEach(async () => {
  await fs.rm(out, { recursive: true, force: true });
});

describe("end-to-end harness", () => {
  it("runs a scenario through the real controller and checks it, writing a transcript", async () => {
    const result = await runScenario(research, fakeModel(), { stallMs: 10000, timeoutMs: 20000, maxParallel: 1, outDir: out });
    expect(result.failures).toEqual([]);
    expect(result.done?.status).toBe("finished");
    expect(result.calls.map((c) => c.request.schema)).toContain("worker_turn");
    const transcript = await fs.readFile(path.join(out, "transcript.md"), "utf8");
    expect(transcript).toMatch(/^# research-answer: passed/);
    expect(transcript).toMatch(/src\/thermostat\.js/);
  });

  it("fails a scenario whose answer is wrong, saying why", async () => {
    const wrong: ModelProvider = {
      ...fakeModel(),
      chat: (() => {
        const inner = fakeModel();
        return async (req: ChatRequest) => (req.jsonSchema ? inner.chat(req) : { content: "I could not find it." });
      })(),
    };
    const result = await runScenario(research, wrong, { stallMs: 10000, timeoutMs: 20000, maxParallel: 1 });
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/does not mention src\/thermostat\.js/);
  });

  it("replays a recorded run without a model", async () => {
    const recorded = await runScenario(research, fakeModel(), { stallMs: 10000, timeoutMs: 20000, maxParallel: 1 });
    const replay = new ReplayProvider(recorded.calls);
    const result = await runScenario(research, replay, { stallMs: 10000, timeoutMs: 20000, maxParallel: 1 });
    expect(result.failures).toEqual([]);
    expect(replay.used).toBe(recorded.calls.length);
  });

  it("says the flow changed when a replay runs out of recorded replies", async () => {
    const recorded = await runScenario(research, fakeModel(), { stallMs: 10000, timeoutMs: 20000, maxParallel: 1 });
    const result = await runScenario(research, new ReplayProvider(recorded.calls.slice(0, 1)), { stallMs: 10000, timeoutMs: 20000, maxParallel: 1 });
    expect(result.passed).toBe(false);
  });

  it("stops a scenario whose model never answers, and reports where it was", async () => {
    const hung: ModelProvider = {
      model: "hung",
      contextWindow: 16384,
      chat: (req) => new Promise((_resolve, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    };
    const started = Date.now();
    const result = await runScenario(research, hung, { stallMs: 60000, timeoutMs: 1500, maxParallel: 1 });
    expect(Date.now() - started).toBeLessThan(15000);
    expect(result.failures[0]).toMatch(/^timed out after \d+ s\. Last entry before it was stopped: user/);
  });

  it("stops a scenario whose model request goes silent, long before the scenario timeout", async () => {
    const hung: ModelProvider = {
      model: "hung",
      contextWindow: 16384,
      chat: (req) => new Promise((_resolve, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    };
    const result = await runScenario(research, hung, { stallMs: 60000, silenceMs: 1500, timeoutMs: 60000, maxParallel: 1 });
    expect(result.failures[0]).toMatch(/^model request silent: call 1 sent nothing back for \d+ s/);
    expect(result.durationMs).toBeLessThan(15000);
  });

  it("counts a model call in flight as activity, but nothing at all as a stall", async () => {
    const p = new RecordingProvider(fakeModel());
    const before = p.lastActivity;
    await p.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(p.inFlight).toBe(0);
    expect(p.lastActivity).toBeGreaterThanOrEqual(before);
    expect(p.calls[0]).toMatchObject({ n: 1, response: { content: expect.any(String) } });
  });

  it("starts every scenario from a project whose only failing test is the one the fix scenario fixes", async () => {
    for (const [rel, text] of Object.entries(research.files)) {
      await fs.mkdir(path.dirname(path.join(out, rel)), { recursive: true });
      await fs.writeFile(path.join(out, rel), text);
    }
    const run = spawnSync(process.execPath, ["test.js"], { cwd: out, encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/FAIL average of three/);
    expect(run.stdout).toMatch(/4 passed, 1 failed/);
    expect(new Set(SCENARIOS.map((s) => s.name)).size).toBe(SCENARIOS.length);
  });

  it("is off unless a model is named, with Ollama's address as the default", () => {
    expect(liveConfigFromEnv({})).toBeUndefined();
    expect(liveConfigFromEnv({ AGENTIC_E2E_MODEL: "qwen3:8b" })).toMatchObject({ baseUrl: "http://localhost:11434/v1", model: "qwen3:8b", contextWindow: 16384 });
  });
});
