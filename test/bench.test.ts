/**
 * Keeps the benchmark honest without a model: every hidden check passes on a
 * correct solution and fails on the untouched project, the research ladder's
 * expected answer is what the code really does, and the single-conversation
 * runner and the scoreboard work end to end with a scripted model.
 */
import { promises as fs } from "fs";
import { describe, expect, it } from "vitest";
import { Attempt, rows, scoreboard, finalAnswerOf, foundOf } from "../e2e/bench/scoreboard";
import { runSingle } from "../e2e/bench/single";
import { ADMITS_SHORTFALL, BENCH_TASKS, editAsks, judge, modulePath, modulesNamed, modulesSaidToThrow, sh, shopProject, throwingModules, writeProject } from "../e2e/bench/tasks";
import { ChatRequest, ModelProvider } from "../src/providers/types";

async function judged(task: (typeof BENCH_TASKS)[number], files: Record<string, string>, answer = "") {
  const { root, tmp } = await writeProject(files, "test");
  try {
    return await judge(task, root, answer);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

describe("benchmark tasks", () => {
  it("have unique names", () => {
    expect(new Set(BENCH_TASKS.map((t) => t.name)).size).toBe(BENCH_TASKS.length);
  });

  for (const task of BENCH_TASKS.filter((t) => t.reference)) {
    it(`${task.name}: the checks pass on a correct solution and fail on the untouched project`, async () => {
      const untouched = await judged(task, task.files);
      expect(untouched.score).toBeLessThan(1);
      const solved = await judged(task, task.reference!(task.files), "Done.");
      expect(solved.parts.filter((p) => !p.ok)).toEqual([]);
      expect(solved.score).toBe(1);
      expect(solved.collateral).toEqual([]);
      expect(solved.falseDone).toBe(false);
    });
  }

  it("flags a change that falls short while the answer says it is done, but not one that admits it", async () => {
    const task = BENCH_TASKS.find((t) => t.name === "three-changes")!;
    expect((await judged(task, task.files, "All three changes are done.")).falseDone).toBe(true);
    expect((await judged(task, task.files, "I added toKelvin, but the median tests still fail.")).falseDone).toBe(false);
    expect(ADMITS_SHORTFALL.test("I could not finish the away mode.")).toBe(true);
    expect(ADMITS_SHORTFALL.test("All changes are in place and the tests pass.")).toBe(false);
  });

  it("counts edits to files the request did not name as collateral damage", async () => {
    const task = BENCH_TASKS.find((t) => t.name === "fix-bug")!;
    const files = task.reference!(task.files);
    const r = await judged(task, { ...files, "src/convert.js": files["src/convert.js"] + "// tidied\n" });
    expect(r.score).toBe(1);
    expect(r.collateral).toEqual(["src/convert.js"]);
  });

  it("knows which shop modules really throw on a negative quantity", async () => {
    const n = 20;
    const { root, tmp } = await writeProject(shopProject(n), "truth");
    try {
      const script = `const out=[];for(let i=0;i<${n};i++){const m=require('./src/mod_'+String(i+1).padStart(3,'0'));try{m.lineTotal(-1,5)}catch{out.push(i)}}console.log(JSON.stringify(out))`;
      const r = await sh(root, "node", ["-e", script]);
      expect(JSON.parse(r.output.split("\n").find((l) => l.startsWith("["))!)).toEqual(throwingModules(n));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
    // Both kinds are well represented, so naming every file or none scores badly.
    expect(throwingModules(n).length).toBeGreaterThan(4);
    expect(throwingModules(n).length).toBeLessThan(n - 4);
  });

  it("scores a research answer by the modules it names", async () => {
    const task = BENCH_TASKS.find((t) => t.name === "find-throwing-20")!;
    const truth = throwingModules(20);
    const right = truth.map((i) => modulePath(i)).join("\n");
    expect((await judged(task, task.files, right)).score).toBe(1);
    const all = Array.from({ length: 20 }, (_, i) => modulePath(i)).join(", ");
    expect((await judged(task, task.files, all)).score).toBeCloseTo(truth.length / 20);
    expect(modulesNamed("mod_007.js, module 12 and src/mod_3.js")).toEqual(new Set([6, 11, 2]));
  });

  it("scores an agentic run on its answer, and a run that never answered as an empty answer", () => {
    const log = { author: "coordinator", text: "Reviewed the researcher's result and accepted it." };
    expect(finalAnswerOf([{ author: "coordinator", kind: "answer", text: "mod_001 throws." }, log])).toBe("mod_001 throws.");
    expect(finalAnswerOf([{ author: "user", text: "Which throw?" }, log])).toBe("");
  });

  it("reports what a research answer found, apart from its score", () => {
    const parts = [
      { name: "mod_000 named", ok: true },
      { name: "mod_001 named", ok: false },
      { name: "mod_002 not named", ok: false },
      { name: "mod_003 not named", ok: true },
    ];
    expect(foundOf({ parts })).toEqual({ found: 1, total: 2, falseAlarms: 1 });
  });

  it("does not count modules the answer says do not throw (bench pass 1)", () => {
    const listed = "mod_001.js mod_002.js\n\n- mod_003.js: checks the quantity but returns 0, so it does not throw.\n- mod_004.js doesn't throw; it clamps the quantity.\n- mod_005.js never throws.";
    expect(modulesSaidToThrow(listed)).toEqual(new Set([0, 1]));
    expect(modulesSaidToThrow("Throwing:\n- mod_001\n- mod_002\n\nNot throwing:\n- mod_003\n- mod_004")).toEqual(new Set([0, 1]));
    expect(modulesSaidToThrow("Throwing:\n- mod_001\n\nStill unknown:\n- mod_003\n- mod_004")).toEqual(new Set([0]));
    // Run 14, find-throwing-5: explanation lines for the ones that do not throw were counted as named.
    expect(modulesSaidToThrow("mod_001.js\nmod_002.js\nmod_003.js logs a warning, mod_004.js clamps, mod_005.js returns 0.")).toEqual(new Set([0, 1]));
    expect(modulesSaidToThrow("mod_001.js throws.\n\nChecked by rule: Unclear from the reports (they hedge or do not say): mod_003.js.")).toEqual(new Set([0]));
    expect(modulesSaidToThrow("mod_001 throws because the quantity is not checked before it is used. mod_002 does not throw.")).toEqual(new Set([0]));
    expect(modulesSaidToThrow("mod_001.js - throws a RangeError - mod_003.js - does not throw")).toEqual(new Set([0]));
    // Check 2026-11-09: a module the answer could not read, or found no lineTotal in, is not said to throw.
    expect(modulesSaidToThrow("- mod_001.js throws.\n- mod_002.js: File not found.\n- mod_005.js: No lineTotal function.")).toEqual(new Set([0]));
  });

  it("spreads the edit ladder's changes over different files", () => {
    for (const k of [1, 3, 6, 10]) {
      const asks = editAsks(20, k);
      expect(new Set(asks.map((a) => a.module)).size).toBe(k);
    }
  });
});

describe("single-conversation runner", () => {
  it("runs the request as one conversation and is scored on what it wrote", async () => {
    const task = BENCH_TASKS.find((t) => t.name === "fix-bug")!;
    const fixed = task.reference!(task.files)["src/stats.js"]!;
    let step = 0;
    const model: ModelProvider = {
      model: "fake",
      contextWindow: 16384,
      async chat(req: ChatRequest) {
        expect(req.jsonSchema?.name).toBe("worker_turn");
        const call = step++ === 0 ? { tool: "write_file", path: "src/stats.js", content: fixed } : { tool: "finish", summary: "Fixed average(): it divided by 2 instead of the number of readings." };
        return { content: JSON.stringify({ thought: "", call }), promptTokens: 1000, completionTokens: 50 };
      },
    };
    const r = await runSingle(task, model, { timeoutMs: 60000, maxTurns: 10 });
    expect(r.ended).toBeUndefined();
    expect(r.judged.score).toBe(1);
    expect(r.answer).toMatch(/divided by 2/);
    expect(r.calls).toHaveLength(2);
  });
});

describe("scoreboard", () => {
  const attempt = (mode: Attempt["mode"], score: number, extra: Partial<Attempt> = {}): Attempt => ({
    task: "three-changes",
    group: "fixed",
    kind: "change",
    files: 6,
    asks: 3,
    mode,
    repeat: 1,
    score,
    parts: [],
    collateral: [],
    deleted: [],
    created: [],
    falseDone: false,
    minutes: 2,
    modelCalls: 5,
    promptTokens: 1000,
    completionTokens: 100,
    peakPromptTokens: 800,
    truncatedReplies: 0,
    answer: "",
    ...extra,
  });

  it("averages attempts per task and mode", () => {
    const r = rows([attempt("single", 1 / 3, { falseDone: true }), attempt("single", 1, { repeat: 2 }), attempt("agentic", 1), attempt("agentic", 1, { repeat: 2, collateral: ["x"] })]);
    const single = r.find((x) => x.mode === "single")!;
    expect(single.score).toBeCloseTo(2 / 3);
    expect(single.solved).toBe(1);
    expect(single.falseDone).toBe(1);
    expect(r.find((x) => x.mode === "agentic")!.collateral).toBe(1);
  });

  it("renders totals, tasks and ladders", () => {
    const board = scoreboard(
      [
        attempt("single", 0.5),
        attempt("agentic", 1),
        attempt("single", 0.2, { task: "find-throwing-50", group: "research-ladder", kind: "question", files: 54, asks: 1 }),
        attempt("agentic", 0.9, { task: "find-throwing-50", group: "research-ladder", kind: "question", files: 54, asks: 1 }),
      ],
      { model: "fake", time: "2026-11-07T23:00:00Z" },
    );
    expect(board).toMatch(/## Totals/);
    expect(board).toMatch(/\| three-changes \| single \| 50% \|/);
    expect(board).toMatch(/\| 54 \| 20% \| 90% \|/);
  });
});
