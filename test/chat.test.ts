import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatController, ChatHost, RunHooks } from "../src/chat/chatController";
import { CheckConfig } from "../src/checks/runner";
import { DetectedCheck, detectChecks } from "../src/checks/detect";
import { AutoApprove, checkToolCall } from "../src/tools/policy";
import { ConversationStore, trimEntries } from "../src/chat/conversationStore";
import { buildCoordinatorMessages, coordinatorTurn, enforceMode } from "../src/chat/coordinatorChat";
import { eventToEntry } from "../src/chat/eventFeed";
import { extractThinking } from "../src/llm/structured";
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

describe("thinking", () => {
  it("takes thinking from the server's reasoning field or from <think> blocks", () => {
    expect(extractThinking('{"a":1}', "I should answer.")).toBe("I should answer.");
    expect(extractThinking('<think>Plan it first.</think>{"a":1}')).toBe("Plan it first.");
    expect(extractThinking('{"a":1}')).toBeUndefined();
  });

  it("returns the coordinator's thought and thinking with its turn", async () => {
    const p = scripted([`<think>The user wants a rename.</think>${JSON.stringify({ thought: "Clear enough to delegate.", reply: "Delegating.", action: "plan", request: "Rename foo to bar in src/foo.ts" })}`]);
    const result = await coordinatorTurn(p, { mode: "plan", entries: [{ id: "1", time: "", author: "user", text: "rename" }] });
    expect(result.thought).toBe("Clear enough to delegate.");
    expect(result.thinking).toBe("The user wants a rename.");
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

  it("marks a sub-agent start as the coordinator starting a sub-agent", () => {
    const e = eventToEntry({ time: "", runId: "r", taskId: "t1", type: "status", message: "running" }, tasks);
    expect(e).toMatchObject({ author: "coordinator", kind: "spawn", taskId: "t1", agentName: "Add model" });
    expect(e!.text).toMatch(/src\/a\.ts/);
  });

  it("shows a sub-agent's finish as its report to the coordinator, with its thinking", () => {
    const e = eventToEntry(
      { time: "", runId: "r", taskId: "t1", type: "tool_call", message: "finish", data: { thought: "All done.", thinking: "Checked everything.", call: { tool: "finish", summary: "Added the User type." } } },
      tasks,
    );
    expect(e).toMatchObject({ author: "agent", kind: "report", text: "Added the User type.", thinking: "Checked everything." });
  });

  it("ignores bookkeeping events", () => {
    expect(eventToEntry({ time: "", runId: "r", taskId: "t1", type: "worktree", message: "/x" }, tasks)).toBeUndefined();
  });
});

describe("ChatController", () => {
  interface SetupOptions {
    detected?: DetectedCheck[];
    saved?: CheckConfig[];
    permissions?: Partial<AutoApprove>;
    /** Runs inside the fake run, with the hooks the chat passed. */
    during?: (hooks: RunHooks, runId: string, tasks: TaskStore) => Promise<void>;
  }

  function setup(replies: string[], mode: ChatMode, opts: SetupOptions = {}) {
    const conversations = new ConversationStore(path.join(dir, "state"));
    const tasks = new TaskStore(path.join(dir, "state"));
    const provider = scripted(replies);
    const started: string[] = [];
    const usedChecks: CheckConfig[][] = [];
    const savedChecks: CheckConfig[][] = [];
    let saved = opts.saved;
    let current = mode;
    const permissions: AutoApprove = { editFiles: true, sensitiveFiles: false, commands: false, merges: false, ...opts.permissions };
    const host: ChatHost = {
      provider: () => provider,
      modelLabel: () => "test at http://localhost",
      pickWorkspace: async () => "/ws",
      fileTree: async () => "src/\n  index.ts",
      runPlan: async (runId, hooks): Promise<RunOutcome> => {
        started.push(runId);
        usedChecks.push(hooks.checks);
        await tasks.log({ runId, taskId: "add-model", type: "tool_call", message: "write_file", data: { thought: "Writing the model.", call: { tool: "write_file", path: "src/model.ts" } } });
        await opts.during?.(hooks, runId, tasks);
        return { integrationBranch: "agentic/x/integration", done: ["add-model", "add-api"], failed: [], blocked: [] };
      },
      cancelRun: () => {},
      defaultMode: () => current,
      setDefaultMode: (m) => (current = m),
      log: () => {},
      openFolder: async () => path.join(dir, "ws"),
      researchLimits: () => ({ maxTurns: 10, maxParallel: 1 }),
      delegationLimits: () => ({ maxTasks: 12, maxResearchers: 5 }),
      checksFor: async () => ({ saved, defaults: [], detected: opts.detected ?? [] }),
      saveChecks: async (_root, checks) => {
        saved = checks;
        savedChecks.push(checks);
      },
      permissions: () => permissions,
      setPermission: async (key, value) => {
        permissions[key] = value;
      },
    };
    return { controller: new ChatController(conversations, tasks, host), started, provider, usedChecks, savedChecks };
  }

  it("answers a question about the project with read-only research, even in Plan mode", async () => {
    await fs.mkdir(path.join(dir, "ws"), { recursive: true });
    await fs.writeFile(path.join(dir, "ws", "README.md"), "# Flight sim\nA flight simulator.\n");
    const worker = (thought: string, call: object) => JSON.stringify({ thought, call });
    const { controller, started } = setup(
      [
        JSON.stringify({ thought: "Need to read the code.", reply: "I'll have a sub-agent read the project.", action: "research", request: "", questions: ["What does this project do?"] }),
        worker("Read the README.", { tool: "read_file", path: "README.md" }),
        worker("Try to edit, which must be refused.", { tool: "write_file", path: "README.md", content: "hacked" }),
        worker("Done.", { tool: "finish", summary: "It is a flight simulator, described in README.md." }),
        JSON.stringify({ thought: "Answer from the report.", reply: "This project is a flight simulator (see README.md).", action: "plan", request: "Do more things to the project" }),
      ],
      "plan",
    );
    await controller.send("Analyze this project and report back");
    await new Promise((r) => setTimeout(r, 50));
    const state = await controller.state();
    const entries = state.current!.entries;
    expect(started).toEqual([]);
    expect(await fs.readFile(path.join(dir, "ws", "README.md"), "utf8")).toMatch(/Flight sim/);
    const research = entries.find((e) => e.kind === "research")!;
    expect(state.plans[research.runId!]).toMatchObject({ kind: "research", tasks: [{ status: "done", fileScope: [] }] });
    expect(entries.some((e) => e.kind === "spawn" && /Read-only/.test(e.text))).toBe(true);
    expect(entries.some((e) => e.author === "agent" && /Blocked/.test(e.text))).toBe(true);
    expect(entries.some((e) => e.kind === "report" && /flight simulator/.test(e.text))).toBe(true);
    // The final answer comes from the reports, and cannot start more work.
    expect(entries.at(-1)).toMatchObject({ author: "coordinator", text: "This project is a flight simulator (see README.md)." });
    expect(entries.filter((e) => e.kind === "plan")).toHaveLength(0);
  });

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
    expect(entries.at(-1)!.text).toMatch(/Reports from the sub-agents:\n- Add model/);
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
  /** Waits until a card of this kind is waiting for the user, then returns it. */
  async function waitForCard(controller: ChatController, kind: string) {
    for (let i = 0; i < 100; i++) {
      const st = await controller.state();
      const e = st.current?.entries.find((x) => x.kind === kind && st.waiting.includes(x.id));
      if (e) return e;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`No waiting ${kind} card`);
  }

  const planReplies = () => [turn("On it.", "plan", "Add a User model and an API that uses it."), plan];

  it("proposes detected checks before the first run in a folder, and remembers the choice", async () => {
    const { controller, usedChecks, savedChecks } = setup(planReplies(), "act", { detected: [{ name: "test", command: "npm test", source: "package.json script" }] });
    const sending = controller.send("add users");
    const card = await waitForCard(controller, "checks");
    expect(card.checks).toEqual([{ name: "test", command: "npm test", source: "package.json script" }]);
    await controller.decide(card.id, { kind: "checks", remember: true, checks: [{ name: "test", command: "npm test -- --run" }] });
    await sending;
    expect(usedChecks).toEqual([[{ name: "test", command: "npm test -- --run" }]]);
    expect(savedChecks).toEqual([[{ name: "test", command: "npm test -- --run" }]]);
  });

  it("does not ask about checks when nothing is found, or when the folder already has saved checks", async () => {
    const a = setup(planReplies(), "act");
    await a.controller.send("add users");
    expect(a.usedChecks).toEqual([[]]);
    const b = setup(planReplies(), "act", { saved: [{ name: "lint", command: "ruff check ." }], detected: [{ name: "test", command: "pytest", source: "x" }] });
    await b.controller.send("add users");
    expect(b.usedChecks).toEqual([[{ name: "lint", command: "ruff check ." }]]);
  });

  it("asks before a sub-agent runs a new command, and can remember it for the folder", async () => {
    let allowed: boolean | undefined;
    const task = { id: "add-model", title: "Add model" } as never;
    const { controller, savedChecks } = setup(planReplies(), "act", {
      during: async (hooks) => {
        allowed = await hooks.approveTool(task, "x", { tool: "request_check", name: "pytest", command: "pytest -q", reason: "tests my change" });
      },
    });
    const sending = controller.send("add users");
    const card = await waitForCard(controller, "approval");
    expect(card).toMatchObject({ rememberable: true, agentName: "Add model" });
    expect(card.text).toMatch(/pytest -q/);
    await controller.decide(card.id, { kind: "allow", remember: true });
    await sending;
    expect(allowed).toBe(true);
    expect(savedChecks.at(-1)).toEqual([{ name: "pytest", command: "pytest -q" }]);
  });

  it("auto-approves commands when that switch is on", async () => {
    let allowed: boolean | undefined;
    const { controller } = setup(planReplies(), "act", {
      permissions: { commands: true },
      during: async (hooks) => {
        allowed = await hooks.approveTool({ id: "add-model", title: "Add model" } as never, "x", { tool: "request_check", name: "t", command: "make t", reason: "r" });
      },
    });
    await controller.send("add users");
    expect(allowed).toBe(true);
    const entries = (await controller.state()).current!.entries;
    expect(entries.some((e) => /Auto-approved/.test(e.text))).toBe(true);
  });

  it("lets a sub-agent ask the user, and delivers direct messages on its next step", async () => {
    let answer = "";
    let inbox: string[] = [];
    const { controller } = setup(planReplies(), "act", {
      during: async (hooks, runId, tasks) => {
        await tasks.setStatus(runId, "add-model", "running");
        answer = await hooks.askUser({ id: "add-model", title: "Add model" } as never, "Should ids be numbers or strings?");
        inbox = hooks.inbox("add-model");
      },
    });
    const sending = controller.send("add users");
    const card = await waitForCard(controller, "question");
    const runId = card.runId!;
    await controller.messageAgent(runId, "add-model", "Use UUID strings.");
    await controller.decide(card.id, { kind: "answer", text: "Strings" });
    await sending;
    expect(answer).toBe("Strings");
    expect(inbox).toEqual(["Use UUID strings."]);
    const entries = (await controller.state()).current!.entries;
    expect(entries.some((e) => e.kind === "direct" && e.agentName === "Add model")).toBe(true);
  });
});

describe("detectChecks", () => {
  it("suggests checks from package.json scripts, Python and Go projects", async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ scripts: { test: "vitest run", lint: "eslint ." } }),
      "pnpm-lock.yaml": "",
      "tsconfig.json": "{}",
    };
    const node = await detectChecks(Object.keys(files), async (p) => files[p]);
    expect(node.map((c) => c.command)).toEqual(["pnpm test", "pnpm lint", "npx tsc --noEmit"]);

    const py = await detectChecks(["pyproject.toml", "tests/test_x.py"], async () => "[tool.ruff]\n");
    expect(py.map((c) => c.command)).toEqual(["python -m pytest -q", "ruff check ."]);

    const go = await detectChecks(["go.mod", "main.go"], async () => "");
    expect(go.map((c) => c.command)).toEqual(["go test ./...", "go vet ./..."]);
  });

  it("ignores npm's placeholder test script", async () => {
    const out = await detectChecks(["package.json"], async () => JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(out).toEqual([]);
  });
});

describe("permissions in the policy", () => {
  it("asks before every edit when edits are not auto-approved, and always asks for new commands", () => {
    const ctx = { fileScope: ["src/**"], allowedChecks: [] };
    expect(checkToolCall({ tool: "write_file", path: "src/a.ts", content: "" }, ctx).verdict).toBe("allow");
    expect(checkToolCall({ tool: "write_file", path: "src/a.ts", content: "" }, { ...ctx, askBeforeWrites: true }).verdict).toBe("ask");
    expect(checkToolCall({ tool: "request_check", name: "t", command: "rm -rf /", reason: "" }, ctx).verdict).toBe("ask");
    // Workspace rules hold whatever is auto-approved.
    expect(checkToolCall({ tool: "write_file", path: "../x", content: "" }, { ...ctx, askBeforeWrites: true }).verdict).toBe("deny");
  });
});
