import { constants, promises as fs } from "fs";
import * as path from "path";
import picomatch from "picomatch";
import { normalizeWorkspacePath } from "./paths";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const SKIP_DIRS = new Set([".git", "node_modules", ".agentic"]);

/**
 * The only way agents touch the file system. Every path is resolved against
 * one workspace folder, and the real path on disk (after following symlinks)
 * must stay inside it. Nothing outside the folder open in VS Code is reachable.
 */
export class WorkspaceSandbox {
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
    await this.assertInside(ancestor, relPath);
    if (await exists(target)) {
      await this.assertInside(target, relPath);
    }
    return target;
  }

  async readFile(relPath: string): Promise<string> {
    const real = await this.resolveExisting(relPath);
    const handle = await fs.open(real, constants.O_RDONLY | NOFOLLOW);
    try {
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const target = await this.resolveForWrite(relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Re-check after mkdir in case a directory was swapped for a link meanwhile.
    await this.assertInside(path.dirname(target), relPath);
    // O_NOFOLLOW refuses to open the file if it was replaced by a symlink.
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o644);
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
  }

  /**
   * Lists workspace files matching a glob. Symlinked directories are never
   * entered, and symlinked files are listed only if they point inside.
   */
  async listFiles(glob = "**", limit = 2000): Promise<string[]> {
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
          if (real && this.contains(real) && (await fs.stat(real)).isFile() && match(childRel)) out.push(childRel);
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
