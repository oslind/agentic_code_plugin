/** Benchmark pass 1: a researcher with 15 files spent one model call on each; read_files reads them in one. */
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { filesRead } from "../src/chat/coverage";
import { checkToolCall } from "../src/tools/policy";
import { toolCallSchema } from "../src/tools/protocol";
import { WorkspaceSandbox } from "../src/tools/sandbox";
import { executeTool } from "../src/worker/tools";

let root: string;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("read_files", () => {
  it("reads several files in one call, each with line numbers, and says which could not be read", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "read-files-"));
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "a.js"), "const a = 1;\nmodule.exports = a;\n");
    await fs.writeFile(path.join(root, "src", "b.js"), "throw new Error('b');\n");
    const call = toolCallSchema.parse({ tool: "read_files", paths: ["src/a.js", "src/b.js", "src/missing.js"] });
    const out = await executeTool(call, { sandbox: await WorkspaceSandbox.create(root), checks: [] });
    expect(out.ok).toBe(true);
    expect(out.output).toMatch(/^src\/a\.js \(3 lines\)\n {3}1\| const a = 1;/);
    expect(out.output).toMatch(/src\/b\.js \(2 lines\)\n {3}1\| throw new Error\('b'\);/);
    expect(out.output).toMatch(/src\/missing\.js: could not be read/);
    // Only the reads that worked are reported, with the lines they showed (audit of PR #54).
    expect(out.read).toEqual([
      { path: "src/a.js", from: 1, to: 3, total: 3, cut: false },
      { path: "src/b.js", from: 1, to: 2, total: 2, cut: false },
    ]);
  });

  it("reports what read_file showed, and nothing when the read failed", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "read-files-"));
    await fs.writeFile(path.join(root, "a.js"), Array.from({ length: 400 }, (_, i) => `x${i}`).join("\n"));
    const sandbox = await WorkspaceSandbox.create(root);
    const out = await executeTool(toolCallSchema.parse({ tool: "read_file", path: "a.js" }), { sandbox, checks: [] });
    expect(out.read).toEqual([{ path: "a.js", from: 1, to: 300, total: 400, cut: false }]);
    const missing = await executeTool(toolCallSchema.parse({ tool: "read_file", path: "b.js" }), { sandbox, checks: [] });
    expect(missing.ok).toBe(false);
    expect(missing.read).toBeUndefined();
  });

  it("shares a fixed budget over the files, and says where to read on", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "read-files-"));
    const long = Array.from({ length: 250 }, (_, i) => `const line${i} = ${i}; // some padding to make the line longer`).join("\n");
    const paths = Array.from({ length: 20 }, (_, i) => `f${i}.js`);
    for (const p of paths) await fs.writeFile(path.join(root, p), long);
    const out = await executeTool(toolCallSchema.parse({ tool: "read_files", paths }), { sandbox: await WorkspaceSandbox.create(root), checks: [] });
    expect(out.output.length).toBeLessThan(30_000);
    expect(out.output).toMatch(/f19\.js \(250 lines\)/);
    expect(out.output).toMatch(/not shown; read them with read_file and startLine=\d+/);
    // A file cut to its share is not counted as read.
    expect(filesRead([{ time: "", runId: "r", type: "files_read", message: "", data: { reads: out.read } }]).size).toBe(0);
  });

  it("is refused for a path outside the project or a secret file, and counts a path once its read worked", () => {
    const ctx = { fileScope: [] };
    expect(checkToolCall(toolCallSchema.parse({ tool: "read_files", paths: ["src/a.js", "../x.js"] }), ctx)).toMatchObject({ verdict: "deny" });
    expect(checkToolCall(toolCallSchema.parse({ tool: "read_files", paths: [".env"] }), ctx)).toMatchObject({ verdict: "deny" });
    expect(checkToolCall(toolCallSchema.parse({ tool: "read_files", paths: ["src/a.js"] }), ctx)).toMatchObject({ verdict: "allow" });
    const reads = [
      { path: "src/a.js", from: 1, to: 3, total: 3, cut: false },
      { path: "./src/b.js", from: 1, to: 2, total: 2, cut: false },
    ];
    const read = filesRead([{ time: "", runId: "r", type: "files_read", message: "", data: { reads } }]);
    expect([...read].sort()).toEqual(["src/a.js", "src/b.js"]);
  });
});

describe("a path without its folder (check 2026-11-09)", () => {
  it("points to the file with that name instead of only saying it is missing", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "read-files-"));
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "mod_002.js"), "x\n");
    const sandbox = await WorkspaceSandbox.create(root);
    const one = await executeTool(toolCallSchema.parse({ tool: "read_file", path: "mod_002.js" }), { sandbox, checks: [] });
    expect(one.ok).toBe(false);
    expect(one.output).toMatch(/The project has src\/mod_002\.js: use that path/);
    const many = await executeTool(toolCallSchema.parse({ tool: "read_files", paths: ["mod_002.js", " "] }), { sandbox, checks: [] });
    expect(many.output).toMatch(/^mod_002\.js: could not be read[\s\S]*src\/mod_002\.js: use that path/);
    expect(many.output).not.toMatch(/^ :/m);
    const listed = await executeTool(toolCallSchema.parse({ tool: "list_files", glob: "mod_002.js" }), { sandbox, checks: [] });
    expect(listed.output).toMatch(/the project has: src\/mod_002\.js/);
    expect(checkToolCall(toolCallSchema.parse({ tool: "read_files", paths: ["src/a.js", " "] }), { fileScope: [] })).toMatchObject({ verdict: "allow" });
  });
});
