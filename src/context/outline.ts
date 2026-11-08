/**
 * The top-level outline of a source file (its functions, classes, exports), so
 * the planner plans against the code that is there. Run 10,
 * two-changes-in-a-row: the plan had three tasks for "the Thermostat class" in
 * a file that only has a plain targetTemp(mode) function.
 */
import { pathsOfTree } from "./budget";
import { ProjectFiles } from "../tools/sandbox";

const DECLARATION =
  /^(export\s+)?(default\s+)?(async\s+)?(function\*?\s+[\w$]+\s*\([^)]*\)|class\s+[\w$]+|(const|let|var)\s+[\w$]+\s*=)|^module\.exports\b|^exports\.[\w$]+\s*=|^(async\s+)?def\s+\w+\s*\([^)]*\)|^class\s+\w+/;

/** Top-level declaration lines of a file, each cut to one short line. */
export function outlineOf(text: string, maxLines = 30): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!DECLARATION.test(line)) continue;
    out.push(line.trim().replace(/\s*\{\s*$/, "").slice(0, 120));
    if (out.length >= maxLines) break;
  }
  return out;
}

/** Outlines of the project files a text names (at most `maxFiles`), read from the project. Workspace-only. */
export async function outlinesOfNamedFiles(files: Pick<ProjectFiles, "readFile">, tree: string | undefined, texts: string[], maxFiles = 4): Promise<string | undefined> {
  const said = texts.join("\n");
  const named = pathsOfTree(tree).filter((p) => /\.(c|m)?[jt]sx?$|\.py$/i.test(p) && said.includes(p)).slice(0, maxFiles);
  const parts: string[] = [];
  for (const p of named) {
    const text = await files.readFile(p, 200_000).catch(() => undefined);
    if (text === undefined) continue;
    const lines = outlineOf(text);
    parts.push(`${p}:\n${lines.length ? lines.map((l) => `  ${l}`).join("\n") : "  (no top-level functions or classes)"}`);
  }
  return parts.length ? parts.join("\n") : undefined;
}

/**
 * The project files that mention a name as a whole word, searched over the
 * whole project (bounded). Run 11, rename-everywhere: research only listed
 * src/**, so test.js kept the old name and its tests broke.
 */
export async function filesMentioning(files: Pick<ProjectFiles, "readFile" | "listFiles">, name: string, maxFiles = 400): Promise<string[]> {
  const word = new RegExp(`(^|[^\\w$])${name.replace(/[$.]/g, (c) => `\\${c}`)}(?![\\w$])`);
  const list = (await files.listFiles("**", 2000).catch(() => [] as string[])).filter((p) => !/\.(png|jpe?g|gif|ico|pdf|zip|gz|lock|woff2?|ttf|exe|dll|so|bin)$/i.test(p)).slice(0, maxFiles);
  const out: string[] = [];
  for (const p of list) {
    const text = await files.readFile(p, 300_000).catch(() => undefined);
    if (text !== undefined && word.test(text)) out.push(p);
  }
  return out;
}
