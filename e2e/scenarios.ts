/**
 * The scripted scenarios. Each one is a small project and a prompt that once
 * went wrong with a real local model (stalls, no final reply, no commands,
 * stopping halfway). Keep the projects tiny so an 8B model can do them, and
 * check outcomes, not wording: a model may phrase things any way it likes.
 */
import { Scenario } from "./harness";

/** A tiny thermostat project in plain Node, so its tests run without installing anything. */
const thermostat: Record<string, string> = {
  "README.md": "# Thermostat\n\nA small heating controller. Run the tests with `node test.js`.\n",
  "package.json": JSON.stringify({ name: "thermostat", version: "1.0.0", private: true, scripts: { test: "node test.js" } }, null, 2) + "\n",
  "src/index.js": [
    "const { targetTemp } = require('./thermostat');",
    "const { toCelsius } = require('./convert');",
    "",
    "console.log(`Target: ${targetTemp(process.argv[2])} C (${toCelsius(70).toFixed(1)} C is 70 F)`);",
    "",
  ].join("\n"),
  "src/thermostat.js": [
    "// The heating target. Night mode lowers it by 3 degrees.",
    "const DEFAULT_TARGET = 21;",
    "",
    "function targetTemp(mode) {",
    "  return mode === 'night' ? DEFAULT_TARGET - 3 : DEFAULT_TARGET;",
    "}",
    "",
    "module.exports = { targetTemp, DEFAULT_TARGET };",
    "",
  ].join("\n"),
  "src/convert.js": ["function toCelsius(f) {", "  return ((f - 32) * 5) / 9;", "}", "", "module.exports = { toCelsius };", ""].join("\n"),
  "src/stats.js": [
    "// Average of a list of temperature readings.",
    "function average(readings) {",
    "  let sum = 0;",
    "  for (const r of readings) sum += r;",
    "  return sum / 2;",
    "}",
    "",
    "module.exports = { average };",
    "",
  ].join("\n"),
  "test.js": [
    "const assert = require('assert');",
    "const { targetTemp } = require('./src/thermostat');",
    "const { toCelsius } = require('./src/convert');",
    "const { average } = require('./src/stats');",
    "",
    "const tests = {",
    "  'default target is 21': () => assert.strictEqual(targetTemp(), 21),",
    "  'night is 3 lower': () => assert.strictEqual(targetTemp('night'), 18),",
    "  'freezing point': () => assert.strictEqual(toCelsius(32), 0),",
    "  'average of two': () => assert.strictEqual(average([20, 22]), 21),",
    "  'average of three': () => assert.strictEqual(average([18, 20, 22]), 20),",
    "};",
    "",
    "let failed = 0;",
    "for (const [name, fn] of Object.entries(tests)) {",
    "  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }",
    "}",
    "console.log(`${Object.keys(tests).length - failed} passed, ${failed} failed`);",
    "process.exit(failed ? 1 : 0);",
    "",
  ].join("\n"),
};

const tests = { name: "tests", command: "node test.js" };

const mentions = (text: string | undefined, pattern: RegExp, what: string): string[] => (pattern.test(text ?? "") ? [] : [`the answer does not mention ${what}: ${(text ?? "").slice(0, 300)}`]);

export const SCENARIOS: Scenario[] = [
  {
    name: "research-answer",
    description: "A read-only question in Plan mode is researched by sub-agents and ends with one combined answer (once ended with no answer at all).",
    mode: "plan",
    files: thermostat,
    prompts: ["Which file decides the heating target temperature, and what is the default target?"],
    expect: (r) => {
      const failures = [...mentions(r.lastCoordinator?.text, /thermostat\.js/, "src/thermostat.js"), ...mentions(r.lastCoordinator?.text, /\b21\b/, "the default of 21")];
      if (!r.entries.some((e) => e.kind === "research" || e.kind === "report" || e.kind === "spawn")) failures.push("no sub-agent read the project: the answer was not researched");
      if (r.entries.some((e) => e.kind === "review")) failures.push("a read-only question produced drafts");
      return failures;
    },
  },
  {
    name: "change-final-reply",
    description: "A change request in Act mode is planned, carried out by a sub-agent and ends with the coordinator's final reply (once froze, or ended without a reply).",
    mode: "act",
    files: thermostat,
    permissions: { editFiles: true },
    prompts: ["Add a function toFahrenheit(celsius) to src/convert.js that returns celsius * 9 / 5 + 32, and export it next to toCelsius."],
    expect: async (r) => {
      const failures: string[] = [];
      const text = await r.read("src/convert.js");
      if (!/toFahrenheit/.test(text ?? "")) failures.push("src/convert.js has no toFahrenheit");
      const check = await r.sh("node", ["-e", "const c=require('./src/convert');if(c.toFahrenheit(100)!==212||c.toCelsius(212)!==100)process.exit(1)"]);
      if (check.code !== 0) failures.push(`toFahrenheit(100) is not 212, or toCelsius broke: ${check.output.slice(0, 300)}`);
      if (r.lastCoordinator?.tag !== "final reply") failures.push(`the run did not end with the coordinator's final reply (last: ${r.lastCoordinator?.tag ?? r.lastCoordinator?.kind ?? "none"})`);
      return failures;
    },
  },
  {
    name: "command-use",
    description: "Asked to run the tests, a sub-agent actually runs the command and the answer reports its result (once answered without running anything).",
    mode: "act",
    files: thermostat,
    prompts: ["Run `node test.js` and tell me which test fails. Do not change any files."],
    expect: async (r) => {
      const failures: string[] = [];
      if (!r.entries.some((e) => e.kind === "command" && /node\s+test\.js/.test(e.command?.line ?? ""))) failures.push("node test.js was never run");
      failures.push(...mentions(r.lastCoordinator?.text, /average/i, "the failing average test"));
      if (r.entries.some((e) => e.kind === "review")) failures.push("files were changed although the prompt said not to");
      return failures;
    },
  },
  {
    name: "verify-fix",
    description: "A bug fix is verified with the approved checks before the coordinator calls it done, with fix-up rounds if needed (once stopped halfway, claiming success).",
    mode: "act",
    files: thermostat,
    permissions: { editFiles: true, commands: true },
    checks: [tests],
    prompts: ["average() in src/stats.js gives wrong results for lists that do not have exactly two readings. Fix it so that `node test.js` passes."],
    expect: async (r) => {
      const failures: string[] = [];
      const run = await r.sh("node", ["test.js"]);
      if (run.code !== 0) failures.push(`node test.js still fails after the run:\n${run.output.slice(-600)}`);
      if (!r.entries.some((e) => e.kind === "command" && /check tests/.test(e.tag ?? ""))) failures.push("the coordinator never ran the checks on the drafts to verify the request");
      if (r.state.done && !/verified/i.test(r.state.done.text)) failures.push(`the Finished bar does not say whether it was verified: ${r.state.done.text}`);
      return failures;
    },
  },
  {
    name: "draft-for-review",
    description: "With Edit files off, a new file waits as a pending draft for review, and no sub-agent stalls on asking the user to look at it (once hung on 'let me wait for your review').",
    mode: "act",
    files: thermostat,
    acceptDrafts: false,
    prompts: ["Write docs/usage.md with a short guide on how to run the thermostat (node src/index.js night) and its tests. I want to review it before it is saved."],
    expect: (r) => {
      const failures: string[] = [];
      const drafts = Object.values(r.state.plans).flatMap((p) => p.changes);
      if (!drafts.some((c) => c.path === "docs/usage.md" && c.status === "pending")) failures.push(`docs/usage.md is not waiting as a pending draft (drafts: ${drafts.map((c) => `${c.path}=${c.status}`).join(", ") || "none"})`);
      const reviewQuestions = r.cards.filter((c) => c.kind === "question" && /review|look at|check (it|the draft)/i.test(c.text));
      if (reviewQuestions.length) failures.push(`a sub-agent asked the user to review instead of finishing: ${reviewQuestions[0]!.text.slice(0, 200)}`);
      return failures;
    },
  },
];
