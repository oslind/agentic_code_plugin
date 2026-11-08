/**
 * A JavaScript draft that cannot load is never accepted. A file that mixes ES modules (import/export) with CommonJS
 * (require/module.exports) does not load in Node. Small models write that
 * mix when asked to "import" something into a CommonJS file (e2e runs 3 to 5),
 * and model reviews kept accepting it, so the drafts are checked here, by rule.
 */

const ESM = /^\s*(import\s+[\w{*]|import\s+["']|export\s+(default\b|const\b|let\b|var\b|function\b|class\b|async\b|\{|\*))/m;
const CJS = /\bmodule\.exports\b|^\s*exports\.\w+\s*=|\brequire\s*\(\s*["']/m;

import * as vm from "vm";
import { posix } from "path";
import { ProjectFiles, WorkspaceSandbox } from "../tools/sandbox";

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
export function moduleStyleProblems(changes: { path: string; original: string | null; proposed: string }[], project?: ModuleStyle): string[] {
  const problems: string[] = [];
  for (const c of changes) {
    if (!/\.(c|m)?js$/i.test(c.path)) continue;
    // Run 10: a new config.js and a rewritten thermostat.js were both pure ES modules in a CommonJS project:
    // nothing mixed within a file, and Node could not load them with the rest.
    if (project === "commonjs" && /\.js$/i.test(c.path) && ESM.test(c.proposed) && !CJS.test(c.proposed) && !(c.original !== null && ESM.test(c.original))) {
      problems.push(`${c.path} uses import/export, but this project uses CommonJS (package.json has no "type": "module" and its files use require and module.exports), so it cannot load with the rest. Use require(...) and module.exports.`);
      continue;
    }
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

/** True when a JavaScript text exports `name` in any common form. */
function exportsName(text: string, name: string): boolean {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const n = name.replace(/\$/g, "\\$");
  const word = `(?<![\\w$])${n}(?![\\w$])`;
  if (new RegExp(`\\b(?:module\\.)?exports\\.${n}\\s*=`).test(code)) return true;
  if (new RegExp(`\\bmodule\\.exports\\s*=\\s*${n}\\s*;?\\s*$`, "m").test(code)) return true;
  if (new RegExp(`^\\s*export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${n}(?![\\w$])`, "m").test(code)) return true;
  if (new RegExp(`^\\s*export\\s+default\\s+${n}\\s*;?\\s*$`, "m").test(code)) return true;
  const lists = [...code.matchAll(/\bmodule\.exports\s*=\s*\{([^{}]*)\}/g), ...code.matchAll(/^\s*export\s*\{([^{}]*)\}/gm), ...code.matchAll(/\bObject\.assign\s*\(\s*(?:module\.)?exports\s*,\s*\{([^{}]*)\}/g)];
  return lists.some((m) => new RegExp(word).test(m[1]!));
}

/**
 * Functions a draft adds that the request says to export, but the file does not export. Run 12B: "add
 * median(readings) to src/stats.js and export it" was inserted with insert_lines, module.exports further down
 * was never touched, and the review and verification both accepted it. Only names that `said` mentions in the
 * same sentence or clause as the word "export" count, so a helper the request never named is left alone.
 */
export function unexportedProblems(changes: { path: string; original: string | null; proposed: string }[], said: string | undefined): string[] {
  if (!said || !/\bexport/i.test(said)) return [];
  const clauses = said.split(/[.;!?](?=\s|$)|\n|\band\s+(?:add|create|change|make|write)\b/i).filter((c) => /\bexport/i.test(c));
  const problems: string[] = [];
  for (const c of changes) {
    if (!/\.(c|m)?[jt]s$/i.test(c.path)) continue;
    const wanted = newFunctionNames(c.original, c.proposed).filter((name) => clauses.some((cl) => new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(cl)));
    const missing = wanted.filter((name) => !exportsName(c.proposed, name));
    if (missing.length) {
      const list = missing.join(", ");
      problems.push(`${c.path} defines ${list}, which the request says to export, but does not export ${missing.length === 1 ? "it" : "them"}, so other files cannot use ${missing.length === 1 ? "it" : "them"}. Add ${missing.length === 1 ? "it" : "them"} to the file's exports (module.exports or export, as the file already does).`);
    }
  }
  return problems;
}

/**
 * Whether a module's text gives other files a property `name`: true, false, or undefined when its shape cannot
 * be read by rule (spreads, computed exports, nothing exported at all).
 */
export function exportsProperty(text: string, name: string): boolean | undefined {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const n = name.replace(/\$/g, "\\$");
  const word = new RegExp(`(?<![\\w$.])${n}(?![\\w$])`);
  if (new RegExp(`\\b(?:module\\.)?exports\\.${n}\\s*=`).test(code)) return true;
  if (new RegExp(`^\\s*export\\s+(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${n}(?![\\w$])`, "m").test(code)) return true;
  const lists = [...code.matchAll(/^\s*export\s*\{([^{}]*)\}/gm)].map((m) => m[1]!.split(",").map((p) => p.trim().split(/\s+as\s+/).pop()!.trim()));
  if (lists.some((l) => l.includes(name))) return true;
  const objects = [...code.matchAll(/\bmodule\.exports\s*=\s*\{([^{}]*)\}/g), ...code.matchAll(/\bObject\.assign\s*\(\s*(?:module\.)?exports\s*,\s*\{([^{}]*)\}/g)];
  if (objects.some((m) => m[1]!.split(",").some((p) => word.test(p.split(":")[0]!)))) return true;
  if (objects.some((m) => /\.\.\./.test(m[1]!))) return undefined;
  // module.exports = something else (a function, a class, a name): the module is that one value.
  const single = /\bmodule\.exports\s*=\s*(?!\{)/.test(code);
  if (objects.length || single || lists.length || /^\s*export\s/m.test(code) || /\bexports\.\w+\s*=/.test(code)) return false;
  return undefined;
}

/**
 * Names a JavaScript draft takes from a project module (`const { a } = require('./x')`, `import { a } from './x.js'`)
 * that the module does not export, read with the drafts in place. Run 12B, new-module-used: format.js was
 * `module.exports = function formatTemp`, index.js took `{ formatTemp }` from it, and the program crashed with
 * "formatTemp is not a function" while the review and verification called it done.
 */
export async function importProblems(changes: { path: string; proposed: string }[], read: (path: string) => Promise<string | undefined>): Promise<string[]> {
  const problems: string[] = [];
  for (const c of changes) {
    if (!/\.(c|m)?js$/i.test(c.path)) continue;
    const code = c.proposed.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    const takes = [
      ...[...code.matchAll(/\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)].map((m) => ({ names: m[1]!.split(",").map((p) => p.trim().split(":")[0]!.trim()), from: m[2]! })),
      ...[...code.matchAll(/^\s*import\s*\{([^{}]*)\}\s*from\s*["'](\.{1,2}\/[^"']+)["']/gm)].map((m) => ({ names: m[1]!.split(",").map((p) => p.trim().split(/\s+as\s+/)[0]!.trim()), from: m[2]! })),
    ];
    for (const t of takes) {
      const base = posix.normalize(posix.join(posix.dirname(c.path), t.from));
      let target: { path: string; text: string } | undefined;
      for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}/index.js`]) {
        const text = changes.find((d) => d.path === candidate)?.proposed ?? (await read(candidate).catch(() => undefined));
        if (text !== undefined) {
          target = { path: candidate, text };
          break;
        }
      }
      if (!target) continue;
      const missing = t.names.filter((n) => /^[A-Za-z_$][\w$]*$/.test(n) && exportsProperty(target!.text, n) === false);
      if (!missing.length) continue;
      const single = /\bmodule\.exports\s*=\s*(?!\{)/.test(target.text) ? ` (${target.path} sets module.exports to a single value, so { } takes nothing from it; export an object like module.exports = { ${missing.join(", ")} }, or import the value without { })` : "";
      problems.push(`${c.path} takes ${missing.join(", ")} from ${t.from}, but ${target.path} does not export ${missing.length === 1 ? "it" : "them"}${single}, so ${missing.length === 1 ? "it is" : "they are"} undefined and calling ${missing.length === 1 ? "it" : "them"} throws. Make the two files fit together.`);
    }
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

/**
 * A default export added to a file that only had named exports. Run 10,
 * esm-project: "add multiply and export it" became `export default function
 * multiply`, so `import { multiply }` found nothing.
 */
export function exportStyleHints(path: string, before: string | null, after: string): string[] {
  if (!before || !/\.(c|m)?[jt]sx?$/i.test(path)) return [];
  const named = /^\s*export\s+(async\s+)?(function|const|let|class)\b|^\s*export\s*\{/m;
  const def = /^\s*export\s+default\b/m;
  if (named.test(before) && !def.test(before) && def.test(after)) {
    return [`${path} only had named exports (export function ...), and the draft adds a default export, so \`import { name }\` will not find it. Unless the user asked for a default export, use a named one like the rest of the file.`];
  }
  return [];
}

/** Names of functions a draft defines that the original did not. */
export function newFunctionNames(before: string | null, after: string): string[] {
  const names = (text: string) =>
    new Set([...text.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)|^\s*def\s+([A-Za-z_]\w*)/gm)].map((m) => (m[1] ?? m[2] ?? m[3])!));
  const old = names(before ?? "");
  return [...names(after)].filter((n) => !old.has(n));
}

/** True for a path that looks like a test file. */
export function isTestPath(p: string): boolean {
  return /(^|\/)(test|tests|__tests__|spec)(\/|\.[cm]?[jt]sx?$|\.py$)|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/i.test(p);
}

/**
 * New functions that no test file mentions: a passing test command says
 * nothing about them. Run 10, esm-project: "tests passed for the function's
 * correctness" while the only test called add(). `tests` is the text of the
 * project's test files with the drafts applied.
 */
export function untestedFunctions(changes: { path: string; original: string | null; proposed: string }[], tests: string): string[] {
  const out: string[] = [];
  for (const c of changes) {
    if (isTestPath(c.path) || !/\.(c|m)?[jt]sx?$|\.py$/i.test(c.path)) continue;
    for (const n of newFunctionNames(c.original, c.proposed)) if (!new RegExp(`\\b${n.replace(/\$/g, "\\$")}\\b`).test(tests)) out.push(n);
  }
  return out;
}

/** The project's test files on disk (a bounded read), for untestedFunctions(). Workspace-only. */
export async function projectTestText(files: Pick<ProjectFiles, "readFile" | "listFiles">): Promise<string> {
  const list = (await files.listFiles("**", 2000).catch(() => [] as string[])).filter(isTestPath).slice(0, 40);
  const texts: string[] = [];
  let total = 0;
  for (const f of list) {
    const t = await files.readFile(f, 100_000).catch(() => "");
    total += t.length;
    if (total > 400_000) break;
    texts.push(t);
  }
  return texts.join("\n");
}

export type ModuleStyle = "commonjs" | "module";

/**
 * The project's module style, when it is clear: "module" when package.json says "type": "module";
 * "commonjs" when package.json says nothing and the project's own .js files use require/module.exports
 * and none uses import/export (a bundled front end may use import in .js files without "type"). Undefined otherwise.
 */
export async function projectModuleStyle(files: Pick<ProjectFiles, "readFile" | "readHead" | "listFiles">): Promise<ModuleStyle | undefined> {
  let pkg: { type?: unknown };
  try {
    pkg = JSON.parse(await files.readFile("package.json", 200_000)) as { type?: unknown };
  } catch {
    return undefined;
  }
  if (pkg.type === "module") return "module";
  if (pkg.type !== undefined && pkg.type !== "commonjs") return undefined;
  const js = (await files.listFiles("**/*.js", 200).catch(() => [] as string[])).filter((f) => !/(^|\/)(node_modules|dist|build|out)\//.test(f)).slice(0, 30);
  let cjs = 0;
  for (const f of js) {
    const head = await files.readHead(f, 20_000).catch(() => undefined);
    const text = head?.text ?? "";
    if (ESM.test(text)) return undefined;
    if (CJS.test(text)) cjs++;
  }
  return cjs > 0 ? "commonjs" : undefined;
}

const styleCache = new Map<string, { at: number; style: Promise<ModuleStyle | undefined> }>();

/** projectModuleStyle() of the project on disk (never of drafts), remembered for a minute. */
export function moduleStyleOf(root: string, now = Date.now()): Promise<ModuleStyle | undefined> {
  const hit = styleCache.get(root);
  if (hit && now - hit.at < 60_000) return hit.style;
  const style = WorkspaceSandbox.create(root).then(projectModuleStyle, () => undefined);
  styleCache.set(root, { at: now, style });
  return style;
}
