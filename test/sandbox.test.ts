import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SandboxError, WorkspaceSandbox } from "../src/tools/sandbox";

let base: string;
let ws: string;
let outside: string;
let sandbox: WorkspaceSandbox;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "sandbox-"));
  ws = path.join(base, "project");
  outside = path.join(base, "secret");
  await mkdir(path.join(ws, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(ws, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(outside, "key.txt"), "TOP SECRET");
  // Links a malicious repo or a confused model could use to get out.
  await symlink(outside, path.join(ws, "escape-dir"));
  await symlink(path.join(outside, "key.txt"), path.join(ws, "escape-file.txt"));
  await symlink(path.join(ws, "src", "a.ts"), path.join(ws, "inner-link.ts"));
  sandbox = await WorkspaceSandbox.create(ws);
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe("WorkspaceSandbox", () => {
  it("reads and writes files inside the workspace", async () => {
    expect(await sandbox.readFile("src/a.ts")).toContain("a = 1");
    await sandbox.writeFile("src/new/b.ts", "b");
    expect(await readFile(path.join(ws, "src", "new", "b.ts"), "utf8")).toBe("b");
  });

  it.each(["../secret/key.txt", "/etc/passwd", "src/../../secret/key.txt"])("refuses lexical escape %s", async (p) => {
    await expect(sandbox.readFile(p)).rejects.toBeInstanceOf(SandboxError);
    await expect(sandbox.writeFile(p, "x")).rejects.toBeInstanceOf(SandboxError);
  });

  it("refuses to read through a symlink that points outside", async () => {
    await expect(sandbox.readFile("escape-file.txt")).rejects.toThrow(/outside the workspace/);
    await expect(sandbox.readFile("escape-dir/key.txt")).rejects.toThrow(/outside the workspace/);
  });

  it("refuses to write through a symlink that points outside", async () => {
    await expect(sandbox.writeFile("escape-file.txt", "pwned")).rejects.toThrow(/outside the workspace/);
    await expect(sandbox.writeFile("escape-dir/new.txt", "pwned")).rejects.toThrow(/outside the workspace/);
    await expect(sandbox.writeFile("escape-dir/deep/new.txt", "pwned")).rejects.toThrow(/outside the workspace/);
    expect(await readFile(path.join(outside, "key.txt"), "utf8")).toBe("TOP SECRET");
  });

  it("allows symlinks that stay inside the workspace", async () => {
    expect(await sandbox.readFile("inner-link.ts")).toContain("a = 1");
  });

  it("lists files without entering outside links", async () => {
    const files = await sandbox.listFiles();
    expect(files).toContain("src/a.ts");
    expect(files).toContain("inner-link.ts");
    expect(files.some((f) => f.startsWith("escape"))).toBe(false);
  });

  it("filters listings by glob and rejects globs outside", async () => {
    expect(await sandbox.listFiles("src/**")).toEqual(["src/a.ts"]);
    await expect(sandbox.listFiles("../**")).rejects.toBeInstanceOf(SandboxError);
  });

  it("refuses to write to the workspace root", async () => {
    await expect(sandbox.writeFile(".", "x")).rejects.toBeInstanceOf(SandboxError);
  });
});
