import { describe, expect, it } from "vitest";
import { parallelWaves, planSchema, repairPlan } from "../src/coordinator/plan";

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
  it("rejects too many tasks", () => {
    const many = Array.from({ length: 9 }, (_, i) => t(`t${i}`));
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
