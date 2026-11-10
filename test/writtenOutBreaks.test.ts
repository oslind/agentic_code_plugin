/** Run 13, new-module-used: write_file content with "\\n" written out made a whole module one comment line. */
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { toolCallSchema } from "../src/tools/protocol";
import { WorkspaceSandbox } from "../src/tools/sandbox";
import { executeTool, realBreaks } from "../src/worker/tools";

let root: string;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("written-out line breaks in a whole file", () => {
  const slip = "// formatTemp function\\nmodule.exports = {\\n  formatTemp: function(celsius) {\\n    return celsius.toFixed(1) + ' °C';\\n  }\\n};";
  it("reads a one-line text with two or more \\n as line breaks, and says so", () => {
    const r = realBreaks(slip);
    expect(r.text.split("\n")).toHaveLength(6);
    expect(r.text.startsWith("// formatTemp function\nmodule.exports = {")).toBe(true);
    expect(r.note).toMatch(/written out instead of line breaks[\s\S]*6 lines/);
  });
  it("leaves real line breaks, and a single \\n in a one-line text, alone", () => {
    expect(realBreaks('const a = "x\\ny";\nmodule.exports = a;\n')).toEqual({ text: 'const a = "x\\ny";\nmodule.exports = a;\n', note: "" });
    expect(realBreaks('console.log("a\\nb");')).toEqual({ text: 'console.log("a\\nb");', note: "" });
  });
  it("writes the module with real lines, so it exports what it says", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "breaks-"));
    const sandbox = await WorkspaceSandbox.create(root);
    const out = await executeTool(toolCallSchema.parse({ tool: "write_file", path: "format.js", content: slip }), { sandbox, checks: [] });
    expect(out.output).toMatch(/\(6 lines\)|6 lines/);
    const text = await sandbox.readFile("format.js");
    const mod = { exports: {} as Record<string, unknown> };
    new Function("module", text)(mod);
    expect(typeof mod.exports.formatTemp).toBe("function");
  });
});
