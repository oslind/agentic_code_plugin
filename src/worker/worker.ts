import { CheckConfig } from "../checks/runner";
import { callStructured } from "../llm/structured";
import { ChatMessage, ModelProvider } from "../providers/types";
import { Task } from "../state/types";
import { checkToolCall } from "../tools/policy";
import { ToolCall, workerTurnSchema } from "../tools/protocol";
import { WorkspaceSandbox } from "../tools/sandbox";
import { compactHistory } from "./history";
import { executeTool } from "./tools";

export interface WorkerOptions {
  provider: ModelProvider;
  /** Sandbox rooted at the task's own worktree. */
  sandbox: WorkspaceSandbox;
  task: Task;
  checks: CheckConfig[];
  maxTurns?: number;
  signal?: AbortSignal;
  /** Asks the user about a call the policy flags. Resolves true to allow it. */
  approve: (reason: string, call: ToolCall) => Promise<boolean>;
  log: (type: string, message: string, data?: Record<string, unknown>) => void;
}

export interface WorkerResult {
  summary: string;
  changedFiles: string[];
  turns: number;
}

export class WorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerError";
  }
}

const REPLY_RESERVE = 4096;

function systemPrompt(task: Task, checks: CheckConfig[]): string {
  return `You are a coding agent working on one task in a project. Work step by step.

Each reply is one JSON object: {"thought": "...", "call": {"tool": "...", ...}}. Make exactly one tool call per reply.

Tools:
- {"tool":"read_file","path":"src/a.ts","startLine":1,"endLine":200}
- {"tool":"list_files","glob":"src/**/*.ts"}
- {"tool":"search","query":"functionName","glob":"src/**"}
- {"tool":"write_file","path":"src/a.ts","content":"full file content"}
- {"tool":"replace_in_file","path":"src/a.ts","search":"exact old text","replace":"new text"}
- {"tool":"run_check","name":"${checks[0]?.name ?? "test"}"}  (available: ${checks.map((c) => c.name).join(", ") || "none"})
- {"tool":"finish","summary":"what you changed"}

Rules:
- You may only change files matching: ${task.fileScope.join(", ")}
- Read a file before changing it. Prefer replace_in_file for small edits.
- Paths are relative to the project root.
- When the task is done and checks pass, call finish.`;
}

/**
 * One agent working one task in its own worktree. The conversation is kept so
 * the orchestrator can send it check failures and let it continue.
 */
export class Worker {
  private readonly messages: ChatMessage[];
  private readonly changed = new Set<string>();
  private turns = 0;

  constructor(private readonly opts: WorkerOptions) {
    this.messages = [
      { role: "system", content: systemPrompt(opts.task, opts.checks) },
      { role: "user", content: `Task: ${opts.task.title}\n\n${opts.task.instructions}` },
    ];
  }

  /** Runs until the model calls finish. `followUp` continues an earlier run, e.g. with check failures. */
  async run(followUp?: string): Promise<WorkerResult> {
    const { provider, task, signal } = this.opts;
    const maxTurns = this.opts.maxTurns ?? 40;
    if (followUp) this.messages.push({ role: "user", content: followUp });
    let lastCall = "";
    let repeats = 0;

    while (this.turns < maxTurns) {
      signal?.throwIfAborted();
      this.turns++;
      const context = compactHistory(this.messages, provider.contextWindow - REPLY_RESERVE);
      const turn = await callStructured({ provider, messages: context, schema: workerTurnSchema, schemaName: "worker_turn", signal });
      this.messages.push({ role: "assistant", content: JSON.stringify(turn) });
      this.opts.log("tool_call", turn.call.tool, { thought: turn.thought, call: turn.call });

      const key = JSON.stringify(turn.call);
      repeats = key === lastCall ? repeats + 1 : 0;
      lastCall = key;
      if (repeats >= 2) {
        this.messages.push({ role: "user", content: "You made the same call three times. Try something different, or call finish if the task is done." });
        continue;
      }

      const decision = checkToolCall(turn.call, { fileScope: task.fileScope, allowedChecks: this.opts.checks.map((c) => c.name) });
      if (decision.verdict === "deny") {
        this.opts.log("denied", decision.reason, { call: turn.call });
        this.messages.push({ role: "user", content: `Not allowed: ${decision.reason}` });
        continue;
      }
      if (decision.verdict === "ask" && !(await this.opts.approve(decision.reason, turn.call))) {
        this.opts.log("denied", `User declined: ${decision.reason}`, { call: turn.call });
        this.messages.push({ role: "user", content: `The user declined this change: ${decision.reason}. Find another way or finish.` });
        continue;
      }

      if (turn.call.tool === "finish") {
        return { summary: turn.call.summary, changedFiles: [...this.changed], turns: this.turns };
      }
      const outcome = await executeTool(turn.call, { sandbox: this.opts.sandbox, checks: this.opts.checks, signal });
      if (outcome.wrote) this.changed.add(outcome.wrote);
      this.messages.push({ role: "user", content: `${outcome.ok ? "Result" : "Error"}:\n${outcome.output}` });
    }
    throw new WorkerError(`Task ${task.id} did not finish within ${maxTurns} turns`);
  }
}
