import { z } from "zod";
import { estimateTokens, truncateToTokens } from "../context/budget";
import { callStructured } from "../llm/structured";
import { ChatMessage, ModelProvider } from "../providers/types";
import { ChatEntry, ChatMode } from "./types";

/**
 * The coordinator has no tools. It can hand a request to the planner ("plan"),
 * start an existing plan ("run"), or send read-only sub-agents to look into
 * the project ("research"). All of these lead to sub-agents doing the work.
 */
/** Read-only sub-agents one research step may start. */
export const MAX_RESEARCHERS = 3;

export const coordinatorTurnSchema = z
  .object({
    thought: z.string().max(600).optional().describe("One or two sentences on what you are deciding and why. Shown to the user."),
    reply: z
      .string()
      .min(1)
      .max(3000)
      .refine((s) => !/```/.test(s), {
        message: "Do not write code or code blocks in reply. You cannot change files; delegate the work with action \"plan\" instead.",
      })
      .describe("Your message to the user. Plain text, short."),
    action: z.enum(["none", "plan", "run", "research"]),
    request: z.string().describe('For action "plan": the full work request for the sub-agents. Otherwise "".'),
    questions: z
      .array(z.string().min(5).max(500))
      .max(MAX_RESEARCHERS)
      .optional()
      .describe(`For action "research": 1 to ${MAX_RESEARCHERS} separate questions, one per read-only sub-agent.`),
  })
  .refine((t) => t.action !== "plan" || t.request.trim().length >= 10, {
    message: 'With action "plan", request must describe the work in full.',
    path: ["request"],
  })
  .refine((t) => t.action !== "research" || (t.questions?.length ?? 0) > 0 || t.request.trim().length >= 5, {
    message: 'With action "research", list at least one question in questions.',
    path: ["questions"],
  });

export type CoordinatorTurn = z.infer<typeof coordinatorTurnSchema>;

const BASE = `You are the coordinator of a team of coding sub-agents working in the user's project.
You cannot read or change files yourself, and you never write code. Sub-agents do both for you:
- To learn about the project (explain it, analyse it, find where something is, review code), use action "research" with 1 to ${MAX_RESEARCHERS} questions. Read-only sub-agents read the files and report back, and then you answer the user. Research never changes anything.
- To change the project, use action "plan" with a complete, standalone description of the work in request. A planner splits it into small tasks, each done by one sub-agent limited to its own files.
- Use action "none" only when you can answer from the conversation and the file list alone, or to ask the user a question.
Keep replies short and plain. No code blocks.`;
const MODE_RULES: Record<ChatMode, string> = {
  plan: `You are in PLAN mode. Nothing runs in this mode.
- Questions about the project: use action "research". Research is allowed in Plan mode.
- Requests to change the project: if something important is unclear, ask one short question with action "none". When it is clear, propose a plan with action "plan".
- Never use action "run". The user switches to Act mode to run a plan.`,
  act: `You are in ACT mode. Sub-agents start as soon as you delegate.
- Questions about the project: use action "research".
- When the user wants anything changed in the project, use action "plan" right away. The plan runs immediately.
- If a plan is waiting and the user says to go ahead, use action "run".
- For questions that need no changes, use action "none".`,
};

const EXAMPLE = `Reply with JSON only. Examples:
{"thought":"The request is clear and touches two files, so I will delegate it.","reply":"I'll have the sub-agents add the toggle and its setting.","action":"plan","request":"Add a dark mode toggle to the settings page in src/settings.tsx and persist the choice in src/prefs.ts."}
{"thought":"I need to read the code to explain it, so I will send researchers.","reply":"I'll have sub-agents read the project and report back.","action":"research","request":"","questions":["What does this project do and how is it structured? Read the README and main entry points.","How are tests and builds set up?"]}`;

/** Added after research, so the coordinator answers from the reports instead of starting more work. */
const ANSWER_RULE = `The read-only sub-agents have reported back; their reports are in the conversation. Now answer the user's question from them, clearly and concretely, naming files where useful. Use action "none".`;

export interface CoordinatorContext {
  mode: ChatMode;
  entries: ChatEntry[];
  fileTree?: string;
  /** Short description of a plan that is proposed but not run yet. */
  pendingPlan?: string;
  /** True right after research: the coordinator must answer, not start more work. */
  answerFromResearch?: boolean;
}

const REPLY_RESERVE = 2048;

/** Builds the coordinator prompt: rules, project files, then as much recent conversation as fits. */
export function buildCoordinatorMessages(ctx: CoordinatorContext, contextWindow: number): ChatMessage[] {
  const system = [BASE, MODE_RULES[ctx.mode], EXAMPLE, ctx.answerFromResearch ? ANSWER_RULE : ""].filter(Boolean).join("\n\n");
  let budget = Math.max(1024, contextWindow - REPLY_RESERVE) - estimateTokens(system);

  const history: ChatMessage[] = [];
  // Sub-agent starts are shown to the user but would only crowd the coordinator's context.
  const turns = ctx.entries.filter((e) => (e.author === "user" || e.author === "coordinator") && e.kind !== "spawn");
  for (let i = turns.length - 1; i >= 0; i--) {
    const e = turns[i]!;
    const msg: ChatMessage = e.author === "user" ? { role: "user", content: e.text } : { role: "assistant", content: e.text };
    const cost = estimateTokens(msg.content) + 4;
    // The latest user message is always kept, cut if it must be.
    if (cost > budget && history.length > 0) break;
    if (cost > budget) msg.content = truncateToTokens(msg.content, Math.max(budget, 100)) ?? msg.content.slice(0, 400);
    history.unshift(msg);
    budget -= estimateTokens(msg.content) + 4;
  }
  // Chat models expect the conversation to start with the user.
  while (history[0]?.role === "assistant") history.shift();

  const notes: string[] = [];
  if (ctx.pendingPlan) notes.push(`A plan is proposed and waiting to run:\n${ctx.pendingPlan}`);
  if (ctx.fileTree && budget > 200) {
    const tree = truncateToTokens(ctx.fileTree, Math.min(budget - 100, 3000));
    if (tree) notes.push(`Project files:\n${tree}`);
  }
  const systemFull = notes.length ? `${system}\n\n${notes.join("\n\n")}` : system;
  return [{ role: "system", content: systemFull }, ...history];
}

export interface CoordinatorResult extends CoordinatorTurn {
  /** The model's full thinking, when it produced any. */
  thinking?: string;
  /** Set when the model asked for something the mode does not allow and it was changed. */
  overridden?: string;
}

/**
 * One coordinator turn. Mode rules are enforced here, not just in the prompt:
 * Plan mode never starts sub-agents, and "run" without a waiting plan does nothing.
 */
export async function coordinatorTurn(
  provider: ModelProvider,
  ctx: CoordinatorContext,
  options: { signal?: AbortSignal; onAttempt?: (n: number, error?: string) => void } = {},
): Promise<CoordinatorResult> {
  let thinking: string | undefined;
  const turn = await callStructured({
    provider,
    onThinking: (t) => (thinking = t),
    messages: buildCoordinatorMessages(ctx, provider.contextWindow),
    schema: coordinatorTurnSchema,
    schemaName: "coordinator_turn",
    maxRetries: 2,
    signal: options.signal,
    onAttempt: options.onAttempt,
  });
  if (ctx.answerFromResearch && turn.action !== "none") {
    // One research round per message; the coordinator answers with what it has.
    return { ...turn, action: "none", thinking };
  }
  return { ...enforceMode(turn, ctx.mode, ctx.pendingPlan !== undefined), thinking };
}

/** The questions a research action asks, one per read-only sub-agent. */
export function researchQuestions(turn: CoordinatorTurn): string[] {
  const qs = (turn.questions ?? []).map((q) => q.trim()).filter((q) => q.length > 0);
  return (qs.length ? qs : [turn.request.trim()]).slice(0, MAX_RESEARCHERS);
}

export function enforceMode(turn: CoordinatorTurn, mode: ChatMode, hasPendingPlan: boolean): CoordinatorResult {
  if (turn.action !== "run") return turn;
  if (mode === "plan") {
    return { ...turn, action: "none", overridden: "Plan mode does not run anything. Switch to Act mode to run the plan." };
  }
  if (!hasPendingPlan) {
    return { ...turn, action: "none", overridden: "There is no plan waiting to run." };
  }
  return turn;
}
