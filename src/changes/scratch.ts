import { promises as fs } from "fs";
import * as path from "path";

/**
 * A copy of the project inside its own .agentic folder, with pending changes
 * written into it, so checks can run against them without touching the
 * user's files. Large folders such as node_modules are linked, not copied.
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
      const top = new Set([...this.skip, ...this.linkDirs]);
      // Copied entry by entry: the copy lives inside the project, and copying a folder into itself is refused.
      for (const entry of await fs.readdir(this.projectRoot)) {
        if (top.has(entry)) continue;
        await fs.cp(path.join(this.projectRoot, entry), path.join(this.dir, entry), { recursive: true, verbatimSymlinks: true });
      }
      for (const d of this.linkDirs) {
        const source = path.join(this.projectRoot, d);
        if (await exists(source)) await fs.symlink(source, path.join(this.dir, d), process.platform === "win32" ? "junction" : "dir");
      }
      this.ready = true;
    }
    for (const [rel, content] of files) {
      const target = path.join(this.dir, ...rel.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
    }
    return this.dir;
  }

  async remove(): Promise<void> {
    await fs.rm(this.dir, { recursive: true, force: true });
    this.ready = false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}
