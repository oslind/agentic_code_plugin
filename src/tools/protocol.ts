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
    search: z.string().min(1).describe("Exact text to find; must occur exactly once"),
    replace: z.string(),
  }),
  z.object({ tool: z.literal("run_check"), name: z.string().describe("Name of a configured check, e.g. test or lint") }),
  z.object({ tool: z.literal("finish"), summary: z.string().min(1) }),
]);

export type ToolCall = z.infer<typeof toolCallSchema>;

/** A worker turn: brief reasoning then exactly one tool call. */
export const workerTurnSchema = z.object({
  thought: z.string().max(600).describe("One or two sentences on what you are doing next"),
  call: toolCallSchema,
});

export type WorkerTurn = z.infer<typeof workerTurnSchema>;

export const WRITE_TOOLS = new Set<ToolCall["tool"]>(["write_file", "replace_in_file"]);
