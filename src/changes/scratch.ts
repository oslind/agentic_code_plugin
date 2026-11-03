import { constants as fsConstants, promises as fs } from "fs";
import * as path from "path";
import { isSecretPath } from "../tools/policy";

/**
 * A copy of the project inside its own .agentic folder, with pending changes
 * written into it, so checks can run against them without touching the
 * user's files. Large folders such as node_modules are linked, not copied.
 *
 * Files that may hold secrets (.env files, keys, certificates, credentials)
 * are left out, so a check that runs here cannot read them from the copy.
 * This is not a security boundary: a check runs as you, and can still read
 * anything your user account can, including the real project folder.
 */
export class ScratchCopy {
  private ready = false;

  constructor(
    private readonly projectRoot: string,
    readonly dir: string,
    private readonly linkDirs: string[],
    private readonly skip: string[] = [".git", ".agentic"],
  ) {}

  /** Creates the copy the first time, then writes the given files into it. Resolves the folder. */
  async sync(files: ReadonlyMap<string, string>): Promise<string> {
    if (!this.ready) {
      await fs.rm(this.dir, { recursive: true, force: true });
      await fs.mkdir(this.dir, { recursive: true });
      const top = new Set([...this.skip, ...safeLinkDirs(this.linkDirs)]);
      // Copied entry by entry: the copy lives inside the project, and copying a folder into itself is refused.
      for (const entry of await fs.readdir(this.projectRoot)) {
        if (top.has(entry)) continue;
        await fs.cp(path.join(this.projectRoot, entry), path.join(this.dir, entry), {
          recursive: true,
          verbatimSymlinks: true,
          filter: (source) => this.keep(source),
        });
      }
      for (const d of safeLinkDirs(this.linkDirs)) {
        const source = path.join(this.projectRoot, d);
        const stat = await fs.lstat(source).catch(() => undefined);
        // Only a real folder, never a link to somewhere else.
        if (stat?.isDirectory()) await this.linkTree(source, path.join(this.dir, d));
      }
      this.ready = true;
    }
    for (const [rel, content] of files) await this.writeInCopy(rel, content);
    return this.dir;
  }

  /**
   * Links a dependency folder into the copy without its secret files. A
   * folder with no secrets anywhere inside is linked whole; one that holds
   * some is recreated, and its other entries are linked one by one, so the
   * secret files themselves are the only things left out.
   */
  private async linkTree(source: string, target: string, whole = true): Promise<void> {
    const root = await fs.realpath(this.projectRoot);
    if (whole && !(await holdsSecrets(source, root))) {
      await fs.symlink(source, target, process.platform === "win32" ? "junction" : "dir");
      return;
    }
    await fs.mkdir(target, { recursive: true });
    for (const e of await fs.readdir(source, { withFileTypes: true })) {
      const from = path.join(source, e.name);
      const to = path.join(target, e.name);
      if (!(await this.keep(from))) continue;
      if (e.isDirectory()) {
        await this.linkTree(from, to);
        continue;
      }
      const isDir = await fs.stat(from).then((x) => x.isDirectory(), () => false);
      // Windows needs extra rights for file links; a copy of the file does the same job.
      await fs.symlink(from, to, isDir ? (process.platform === "win32" ? "junction" : "dir") : "file").catch(() => fs.cp(from, to, { recursive: true }));
    }
  }

  /**
   * Writes a pending change into the copy. Linked folders and files in the
   * copy point at the real project, so writing through one would change the
   * user's file before they accepted anything. Every link on the way is
   * replaced first: a linked folder by a real one whose entries are linked
   * one by one, a linked file by the new file.
   */
  private async writeInCopy(rel: string, content: string): Promise<void> {
    const parts = rel.split("/");
    let current = this.dir;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]!);
      const stat = await fs.lstat(current).catch(() => undefined);
      if (!stat) break;
      if (!stat.isSymbolicLink()) continue;
      const real = await fs.realpath(current).catch(() => undefined);
      const isDir = real ? await fs.stat(real).then((x) => x.isDirectory(), () => false) : false;
      await fs.rm(current, { force: true });
      if (i < parts.length - 1 && real && isDir) await this.linkTree(real, current, false);
    }
    const target = path.join(this.dir, ...parts);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Nothing on the way is a link any more; refuse if one appeared meanwhile.
    const handle = await fs.open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0), 0o644);
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    const realTarget = await fs.realpath(target);
    const inside = path.relative(await fs.realpath(this.dir), realTarget);
    if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Error(`The scratch copy of '${rel}' resolves outside the scratch folder.`);
  }

  private rel(absolute: string): string {
    return path.relative(this.projectRoot, absolute).split(path.sep).join("/");
  }

  /**
   * Whether an entry goes into the copy. Secret files are left out by name.
   * Links are kept as links, so they are also followed: one that leads
   * outside the project or to a secret file is left out, and so is one to a
   * folder that holds secret files.
   */
  private async keep(source: string): Promise<boolean> {
    if (isSecretPath(this.rel(source))) return false;
    const stat = await fs.lstat(source).catch(() => undefined);
    if (!stat?.isSymbolicLink()) return true;
    const real = await fs.realpath(source).catch(() => undefined);
    if (!real) return false;
    const root = await fs.realpath(this.projectRoot);
    const rel = path.relative(root, real).split(path.sep).join("/");
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || isSecretPath(rel)) return false;
    const target = await fs.stat(real);
    return !target.isDirectory() || !(await holdsSecrets(real, root));
  }

  async remove(): Promise<void> {
    await fs.rm(this.dir, { recursive: true, force: true });
    this.ready = false;
  }
}

/**
 * Folders that may be linked into the scratch copy: dependency folders that
 * are too large to copy. Anything else is copied, so the secret filter
 * applies to it. A project folder such as `src` can never be linked
 * wholesale.
 */
export const LINKABLE_DIRS = ["node_modules", "bower_components", ".venv", "venv", "vendor", ".tox", ".gradle", "target"];

/** The configured folders that may be linked: only names from LINKABLE_DIRS. */
export function safeLinkDirs(value: unknown): string[] {
  if (!Array.isArray(value)) return ["node_modules"];
  return [...new Set(value.filter((d): d is string => typeof d === "string" && LINKABLE_DIRS.includes(d)))];
}

/** Whether a folder holds a file that may contain secrets, or a link to one. Gives up (true) on very large folders. */
async function holdsSecrets(dir: string, root: string, budget = { left: 5000 }, seen = new Set<string>()): Promise<boolean> {
  const self = await fs.realpath(dir).catch(() => dir);
  if (seen.has(self)) return false;
  seen.add(self);
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (--budget.left < 0) return true;
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (isSecretPath(rel)) return true;
    if (e.isSymbolicLink()) {
      const real = await fs.realpath(abs).catch(() => undefined);
      if (!real) continue;
      const realRel = path.relative(root, real).split(path.sep).join("/");
      if (realRel.startsWith("..") || path.isAbsolute(realRel) || isSecretPath(realRel)) return true;
      // A linked folder is looked into too: what it holds is reachable through the link.
      const isDir = await fs.stat(real).then((x) => x.isDirectory(), () => false);
      if (isDir && (await holdsSecrets(real, root, budget, seen))) return true;
    } else if (e.isDirectory() && (await holdsSecrets(abs, root, budget, seen))) {
      return true;
    }
  }
  return false;
}
