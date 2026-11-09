import { z } from "zod";
import { normalizeWorkspacePath, scopesOverlap } from "../tools/paths";

/** Hard cap on tasks per plan. The setting agentic.delegation.maxTasks picks a lower limit. */
export const MAX_TASKS = 30;
/** Used when no limit is passed. */
export const DEFAULT_MAX_TASKS = 12;

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
  // Defaults to none: a one-task plan without it was rejected four times in e2e run 6.
  dependsOn: z.array(z.string()).default([]).describe("ids of tasks that must finish first"),
  fileScope: z
    .array(z.string())
    .min(1)
    .max(10)
    .describe("Workspace-relative files or globs this task may write, for example src/auth/**"),
  changes: z
    .boolean()
    .optional()
    .describe("false if the task only reads files and reports back; true if it creates or edits files"),
  skills: z
    .array(z.string().max(60))
    .max(6)
    .optional()
    .describe("Names of skills from the skill list that fit this task, at most 2"),
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

/**
 * Drops dependsOn ids that name no task in the plan, or the task itself. Run 9: qwen copied
 * "add-user-model" from the prompt's example into a real plan, and the retry cost a model call.
 * A dependency on a task that does not exist cannot be waited for anyway.
 */
export function dropUnknownDependencies(value: unknown): unknown {
  const plan = value as { tasks?: unknown };
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.tasks)) return value;
  const tasks = plan.tasks as { id?: unknown; dependsOn?: unknown }[];
  const ids = new Set(tasks.map((t) => (t && typeof t === "object" ? t.id : undefined)).filter((id): id is string => typeof id === "string"));
  return {
    ...plan,
    tasks: tasks.map((t) => (t && typeof t === "object" && Array.isArray(t.dependsOn) ? { ...t, dependsOn: t.dependsOn.filter((d) => typeof d !== "string" || (ids.has(d) && d !== t.id)) } : t)),
  };
}

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

/**
 * Joins tasks that write the same files into one task. Used for fix-up rounds: run 6E planned "Fix median"
 * and "Revert average" on the same src/stats.js, and the two sub-agents undid each other until the run timed out.
 * Tasks that only read (empty file scope) are left alone.
 */
export function mergeSameFileTasks(tasks: PlannedTask[]): PlannedTask[] {
  const out: PlannedTask[] = [];
  const into = new Map<string, string>();
  for (const t of tasks) {
    const host = t.fileScope.length ? out.find((o) => o.fileScope.length && scopesOverlap(o.fileScope, t.fileScope)) : undefined;
    if (!host) {
      out.push({ ...t, dependsOn: [...t.dependsOn], fileScope: [...t.fileScope] });
      continue;
    }
    into.set(t.id, host.id);
    host.instructions = `${host.instructions}\n\nAlso (planned as a separate task on the same file; where the two disagree, follow the user's request and leave code it did not ask about as it is): ${t.instructions}`;
    host.fileScope = [...new Set([...host.fileScope, ...t.fileScope])];
    host.dependsOn = [...new Set([...host.dependsOn, ...t.dependsOn])];
    if (t.skills?.length) host.skills = [...new Set([...(host.skills ?? []), ...t.skills])];
    if (t.changes) host.changes = true;
  }
  for (const t of out) t.dependsOn = [...new Set(t.dependsOn.map((d) => into.get(d) ?? d))].filter((d) => d !== t.id);
  return out;
}

/**
 * Fix-up tasks that touch none of the files the missing work names, when other tasks do. Run 6H's fix-up plan
 * added "Fix 'away' mode test" next to the one thing verification found missing (a duplicate median in stats.js).
 * When no task's files are named, nothing is dropped: the missing work may not name files at all.
 */
export function offTargetTasks(tasks: PlannedTask[], missing: string[]): PlannedTask[] {
  const text = missing.join("\n").toLowerCase();
  const named = (t: PlannedTask) => t.fileScope.some((f) => {
    const plain = f.replace(/\/\*\*?$|\*.*$/, "").toLowerCase();
    const base = plain.split("/").pop() ?? "";
    return (plain.length > 0 && text.includes(plain)) || (base.length > 2 && text.includes(base));
  });
  return tasks.some(named) ? tasks.filter((t) => t.fileScope.length > 0 && !named(t)) : [];
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

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length]!;
}

/** True when text names a file by its path, or by its file name as a whole word. */
function namesFile(text: string, file: string): boolean {
  const base = file.split("/").pop()!;
  return text.includes(file) || new RegExp(`(^|[^\\w./-])${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`).test(text);
}

/**
 * Puts right a fileScope path the planner garbled. Run 10: a plan had "src/ther,mostat.js" for
 * src/thermostat.js, so every write was refused as out of scope and the task did nothing. A plain
 * path that is not in the project, and that the request and the task do not name as a new file, is
 * replaced by the one project file it is a slip away from (at most 2 edits, same folder depth), and only when the
 * user's own words name that file (audit of PR #54: a guess the user never anchored could widen a task's scope to
 * a file nobody asked to change). Otherwise the scope is kept, and a write outside it is refused as usual.
 */
export function snapScopes(plan: Plan, files: string[], named: string, userWords = named): { plan: Plan; snapped: { taskId: string; from: string; to: string }[] } {
  if (!files.length) return { plan, snapped: [] };
  const known = new Set(files);
  const snapped: { taskId: string; from: string; to: string }[] = [];
  const tasks = plan.tasks.map((t) => {
    const text = `${named}\n${t.instructions}`;
    const fileScope = t.fileScope.map((g) => {
      if (known.has(g) || /[*?[\]{}]/.test(g) || text.includes(g)) return g;
      const depth = g.split("/").length;
      const near = files.filter((f) => f.split("/").length === depth && editDistance(f, g) <= 2);
      if (near.length !== 1 || !namesFile(userWords, near[0]!)) return g;
      snapped.push({ taskId: t.id, from: g, to: near[0]! });
      return near[0]!;
    });
    return { ...t, fileScope: [...new Set(fileScope)] };
  });
  return { plan: { tasks }, snapped };
}
