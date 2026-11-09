/**
 * The top-level outline of a source file (its functions, classes, exports), so
 * the planner plans against the code that is there. Run 10,
 * two-changes-in-a-row: the plan had three tasks for "the Thermostat class" in
 * a file that only has a plain targetTemp(mode) function.
 */
import { pathsOfTree } from "./budget";
import { ProjectFiles } from "../tools/sandbox";
import { isSecretPath } from "../tools/policy";

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

/** Escapes every regular-expression character in text, so it matches only itself. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The files that mention a name, and whether every file was searched. */
export interface Mentions {
  files: string[];
  /** Why the search did not cover every project file, in plain words; undefined when it did. */
  incomplete?: string;
}

/** Most files listed for a whole-project search, and most bytes read in all. */
export const MENTION_SEARCH_FILES = 5000;
const MENTION_SEARCH_BYTES = 128 * 1024 * 1024;

/**
 * The project files that mention a name as a whole word, searched over the
 * whole project. Run 11, rename-everywhere: research only listed src/**, so
 * test.js kept the old name and its tests broke. Audit of PR #54: it used to
 * stop silently after 400 files, so a rename could be called complete with
 * files nobody searched; now every listed file is searched, and anything left
 * out (a project too large to list, files too large to read, unreadable ones)
 * is said in `incomplete`.
 */
export async function filesMentioning(files: Pick<ProjectFiles, "readFile" | "listFiles">, name: string): Promise<Mentions> {
  const word = new RegExp(`(^|[^\\w$])${escapeRegExp(name)}(?![\\w$])`);
  let listed: string[];
  const skipped: string[] = [];
  try {
    listed = await files.listFiles("**", MENTION_SEARCH_FILES + 1, (rel, why) => skipped.push(`${rel} (${why})`));
  } catch (err) {
    return { files: [], incomplete: `the project's files could not be listed (${(err as Error).message})` };
  }
  const reasons: string[] = [];
  if (skipped.length) reasons.push(`linked file(s) or folder(s) not searched: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", …" : ""}`);
  if (listed.length > MENTION_SEARCH_FILES) reasons.push(`the project has more than ${MENTION_SEARCH_FILES} files, and only the first ${MENTION_SEARCH_FILES} were searched`);
  // Secret files are never read or changed by a sub-agent, so they are not searched either.
  const list = listed.slice(0, MENTION_SEARCH_FILES).filter((p) => !isSecretPath(p) && !/\.(png|jpe?g|gif|ico|pdf|zip|gz|lock|woff2?|ttf|exe|dll|so|bin)$/i.test(p));
  const out: string[] = [];
  const unread: string[] = [];
  let bytes = 0;
  for (const [i, p] of list.entries()) {
    if (bytes > MENTION_SEARCH_BYTES) {
      reasons.push(`the search stopped after ${i} of ${list.length} files (over ${MENTION_SEARCH_BYTES / (1024 * 1024)} MB read)`);
      break;
    }
    const text = await files.readFile(p, 1024 * 1024).catch(() => undefined);
    if (text === undefined) {
      unread.push(p);
      continue;
    }
    bytes += text.length;
    if (word.test(text)) out.push(p);
  }
  if (unread.length) reasons.push(`${unread.length} file(s) could not be read or are over 1 MB (${unread.slice(0, 5).join(", ")}${unread.length > 5 ? ", …" : ""})`);
  return { files: out, incomplete: reasons.length ? reasons.join("; ") : undefined };
}
