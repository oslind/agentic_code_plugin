import { z } from "zod";
import { normalizeWorkspacePath, scopesOverlap } from "../tools/paths";

export const MAX_TASKS = 8;

const taskSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "id must be a short lowercase slug like 'add-login-form'")
    .describe("Short lowercase slug, unique within the plan"),
  title: z.string().min(3).max(80),
  instructions: z
    .string()
    .min(10)
    .max(1200)
    .describe("What the worker must do, written so it can be done without seeing the other tasks"),
  dependsOn: z.array(z.string()).describe("ids of tasks that must finish first"),
  fileScope: z
    .array(z.string())
    .min(1)
    .max(10)
    .describe("Workspace-relative files or globs this task may write, for example src/auth/**"),
});

export type PlannedTask = z.infer<typeof taskSchema>;

/**
 * The plan the coordinator model must return. Graph and path checks live in
 * superRefine, so their errors go back to the model as retry feedback.
 */
export const planSchema = z
  .object({
    tasks: z.array(taskSchema).min(1).max(MAX_TASKS),
  })
  .superRefine((plan, ctx) => {
    const ids = new Set<string>();
    plan.tasks.forEach((t, i) => {
      if (ids.has(t.id)) {
        ctx.addIssue({ code: "custom", path: ["tasks", i, "id"], message: `Duplicate id '${t.id}'` });
      }
      ids.add(t.id);
      t.fileScope.forEach((g, j) => {
        if (!normalizeWorkspacePath(g)) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", i, "fileScope", j],
            message: `'${g}' must be a relative path inside the workspace`,
          });
        }
      });
    });
    plan.tasks.forEach((t, i) => {
      t.dependsOn.forEach((d, j) => {
        if (!ids.has(d)) {
          ctx.addIssue({ code: "custom", path: ["tasks", i, "dependsOn", j], message: `Unknown task id '${d}'` });
        } else if (d === t.id) {
          ctx.addIssue({ code: "custom", path: ["tasks", i, "dependsOn", j], message: "A task cannot depend on itself" });
        }
      });
    });
    const cycle = findCycle(plan.tasks);
    if (cycle) {
      ctx.addIssue({ code: "custom", path: ["tasks"], message: `Dependency cycle: ${cycle.join(" -> ")}` });
    }
  });

export type Plan = z.infer<typeof planSchema>;

export function findCycle(tasks: Pick<PlannedTask, "id" | "dependsOn">[]): string[] | undefined {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, trail: string[]): string[] | undefined => {
    if (state.get(id) === "done") return undefined;
    if (state.get(id) === "visiting") return [...trail.slice(trail.indexOf(id)), id];
    state.set(id, "visiting");
    for (const d of deps.get(id) ?? []) {
      const found = visit(d, [...trail, id]);
      if (found) return found;
    }
    state.set(id, "done");
    return undefined;
  };
  for (const t of tasks) {
    const found = visit(t.id, []);
    if (found) return found;
  }
  return undefined;
}

function dependsTransitively(tasks: Map<string, PlannedTask>, from: string, on: string): boolean {
  const seen = new Set<string>();
  const stack = [...(tasks.get(from)?.dependsOn ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === on) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(tasks.get(id)?.dependsOn ?? []));
  }
  return false;
}

export interface Repair {
  taskId: string;
  addedDependency: string;
  reason: string;
}

/**
 * Makes a valid plan safe to run in parallel without another model call.
 * Paths are normalized, and when two unordered tasks could write the same
 * files, the later one is made to wait for the earlier one.
 */
export function repairPlan(plan: Plan): { plan: Plan; repairs: Repair[] } {
  const tasks = plan.tasks.map((t) => ({
    ...t,
    dependsOn: [...new Set(t.dependsOn)],
    fileScope: [...new Set(t.fileScope.map((g) => normalizeWorkspacePath(g)!))],
  }));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const repairs: Repair[] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!;
      const b = tasks[j]!;
      if (dependsTransitively(byId, a.id, b.id) || dependsTransitively(byId, b.id, a.id)) continue;
      if (scopesOverlap(a.fileScope, b.fileScope)) {
        b.dependsOn.push(a.id);
        repairs.push({ taskId: b.id, addedDependency: a.id, reason: "file scopes overlap" });
      }
    }
  }
  return { plan: { tasks }, repairs };
}

/** Groups tasks into waves that can run at the same time. */
export function parallelWaves(tasks: Pick<PlannedTask, "id" | "dependsOn">[]): string[][] {
  const remaining = new Map(tasks.map((t) => [t.id, new Set(t.dependsOn)]));
  const waves: string[][] = [];
  while (remaining.size) {
    const wave = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (wave.length === 0) throw new Error("Dependency cycle");
    waves.push(wave);
    for (const id of wave) remaining.delete(id);
    for (const deps of remaining.values()) for (const id of wave) deps.delete(id);
  }
  return waves;
}
