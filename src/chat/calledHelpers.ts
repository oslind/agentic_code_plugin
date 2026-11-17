import * as path from "path";
import { ProjectFiles } from "../tools/sandbox";
import { dataBlock } from "../context/untrusted";
import { escapeRegExp } from "../context/outline";

/** How many helper functions one batch question shows, and how many lines of each. */
const MAX_HELPERS = 6;
const MAX_LINES = 14;

interface Helper {
  name: string;
  file: string;
  code: string;
  usedBy: string[];
}

/** Names a file takes from a relative module: `const { a, b } = require("./m")` and `import { a, b } from "./m"`. */
export function localImports(text: string): { names: string[]; from: string }[] {
  const out: { names: string[]; from: string }[] = [];
  const names = (list: string) =>
    list
      .split(",")
      .map((n) => n.trim().split(/\s*(?::|\bas\b)\s*/)[0]!.trim())
      .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) out.push({ names: names(m[1]!), from: m[2]! });
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](\.{1,2}\/[^"']+)["']/g)) out.push({ names: names(m[1]!), from: m[2]! });
  return out;
}

/** The lines of `function name(...) { ... }` or `const name = (...) => { ... }` in a file, by brace matching; undefined when not found or too long. */
export function functionSource(text: string, name: string): string | undefined {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(|^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=`).test(l));
  if (start < 0) return undefined;
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length && i < start + MAX_LINES; i++) {
    for (const ch of lines[i]!) {
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") depth--;
    }
    if ((opened && depth <= 0) || (!opened && /;\s*$/.test(lines[i]!))) return lines.slice(start, i + 1).join("\n");
  }
  return undefined;
}

async function resolveModule(files: Pick<ProjectFiles, "readFile">, from: string, spec: string): Promise<{ file: string; text: string } | undefined> {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  if (base.startsWith("..")) return undefined;
  for (const file of [base, `${base}.js`, `${base}.ts`, `${base}.mjs`, `${base}.cjs`, `${base}/index.js`, `${base}/index.ts`]) {
    const text = await files.readFile(file).catch(() => undefined);
    if (typeof text === "string") return { file, text };
  }
  return undefined;
}

/**
 * Run 17, big questions: modules that throw through `assertNonNegative` in util were reported as "does not explicitly
 * throw", although the batch question says to open the other file. So the code of functions that the batch's files
 * call from other project files is found by rule and put in the question, fenced as data.
 */
export async function helpersUsed(files: Pick<ProjectFiles, "readFile">, batch: string[]): Promise<string | undefined> {
  const helpers = new Map<string, Helper>();
  for (const file of batch) {
    const text = await files.readFile(file).catch(() => undefined);
    if (typeof text !== "string") continue;
    for (const imp of localImports(text)) {
      // Only names the file calls, beyond the import line itself.
      const called = imp.names.filter((n) => (text.match(new RegExp(`(?<![\\w$.])${escapeRegExp(n)}\\s*\\(`, "g")) ?? []).length > 0);
      if (!called.length) continue;
      const mod = await resolveModule(files, file, imp.from);
      if (!mod || batch.includes(mod.file)) continue;
      for (const name of called) {
        const key = `${mod.file}#${name}`;
        const known = helpers.get(key);
        if (known) {
          known.usedBy.push(file);
          continue;
        }
        const code = functionSource(mod.text, name);
        if (code) helpers.set(key, { name, file: mod.file, code, usedBy: [file] });
      }
    }
  }
  if (!helpers.size) return undefined;
  // The helpers most files of the batch use come first.
  const shown = [...helpers.values()].sort((a, b) => b.usedBy.length - a.usedBy.length).slice(0, MAX_HELPERS);
  const body = shown.map((h) => `${h.name} in ${h.file}, called by ${h.usedBy.join(", ")}:\n${h.code}`).join("\n\n");
  return [
    `Checked by rule: these files call functions that are defined in other files. The code of those functions is below, so judge each calling file by what the function it calls does (a file that calls a function that throws can throw).${helpers.size > shown.length ? ` ${helpers.size - shown.length} more such function(s) are not shown: open their files.` : ""}`,
    dataBlock("functions from other project files", body),
  ].join("\n");
}
