import { createHash } from "crypto";
import { constants as fsConstants, promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import picomatch from "picomatch";
import { isSecretPath } from "../tools/policy";

export class ScratchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScratchError";
  }
}

/**
 * Where scratch copies live: a folder that belongs to the extension (VS
 * Code's global storage for it), never inside the project. A project cannot
 * plant a link such as `.agentic -> /tmp` to move the copy somewhere else,
 * because nothing in the project decides where the copy goes.
 *
 * Without a configured folder (tests, or a host without storage), a private
 * temporary folder made with mkdtemp is used.
 */
let configuredBase: string | undefined;
let tempBase: Promise<string> | undefined;

/** Sets the extension's own folder for scratch copies. Called once at activation. */
export function setScratchBase(dir: string | undefined): void {
  configuredBase = dir ? path.resolve(dir) : undefined;
}

/** The real path of the folder that holds every scratch copy. */
export async function scratchBase(): Promise<string> {
  if (configuredBase) {
    await fs.mkdir(configuredBase, { recursive: true, mode: 0o700 });
    return fs.realpath(configuredBase);
  }
  tempBase ??= fs.mkdtemp(path.join(os.tmpdir(), "agentic-scratch-")).then((d) => fs.realpath(d));
  return tempBase;
}

/** One folder name: kept when plain, otherwise replaced by a hash, so a name can never add a level or leave the folder. */
function safeName(name: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : createHash("sha256").update(name).digest("hex").slice(0, 16);
}

/** The folder for one project: its name (for people looking at the folder) and a hash of its real path. */
function projectKey(realRoot: string): string {
  const name = path.basename(realRoot).replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 32) || "project";
  return `${name}-${createHash("sha256").update(realRoot).digest("hex").slice(0, 12)}`;
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Where the scratch folder for a project and the given names is (or would be). Nothing is checked or made. */
export async function scratchPathFor(projectRoot: string, ...names: string[]): Promise<string> {
  return path.join(await scratchBase(), projectKey(await fs.realpath(projectRoot)), ...names.map(safeName));
}

/**
 * The scratch folder for a project and the given names (such as a run and a
 * task), checked and, with `create`, made level by level. Every level below
 * the extension's folder must be a real folder: a link anywhere on the way is
 * refused, so nothing is created, copied or deleted anywhere else. The folder
 * may not be inside the project either, nor hold it.
 * Resolves undefined when `create` is off and the folder does not exist.
 */
async function scratchFolder(projectRoot: string, names: string[], create: boolean): Promise<string | undefined> {
  const base = await scratchBase();
  const project = await fs.realpath(projectRoot);
  if (inside(project, base) || inside(base, project)) {
    throw new ScratchError(`The scratch folder ${base} is inside the project or holds it, so no copy is made there.`);
  }
  const levels = [projectKey(project), ...names.map(safeName)];
  let current = base;
  for (const level of levels) {
    current = path.join(current, level);
    let stat = await fs.lstat(current).catch(() => undefined);
    if (!stat) {
      if (!create) return undefined;
      await fs.mkdir(current, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
      });
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ScratchError(`${current} is not a plain folder, so the scratch copy is not made or removed there.`);
    }
  }
  // Nothing on the way is a link, so the folder is exactly where it was asked to be.
  if ((await fs.realpath(current)) !== current) throw new ScratchError(`${current} resolves somewhere else, so the scratch copy is not used.`);
  return current;
}

/**
 * Removes a project's scratch folder for the given names (such as a whole
 * run) after the same checks as making it. A link on the way is never
 * followed: such a folder is left as it is.
 */
export async function removeScratchFolder(projectRoot: string, ...names: string[]): Promise<void> {
  const dir = await scratchFolder(projectRoot, names, false);
  if (dir) await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Removes scratch folders older than `maxAgeMs`: copies left behind when VS
 * Code was closed in the middle of a run. A copy is made again whenever a
 * check needs it, so removing one is always safe once its run is over.
 */
export async function removeStaleScratch(maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now()): Promise<number> {
  const base = await scratchBase();
  let removed = 0;
  for (const project of await fs.readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!project.isDirectory()) continue;
    for (const run of await fs.readdir(path.join(base, project.name), { withFileTypes: true }).catch(() => [])) {
      const abs = path.join(base, project.name, run.name);
      const stat = await fs.lstat(abs).catch(() => undefined);
      if (!stat || now - stat.mtimeMs < maxAgeMs) continue;
      // A link is removed itself; what it points to is never touched.
      await fs.rm(abs, { recursive: true, force: true }).catch(() => undefined);
      removed++;
    }
  }
  return removed;
}

/** How much one scratch copy, and all of them together, may hold. From user settings only. */
export interface ScratchLimits {
  /** Most files copied into one copy. Linked dependency folders do not count. */
  maxFiles: number;
  /** Most bytes copied into one copy. */
  maxBytes: number;
  /** Most bytes in all copies that exist at the same time (parallel sub-agents each have one). */
  maxTotalBytes: number;
  /** Globs (relative to the project) of files and folders never copied, such as `dist` or `logs/*.log`. A folder name excludes everything in it. */
  exclude: string[];
}

export const DEFAULT_SCRATCH_LIMITS: ScratchLimits = {
  maxFiles: 50_000,
  maxBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  exclude: [],
};

let limits: ScratchLimits = DEFAULT_SCRATCH_LIMITS;
/** Bytes held by each copy that exists right now. */
const held = new Map<ScratchCopy, number>();

export function setScratchLimits(next: Partial<ScratchLimits>): void {
  limits = { ...DEFAULT_SCRATCH_LIMITS, ...next };
}

/** Copies that exist right now, so the terminal can say a command runs in a copy. */
const liveFolders = new Map<string, string>();

/** The copy `dir` is in, if it is a live scratch copy: its folder, the path inside it, and the project it copies. */
export function scratchCopyOf(dir: string): { folder: string; rel: string; project: string } | undefined {
  for (const [folder, project] of liveFolders) {
    if (inside(folder, dir)) return { folder, project, rel: path.relative(folder, dir).split(path.sep).join("/") };
  }
  return undefined;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * A copy of the project in the extension's own storage, with pending changes
 * written into it, so checks can run against them without touching the
 * user's files. Large folders such as node_modules are linked, not copied.
 *
 * Files that may hold secrets (.env files, keys, certificates, credentials)
 * are left out, so a check that runs here cannot read them from the copy.
 * This is not a security boundary: a check runs as you, and can still read
 * anything your user account can, including the real project folder.
 *
 * The copy has a size budget (files and bytes, per copy and for all copies
 * together); a project too large for it is refused with a message saying
 * which setting to change, instead of filling the disk.
 */
export class ScratchCopy {
  private ready = false;
  private folder?: string;
  private files = 0;
  private bytes = 0;

  constructor(
    private readonly projectRoot: string,
    /** Names of the folder levels below the project's scratch folder, such as a run and a task. */
    private readonly names: string[],
    private readonly linkDirs: string[],
    private readonly skip: string[] = [".git", ".agentic"],
  ) {}

  /** The folder of the copy, made and checked if needed. */
  async dir(): Promise<string> {
    this.folder ??= await scratchFolder(this.projectRoot, this.names, true);
    return this.folder!;
  }

  private count(bytes: number, file: boolean): void {
    if (file) this.files++;
    this.bytes += bytes;
    held.set(this, this.bytes);
    if (this.files > limits.maxFiles) {
      throw new ScratchError(`The project has more than ${limits.maxFiles} files to copy for running commands. Add folders that commands do not need to agentic.scratch.exclude, or raise agentic.scratch.maxFiles (user settings).`);
    }
    if (this.bytes > limits.maxBytes) {
      throw new ScratchError(`The project holds more than ${megabytes(limits.maxBytes)} to copy for running commands. Add large folders that commands do not need to agentic.scratch.exclude, or raise agentic.scratch.maxMegabytes (user settings).`);
    }
    let total = 0;
    for (const n of held.values()) total += n;
    if (total > limits.maxTotalBytes) {
      throw new ScratchError(`The scratch copies of running sub-agents together hold more than ${megabytes(limits.maxTotalBytes)}. Let fewer sub-agents run at once, exclude folders with agentic.scratch.exclude, or raise agentic.scratch.maxTotalMegabytes (user settings).`);
    }
  }

  /** Creates the copy the first time, then writes the given files into it. Resolves the folder. */
  async sync(files: ReadonlyMap<string, string>): Promise<string> {
    const dir = await this.dir();
    if (!this.ready) {
      liveFolders.set(dir, this.projectRoot);
      try {
        await this.fill(dir);
      } catch (err) {
        // A copy that failed half way is removed, so it holds no disk space and is made again next time.
        await this.remove().catch(() => undefined);
        throw err;
      }
      this.ready = true;
    }
    for (const [rel, content] of files) {
      this.count(Buffer.byteLength(content, "utf8"), false);
      await this.writeInCopy(dir, rel, content);
    }
    return dir;
  }

  private async fill(dir: string): Promise<void> {
    await fs.rm(dir, { recursive: true, force: true });
    // Checked again after the old copy is gone: every level is a real folder, made here.
    this.folder = await scratchFolder(this.projectRoot, this.names, true);
    this.files = 0;
    this.bytes = 0;
    const top = new Set([...this.skip, ...safeLinkDirs(this.linkDirs)]);
    const excluded = limits.exclude.length ? picomatch(limits.exclude.flatMap((p) => [p, `${p.replace(/\/+$/, "")}/**`]), { dot: true }) : () => false;
    // Copied entry by entry, so the folders skipped above are never even entered.
    for (const entry of await fs.readdir(this.projectRoot)) {
      if (top.has(entry)) continue;
      await fs.cp(path.join(this.projectRoot, entry), path.join(dir, entry), {
        recursive: true,
        verbatimSymlinks: true,
        filter: async (source) => {
          if (excluded(this.rel(source))) return false;
          if (!(await this.keep(source))) return false;
          const stat = await fs.lstat(source).catch(() => undefined);
          if (stat?.isFile()) this.count(stat.size, true);
          return true;
        },
      });
    }
    for (const d of safeLinkDirs(this.linkDirs)) {
      const source = path.join(this.projectRoot, d);
      const stat = await fs.lstat(source).catch(() => undefined);
      // Only a real folder, never a link to somewhere else.
      if (stat?.isDirectory()) await this.linkTree(source, path.join(dir, d));
    }
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
  private async writeInCopy(dir: string, rel: string, content: string): Promise<void> {
    const parts = rel.split("/");
    let current = dir;
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
    const target = path.join(dir, ...parts);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Nothing on the way is a link any more. Opened without truncating, and checked before anything is written:
    // O_NOFOLLOW refuses a link as the file itself, and the checks below catch a folder on the way swapped for one.
    const handle = await fs.open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0), 0o644);
    try {
      const realTarget = await fs.realpath(target);
      const inside = path.relative(await fs.realpath(dir), realTarget);
      if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Error(`The scratch copy of '${rel}' resolves outside the scratch folder.`);
      const [opened, reached] = await Promise.all([handle.stat(), fs.stat(realTarget)]);
      if (opened.dev !== reached.dev || opened.ino !== reached.ino) throw new Error(`The scratch copy of '${rel}' changed while it was being opened.`);
      await handle.truncate(0);
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
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

  /** Removes the copy, after checking again that every level of its folder is a real folder. */
  async remove(): Promise<void> {
    held.delete(this);
    if (this.folder) liveFolders.delete(this.folder);
    this.ready = false;
    this.files = 0;
    this.bytes = 0;
    if (!this.folder) return;
    await removeScratchFolder(this.projectRoot, ...this.names);
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
