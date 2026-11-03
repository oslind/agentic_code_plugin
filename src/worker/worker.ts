import { CommandSink } from "../checks/commandTerminal";
import { ApproveCommand, CheckConfig } from "../checks/runner";
import { callStructured } from "../llm/structured";
import { ChatMessage, ModelProvider } from "../providers/types";
import { Task } from "../state/types";
import { checkToolCall } from "../tools/policy";
import { ToolCall, workerTurnSchema } from "../tools/protocol";
import { ProjectFiles } from "../tools/sandbox";
import { compactHistory } from "./history";
import { executeTool } from "./tools";

export interface WorkerOptions {
  provider: ModelProvider;
  /** The project as this sub-agent sees it. Writes stay pending until the user accepts them. */
  sandbox: ProjectFiles;
  /** Folder where check commands run. Defaults to the project folder (used by research, which never writes). */
  checkDir?: () => Promise<string>;
  /** The extension's terminal, where commands are shown as they run. */
  terminal?: CommandSink;
  task: Task;
  /** Extra notes for the first message, such as what a failed earlier attempt did. */
  context?: string;
  checks: CheckConfig[];
  maxTurns?: number;
  signal?: AbortSignal;
  /** Asks the user about a call the policy flags. Resolves true to allow it. */
  /** Asks the user about a call the policy flagged. `preview` shows a file change before it is made. */
  approve: (reason: string, call: ToolCall, preview?: string) => Promise<boolean>;
  /** Asks before a check command runs. Without it, approved checks run freely. */
  approveCommand?: ApproveCommand;
  log: (type: string, message: string, data?: Record<string, unknown>) => void;
  /**
   * A research worker: it may only read, and its finish summary is its report.
   * Writes are refused by the policy anyway, since its file scope is empty.
   */
  readOnly?: boolean;
  /** Messages the user sent to this sub-agent since its last step. Each call drains them. */
  inbox?: () => string[];
  /** Asks the user a question in the chat and resolves with the answer. Without it, ask_user is refused. */
  askUser?: (question: string) => Promise<string>;
  /**
   * Called right before ask_user. The orchestrator uses it to put this
   * sub-agent's drafts up for review, so the user can see what the question
   * is about before answering.
   */
  beforeAsk?: () => Promise<void>;
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

function researchPrompt(): string {
  return `You are a research agent. You investigate one question about a project by reading its files. You cannot change files or run commands.

Each reply is one JSON object: {"thought": "...", "call": {"tool": "...", ...}}. Make exactly one tool call per reply.

Tools:
- {"tool":"list_files","glob":"src/**"}
- {"tool":"read_file","path":"README.md","startLine":1,"endLine":200}
- {"tool":"search","query":"functionName","glob":"src/**"}
- {"tool":"finish","summary":"your report"}

Rules:
- Start broad (README, package files, the file list), then read what matters for the question.
- Paths are relative to the project root.
- Read only what you need. When you can answer, call finish.
- The finish summary is your report to the coordinator: concrete findings, with file names. A few short paragraphs or a list.`;
}

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
- {"tool":"request_check","name":"pytest","command":"python -m pytest tests/test_api.py -q","reason":"runs the tests for the code I changed"}  (asks the user to approve a new verification command)
- {"tool":"ask_user","question":"..."}  (only when you cannot continue without the user's answer)
- {"tool":"finish","summary":"what you changed"}

Rules:
- You may only change files matching: ${task.fileScope.join(", ")}
- Read a file before changing it. Prefer replace_in_file for small edits.
- Paths are relative to the project root.
- Only use request_check if you changed code and none of the available checks covers it. Never for documentation, config text or other changes that have nothing to test. Approved checks also run when your task is verified.
- Only use ask_user if you truly cannot continue without the user's decision. Never use it to ask for review or feedback ("Anything to change?", "Let me wait for your review"): the user reviews every draft after you call finish, and can message you then.
- write_file and replace_in_file only make drafts. Nothing reaches the project until the user accepts it, so never say a file "has been created" or "has been updated". Say it is ready for review.
- When the task is done and checks pass, call finish.`;
}

/**
 * One agent working one task on its view of the project. The conversation is kept so
 * the orchestrator can send it check failures and let it continue.
 */
export class Worker {
  private readonly messages: ChatMessage[];
  /** Checks the user approved for this task through request_check. They also run at verification. */
  readonly extraChecks: CheckConfig[] = [];
  private readonly changed = new Set<string>();
  private turns = 0;

  constructor(private readonly opts: WorkerOptions) {
    this.messages = [
      { role: "system", content: opts.readOnly ? researchPrompt() : systemPrompt(opts.task, opts.checks) },
      { role: "user", content: `Task: ${opts.task.title}\n\n${opts.task.instructions}${opts.context ? `\n\n${opts.context}` : ""}` },
    ];
  }

  /** Configured checks plus any the user approved for this task. A later approval replaces one with the same name. */
  get checks(): CheckConfig[] {
    const extraNames = new Set(this.extraChecks.map((c) => c.name));
    return [...this.opts.checks.filter((c) => !extraNames.has(c.name)), ...this.extraChecks];
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
      for (const m of this.opts.inbox?.() ?? []) {
        this.messages.push({ role: "user", content: `Message from the user: ${m}\n\nTake this into account, then continue with your task.` });
      }
      const context = compactHistory(this.messages, provider.contextWindow - REPLY_RESERVE);
      let thinking: string | undefined;
      const turn = await callStructured({
        provider,
        messages: context,
        schema: workerTurnSchema,
        schemaName: "worker_turn",
        signal,
        onThinking: (t) => (thinking = t),
      });
      this.messages.push({ role: "assistant", content: JSON.stringify(turn) });
      this.opts.log("tool_call", turn.call.tool, { thought: turn.thought, call: turn.call, thinking: clip(thinking) });

      const key = JSON.stringify(turn.call);
      repeats = key === lastCall ? repeats + 1 : 0;
      lastCall = key;
      if (repeats >= 2) {
        this.messages.push({ role: "user", content: "You made the same call three times. Try something different, or call finish if the task is done." });
        continue;
      }

      const checks = this.checks;
      const decision = checkToolCall(turn.call, {
        fileScope: task.fileScope,
        allowedChecks: this.opts.readOnly ? [] : checks.map((c) => c.name),
        knownCommands: new Map(checks.map((c) => [c.name, c.command])),
      });
      if (decision.verdict === "deny") {
        this.opts.log("denied", decision.reason, { call: turn.call });
        this.messages.push({ role: "user", content: `Not allowed: ${decision.reason}` });
        continue;
      }
      // A file change is shown before it is made; nothing is written until it is approved.
      const preview = decision.verdict === "ask" ? await previewChange(turn.call, this.opts.sandbox) : undefined;
      if (decision.verdict === "ask" && !(await this.opts.approve(decision.reason, turn.call, preview))) {
        this.opts.log("denied", `User declined: ${decision.reason}`, { call: turn.call });
        this.messages.push({ role: "user", content: `The user declined this change: ${decision.reason}. Find another way or finish.` });
        continue;
      }

      if (turn.call.tool === "finish") {
        return { summary: turn.call.summary, changedFiles: [...this.changed], turns: this.turns };
      }
      if (turn.call.tool === "ask_user") {
        if (!this.opts.askUser) {
          this.messages.push({ role: "user", content: "The user cannot be asked right now. Make a reasonable choice, say which in your summary, and continue." });
          continue;
        }
        await this.opts.beforeAsk?.();
        const answer = await this.opts.askUser(turn.call.question);
        this.opts.log("user_answer", answer);
        this.messages.push({ role: "user", content: `The user answered: ${answer}` });
        continue;
      }
      if (turn.call.tool === "request_check") {
        if (this.opts.readOnly) {
          this.messages.push({ role: "user", content: "Research agents cannot run commands." });
          continue;
        }
        // Approved above. Remember it so it can be rerun by name and runs at verification.
        const check = { name: turn.call.name, command: turn.call.command };
        if (!checks.some((c) => c.name === check.name && c.command === check.command)) {
          const i = this.extraChecks.findIndex((c) => c.name === check.name);
          if (i >= 0) this.extraChecks.splice(i, 1);
          this.extraChecks.push(check);
          this.opts.log("check_added", `${check.name}: ${check.command}`, { check });
        }
      }
      const call = turn.call.tool === "request_check" ? { tool: "run_check" as const, name: turn.call.name } : turn.call;
      if (call.tool === "run_check" && this.opts.approveCommand) {
        // A new command was just approved above; any other check run is asked about now, before it runs.
        const justApproved = turn.call.tool === "request_check" && decision.verdict === "ask";
        const check = this.checks.find((c) => c.name === call.name);
        if (check && !justApproved && !(await this.opts.approveCommand(check))) {
          this.opts.log("denied", `User declined running ${check.command}`, { call: turn.call });
          this.messages.push({ role: "user", content: `The user did not allow running \`${check.command}\` now. Continue without it, or finish.` });
          continue;
        }
      }
      const outcome = await executeTool(call, { sandbox: this.opts.sandbox, checks: this.checks, signal, checkDir: this.opts.checkDir, terminal: this.opts.terminal });
      if (outcome.wrote) this.changed.add(outcome.wrote);
      this.messages.push({ role: "user", content: `${outcome.ok ? "Result" : "Error"}:\n${outcome.output}` });
    }
    throw new WorkerError(`Task ${task.id} did not finish within ${maxTurns} turns`);
  }
}

/** What a file change will do, for the approval card. Small enough to read; long changes are cut. */
export async function previewChange(call: ToolCall, sandbox: ProjectFiles, max = 6000): Promise<string | undefined> {
  if (call.tool !== "write_file" && call.tool !== "replace_in_file") return undefined;
  const before = await sandbox.readFile(call.path).catch(() => undefined);
  let text: string;
  if (call.tool === "replace_in_file") {
    text = [...call.search.split("\n").map((l) => `- ${l}`), ...call.replace.split("\n").map((l) => `+ ${l}`)].join("\n");
  } else if (before === undefined) {
    text = `New file:\n${call.content.split("\n").map((l) => `+ ${l}`).join("\n")}`;
  } else {
    text = lineDiff(before, call.content);
  }
  return text.length > max ? `${text.slice(0, max)}\n[… cut, ${text.length - max} more characters]` : text;
}

/** A plain line diff: unchanged lines at the start and end are trimmed, the middle is shown as removed then added. */
function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return "No change.";
  const head = start > 0 ? [`@@ line ${start + 1} @@`] : [];
  return [...head, ...a.slice(start, endA).map((l) => `- ${l}`), ...b.slice(start, endB).map((l) => `+ ${l}`)].join("\n");
}

/** Thinking can be long; keep enough to follow along without bloating the log. */
function clip(text: string | undefined, max = 4000): string | undefined {
  text = text?.trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}\n[… cut]` : text;
}
