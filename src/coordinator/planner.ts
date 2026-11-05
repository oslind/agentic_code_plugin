import { ContextSection, estimateTokens, fitToBudget } from "../context/budget";
import { untrustedSection } from "../context/untrusted";
import { callStructured } from "../llm/structured";
import { ModelProvider } from "../providers/types";
import { DEFAULT_MAX_TASKS, MAX_TASKS, Plan, planSchema, Repair, repairPlan } from "./plan";

// Kept short on purpose: small models follow a few concrete rules and one
// example better than a long policy document.
const systemPrompt = (maxTasks: number) => `You are the coordinator of a team of coding agents. Split the user's request into small, focused tasks and delegate heavily.

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

Reply with JSON only, in this shape:
{"tasks":[{"id":"add-user-model","title":"Add User model","instructions":"Create src/models/user.ts exporting a User interface with id, email and createdAt.","dependsOn":[],"fileScope":["src/models/user.ts"],"changes":true},{"id":"add-user-api","title":"Add user API route","instructions":"Add GET /users/:id in src/routes/users.ts that returns a User from src/models/user.ts.","dependsOn":["add-user-model"],"fileScope":["src/routes/users.ts"],"changes":true}]}`;

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
  /** Compact file listing of the workspace. Truncated to fit if needed. */
  fileTree?: string;
  /** Extra context such as README or package.json excerpts, lowest priority. */
  notes?: string;
  /** What the coordinator learned earlier in the conversation: research answers and sub-agent reports. */
  learned?: string;
  /** Most tasks the plan may have (agentic.delegation.maxTasks). */
  maxTasks?: number;
}

export interface PlanResult {
  plan: Plan;
  repairs: Repair[];
  droppedContext: string[];
}

/** The heading of the project's file listing in a prompt. */
export const FILES_HEADING = "Workspace files (names only, from the project):";

/** Tokens held back for the model's reply and for retry turns. */
const REPLY_RESERVE = 4096;

export function buildPlannerMessages(input: PlanInput, contextWindow: number) {
  const budget = Math.max(1024, contextWindow - REPLY_RESERVE);
  const sections: ContextSection[] = [
    { name: "request", text: `Request:\n${input.request}`, priority: 100, required: true },
  ];
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
  const system = systemPrompt(taskLimit(input));
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
    provider,
    messages,
    schema: planSchema.refine((p) => p.tasks.length <= taskLimit(input), {
      message: `Too many tasks: at most ${taskLimit(input)}. Merge the smallest related tasks.`,
      path: ["tasks"],
    }),
    schemaName: "plan",
    maxRetries: 3,
    signal: options.signal,
    onAttempt: options.onAttempt,
    onThinking: options.onThinking,
  });
  const repaired = repairPlan(plan);
  return { ...repaired, droppedContext: dropped };
}
