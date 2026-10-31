import { z } from "zod";
import { estimateTokens, truncateToTokens } from "../context/budget";
import { callStructured } from "../llm/structured";
import { ChatMessage, ModelProvider } from "../providers/types";
import { ChatEntry, ChatMode } from "./types";

/**
 * The coordinator has no tools. Its only ways to affect the project are to
 * hand a request to the planner ("plan") or start an existing plan ("run"),
 * and both lead to sub-agents with explicit file scopes doing the work.
 */
export const coordinatorTurnSchema = z
  .object({
    reply: z
      .string()
      .min(1)
      .max(3000)
      .refine((s) => !/```/.test(s), {
        message: "Do not write code or code blocks in reply. You cannot change files; delegate the work with action \"plan\" instead.",
      })
      .describe("Your message to the user. Plain text, short."),
    action: z.enum(["none", "plan", "run"]),
    request: z.string().describe('For action "plan": the full work request for the sub-agents. Otherwise "".'),
  })
  .refine((t) => t.action !== "plan" || t.request.trim().length >= 10, {
    message: 'With action "plan", request must describe the work in full.',
    path: ["request"],
  });

export type CoordinatorTurn = z.infer<typeof coordinatorTurnSchema>;

const BASE = `You are the coordinator of a team of coding sub-agents working in the user's project.
You cannot read or change files and you never write code. Every change to the project is done by sub-agents.
To get work done you delegate: set action "plan" and put a complete, standalone description of the work in request. A planner splits it into small tasks, each done by one sub-agent limited to its own files.
Keep replies short and plain. No code blocks.`;

const MODE_RULES: Record<ChatMode, string> = {
  plan: `You are in PLAN mode. Nothing runs in this mode.
- Discuss the request. If something important is unclear, ask one short question with action "none".
- When the request is clear, propose a plan with action "plan".
- Never use action "run". The user switches to Act mode to run a plan.`,
  act: `You are in ACT mode. Sub-agents start as soon as you delegate.
- When the user wants anything changed in the project, use action "plan" right away. The plan runs immediately.
- If a plan is waiting and the user says to go ahead, use action "run".
- For questions that need no changes, use action "none".`,
};

const EXAMPLE = `Reply with JSON only, for example:
{"reply":"I'll have the sub-agents add the toggle and its setting.","action":"plan","request":"Add a dark mode toggle to the settings page in src/settings.tsx and persist the choice in src/prefs.ts."}`;

export interface CoordinatorContext {
  mode: ChatMode;
  entries: ChatEntry[];
  fileTree?: string;
  /** Short description of a plan that is proposed but not run yet. */
  pendingPlan?: string;
}

const REPLY_RESERVE = 2048;

/** Builds the coordinator prompt: rules, project files, then as much recent conversation as fits. */
export function buildCoordinatorMessages(ctx: CoordinatorContext, contextWindow: number): ChatMessage[] {
  const system = [BASE, MODE_RULES[ctx.mode], EXAMPLE].join("\n\n");
  let budget = Math.max(1024, contextWindow - REPLY_RESERVE) - estimateTokens(system);

  const history: ChatMessage[] = [];
  const turns = ctx.entries.filter((e) => e.author === "user" || e.author === "coordinator");
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
  const turn = await callStructured({
    provider,
    messages: buildCoordinatorMessages(ctx, provider.contextWindow),
    schema: coordinatorTurnSchema,
    schemaName: "coordinator_turn",
    maxRetries: 2,
    signal: options.signal,
    onAttempt: options.onAttempt,
  });
  return enforceMode(turn, ctx.mode, ctx.pendingPlan !== undefined);
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
