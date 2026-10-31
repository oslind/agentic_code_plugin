import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatController, ChatHost } from "../src/chat/chatController";
import { ConversationStore, trimEntries } from "../src/chat/conversationStore";
import { buildCoordinatorMessages, coordinatorTurn, enforceMode } from "../src/chat/coordinatorChat";
import { eventToEntry } from "../src/chat/eventFeed";
import { ChatEntry, ChatMode } from "../src/chat/types";
import { RunOutcome } from "../src/coordinator/orchestrator";
import { ChatRequest, ModelProvider } from "../src/providers/types";
import { TaskStore } from "../src/state/taskStore";

function scripted(replies: string[], contextWindow = 32768): ModelProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    model: "test",
    contextWindow,
    requests,
    async chat(req) {
      requests.push({ ...req, messages: [...req.messages] });
      return { content: replies.shift() ?? "" };
    },
  };
}

const turn = (reply: string, action = "none", request = "") => JSON.stringify({ reply, action, request });
const plan = JSON.stringify({
  tasks: [
    { id: "add-model", title: "Add model", instructions: "Create src/model.ts with a User type.", dependsOn: [], fileScope: ["src/model.ts"] },
    { id: "add-api", title: "Add API", instructions: "Add src/api.ts using the User type.", dependsOn: ["add-model"], fileScope: ["src/api.ts"] },
  ],
});

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-chat-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("ConversationStore", () => {
  it("keeps only the most recent conversations, and never fewer than 3", async () => {
    let t = 0;
    const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++));
    const store = new ConversationStore(dir, () => 1, clock);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await store.create("/ws", "plan", `c${i}`)).id);
    const left = await store.list();
    expect(left.map((c) => c.title)).toEqual(["c4", "c3", "c2"]);
    // Updating an old conversation makes it the most recent.
    await store.append(ids[2]!, { author: "user", text: "hi" });
    expect((await store.list())[0]!.id).toBe(ids[2]);
  });

  it("respects a larger history size and survives a reload", async () => {
    const store = new ConversationStore(dir, () => 10);
    for (let i = 0; i < 6; i++) await store.create("/ws", "act", `c${i}`);
    const again = new ConversationStore(dir, () => 10);
    expect(await again.list()).toHaveLength(6);
  });

  it("drops the oldest sub-agent messages first when a conversation grows too long", () => {
    const e = (author: ChatEntry["author"], text: string): ChatEntry => ({ id: text, time: "", author, text });
    const out = trimEntries([e("user", "u1"), e("agent", "a1"), e("coordinator", "c1"), e("agent", "a2"), e("agent", "a3")], 3);
    expect(out.map((x) => x.text)).toEqual(["u1", "c1", "a3"]);
  });
});

describe("coordinator turn", () => {
  it("rejects code in the reply and retries, so the coordinator delegates instead of coding", async () => {
    const p = scripted([turn("Here you go:\n```ts\nexport const x = 1;\n```"), turn("I'll delegate it.", "plan", "Add export const x = 1 to src/x.ts")]);
    const result = await coordinatorTurn(p, { mode: "act", entries: [{ id: "1", time: "", author: "user", text: "add x" }] });
    expect(p.requests).toHaveLength(2);
    expect(p.requests[1]!.messages.at(-1)!.content).toMatch(/delegate/);
    expect(result.action).toBe("plan");
  });

  it("requires a full request when planning", async () => {
    const p = scripted([turn("ok", "plan", ""), turn("ok", "plan", "Rename foo to bar in src/foo.ts")]);
    const result = await coordinatorTurn(p, { mode: "plan", entries: [{ id: "1", time: "", author: "user", text: "rename" }] });
    expect(p.requests).toHaveLength(2);
    expect(result.request).toMatch(/Rename/);
  });

  it("never runs in Plan mode, and never runs without a waiting plan", () => {
    const run = { reply: "Go", action: "run" as const, request: "" };
    expect(enforceMode(run, "plan", true).action).toBe("none");
    expect(enforceMode(run, "act", false).action).toBe("none");
    expect(enforceMode(run, "act", true).action).toBe("run");
  });

  it("tells the model which mode it is in and starts the history with the user", () => {
    const entries: ChatEntry[] = [
      { id: "0", time: "", author: "coordinator", text: "old reply" },
      { id: "1", time: "", author: "agent", text: "sub-agent chatter is not sent" },
      { id: "2", time: "", author: "user", text: "do it" },
    ];
    const msgs = buildCoordinatorMessages({ mode: "plan", entries }, 8192);
    expect(msgs[0]!.content).toMatch(/PLAN mode/);
    expect(msgs.slice(1).map((m) => m.content)).toEqual(["do it"]);
  });

  it("keeps the latest message when the context window is tiny", () => {
    const long = "x".repeat(50000);
    const entries: ChatEntry[] = [
      { id: "1", time: "", author: "user", text: "first" },
      { id: "2", time: "", author: "user", text: long },
    ];
    const msgs = buildCoordinatorMessages({ mode: "act", entries }, 4096);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.content.length).toBeLessThan(long.length);
  });
});

describe("eventToEntry", () => {
  const tasks = [{ id: "t1", title: "Add model", instructions: "", dependsOn: [], fileScope: ["src/a.ts"], status: "running" as const, attempts: 1, createdAt: "", updatedAt: "" }];

  it("shows a sub-agent's reasoning and tool as its message", () => {
    const e = eventToEntry(
      { time: "", runId: "r", taskId: "t1", type: "tool_call", message: "read_file", data: { thought: "Look at the file first.", call: { tool: "read_file", path: "src/a.ts" } } },
      tasks,
    );
    expect(e).toMatchObject({ author: "agent", agentName: "Add model", text: "Look at the file first.", tag: "read_file src/a.ts" });
  });

  it("ignores bookkeeping events", () => {
    expect(eventToEntry({ time: "", runId: "r", taskId: "t1", type: "worktree", message: "/x" }, tasks)).toBeUndefined();
  });
});

describe("ChatController", () => {
  function setup(replies: string[], mode: ChatMode) {
    const conversations = new ConversationStore(path.join(dir, "state"));
    const tasks = new TaskStore(path.join(dir, "state"));
    const provider = scripted(replies);
    const started: string[] = [];
    let current = mode;
    const host: ChatHost = {
      provider: () => provider,
      modelLabel: () => "test at http://localhost",
      pickWorkspace: async () => "/ws",
      fileTree: async () => "src/\n  index.ts",
      runPlan: async (runId): Promise<RunOutcome> => {
        started.push(runId);
        await tasks.log({ runId, taskId: "add-model", type: "tool_call", message: "write_file", data: { thought: "Writing the model.", call: { tool: "write_file", path: "src/model.ts" } } });
        return { integrationBranch: "agentic/x/integration", done: ["add-model", "add-api"], failed: [], blocked: [] };
      },
      cancelRun: () => {},
      defaultMode: () => current,
      setDefaultMode: (m) => (current = m),
      log: () => {},
    };
    return { controller: new ChatController(conversations, tasks, host), started, provider };
  }

  it("Plan mode proposes a plan and does not start sub-agents", async () => {
    const { controller, started } = setup([turn("I'll split this up.", "plan", "Add a User model and an API that uses it."), plan], "plan");
    await controller.send("add users");
    const state = await controller.state();
    expect(started).toEqual([]);
    const planEntry = state.current!.entries.find((e) => e.kind === "plan")!;
    expect(state.plans[planEntry.runId!]!.tasks).toHaveLength(2);
    expect(state.plans[planEntry.runId!]!.started).toBe(false);
    expect(state.conversations[0]!.title).toBe("add users");
  });

  it("pressing Run on a plan switches to Act mode and starts sub-agents", async () => {
    const { controller, started } = setup([turn("Plan below.", "plan", "Add a User model and an API that uses it."), plan], "plan");
    await controller.send("add users");
    const runId = (await controller.state()).current!.entries.find((e) => e.kind === "plan")!.runId!;
    await controller.runPlan(runId);
    const state = await controller.state();
    expect(state.mode).toBe("act");
    expect(started).toEqual([runId]);
  });

  it("Act mode runs the plan right away and shows sub-agent messages in the chat", async () => {
    const { controller, started } = setup([turn("On it.", "plan", "Add a User model and an API that uses it."), plan], "act");
    await controller.send("add users");
    expect(started).toHaveLength(1);
    // Event handling is queued; let it drain.
    await new Promise((r) => setTimeout(r, 50));
    const entries = (await controller.state()).current!.entries;
    expect(entries.some((e) => e.author === "agent" && e.text === "Writing the model." && e.agentName === "Add model")).toBe(true);
    expect(entries.at(-1)).toMatchObject({ kind: "outcome", tone: "success" });
  });

  it("a coordinator asking to run in Plan mode runs nothing", async () => {
    const { controller, started } = setup(
      [turn("Plan below.", "plan", "Add a User model and an API that uses it."), plan, turn("Running it now.", "run")],
      "plan",
    );
    await controller.send("add users");
    await controller.send("go");
    expect(started).toEqual([]);
    const entries = (await controller.state()).current!.entries;
    expect(entries.at(-1)).toMatchObject({ author: "system", tone: "warning" });
  });
});
