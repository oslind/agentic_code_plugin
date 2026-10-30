import { ContextSection, estimateTokens, fitToBudget } from "../context/budget";
import { callStructured } from "../llm/structured";
import { ModelProvider } from "../providers/types";
import { MAX_TASKS, Plan, planSchema, Repair, repairPlan } from "./plan";

// Kept short on purpose: small models follow a few concrete rules and one
// example better than a long policy document.
const SYSTEM_PROMPT = `You are the coordinator of a team of coding agents. Split the user's request into small tasks.

Rules:
- At most ${MAX_TASKS} tasks. Prefer fewer. One task per file or module where possible.
- Each task must be doable alone by a worker who sees only that task and its files.
- fileScope lists every file or glob the task may create or change, relative to the workspace root.
- Tasks that change the same files must not run at the same time: make one depend on the other.
- dependsOn lists ids of tasks whose results this task needs.
- Do not add tasks for running tests or reviewing; that happens automatically.

Reply with JSON only, in this shape:
{"tasks":[{"id":"add-user-model","title":"Add User model","instructions":"Create src/models/user.ts exporting a User interface with id, email and createdAt.","dependsOn":[],"fileScope":["src/models/user.ts"]},{"id":"add-user-api","title":"Add user API route","instructions":"Add GET /users/:id in src/routes/users.ts that returns a User from src/models/user.ts.","dependsOn":["add-user-model"],"fileScope":["src/routes/users.ts"]}]}`;

export interface PlanInput {
  request: string;
  /** Compact file listing of the workspace. Truncated to fit if needed. */
  fileTree?: string;
  /** Extra context such as README or package.json excerpts, lowest priority. */
  notes?: string;
}

export interface PlanResult {
  plan: Plan;
  repairs: Repair[];
  droppedContext: string[];
}

/** Tokens held back for the model's reply and for retry turns. */
const REPLY_RESERVE = 4096;

export function buildPlannerMessages(input: PlanInput, contextWindow: number) {
  const budget = Math.max(1024, contextWindow - REPLY_RESERVE);
  const sections: ContextSection[] = [
    { name: "request", text: `Request:\n${input.request}`, priority: 100, required: true },
  ];
  if (input.fileTree) {
    sections.push({ name: "files", text: `Workspace files:\n${input.fileTree}`, priority: 50 });
  }
  if (input.notes) {
    sections.push({ name: "notes", text: `Project notes:\n${input.notes}`, priority: 10 });
  }
  const user = fitToBudget(sections, budget - estimateTokens(SYSTEM_PROMPT));
  return {
    messages: [
      { role: "system" as const, content: SYSTEM_PROMPT },
      { role: "user" as const, content: user.text },
    ],
    dropped: [...user.dropped, ...user.truncated.map((n) => `${n} (truncated)`)],
  };
}

export async function planRequest(
  provider: ModelProvider,
  input: PlanInput,
  options: { signal?: AbortSignal; onAttempt?: (n: number, error?: string) => void } = {},
): Promise<PlanResult> {
  const { messages, dropped } = buildPlannerMessages(input, provider.contextWindow);
  const plan = await callStructured({
    provider,
    messages,
    schema: planSchema,
    schemaName: "plan",
    maxRetries: 3,
    signal: options.signal,
    onAttempt: options.onAttempt,
  });
  const repaired = repairPlan(plan);
  return { ...repaired, droppedContext: dropped };
}
