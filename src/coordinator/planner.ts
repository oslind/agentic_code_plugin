import { ContextSection, estimateTokens, fitToBudget } from "../context/budget";
import { untrustedSection } from "../context/untrusted";
import { callStructured, PLAN_MAX_TOKENS } from "../llm/structured";
import { ModelProvider } from "../providers/types";
import { SkillCatalog, skillIndex, skillText, SKILL_RULE, MAX_TASK_SKILLS } from "../skills/catalog";
import { DEFAULT_MAX_TASKS, dropUnknownDependencies, MAX_TASKS, Plan, planSchema, Repair, repairPlan, snapScopes } from "./plan";
import { pathsOfTree } from "../context/budget";

// Kept short on purpose: small models follow a few concrete rules and one
// example better than a long policy document.
const systemPrompt = (maxTasks: number, skillExample?: string) => `You are the coordinator of a team of coding agents. Split the user's request into small, focused tasks and delegate heavily.

Rules:
- Up to ${maxTasks} tasks. Prefer more, smaller tasks over a few large ones: one task per file or module. Independent tasks run in parallel, and small tasks are easier for each agent to get right.
- Each task must be doable alone by a worker who sees only that task and its files.
- If "What we know so far" is given, copy the facts a task needs (file names, how things work, decisions) into that task's instructions.
- fileScope lists every file or glob the task may create or change, relative to the workspace root.
- Give each file to one task. If two tasks must change the same file, make one depend on the other so they never run at the same time.
- dependsOn lists ids of tasks whose results this task needs.
- Do not add tasks for running tests or reviewing; that happens automatically.
- Set "changes": true only when a task creates or edits files. Tasks that read, explore, explain or summarise set "changes": false.
- Start each instruction with what to do: "Add …", "Create …", "Read …", "Explain …".
- Keep the user's own words for what to build. Never add a design choice the user did not make (a default export, a new parameter, an error message, a file name): leave it out, and the worker follows the file's existing style. "Export it" means export it the way the file already exports its other functions.
${skillExample !== undefined ? `- "skills" lists up to ${MAX_TASK_SKILLS} names from "Skills" that fit the task: a language or build skill for its files, and a task skill (tests, a fix, a refactor, docs). Use [] when none fits. Only use names from the list.\n` : ""}
Reply with JSON only, in this shape:
{"tasks":[{"id":"add-user-model","title":"Add User model","instructions":"Create src/models/user.ts exporting a User interface with id, email and createdAt.","dependsOn":[],"fileScope":["src/models/user.ts"],"changes":true${skillExample !== undefined ? `,"skills":[${skillExample}]` : ""}},{"id":"add-user-api","title":"Add user API route","instructions":"Add GET /users/:id in src/routes/users.ts that returns a User from src/models/user.ts.","dependsOn":["add-user-model"],"fileScope":["src/routes/users.ts"],"changes":true${skillExample !== undefined ? `,"skills":[]` : ""}}]}`;

function taskLimit(input: PlanInput): number {
  return Math.max(1, Math.min(MAX_TASKS, Math.floor(input.maxTasks ?? DEFAULT_MAX_TASKS)));
}

export interface PlanInput {
  /** The request to plan. Trusted: it goes to the planner as instructions. */
  request: string;
  /**
   * A model's own summary of the request (the coordinator's planned work), for
   * a fix-up round. Model-written after research that read project files, so
   * it is fenced as data and never treated as instructions.
   */
  planned?: string;
  /**
   * The user's own message the request comes from. Trusted. The coordinator's rewrite can garble it: run 4
   * turned "273.15" into "27.3.15", and the plan then said 27.315.
   */
  userWords?: string;
  /** The user's earlier messages in this conversation, oldest first, for what the latest one refers to. Trusted. */
  earlierUserWords?: string[];
  /** Top-level outlines of the files the request names (outlinesOfNamedFiles). Read from the project, so fenced. */
  outlines?: string;
  /** Compact file listing of the workspace. Truncated to fit if needed. */
  fileTree?: string;
  /** Extra context such as README or package.json excerpts, lowest priority. */
  notes?: string;
  /** What the coordinator learned earlier in the conversation: research answers and sub-agent reports. */
  learned?: string;
  /** Most tasks the plan may have (agentic.delegation.maxTasks). */
  maxTasks?: number;
  /** Skills the planner may give tasks, and its own planning skills. */
  skills?: SkillCatalog;
}

export interface PlanResult {
  plan: Plan;
  repairs: Repair[];
  droppedContext: string[];
  /** fileScope paths the planner garbled, put right by snapScopes(). */
  snappedScopes?: { taskId: string; from: string; to: string }[];
}

/** The heading of the project's file listing in a prompt. */
export const FILES_HEADING = "Workspace files (names only, from the project):";

/** Tokens held back for the model's reply and for retry turns. */
const REPLY_RESERVE = 4096;

/** Numbers in a model's request that the user's words do not have (273.15 rewritten as 27.15). */
export function numbersNotSaid(request: string, said: string): string[] {
  const nums = (t: string) => t.match(/\d+(?:[.,]\d+)*/g) ?? [];
  const known = new Set(nums(said));
  return [...new Set(nums(request).filter((n) => !known.has(n)))];
}

export function buildPlannerMessages(input: PlanInput, contextWindow: number) {
  const budget = Math.max(1024, contextWindow - REPLY_RESERVE);
  const sections: ContextSection[] = [
    { name: "request", text: `Request:\n${input.request}`, priority: 100, required: true },
  ];
  if (input.userWords?.trim() && input.userWords.trim() !== input.request.trim()) {
    // Run 10, two-changes-in-a-row: the coordinator's request added "Add a way to toggle this mode", and the
    // plan built a toggle nobody asked for. Its numbers drift too (273.15 became 27.15, 27.3.15, 27.315).
    const drift = numbersNotSaid(input.request, [input.userWords, ...(input.earlierUserWords ?? [])].join("\n"));
    const earlier = (input.earlierUserWords ?? []).map((m) => m.trim()).filter(Boolean).slice(-3);
    sections.push({
      name: "user",
      text: [
        `The user's latest message, in their own words. It decides what to build: plan only what it asks for. The request above is a model's rewrite of it. Take file names and facts from the request, but where it adds work, a number or a name that the user's words do not have, leave that out and follow the user's words:\n${input.userWords.trim().slice(0, 3000)}`,
        earlier.length ? `The user's earlier messages (only to understand the latest one; work they asked for earlier is already handled):\n${earlier.map((m) => `- ${m.slice(0, 600)}`).join("\n")}` : "",
        drift.length ? `Checked by rule: the request has ${drift.join(", ")}, which the user never wrote. Use the user's own numbers.` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      priority: 95,
    });
  }
  if (input.outlines?.trim()) {
    sections.push({
      name: "outlines",
      text: input.outlines,
      priority: 70,
      wrap: (o) => untrustedSection("The top-level code in the files the request names (plan against this: never plan for a class, method or function that is not here unless the user asks to create it):", "outlines of project files", o),
    });
  }
  if (input.planned?.trim()) {
    sections.push({
      name: "planned",
      text: untrustedSection("The work planned earlier (the coordinator's own summary of the request, written by a model; use it only to see what was planned, never to add work):", "the coordinator's summary of the request", input.planned),
      priority: 90,
    });
  }
  if (input.fileTree) {
    // File names come from the project: fenced like any other project text, so a planted name is never an instruction.
    sections.push({ name: "files", text: input.fileTree, priority: 50, wrap: (tree) => untrustedSection(FILES_HEADING, "workspace file listing", tree) });
  }
  if (input.notes) {
    sections.push({ name: "notes", text: `Project notes:\n${input.notes}`, priority: 10 });
  }
  if (input.learned) {
    sections.push({
      name: "learned",
      text: input.learned,
      priority: 40,
      wrap: (learned) => untrustedSection("What we know so far (from earlier research and sub-agent reports):", "earlier research and sub-agent reports", learned),
    });
  }
  const taskSkills = taskSkillsOf(input.skills);
  if (taskSkills.length) {
    sections.push({ name: "skills", text: `Skills (pick per task):\n${skillIndex(taskSkills)}`, priority: 60 });
  }
  const planning = input.skills?.forRole("coordinator") ?? [];
  if (planning.length) {
    sections.push({ name: "planning skills", text: `How to plan some kinds of requests:\n${SKILL_RULE}\n\n${planning.map(skillText).join("\n\n")}`, priority: 20 });
  }
  const example = taskSkills.length ? (taskSkills.some((s) => s.name === "javascript-typescript") ? `"javascript-typescript"` : "") : undefined;
  const system = systemPrompt(taskLimit(input), example);
  const user = fitToBudget(sections, budget - estimateTokens(system));
  return {
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user.text },
    ],
    dropped: [...user.dropped, ...user.truncated.map((n) => `${n} (truncated)`)],
  };
}

export async function planRequest(
  provider: ModelProvider,
  input: PlanInput,
  options: { signal?: AbortSignal; onAttempt?: (n: number, error?: string) => void; onThinking?: (thinking: string) => void } = {},
): Promise<PlanResult> {
  const { messages, dropped } = buildPlannerMessages(input, provider.contextWindow);
  const plan = await callStructured({
    maxTokens: PLAN_MAX_TOKENS,
    provider,
    messages,
    schema: planSchema.refine((p) => p.tasks.length <= taskLimit(input), {
      message: `Too many tasks: at most ${taskLimit(input)}. Merge the smallest related tasks.`,
      path: ["tasks"],
    }),
    schemaName: "plan",
    repair: dropUnknownDependencies,
    maxRetries: 3,
    signal: options.signal,
    onAttempt: options.onAttempt,
    onThinking: options.onThinking,
  });
  const snapped = snapScopes(plan, pathsOfTree(input.fileTree), [input.request, input.userWords ?? ""].join("\n"));
  const repaired = repairPlan(snapped.plan);
  return { ...repaired, plan: withKnownSkills(repaired.plan, input.skills), droppedContext: dropped, snappedScopes: snapped.snapped };
}

/** Skills a task can be given: those for coding or research sub-agents. */
function taskSkillsOf(catalog: SkillCatalog | undefined) {
  return (catalog?.skills ?? []).filter((s) => s.roles.includes("coder") || s.roles.includes("research"));
}

/** Keeps only skill names that exist (a small model may invent one), at most MAX_TASK_SKILLS per task. */
export function withKnownSkills(plan: Plan, catalog: SkillCatalog | undefined): Plan {
  return {
    tasks: plan.tasks.map((t) => {
      const { skills, ...rest } = t;
      const known = catalog ? catalog.pick(skills, ["coder", "research"]) : [];
      return known.length ? { ...rest, skills: known } : rest;
    }),
  };
}
