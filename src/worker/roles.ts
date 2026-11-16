import { z } from "zod";
import { Task } from "../state/types";
import { ToolCall, toolCallSchema } from "../tools/protocol";

/**
 * The harness a sub-agent runs in. One loop (Worker) runs every role; the role
 * decides which tools the model is offered, what it is told up front, and
 * which rules hold before it may finish.
 *
 * - researcher: reads and runs commands, never writes (a research run's sub-agents).
 * - editor: changes code in its files (every change task that is not a tester).
 * - tester: a change task whose files are all tests; it must run them before it finishes.
 *
 * The role never decides whether a task may write: that stays with the run's
 * kind, the task's file scope and the policy. It only changes advice and rules.
 */
export type AgentRole = "researcher" | "editor" | "tester";

/** A test file by its path: test/ or tests/ folders, *.test.*, *.spec.*, *_test.*, test_*.py, or a root test.js. */
export function isTestPath(path: string): boolean {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return /(^|\/)(test|tests|__tests__|spec)\//.test(p) || /\.(test|spec)\.[\w]+$/.test(p) || /_test\.[\w]+$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p) || /(^|\/)tests?\.(js|cjs|mjs|ts|py)$/.test(p);
}

/**
 * The role of a task's sub-agent. Read-only sub-agents are researchers. A change task is a tester only when
 * every file it may change is a test file, from the plan's file scope and never from the user's words.
 */
export function roleOf(task: Pick<Task, "fileScope">, readOnly: boolean | undefined): AgentRole {
  if (readOnly) return "researcher";
  return task.fileScope.length > 0 && task.fileScope.every(isTestPath) ? "tester" : "editor";
}

type ToolName = ToolCall["tool"];

/** Tools a role can never use. A call to one gets a plain "not available" step, never a retry. */
const ROLE_TOOLS: Record<AgentRole, readonly ToolName[]> = {
  researcher: ["list_files", "read_file", "read_files", "search", "run_command", "ask_coordinator", "load_skill", "finish"],
  editor: ["read_file", "list_files", "search", "write_file", "replace_in_file", "insert_lines", "run_check", "run_command", "request_check", "ask_coordinator", "ask_user", "load_skill", "finish", "read_files"],
  tester: ["read_file", "list_files", "search", "write_file", "replace_in_file", "insert_lines", "run_check", "run_command", "request_check", "ask_coordinator", "ask_user", "load_skill", "finish", "read_files"],
};

export function roleAllows(role: AgentRole, tool: ToolName): boolean {
  return ROLE_TOOLS[role].includes(tool);
}

/** What the sub-agent can actually use: the role's tools, without those whose hook is missing. */
export interface ToolAvailability {
  askUser: boolean;
  askCoordinator: boolean;
  skills: boolean;
}

export function offeredTools(role: AgentRole, has: ToolAvailability): Set<ToolName> {
  return new Set(
    ROLE_TOOLS[role].filter((t) => (t !== "ask_user" || has.askUser) && (t !== "ask_coordinator" || has.askCoordinator) && (t !== "load_skill" || has.skills)),
  );
}

/**
 * The JSON schema sent to the server for a worker turn: only the offered tools, so a server that
 * constrains its output cannot pick another. The reply is still checked against the full tool
 * schema, so a model that ignores the format (plain JSON mode) gets a normal step back, not a retry.
 */
export function offeredTurnSchema(tools: Set<ToolName>) {
  const options = toolCallSchema.options.filter((o) => tools.has(o.shape.tool.value));
  return z.object({
    thought: z.string().max(600).describe("One or two sentences on what you are doing next"),
    // At least two options always remain (finish plus a reading tool), as discriminatedUnion needs.
    call: z.discriminatedUnion("tool", options as unknown as [(typeof options)[number], ...(typeof options)[number][]]),
  });
}

/** Said when a model calls a tool its role does not have. */
export function notAvailable(role: AgentRole, tool: string, tools: Set<ToolName>): string {
  return `The tool "${tool}" is not available to you as ${role === "researcher" ? "a research agent" : role === "tester" ? "the test agent" : "the coding agent"} of this task. Use one of: ${[...tools].join(", ")}.`;
}

/** Fixed wording added to a report when a finish rule was still not met after its reminder. No model text in it. */
export const UNMET_NOTE = {
  noWrites: "Note from the extension: this sub-agent wrote no file in this task, although its report describes a change.",
  untested: (what: string) => `Note from the extension: this sub-agent did not run ${what} after its last change.`,
  testsNotRun: (changed: boolean) => `Note from the extension: this test sub-agent did not run the tests${changed ? " after its last change" : ""}, so any test results in its report are not confirmed.`,
} as const;
