/**
 * A JavaScript draft that cannot load is never accepted. A file that mixes ES modules (import/export) with CommonJS
 * (require/module.exports) does not load in Node. Small models write that
 * mix when asked to "import" something into a CommonJS file (e2e runs 3 to 5),
 * and model reviews kept accepting it, so the drafts are checked here, by rule.
 */

const ESM = /^\s*(import\s+[\w{*]|import\s+["']|export\s+(default\b|const\b|let\b|var\b|function\b|class\b|async\b|\{|\*))/m;
const CJS = /\bmodule\.exports\b|^\s*exports\.\w+\s*=|\brequire\s*\(\s*["']/m;

import * as vm from "vm";

/** Heading of the problems section in draftsForReview(). Its lines are facts from this check. */
export const DRAFT_PROBLEMS_HEADING = "Problems the extension found in the drafts (checked by rule, not a model's opinion):";

function mixes(text: string): boolean {
  return ESM.test(text) && CJS.test(text);
}

/**
 * The syntax error in a CommonJS script, compiled (never run) the way Node wraps a module. Undefined when it
 * compiles, and for ES module files, which a plain script cannot compile.
 */
export function scriptSyntaxError(text: string): string | undefined {
  if (ESM.test(text)) return undefined;
  const body = text.replace(/^#!.*/, "");
  try {
    new vm.Script(`(function (exports, require, module, __filename, __dirname) {${body}\n})`);
    return undefined;
  } catch (err) {
    return err instanceof SyntaxError ? err.message : undefined;
  }
}

/**
 * One line per JavaScript draft that cannot load and did not have that problem before: it mixes the two
 * module styles, or (as a CommonJS file) it has a syntax error. Run 5 accepted a test.js with its new
 * tests pasted after the closing brace.
 */
export function moduleStyleProblems(changes: { path: string; original: string | null; proposed: string }[]): string[] {
  const problems: string[] = [];
  for (const c of changes) {
    if (!/\.(c|m)?js$/i.test(c.path)) continue;
    if (mixes(c.proposed) && !(c.original !== null && mixes(c.original))) {
      problems.push(`${c.path} uses both import/export and require/module.exports, so Node cannot load it. Use one module style, the one the rest of the file and project uses.`);
      continue;
    }
    if (/\.mjs$/i.test(c.path)) continue;
    const error = scriptSyntaxError(c.proposed);
    if (error && !(c.original !== null && scriptSyntaxError(c.original))) problems.push(`${c.path} has a syntax error, so it cannot load: ${error.slice(0, 160)}. Fix the code around it.`);
  }
  return problems;
}

/** The problem lines inside a draftsForReview() text, if any. */
export function draftProblemsOf(drafts: string): string[] {
  const at = drafts.lastIndexOf(DRAFT_PROBLEMS_HEADING);
  if (at < 0) return [];
  return drafts
    .slice(at + DRAFT_PROBLEMS_HEADING.length)
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}
