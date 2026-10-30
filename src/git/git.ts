import { promises as fs } from "fs";
import * as path from "path";
import { exec } from "../util/exec";

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** Thin wrapper over the git CLI. Arguments are passed without a shell. */
export class Git {
  constructor(readonly cwd: string) {}

  async run(args: string[], allowFail = false): Promise<string> {
    const res = await exec("git", args, { cwd: this.cwd, timeoutMs: 120_000 });
    if (res.code !== 0 && !allowFail) {
      throw new GitError(`git ${args[0]} failed: ${res.stderr.trim() || res.stdout.trim()}`, res.stderr);
    }
    return res.stdout.trim();
  }

  async ok(args: string[]): Promise<boolean> {
    const res = await exec("git", args, { cwd: this.cwd, timeoutMs: 120_000 });
    return res.code === 0;
  }

  at(dir: string): Git {
    return new Git(dir);
  }

  isRepo(): Promise<boolean> {
    return this.ok(["rev-parse", "--is-inside-work-tree"]);
  }

  toplevel(): Promise<string> {
    return this.run(["rev-parse", "--show-toplevel"]);
  }

  head(): Promise<string> {
    return this.run(["rev-parse", "HEAD"]);
  }

  revParse(ref: string): Promise<string> {
    return this.run(["rev-parse", "--verify", `${ref}^{commit}`]);
  }

  branchExists(branch: string): Promise<boolean> {
    return this.ok(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  }

  async isClean(): Promise<boolean> {
    return (await this.run(["status", "--porcelain"])) === "";
  }

  /** Keeps agent folders out of `git status` without touching the user's .gitignore. */
  async excludeLocally(pattern: string): Promise<void> {
    const gitDir = await this.run(["rev-parse", "--git-common-dir"]);
    const file = path.resolve(this.cwd, gitDir, "info", "exclude");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const current = await fs.readFile(file, "utf8").catch(() => "");
    if (!current.split("\n").includes(pattern)) {
      await fs.appendFile(file, `${current.endsWith("\n") || current === "" ? "" : "\n"}${pattern}\n`);
    }
  }

  async addWorktree(dir: string, branch: string, base: string): Promise<void> {
    if (await this.branchExists(branch)) {
      await this.run(["worktree", "add", dir, branch]);
    } else {
      await this.run(["worktree", "add", "-b", branch, dir, base]);
    }
  }

  /** Removes the checkout only. The branch is kept so work can be recovered. */
  async removeWorktree(dir: string): Promise<void> {
    await this.run(["worktree", "remove", "--force", dir], true);
    await this.run(["worktree", "prune"], true);
  }

  /** Commits everything in this worktree. Returns undefined when nothing changed. */
  async commitAll(message: string): Promise<string | undefined> {
    await this.run(["add", "-A"]);
    return this.commitStaged(message);
  }

  /** Commits what is staged. Returns undefined when nothing is staged. */
  async commitStaged(message: string): Promise<string | undefined> {
    if (await this.ok(["diff", "--cached", "--quiet"])) return undefined;
    await this.run(["-c", "user.name=Agentic Code", "-c", "user.email=agentic@localhost", "commit", "-q", "--no-verify", "-m", message]);
    return this.head();
  }

  async changedFiles(from: string, to: string): Promise<string[]> {
    const out = await this.run(["diff", "--name-only", "--no-renames", `${from}...${to}`]);
    return out ? out.split("\n") : [];
  }

  diff(from: string, to: string): Promise<string> {
    return this.run(["diff", `${from}...${to}`]);
  }

  /** Merges `branch` into the checked-out branch. Returns the conflicted files, or [] on success. */
  async merge(branch: string, message: string): Promise<string[]> {
    const ok = await this.ok(["-c", "user.name=Agentic Code", "-c", "user.email=agentic@localhost", "merge", "--no-ff", "--no-edit", "-m", message, branch]);
    if (ok) return [];
    const conflicted = await this.run(["diff", "--name-only", "--diff-filter=U"], true);
    await this.run(["merge", "--abort"], true);
    return conflicted ? conflicted.split("\n") : ["(unknown)"];
  }

  /** Moves the checked-out branch back. Only used on branches the extension owns. */
  async resetHard(ref: string): Promise<void> {
    await this.run(["reset", "--hard", "-q", ref]);
  }
}
