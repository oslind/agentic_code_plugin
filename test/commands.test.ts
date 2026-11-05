import { scratchBase } from "../src/changes/scratch";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandEnd, CommandSink } from "../src/checks/commandTerminal";
import { toPlainText } from "../src/checks/terminalText";
import { eventToEntry } from "../src/chat/eventFeed";
import { Orchestrator } from "../src/coordinator/orchestrator";
import { ChatRequest, ModelProvider } from "../src/providers/types";
import { TaskStore } from "../src/state/taskStore";
import { checkToolCall, isAutoApproved } from "../src/tools/policy";
import { ToolCall } from "../src/tools/protocol";

const node = (code: string) => `node -e ${JSON.stringify(code)}`;

let base: string;
let repo: string;
let store: TaskStore;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "cmd-"));
  repo = path.join(base, "project");
  await mkdir(repo);
  await writeFile(path.join(repo, "a.txt"), "on disk\n");
  store = new TaskStore(path.join(base, "state"));
});
afterEach(() => rm(base, { recursive: true, force: true }));

type Turn = { thought: string; call: Record<string, unknown> };

function scripted(turns: Turn[], seen: ChatRequest[] = []): ModelProvider {
  return {
    model: "fake",
    contextWindow: 32768,
    async chat(req) {
      seen.push(req);
      const next = turns.shift();
      if (!next) throw new Error("No scripted reply left");
      return { content: JSON.stringify(next) };
    },
  };
}

/** A terminal that records what it was shown. */
function recordingTerminal() {
  const shown: { command: string; cwd: string; output: string; end?: CommandEnd }[] = [];
  const sink: CommandSink = {
    start(command, cwd) {
      const rec: (typeof shown)[number] = { command, cwd, output: "" };
      shown.push(rec);
      return { output: (c) => void (rec.output += c), end: (e) => void (rec.end = e) };
    },
  };
  return { sink, shown };
}

async function runOne(turns: Turn[], approve: (call: ToolCall) => boolean) {
  const run = await store.createRun("test", repo);
  await store.addTasks(run.id, [{ id: "t1", title: "t1", instructions: "Do t1", fileScope: ["**"], dependsOn: [] }]);
  const seen: ChatRequest[] = [];
  const terminal = recordingTerminal();
  const asked: string[] = [];
  const o = new Orchestrator({
    store,
    runId: run.id,
    provider: scripted(turns, seen),
    workspaceRoot: repo,
    checks: [],
    retryDelayMs: 1,
    terminal: terminal.sink,
    onChanges: async () => {},
    approveTool: async (_task, reason, call) => {
      asked.push(reason);
      return approve(call);
    },
  });
  await o.run();
  return { runId: run.id, seen, terminal, asked, events: await store.readLog(run.id) };
}

const print = node("console.log(require('fs').readFileSync('a.txt','utf8').trim())");

describe("run_command", () => {
  it("is offered to sub-agents, asks first, and runs in the copy that has the drafts, shown in the terminal and the chat", async () => {
    const { seen, terminal, asked, events } = await runOne(
      [
        { thought: "Draft.", call: { tool: "write_file", path: "a.txt", content: "drafted\n" } },
        { thought: "See what the file holds now.", call: { tool: "run_command", command: print, reason: "check my draft" } },
        { thought: "Done.", call: { tool: "finish", summary: "ok" } },
      ],
      () => true,
    );
    // The prompt tells the model about the tool and when to use it.
    expect(seen[0]!.messages[0]!.content).toMatch(/"tool":"run_command"/);
    expect(seen[0]!.messages[0]!.content).toMatch(/Use run_command like a developer at a terminal/);
    expect(asked).toEqual([`Run \`${print}\`: check my draft`]);
    // Shown in the terminal, run inside the scratch copy, never in the project itself.
    expect(terminal.shown[0]).toMatchObject({ command: print, end: { code: 0 } });
    expect(terminal.shown[0]!.cwd.startsWith(await scratchBase())).toBe(true);
    expect(terminal.shown[0]!.output).toMatch(/drafted/);
    // The model gets the output back.
    expect(seen[2]!.messages.at(-1)!.content).toMatch(/exit code 0[\s\S]*drafted/);
    // And the chat gets a command entry with the output.
    const ev = events.find((e) => e.type === "command")!;
    expect(ev).toMatchObject({ message: print, data: { passed: true, code: 0 } });
    const entry = eventToEntry(ev, [{ id: "t1", title: "t1" } as never])!;
    expect(entry).toMatchObject({ kind: "command", tag: "ran a command", tone: "success", command: { line: print, output: "drafted" } });
  });

  it("runs nothing when the user declines, and tells the model", async () => {
    const { terminal, seen, events } = await runOne(
      [
        { thought: "Run it.", call: { tool: "run_command", command: print } },
        { thought: "Done.", call: { tool: "finish", summary: "ok" } },
      ],
      () => false,
    );
    expect(terminal.shown).toEqual([]);
    expect(events.some((e) => e.type === "command")).toBe(false);
    expect(seen[1]!.messages.at(-1)!.content).toMatch(/declined/);
  });

  it("refuses commands that point outside the project without asking", async () => {
    const { terminal, asked } = await runOne(
      [
        { thought: "Look around.", call: { tool: "run_command", command: "cat ~/.ssh/id_rsa" } },
        { thought: "Done.", call: { tool: "finish", summary: "ok" } },
      ],
      () => true,
    );
    expect(asked).toEqual([]);
    expect(terminal.shown).toEqual([]);
  });

  it("shows a failing command as failed in the chat", async () => {
    const { events } = await runOne(
      [
        { thought: "Run it.", call: { tool: "run_command", command: node("console.error('boom'); process.exit(3)") } },
        { thought: "Done.", call: { tool: "finish", summary: "ok" } },
      ],
      () => true,
    );
    const entry = eventToEntry(events.find((e) => e.type === "command")!, [])!;
    expect(entry).toMatchObject({ tone: "warning", command: { output: "boom" } });
    expect(entry.text).toMatch(/Failed .*exit code 3/);
  });
});

describe("run_command policy", () => {
  const ctx = { fileScope: ["src/**"], allowedChecks: [] };
  it("always asks, unless the Run commands switch is on", () => {
    const call = { tool: "run_command" as const, command: "npm test" };
    expect(checkToolCall(call, ctx).verdict).toBe("ask");
    expect(checkToolCall({ tool: "run_command", command: "rm -rf /" }, ctx).verdict).toBe("deny");
    expect(isAutoApproved(call, { editFiles: true, sensitiveFiles: true, commands: false })).toBe(false);
    expect(isAutoApproved(call, { editFiles: false, sensitiveFiles: false, commands: true })).toBe(true);
  });
});

describe("toPlainText", () => {
  it("keeps the text, drops styles and escape sequences, and collapses progress redraws", () => {
    expect(toPlainText("a\x1b[31mred\x1b[0m\nprog 10%\rprog 100%\r\nend\x1b]8;;http://x\x07link\x1b]8;;\x07\x1b[2J")).toBe("ared\nprog 100%\nendlink");
  });
});
