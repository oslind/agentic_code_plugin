/** A change task that reports a change it never wrote is told so once before it can finish (run 10). */
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { OverlayFiles } from "../src/changes/overlay";
import { ChatRequest, ModelProvider } from "../src/providers/types";
import { Task } from "../src/state/types";
import { WorkspaceSandbox } from "../src/tools/sandbox";
import { Worker } from "../src/worker/worker";

function scripted(calls: object[]): ModelProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    model: "fake",
    contextWindow: 16384,
    requests,
    async chat(req) {
      requests.push(req);
      return { content: JSON.stringify({ thought: "", call: calls[Math.min(requests.length - 1, calls.length - 1)] }) };
    },
  };
}

async function worker(model: ModelProvider) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "no-writes-"));
  await fs.writeFile(path.join(root, "convert.js"), "module.exports = {};\n");
  const now = new Date().toISOString();
  const task: Task = { id: "t1", title: "Add toKelvin", instructions: "Add toKelvin to convert.js", dependsOn: [], fileScope: ["convert.js"], status: "running", attempts: 0, createdAt: now, updatedAt: now };
  const overlay = new OverlayFiles(await WorkspaceSandbox.create(root));
  return { w: new Worker({ provider: model, sandbox: overlay, task, checks: [], maxTurns: 6, approve: async () => true, log: () => {} }), overlay, root };
}

describe("a report of a change that was never written", () => {
  it("is sent back once, and the change is then made", async () => {
    const model = scripted([
      { tool: "finish", summary: "Added toKelvin to convert.js." },
      { tool: "write_file", path: "convert.js", content: "function toKelvin(c) {\n  return c + 273.15;\n}\n\nmodule.exports = { toKelvin };\n" },
      { tool: "finish", summary: "Added toKelvin to convert.js." },
    ]);
    const { w, overlay, root } = await worker(model);
    const r = await w.run();
    expect(model.requests[1]!.messages.at(-1)!.content).toMatch(/You have not changed any file in this task/);
    expect(r.changedFiles).toEqual(["convert.js"]);
    expect(overlay.writes.get("convert.js")).toMatch(/273\.15/);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lets it finish the second time, and a report that changed nothing finishes at once", async () => {
    const twice = scripted([{ tool: "finish", summary: "Added toKelvin." }]);
    const a = await worker(twice);
    expect((await a.w.run()).changedFiles).toEqual([]);
    expect(twice.requests).toHaveLength(2);
    const honest = scripted([{ tool: "finish", summary: "No change needed: convert.js already does this." }]);
    const b = await worker(honest);
    await b.w.run();
    expect(honest.requests).toHaveLength(1);
    await fs.rm(a.root, { recursive: true, force: true });
    await fs.rm(b.root, { recursive: true, force: true });
  });
});
