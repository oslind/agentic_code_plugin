import picomatch from "picomatch";
import { PendingChange } from "../state/types";
import { normalizeWorkspacePath } from "../tools/paths";
import { ProjectFiles, SandboxError, WorkspaceSandbox } from "../tools/sandbox";

/**
 * The project as one sub-agent sees it: the files on disk, plus changes that
 * earlier tasks of the run proposed, plus this sub-agent's own writes.
 * Writes never reach the disk here; they become pending changes the user
 * reviews. Paths are still checked against the real project folder, so a
 * pending change can never point outside it.
 */
export class OverlayFiles implements ProjectFiles {
  /** This sub-agent's writes, by normalized path. */
  readonly writes = new Map<string, string>();
  /** The text on disk when a file was first written here; null if it did not exist. */
  private readonly originals = new Map<string, string | null>();

  constructor(
    private readonly disk: WorkspaceSandbox,
    /** Pending changes from earlier tasks of the run, by path. */
    private readonly base: ReadonlyMap<string, string> = new Map(),
  ) {}

  get root(): string {
    return this.disk.root;
  }

  private norm(relPath: string): string {
    const p = normalizeWorkspacePath(relPath);
    if (!p) throw new SandboxError(`'${relPath}' is outside the workspace`);
    return p;
  }

  async readFile(relPath: string): Promise<string> {
    const p = this.norm(relPath);
    const own = this.writes.get(p) ?? this.base.get(p);
    return own ?? this.disk.readFile(p);
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const p = this.norm(relPath);
    // Confinement is checked against the real folder even though nothing is written yet.
    await this.disk.resolveForWrite(p);
    if (!this.originals.has(p)) this.originals.set(p, await this.disk.readFile(p).catch(() => null));
    this.writes.set(p, content);
  }

  async listFiles(glob = "**", limit = 2000): Promise<string[]> {
    const onDisk = await this.disk.listFiles(glob, limit);
    const match = picomatch(glob, { dot: true });
    const extra = [...this.base.keys(), ...this.writes.keys()].filter((p) => match(p));
    return [...new Set([...onDisk, ...extra])].sort().slice(0, limit);
  }

  /**
   * The user accepted this text for `relPath` while the sub-agent was still
   * working, so it is on disk now. Later drafts are compared with it.
   */
  rebase(relPath: string, onDisk: string): void {
    this.originals.set(this.norm(relPath), onDisk);
  }

  /** Every file this sub-agent and the tasks before it changed, with its current text. For checks. */
  allChanges(): Map<string, string> {
    return new Map([...this.base, ...this.writes]);
  }

  /** This sub-agent's writes as pending changes. Writes that ended up identical to the file on disk are left out. */
  pending(taskId: string): PendingChange[] {
    const out: PendingChange[] = [];
    for (const [p, proposed] of this.writes) {
      const original = this.originals.get(p) ?? null;
      if (original === proposed) continue;
      out.push({ path: p, taskId, original, proposed, status: "pending" });
    }
    return out;
  }
}

/** The run's pending changes that later tasks build on, by path. Rejected changes are left out; accepted ones are on disk. */
export function pendingBase(changes: PendingChange[] | undefined): Map<string, string> {
  return new Map((changes ?? []).filter((c) => c.status === "pending").map((c) => [c.path, c.proposed]));
}
