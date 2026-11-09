import { constants, promises as fs } from "fs";
import * as path from "path";
import picomatch from "picomatch";
import { normalizeWorkspacePath } from "./paths";
import { isProtectedPath, isSecretPath, isSensitivePath } from "./policy";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * The largest file read whole. A bigger one is refused before anything is
 * read, so a huge file in the project cannot fill the extension's memory.
 */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

/** The start of a file, read without loading the rest. */
export interface FileHead {
  text: string;
  /** The file's size in bytes. */
  size: number;
  /** True when the file is longer than what was read. */
  truncated: boolean;
}

function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

/** Reads at most `maxBytes` from an open file, whatever its size. */
async function readBounded(handle: fs.FileHandle, maxBytes: number): Promise<FileHead> {
  const size = (await handle.stat()).size;
  // One byte more than allowed, to tell a file that is exactly at the limit from one that is longer (or grew).
  const buffer = Buffer.alloc(Math.min(size, maxBytes) + 1);
  let read = 0;
  while (read < buffer.length) {
    const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  const truncated = read > maxBytes || size > maxBytes;
  return { text: buffer.subarray(0, Math.min(read, maxBytes)).toString("utf8"), size: Math.max(size, read), truncated };
}
const SKIP_DIRS = new Set([".git", "node_modules", ".agentic"]);

/** What a sub-agent's tools see of the project: the real files, or the real files plus pending changes. */
export interface ProjectFiles {
  /** The project folder on disk. */
  readonly root: string;
  /** The whole file. Refused when it is larger than MAX_FILE_BYTES (or `maxBytes`). */
  readFile(relPath: string, maxBytes?: number): Promise<string>;
  /** At most the first `maxBytes` of a file, and its size, for tools that only need the start of a big file. */
  readHead(relPath: string, maxBytes: number): Promise<FileHead>;
  writeFile(relPath: string, content: string): Promise<void>;
  /** `onSkipped` hears of every linked folder that is not listed because what it links to is not (see listFiles). */
  listFiles(glob?: string, limit?: number, onSkipped?: (rel: string, why: string) => void): Promise<string[]>;
}

/**
 * The only way agents touch the file system. Every path is resolved against
 * one workspace folder, and the real path on disk (after following symlinks)
 * must stay inside it. Nothing outside the folder open in VS Code is reachable.
 *
 * The secret and protected file rules are applied here to the real path as
 * well as to the name asked for, so a harmless-looking link such as
 * `src/build-info.txt -> ../.env` cannot be used to read or write a protected
 * file.
 */
export class WorkspaceSandbox implements ProjectFiles {
  private constructor(readonly root: string) {}

  static async create(workspaceFolder: string): Promise<WorkspaceSandbox> {
    const root = await fs.realpath(workspaceFolder);
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      throw new SandboxError(`${workspaceFolder} is not a directory`);
    }
    return new WorkspaceSandbox(root);
  }

  contains(absolute: string): boolean {
    const rel = path.relative(this.root, absolute);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  private lexical(relPath: string): string {
    const normal = normalizeWorkspacePath(relPath);
    if (!normal) {
      throw new SandboxError(`'${relPath}' is outside the workspace`);
    }
    return path.join(this.root, ...normal.split("/"));
  }

  /** A real absolute path inside the workspace as a workspace-relative POSIX path. */
  private relative(real: string): string {
    return path.relative(this.root, real).split(path.sep).join("/");
  }

  private async assertInside(absolute: string, shown: string): Promise<string> {
    let real: string;
    try {
      real = await fs.realpath(absolute);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new SandboxError(code === "ENOENT" ? `'${shown}' does not exist` : `'${shown}' cannot be resolved (${code})`);
    }
    if (!this.contains(real)) {
      throw new SandboxError(`'${shown}' resolves outside the workspace`);
    }
    return real;
  }

  /** Real path of an existing file or directory inside the workspace. */
  async resolveExisting(relPath: string): Promise<string> {
    return this.assertInside(this.lexical(relPath), relPath);
  }

  /**
   * Path to write to. The nearest existing ancestor must really be inside the
   * workspace, and an existing target must not be a link that points out.
   */
  async resolveForWrite(relPath: string): Promise<string> {
    const target = this.lexical(relPath);
    if (target === this.root) {
      throw new SandboxError("Cannot write to the workspace root itself");
    }
    let ancestor = path.dirname(target);
    while (!(await exists(ancestor))) {
      ancestor = path.dirname(ancestor);
    }
    const realAncestor = await this.assertInside(ancestor, relPath);
    // Where the file really lands, with links in the folders on the way resolved.
    let real = path.join(realAncestor, path.relative(ancestor, target));
    if (await exists(target)) {
      real = await this.assertInside(target, relPath);
    }
    const realRel = this.relative(real);
    if (isProtectedPath(relPath) || isProtectedPath(realRel)) {
      throw new SandboxError(`'${relPath}' is protected and is never written`);
    }
    // package.json, lockfiles, CI and git hooks have their own approval switch, which goes by the name of the change.
    // A link with another name would slip past it, so such files are written only by their real name.
    const lexicalRel = normalizeWorkspacePath(relPath);
    if (realRel !== lexicalRel && isSensitivePath(realRel) && !isSensitivePath(lexicalRel ?? "")) {
      throw new SandboxError(`'${relPath}' links to '${realRel}', which needs your approval to change. Change it by its real name, '${realRel}'.`);
    }
    return target;
  }

  /** Real path of a file that may be read: inside the workspace, and neither it nor what it links to may hold secrets. */
  async resolveForRead(relPath: string): Promise<string> {
    if (isSecretPath(relPath)) throw new SandboxError(`'${relPath}' may contain secrets and cannot be read`);
    const real = await this.resolveExisting(relPath);
    if (isSecretPath(this.relative(real))) throw new SandboxError(`'${relPath}' links to a file that may contain secrets and cannot be read`);
    return real;
  }

  async readFile(relPath: string, maxBytes = MAX_FILE_BYTES): Promise<string> {
    const head = await this.readHead(relPath, maxBytes);
    if (head.truncated) throw new SandboxError(`'${relPath}' is too large to read whole (${megabytes(head.size)}; the limit is ${megabytes(maxBytes)})`);
    return head.text;
  }

  async readHead(relPath: string, maxBytes: number): Promise<FileHead> {
    const real = await this.resolveForRead(relPath);
    const handle = await fs.open(real, constants.O_RDONLY | NOFOLLOW);
    try {
      await this.assertSameFile(handle, relPath, () => this.resolveForRead(relPath));
      // Size is checked on the open file, and no more than the limit is ever read, even if the file grows meanwhile.
      return await readBounded(handle, maxBytes);
    } finally {
      await handle.close();
    }
  }

  /**
   * Checks after opening that the open file is still the one the path
   * resolves to. Narrows the window in which a folder on the way could be
   * swapped for a link between the check and the open.
   */
  private async assertSameFile(handle: fs.FileHandle, shown: string, resolve: () => Promise<string>): Promise<void> {
    const [opened, again] = await Promise.all([handle.stat(), resolve().then((p) => fs.stat(p))]);
    if (opened.dev !== again.dev || opened.ino !== again.ino) {
      throw new SandboxError(`'${shown}' changed while it was being opened`);
    }
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const target = await this.resolveForWrite(relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Re-check after mkdir in case a directory was swapped for a link meanwhile.
    await this.assertInside(path.dirname(target), relPath);
    // O_NOFOLLOW refuses to open the file if it was replaced by a symlink.
    // Not truncated on open: it is emptied only after checking the open file is the one that was checked.
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | NOFOLLOW, 0o644);
    try {
      await this.assertSameFile(handle, relPath, () => this.resolveForWrite(relPath).then((t) => fs.realpath(t)));
      await handle.truncate(0);
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
  }

  /**
   * Deletes one file, with the same rules as writing it: inside the
   * workspace, never a protected file, never a folder. A link is removed
   * itself; what it points to is left alone.
   */
  async deleteFile(relPath: string): Promise<void> {
    const target = await this.resolveForWrite(relPath);
    const stat = await fs.lstat(target);
    if (stat.isDirectory()) throw new SandboxError(`'${relPath}' is a folder and is never deleted`);
    await fs.unlink(target);
  }

  /**
   * Lists workspace files matching a glob. Symlinked directories are never
   * entered, and symlinked files are listed only if they point inside.
   */
  /**
   * Project files matching glob. A linked folder is not walked: when it links to a folder inside the project,
   * those files are listed under their own path already. Audit of PR #54: one that links to a folder that is
   * not listed (outside the project, or in .git/node_modules/.agentic) used to vanish without a word, so a
   * project-wide search called itself complete. `onSkipped` is told of each, so a search can say so.
   */
  async listFiles(glob = "**", limit = 2000, onSkipped?: (rel: string, why: string) => void): Promise<string[]> {
    if (!normalizeWorkspacePath(glob)) {
      throw new SandboxError(`'${glob}' must be a relative glob inside the workspace`);
    }
    const match = picomatch(glob, { dot: true });
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= limit) return;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        const childAbs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) await walk(childAbs, childRel);
        } else if (e.isFile()) {
          if (match(childRel)) out.push(childRel);
        } else if (e.isSymbolicLink()) {
          const real = await fs.realpath(childAbs).catch(() => undefined);
          // A link to a secret file is left out, like the secret file itself would be unreadable.
          if (!real) continue;
          const stat = await fs.stat(real).catch(() => undefined);
          if (stat?.isDirectory()) {
            if (!onSkipped) continue;
            const target = this.relative(real);
            if (!this.contains(real)) onSkipped(childRel, "it links to a folder outside the project");
            else if (target.split("/").some((part) => SKIP_DIRS.has(part))) onSkipped(childRel, `it links into ${target}, which is not searched`);
            continue;
          }
          if (this.contains(real) && !isSecretPath(this.relative(real)) && stat?.isFile() && match(childRel)) out.push(childRel);
        }
      }
    };
    await walk(this.root, "");
    return out;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
