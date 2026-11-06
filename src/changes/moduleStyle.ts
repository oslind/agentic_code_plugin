/**
 * A JavaScript file that mixes ES modules (import/export) with CommonJS
 * (require/module.exports) does not load in Node. Small models write that
 * mix when asked to "import" something into a CommonJS file (e2e runs 3 to 5),
 * and model reviews kept accepting it, so the drafts are checked here, by rule.
 */

const ESM = /^\s*(import\s+[\w{*]|import\s+["']|export\s+(default\b|const\b|let\b|var\b|function\b|class\b|async\b|\{|\*))/m;
const CJS = /\bmodule\.exports\b|^\s*exports\.\w+\s*=|\brequire\s*\(\s*["']/m;

/** Heading of the problems section in draftsForReview(). Its lines are facts from this check. */
export const DRAFT_PROBLEMS_HEADING = "Problems the extension found in the drafts (checked by rule, not a model's opinion):";

function mixes(text: string): boolean {
  return ESM.test(text) && CJS.test(text);
}

/** One line per draft of a .js/.cjs/.mjs file that now mixes the two module styles (and did not before). */
export function moduleStyleProblems(changes: { path: string; original: string | null; proposed: string }[]): string[] {
  return changes
    .filter((c) => /\.(c|m)?js$/i.test(c.path) && mixes(c.proposed) && !(c.original !== null && mixes(c.original)))
    .map((c) => `${c.path} uses both import/export and require/module.exports, so Node cannot load it. Use one module style, the one the rest of the file and project uses.`);
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
