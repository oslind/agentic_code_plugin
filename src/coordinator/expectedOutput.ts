import { z } from "zod";
import { dataBlock, DATA_REMINDER, DATA_RULE } from "../context/untrusted";
import { callStructured, VERDICT_MAX_TOKENS } from "../llm/structured";
import { ChatMessage, ModelProvider } from "../providers/types";

/**
 * What the program must print once the request is done, read from the user's own words before anyone looks at the
 * drafts, and then checked by code against what the program printed with all drafts together.
 *
 * Run 30, new-module-used: the user asked for formatTemp (with "formatTemp(21) returns '21.0 °C'") to be used in
 * src/index.js to print the target. The plan made it `console.log('Formatted Temp:', formatTemp(212))`; the program
 * printed "Formatted Temp: 212.0 °C" and "Target: 21 C", and verification, reading the drafts, called it done. A
 * reader that never sees the drafts is not drawn to them, and the text it names must be copied from the user's
 * words, so it cannot make up an expectation of its own. One model call per run, only when the user's words quote
 * something and a changed program ran.
 */

export interface ProgramRun {
  line: string;
  /** Output on the project without the drafts; undefined when it failed or did not run. */
  before?: string;
  /** Output with all drafts. */
  now: string;
}

export interface Expectation {
  command: string;
  shows: string;
}

export const expectationSchema = z.object({
  expectations: z
    .array(
      z.object({
        command: z.string().min(1).max(200).describe("The command, exactly as listed"),
        shows: z.string().min(1).max(120).describe("Text its output must contain once the request is done, copied exactly from the user's words"),
      }),
    )
    .max(3)
    .describe("Empty when the user's words do not say what a listed command prints"),
});

const SYSTEM = `You read a user's request to a coding assistant and say what the program must print once the request is done. You do not see the changes.
- Only text the user's words say the program prints or shows: directly ("prints 'Result: 5'"), or by asking for a function to be used to print something whose result the words give (a function used "to print the target", with "f(21) returns '21.0 °C'" and a target of 21 in the output before, prints 21.0 °C).
- Copy that text exactly from the user's words, without the quote marks around it. Never write text that is not in the user's words.
- The output before the changes shows what the program prints now: use it to see which value the user means.
- If the user's words do not say what a listed command prints, return no expectations.

${DATA_RULE}`;

const squeeze = (t: string) => t.replace(/\s+/g, "");

/** Whether the user's words quote anything: without that there is nothing to copy, and no call is made. */
export function quotesSomething(words: string): boolean {
  return /'[^'\n]{2,80}'|"[^"\n]{2,80}"|`[^`\n]{2,80}`|“[^”\n]{2,80}”|‘[^’\n]{2,80}’/.test(words);
}

export function buildExpectationMessages(words: string, runs: ProgramRun[]): ChatMessage[] {
  const listed = runs
    .slice(0, 3)
    .map((r) => dataBlock(`\`${r.line.slice(0, 120)}\``, `Output before the changes:\n${r.before?.trim() || "(failed or printed nothing)"}`))
    .join("\n\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: `The user's request:\n${words.trim()}\n\nThe commands:\n${listed}\n\n${DATA_REMINDER} What must each command print once the request is done?` },
  ];
}

/** Keeps expectations for a listed command whose text is in the user's words (compared without white space). */
export function checkedExpectations(found: Expectation[], words: string, runs: ProgramRun[]): Expectation[] {
  const said = squeeze(words);
  return found
    .map((e) => ({ command: e.command.trim().replace(/^`|`$/g, ""), shows: e.shows.trim().replace(/^['"`“‘]+|['"`”’]+$/g, "") }))
    .filter((e) => squeeze(e.shows).length >= 2 && said.includes(squeeze(e.shows)) && runs.some((r) => squeeze(r.line) === squeeze(e.command)));
}

export async function expectedOutput(provider: ModelProvider, words: string, runs: ProgramRun[], opts: { signal?: AbortSignal } = {}): Promise<Expectation[]> {
  if (!runs.length || !quotesSomething(words)) return [];
  const res = await callStructured({ maxTokens: VERDICT_MAX_TOKENS, provider, messages: buildExpectationMessages(words, runs), schema: expectationSchema, schemaName: "expected_output", signal: opts.signal });
  return checkedExpectations(res.expectations, words, runs);
}

/** The expectations the output with the drafts does not meet (white space ignored), each with what was printed. */
export function unmetExpectations(expected: Expectation[], runs: ProgramRun[]): { expectation: Expectation; run: ProgramRun }[] {
  return expected.flatMap((e) => {
    const run = runs.find((r) => squeeze(r.line) === squeeze(e.command));
    return run && !squeeze(run.now).includes(squeeze(e.shows)) ? [{ expectation: e, run }] : [];
  });
}
