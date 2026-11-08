/** Run 10, validate-input: a change task with no saved checks runs the project's tests once before it finishes. */
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { OverlayFiles } from "../src/changes/overlay";
import { asksResearchForCode } from "../src/coordinator/review";
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

const WRITE = { tool: "write_file", path: "convert.js", content: "module.exports = { toKelvin: (c) => c + 273.15 };\n" };
const FINISH = { tool: "finish", summary: "Added toKelvin to convert.js." };

async function worker(model: ModelProvider, testCommand?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "test-first-"));
  await fs.writeFile(path.join(root, "convert.js"), "module.exports = {};\n");
  const now = new Date().toISOString();
  const task: Task = { id: "t1", title: "Add toKelvin", instructions: "Add toKelvin to convert.js", dependsOn: [], fileScope: ["convert.js"], status: "running", attempts: 0, createdAt: now, updatedAt: now };
  const overlay = new OverlayFiles(await WorkspaceSandbox.create(root));
  // Commands are declined, so nothing runs in the test.
  const w = new Worker({ provider: model, sandbox: overlay, task, checks: [], testCommand, maxTurns: 8, approve: async (_r, call) => call.tool !== "run_command", log: () => {} });
  return { w, root };
}

describe("a change task that never ran anything", () => {
  it("is told once to run the project's tests before it finishes", async () => {
    const model = scripted([WRITE, FINISH, { tool: "run_command", command: "npm test", reason: "run the tests" }, FINISH]);
    const { w, root } = await worker(model, "npm test");
    await w.run();
    expect(model.requests[2]!.messages.at(-1)!.content).toMatch(/Run the project's tests once with run_command \(command: "npm test"\)/);
    expect(model.requests).toHaveLength(4);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("finishes at once without a test command, or after running something since its last write", async () => {
    const none = scripted([WRITE, FINISH]);
    const a = await worker(none);
    await a.w.run();
    expect(none.requests).toHaveLength(2);
    const ran = scripted([WRITE, { tool: "run_command", command: "node -e 1", reason: "try it" }, FINISH]);
    const b = await worker(ran, "npm test");
    await b.w.run();
    expect(ran.requests).toHaveLength(3);
    await fs.rm(a.root, { recursive: true, force: true });
    await fs.rm(b.root, { recursive: true, force: true });
  });
});

describe("asksResearchForCode", () => {
  it("spots a send-back that asks a researcher for code", () => {
    expect(asksResearchForCode("The draft contains no code changes. Add the mode validation logic to targetTemp.")).toBe(true);
    expect(asksResearchForCode("Implement the check in src/thermostat.js.")).toBe(true);
    expect(asksResearchForCode("Your answer does not say which line handles the night mode. Name the line.")).toBe(false);
    expect(asksResearchForCode("Add the line numbers of each match to your answer.")).toBe(false);
  });
});
