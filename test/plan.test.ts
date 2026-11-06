import { describe, expect, it } from "vitest";
import { mergeSameFileTasks, offTargetTasks, parallelWaves, planSchema, repairPlan } from "../src/coordinator/plan";

const t = (id: string, dependsOn: string[] = [], fileScope = [`src/${id}.ts`]) => ({
  id,
  title: `Task ${id}`,
  instructions: `Do the ${id} work properly.`,
  dependsOn,
  fileScope,
});

const issues = (input: unknown) => {
  const r = planSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("planSchema", () => {
  it("accepts a valid plan", () => {
    expect(issues({ tasks: [t("a"), t("b", ["a"])] })).toEqual([]);
  });
  it("rejects duplicate ids, unknown deps and self deps", () => {
    const msgs = issues({ tasks: [t("a", ["a"]), t("a"), t("b", ["zzz"])] });
    expect(msgs.join("\n")).toMatch(/Duplicate id 'a'/);
    expect(msgs.join("\n")).toMatch(/Unknown task id 'zzz'/);
    expect(msgs.join("\n")).toMatch(/depend on itself/);
  });
  it("rejects cycles", () => {
    expect(issues({ tasks: [t("a", ["c"]), t("b", ["a"]), t("c", ["b"])] }).join()).toMatch(/cycle: a -> c -> b -> a/);
  });
  it("rejects scopes outside the workspace", () => {
    expect(issues({ tasks: [t("a", [], ["../x.ts"])] }).join()).toMatch(/inside the workspace/);
  });
  it("rejects more tasks than the hard cap", () => {
    const many = Array.from({ length: 31 }, (_, i) => t(`t${i}`));
    expect(issues({ tasks: many }).length).toBeGreaterThan(0);
  });
});

describe("repairPlan", () => {
  it("orders unordered tasks that could write the same files", () => {
    const plan = planSchema.parse({ tasks: [t("a", [], ["src/**"]), t("b", [], ["src/ui/x.ts"]), t("c", [], ["docs/x.md"])] });
    const { plan: fixed, repairs } = repairPlan(plan);
    expect(repairs).toEqual([{ taskId: "b", addedDependency: "a", reason: "file scopes overlap" }]);
    expect(fixed.tasks.find((x) => x.id === "b")?.dependsOn).toEqual(["a"]);
    expect(parallelWaves(fixed.tasks)).toEqual([["a", "c"], ["b"]]);
  });
  it("leaves tasks alone when they are already ordered", () => {
    const plan = planSchema.parse({ tasks: [t("a", [], ["src/a.ts"]), t("b", ["a"], ["src/a.ts"])] });
    expect(repairPlan(plan).repairs).toEqual([]);
  });
  it("normalizes scope paths", () => {
    const plan = planSchema.parse({ tasks: [t("a", [], ["./src//a.ts", "src/a.ts"])] });
    expect(repairPlan(plan).plan.tasks[0]?.fileScope).toEqual(["src/a.ts"]);
  });
});

describe("a plan without dependsOn", () => {
  it("reads a missing dependsOn as no dependencies", () => {
    // e2e run 6 without structured output: a one-task plan without dependsOn was rejected four times.
    const parsed = planSchema.safeParse({ tasks: [{ id: "a", title: "Add toFahrenheit", instructions: "Add toFahrenheit to src/convert.js.", fileScope: ["src/convert.js"] }] });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.tasks[0]!.dependsOn).toEqual([]);
  });
});

describe("fix-up tasks on the same file", () => {
  it("joins tasks that write the same files into one, and points dependencies at it", () => {
    const t = (id: string, fileScope: string[], dependsOn: string[] = []) => ({ id, title: `Task ${id}`, instructions: `Do ${id}.`, fileScope, dependsOn });
    const merged = mergeSameFileTasks([t("a", ["src/stats.js"]), t("b", ["src/convert.js"]), t("c", ["src/stats.js"], ["b"]), t("d", ["test.js"], ["c"]), t("r", [])]);
    expect(merged.map((x) => x.id)).toEqual(["a", "b", "d", "r"]);
    expect(merged[0]).toMatchObject({ instructions: expect.stringMatching(/^Do a\.\n\nAlso \(planned as a separate task[^)]*follow the user's request[^)]*\): Do c\.$/), fileScope: ["src/stats.js"], dependsOn: ["b"] });
    expect(merged[2]!.dependsOn).toEqual(["a"]);
    expect(mergeSameFileTasks([t("x", []), t("y", [])]).map((x) => x.id)).toEqual(["x", "y"]);
  });
});

describe("fix-up tasks the missing work does not ask for", () => {
  const t = (id: string, fileScope: string[]) => ({ id, title: `Task ${id}`, instructions: `Do ${id}.`, fileScope, dependsOn: [] });
  it("finds tasks on files the missing work never names, but only when another task's files are named", () => {
    const tasks = [t("median", ["src/stats.js"]), t("away", ["src/thermostat.js", "test.js"]), t("read", [])];
    expect(offTargetTasks(tasks, ["Fix the duplicate median function in src/stats.js"]).map((x) => x.id)).toEqual(["away"]);
    expect(offTargetTasks(tasks, ["Remove the second median in stats.js"]).map((x) => x.id)).toEqual(["away"]);
    expect(offTargetTasks(tasks, ["Fix the duplicate median function"])).toEqual([]);
    expect(offTargetTasks([t("a", ["src/**"])], ["fix src/stats.js"])).toEqual([]);
  });
});
