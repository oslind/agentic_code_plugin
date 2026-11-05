import { promises as fs } from "node:fs";
import * as path from "node:path";
import { WorkspaceSandbox } from "../tools/sandbox";
import { isSkill, parseSkill, Skill, slug } from "./skill";

/** The folder in a project that holds its skills. */
export const PROJECT_SKILLS_DIR = ".agentic/skills";
/** Files other agent tools use for a project's conventions. Read as one skill each. */
export const CONVENTION_FILES = ["AGENTS.md", ".clinerules"] as const;
/** Most skill files read from one folder. */
export const MAX_SKILL_FILES = 30;
/** A skill file larger than this is not read: skills are short. */
export const MAX_SKILL_FILE_BYTES = 32 * 1024;

export interface LoadResult {
  skills: Skill[];
  /** Files that could not be used, with why. Shown in Settings. */
  problems: { file: string; error: string }[];
}

function addParsed(out: LoadResult, text: string, opts: Parameters<typeof parseSkill>[1]): void {
  const parsed = parseSkill(text, opts);
  if (isSkill(parsed)) out.skills.push(parsed);
  else out.problems.push({ file: opts.file ?? "?", error: parsed.error });
}

/**
 * The user's own skills, from a folder in the extension's storage (opened
 * with "Agentic: Open my skills folder"). Trusted like the user's settings.
 * Only regular .md files directly in the folder are read: links are skipped.
 */
export async function loadUserSkills(dir: string): Promise<LoadResult> {
  const out: LoadResult = { skills: [], problems: [] };
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const files = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md")).map((e) => e.name).sort().slice(0, MAX_SKILL_FILES);
  for (const name of files) {
    const file = path.join(dir, name);
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_SKILL_FILE_BYTES) {
        out.problems.push({ file, error: `larger than ${MAX_SKILL_FILE_BYTES / 1024} KB` });
        continue;
      }
      addParsed(out, await fs.readFile(file, "utf8"), { source: "user", file, fallbackName: slug(name) });
    } catch (err) {
      out.problems.push({ file, error: (err as Error).message });
    }
  }
  return out;
}

/**
 * The project's own skills: .agentic/skills/*.md, plus AGENTS.md and
 * .clinerules (a file, or a folder of .md files) as convention skills. Read
 * through the sandbox, so only files really inside the project are read and
 * secret files never are. These are untrusted: the caller decides with the
 * user's trust whether any of them is used.
 */
export async function loadProjectSkills(workspaceRoot: string): Promise<LoadResult> {
  const out: LoadResult = { skills: [], problems: [] };
  let sandbox: WorkspaceSandbox;
  try {
    sandbox = await WorkspaceSandbox.create(workspaceRoot);
  } catch {
    return out;
  }
  const read = async (rel: string): Promise<string | undefined> => {
    try {
      const head = await sandbox.readHead(rel, MAX_SKILL_FILE_BYTES);
      if (head.truncated) {
        out.problems.push({ file: rel, error: `larger than ${MAX_SKILL_FILE_BYTES / 1024} KB` });
        return undefined;
      }
      return head.text;
    } catch (err) {
      out.problems.push({ file: rel, error: (err as Error).message });
      return undefined;
    }
  };
  const mdFilesIn = async (relDir: string): Promise<string[] | undefined> => {
    try {
      const real = await sandbox.resolveExisting(relDir);
      if (!(await fs.stat(real)).isDirectory()) return undefined;
      const entries = await fs.readdir(real, { withFileTypes: true });
      return entries
        .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.toLowerCase().endsWith(".md"))
        .map((e) => `${relDir}/${e.name}`)
        .sort()
        .slice(0, MAX_SKILL_FILES);
    } catch {
      return undefined;
    }
  };

  for (const rel of (await mdFilesIn(PROJECT_SKILLS_DIR)) ?? []) {
    const text = await read(rel);
    if (text !== undefined) addParsed(out, text, { source: "project", file: rel, fallbackName: slug(path.posix.basename(rel)) });
  }

  const conventions = { fallbackDescription: "This project's own conventions and rules for agents", fallbackRoles: ["coder", "research"] as Skill["roles"] };
  const agents = await exists(sandbox, "AGENTS.md");
  if (agents) {
    const text = await read("AGENTS.md");
    if (text !== undefined) addParsed(out, withoutHeader(text), { source: "project", file: "AGENTS.md", fallbackName: "project-conventions", ...conventions });
  }
  const clineDir = await mdFilesIn(".clinerules");
  if (clineDir) {
    for (const rel of clineDir) {
      const text = await read(rel);
      if (text !== undefined) addParsed(out, withoutHeader(text), { source: "project", file: rel, fallbackName: `cline-${slug(path.posix.basename(rel))}`.slice(0, 40), ...conventions });
    }
  } else if (await exists(sandbox, ".clinerules")) {
    const text = await read(".clinerules");
    if (text !== undefined) addParsed(out, withoutHeader(text), { source: "project", file: ".clinerules", fallbackName: "cline-rules", ...conventions });
  }
  return out;
}

/**
 * AGENTS.md and .clinerules are not skill files: their own front matter (if
 * any) is not a skill header, so the fallback name and description are used.
 */
function withoutHeader(text: string): string {
  return text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
}

async function exists(sandbox: WorkspaceSandbox, rel: string): Promise<boolean> {
  try {
    await sandbox.resolveExisting(rel);
    return true;
  } catch {
    return false;
  }
}
