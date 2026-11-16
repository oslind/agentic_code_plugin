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

/**
 * A test file by its path, in any letter case (Test/ and test/ are one folder on Windows and macOS): test, tests,
 * __tests__, spec and e2e folders, *.test.*, *.spec.*, *.e2e.*, *_test.*, test_*.py, *Test.cs / *Tests.java and
 * the like, or a root test.js.
 */
export function isTestPath(path: string): boolean {
  const original = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const p = original.toLowerCase();
  return (
    /(^|\/)(test|tests|__tests__|spec|specs|e2e)\//.test(p) ||
    /\.(test|spec|e2e)\.[\w]+$/.test(p) ||
    /_test\.[\w]+$/.test(p) ||
    /(^|\/)test_[^/]+\.py$/.test(p) ||
    // CalcTests.cs, UserTest.java: the capital T marks the word, so attest.cs is not a test.
    /(^|\/|[a-z0-9])Tests?\.(cs|java|kt|scala|swift|php)$/.test(original) ||
    /(^|\/)tests?\.(js|cjs|mjs|ts|py)$/.test(p)
  );
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

/** The tools each role may use. A call to any other gets a plain "not available" step, never a retry. */
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
  testsRan: (code: number) => `Note from the extension: this test sub-agent's last test run after its last change exited with code ${code}${code === 0 ? "" : " (a failure, or the tests could not start)"}.`,
  testsNotRun: (changed: boolean) => `Note from the extension: this test sub-agent did not run the tests${changed ? " after its last change" : ""}, so any test results in its report are not confirmed.`,
} as const;

/** A runner at the start of a command segment: the common test runners and package-manager test scripts. */
const TEST_RUNNER =
  /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|npx\s+(?:vitest|jest|mocha|ava|tap|playwright\s+test)\b|(?:vitest|jest|mocha|ava|jasmine|karma|pytest|nose2|tox|ctest|phpunit|rspec)\b|python3?\s+-m\s+(?:pytest|unittest)\b|go\s+test\b|cargo\s+test\b|make\s+(?:test|check)\b|dotnet\s+test\b|\.?\/?gradlew?\s+test\b|mvn\s+test\b|node\s+--test\b|deno\s+test\b)/;
/** Flags that make a runner list, describe or print instead of running tests. */
const NOT_A_RUN = /(^|\s)(?:--help|-h|--version|-V|--collect-only|--co|--listTests|--list|--dry-run|--showConfig)(?=\s|=|$)/;
/** An interpreter running one file, with no flags before it: "node test.js", "python tests/test_api.py". */
const RUNS_FILE = /^(?:node|python3?|py|bun|deno\s+run)\s+(\.?\/?[\w./-]+)(?:\s|$)/;

/**
 * True when a command runs tests (second audit of PR #55, F5): the project's test command, or a command segment
 * (split at && and ;, after an optional "cd dir") that starts with a known runner or runs a test file directly,
 * without --help, --version, --collect-only and the like. A command with || never counts, and one that only
 * mentions a runner (echo npm test, ls jest, cat pytest.ini) does not either.
 */
export function isTestCommand(command: string, ctx: { testCommand?: string }): boolean {
  const c = command.trim();
  if (!c) return false;
  if (ctx.testCommand && c === ctx.testCommand.trim()) return true;
  if (c.includes("||")) return false;
  return c
    .split(/&&|;/)
    // What runs after a pipe only reads the output; the runner is the part before it.
    .map((seg) => seg.split("|")[0]!.trim().replace(/^(?:[A-Za-z_][\w]*=\S*\s+)+/, ""))
    .filter((seg) => seg && !/^cd(\s|$)/.test(seg))
    .some((seg) => {
      if (NOT_A_RUN.test(seg)) return false;
      if (TEST_RUNNER.test(seg)) return true;
      const file = RUNS_FILE.exec(seg)?.[1]?.replace(/^\.\//, "");
      return !!file && isTestPath(file);
    });
}

/** A check name that may appear in the extension's own words and prompts: one short plain word (F7). */
export function isPlainCheckName(name: string): boolean {
  return /^[\w.-]{1,40}$/.test(name);
}

/**
 * A model's report with every line that reads like the extension's own note marked as the model's, so only the
 * extension's notes start with "Note from the extension" (second audit of PR #55, F6).
 */
export function markForgedNotes(summary: string): string {
  return summary.replace(/^([ \t>*_-]*)(note from the extension\b)/gim, (_m, lead: string, words: string) => `${lead}(The sub-agent wrote:) ${words}`);
}
