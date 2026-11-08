import { z } from "zod";

/**
 * The tools a worker can call. Workers make one call per turn, which small
 * models handle far more reliably than parallel or nested calls.
 */
export const toolCallSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("read_file"),
    path: z.string(),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  }),
  z.object({ tool: z.literal("list_files"), glob: z.string() }),
  z.object({ tool: z.literal("search"), query: z.string().min(1), glob: z.string().optional() }),
  z.object({ tool: z.literal("write_file"), path: z.string(), content: z.string() }),
  z.object({
    tool: z.literal("replace_in_file"),
    path: z.string(),
    search: z.string().min(1).describe("Exact text to find; must occur exactly once unless all is true"),
    replace: z.string(),
    all: z.boolean().optional().describe("true: replace every occurrence (for a rename)"),
  }),
  z.object({
    tool: z.literal("insert_lines"),
    path: z.string(),
    line: z.number().int().min(1).describe("Insert before this line number; 1 = the very top of the file"),
    text: z.string().min(1).describe("The lines to insert"),
  }),
  z.object({ tool: z.literal("run_check"), name: z.string().describe("Name of a configured check, e.g. test or lint") }),
  z.object({
    tool: z.literal("request_check"),
    name: z.string().min(1).max(40).describe("Short name, e.g. pytest"),
    command: z.string().min(1).max(500).describe("Shell command run from the project root"),
    reason: z.string().max(300).describe("Why this check verifies your task"),
  }),
  z.object({
    tool: z.literal("run_command"),
    command: z.string().min(1).max(500).describe("One shell command, run from the project root, e.g. npm test or ls src"),
    reason: z.string().max(300).optional().describe("Why you run it"),
  }),
  z.object({ tool: z.literal("load_skill"), name: z.string().min(1).max(60).describe("A skill name from the skill list") }),
  z.object({ tool: z.literal("ask_user"), question: z.string().min(5).max(1000) }),
  z.object({ tool: z.literal("ask_coordinator"), question: z.string().min(5).max(1000) }),
  z.object({ tool: z.literal("finish"), summary: z.string().min(1) }),
]);

export type ToolCall = z.infer<typeof toolCallSchema>;

/** A worker turn: brief reasoning then exactly one tool call. */
export const workerTurnSchema = z.object({
  thought: z.string().max(600).describe("One or two sentences on what you are doing next"),
  call: toolCallSchema,
});

export type WorkerTurn = z.infer<typeof workerTurnSchema>;

export const WRITE_TOOLS = new Set<ToolCall["tool"]>(["write_file", "replace_in_file", "insert_lines"]);
