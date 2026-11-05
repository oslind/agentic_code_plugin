import { createHash } from "node:crypto";

/**
 * A skill is a short how-to for one kind of work ("run the tests", "work in a
 * Python project"), written in Markdown. The planner picks skills for each
 * task and the sub-agent gets their text in its first message; a sub-agent
 * can also load one itself with load_skill.
 *
 * Kept free of the vscode module so it can be tested directly.
 */

/** Who a skill is for: coding sub-agents, read-only research sub-agents, or the coordinator's planner. */
export type SkillRole = "coder" | "research" | "coordinator";
export const SKILL_ROLES: readonly SkillRole[] = ["coder", "research", "coordinator"];

/**
 * Where a skill came from. Built-in and user skills are trusted. Project
 * skills come from the workspace, so they are written by whoever wrote the
 * repository: they are fenced as data and used only once the user trusts them.
 */
export type SkillSource = "builtin" | "user" | "project";

export interface Skill {
  name: string;
  description: string;
  roles: SkillRole[];
  body: string;
  source: SkillSource;
  /** The file it was read from: workspace-relative for a project skill, absolute for a user skill. */
  file?: string;
  /** sha256 of the file's text, so a changed project skill has to be trusted again. */
  hash: string;
  /** The body was longer than MAX_SKILL_CHARS and was cut. */
  cut?: boolean;
}

/** About 600 tokens. A sub-agent gets at most two skills up front, so this keeps skills to a small part of a 16k context. */
export const MAX_SKILL_CHARS = 2400;
export const MAX_DESCRIPTION_CHARS = 160;
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A file name or heading turned into a skill name: "Run Tests.md" -> "run-tests". */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

function oneLine(text: string, max: number): string {
  // Control and format characters (line breaks, right-to-left overrides) never reach a prompt line.
  const flat = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function parseRoles(value: string | undefined): SkillRole[] {
  const roles = (value ?? "")
    .split(/[,\s]+/)
    .map((r) => r.trim().toLowerCase())
    .map((r) => (r === "coding" || r === "code" || r === "worker" ? "coder" : r === "researcher" ? "research" : r === "planner" ? "coordinator" : r))
    .filter((r): r is SkillRole => (SKILL_ROLES as readonly string[]).includes(r));
  return roles.length ? [...new Set(roles)] : ["coder", "research"];
}

export interface ParseOptions {
  source: SkillSource;
  file?: string;
  /** Used when the file has no name in its header. */
  fallbackName?: string;
  /** Used when the file has no description in its header. */
  fallbackDescription?: string;
  /** Used when the file has no "for:" in its header. */
  fallbackRoles?: SkillRole[];
}

/**
 * Reads a skill file. The header is optional:
 *
 *     ---
 *     name: run-tests
 *     description: Run and read the project's tests after a code change
 *     for: coder, research
 *     ---
 *     1. Find the test command ...
 *
 * Without a header, the name comes from the file name and the description
 * from the first heading or line.
 */
export function parseSkill(text: string, opts: ParseOptions): Skill | { error: string } {
  const hash = hashText(text);
  let body = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const header: Record<string, string> = {};
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(body);
  if (m) {
    for (const line of m[1]!.split("\n")) {
      const kv = /^\s*([A-Za-z_-]+)\s*:\s*(.*?)\s*$/.exec(line);
      if (kv) header[kv[1]!.toLowerCase()] = kv[2]!.replace(/^["']|["']$/g, "");
    }
    body = body.slice(m[0].length);
  }
  body = body.trim();
  const name = slug(header.name ?? "") || opts.fallbackName || "";
  if (!SKILL_NAME.test(name)) return { error: `the skill name '${oneLine(header.name ?? opts.fallbackName ?? "", 60)}' must be a short lowercase name like run-tests` };
  if (!body) return { error: `the skill '${name}' has no text` };
  const firstLine = body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") ?? "";
  const description = oneLine(header.description || opts.fallbackDescription || firstLine, MAX_DESCRIPTION_CHARS);
  if (!description) return { error: `the skill '${name}' has no description` };
  const cut = body.length > MAX_SKILL_CHARS;
  if (cut) body = `${body.slice(0, MAX_SKILL_CHARS).replace(/\n[^\n]*$/, "")}\n[… the rest of this skill was cut: skills are kept short]`;
  return {
    name,
    description,
    roles: header.for ? parseRoles(header.for) : opts.fallbackRoles ?? parseRoles(undefined),
    body,
    source: opts.source,
    file: opts.file,
    hash,
    ...(cut ? { cut } : {}),
  };
}

export function isSkill(x: Skill | { error: string }): x is Skill {
  return !("error" in x);
}
