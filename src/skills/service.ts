import { builtinSkills } from "./builtin";
import { SkillCatalog } from "./catalog";
import { loadProjectSkills, loadUserSkills } from "./loader";
import { Skill, SkillRole, SkillSource } from "./skill";

/**
 * How project skills are used (agentic.skills.projectSkills, user settings only):
 * "ask" uses them once the user trusts them in Settings, and again after any
 * change; "on" uses them without asking; "off" never reads them.
 */
export type ProjectSkillMode = "ask" | "on" | "off";
export const PROJECT_SKILL_MODES: readonly ProjectSkillMode[] = ["ask", "on", "off"];

/** Hashes of the project skill files the user trusted, by file. */
export type TrustedFiles = Record<string, string>;

export interface TrustStore {
  get(workspaceRoot: string): TrustedFiles | undefined;
  set(workspaceRoot: string, trusted: TrustedFiles | undefined): Promise<void>;
}

export interface SkillSettings {
  /** agentic.skills.enabled: off means no skills at all, and no load_skill tool. */
  enabled: boolean;
  projectSkills: ProjectSkillMode;
}

/** What the Settings tab shows about skills. */
export interface SkillsView {
  enabled: boolean;
  projectSkills: ProjectSkillMode;
  skills: { name: string; description: string; source: SkillSource; roles: SkillRole[]; file?: string; cut?: boolean }[];
  /** Project skills not in use because the user has not trusted them (or they changed since). */
  waiting: { name: string; description: string; file: string; changed: boolean }[];
  problems: { file: string; error: string }[];
}

/** Splits project skills into those the user trusted at their current text and those waiting for trust. */
export function applyTrust(project: Skill[], trusted: TrustedFiles | undefined, mode: ProjectSkillMode): { used: Skill[]; waiting: (Skill & { changed: boolean })[] } {
  if (mode === "off") return { used: [], waiting: [] };
  if (mode === "on") return { used: project, waiting: [] };
  const used: Skill[] = [];
  const waiting: (Skill & { changed: boolean })[] = [];
  for (const s of project) {
    const hash = trusted?.[s.file ?? s.name];
    if (hash === s.hash) used.push(s);
    else waiting.push({ ...s, changed: hash !== undefined });
  }
  return { used, waiting };
}

export class SkillService {
  constructor(
    private readonly userDir: string,
    private readonly settings: () => SkillSettings,
    private readonly trust: TrustStore,
  ) {}

  /** Everything known about skills for a project folder. Reads the files again each time, so edits count at once. */
  async status(workspaceRoot: string | undefined): Promise<{ catalog: SkillCatalog; view: SkillsView; project: Skill[] }> {
    const { enabled, projectSkills } = this.settings();
    const user = await loadUserSkills(this.userDir);
    const project = workspaceRoot && enabled && projectSkills !== "off" ? await loadProjectSkills(workspaceRoot) : { skills: [], problems: [] };
    const { used, waiting } = applyTrust(project.skills, workspaceRoot ? this.trust.get(workspaceRoot) : undefined, projectSkills);
    const catalog = enabled ? new SkillCatalog([...builtinSkills(), ...user.skills, ...used]) : SkillCatalog.empty;
    return {
      catalog,
      project: project.skills,
      view: {
        enabled,
        projectSkills,
        skills: catalog.skills.map((s) => ({ name: s.name, description: s.description, source: s.source, roles: s.roles, file: s.file, ...(s.cut ? { cut: true } : {}) })),
        waiting: waiting.map((s) => ({ name: s.name, description: s.description, file: s.file ?? s.name, changed: s.changed })),
        problems: [...user.problems, ...project.problems],
      },
    };
  }

  async catalog(workspaceRoot: string | undefined): Promise<SkillCatalog> {
    return (await this.status(workspaceRoot)).catalog;
  }

  /** Trusts the project's skill files as they are now. A later change to one of them needs trust again. */
  async trustProject(workspaceRoot: string): Promise<number> {
    const { skills } = await loadProjectSkills(workspaceRoot);
    await this.trust.set(workspaceRoot, Object.fromEntries(skills.map((s) => [s.file ?? s.name, s.hash])));
    return skills.length;
  }

  async untrustProject(workspaceRoot: string): Promise<void> {
    await this.trust.set(workspaceRoot, undefined);
  }

  /** The text of a skill, to show it to the user. */
  async find(workspaceRoot: string | undefined, name: string): Promise<Skill | undefined> {
    const { catalog, project } = await this.status(workspaceRoot);
    return catalog.get(name) ?? project.find((s) => s.name === name);
  }
}
