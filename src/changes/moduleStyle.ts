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
 * Names a file exports that it never defines: `module.exports = { a, b }` or `export { a, b }` shorthand
 * whose name appears nowhere else in the file. Node throws a ReferenceError when it loads such a file.
 * Run 6D: a sub-agent's only edit added toKelvin to module.exports without writing the function.
 * Read by rule, never run. Only plain names are checked; `a: b`, `a as b` and spreads are left alone.
 */
export function undefinedExports(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const lists = [...code.matchAll(/\bmodule\.exports\s*=\s*\{([^{}]*)\}/g), ...code.matchAll(/^\s*export\s*\{([^{}]*)\}\s*(?!from)/gm)];
  const missing: string[] = [];
  for (const m of lists) {
    const rest = code.slice(0, m.index) + code.slice(m.index! + m[0].length);
    for (const part of m[1]!.split(",")) {
      const name = part.trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(name) || missing.includes(name)) continue;
      if (!new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(rest)) missing.push(name);
    }
  }
  return missing;
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
    const undefinedNow = undefinedExports(c.proposed).filter((n) => c.original === null || !undefinedExports(c.original).includes(n));
    if (undefinedNow.length) {
      problems.push(`${c.path} exports ${undefinedNow.join(", ")} but never defines ${undefinedNow.length === 1 ? "it" : "them"}, so loading it throws a ReferenceError. Write the missing code.`);
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

/**
 * Array indexes that are half a length: not a whole number when the length is
 * odd, so the element is undefined in JavaScript. Run 9 and 10: qwen wrote
 * median() as sorted[sorted.length / 2] in four of about ten runs, and neither
 * its tests nor the review ran the odd case. A hint, not a load problem: the
 * code may only use it for even lengths.
 */
export function halfIndexHints(path: string, text: string): string[] {
  if (!/\.(c|m)?[jt]sx?$/i.test(path)) return [];
  const hints: string[] = [];
  const direct = text.match(/\[\s*[\w.]+\.length\s*\/\s*2\s*\]/);
  if (direct) hints.push(`${path}: \`${direct[0]}\` is not a whole number when the length is odd, so it gives undefined. Use Math.floor(... / 2) where the odd case needs the middle element.`);
  for (const m of text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*([\w.]+)\.length\s*\/\s*2\s*;/g)) {
    const name = m[1]!;
    if (new RegExp(`\\[\\s*${name}\\s*\\]`).test(text)) {
      hints.push(`${path}: \`${name} = ${m[2]}.length / 2\` is not a whole number when the length is odd, so \`[${name}]\` gives undefined then. Use Math.floor(${m[2]}.length / 2) for the odd case.`);
    }
  }
  return hints;
}
