import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatController, ChatHost, RunHooks } from "../src/chat/chatController";
import { CheckConfig } from "../src/checks/runner";
import { DetectedCheck, detectChecks } from "../src/checks/detect";
import { AutoApprove, checkToolCall } from "../src/tools/policy";
import { commandLeavesProject } from "../src/tools/commandGuard";
import { runAllChecks, runCheck } from "../src/checks/runner";
import { previewChange } from "../src/worker/worker";
import { WorkspaceSandbox } from "../src/tools/sandbox";
import { ConversationStore, trimEntries } from "../src/chat/conversationStore";
import { buildCoordinatorMessages, coordinatorTurn, editingReason, enforceMode, isReadOnlyPlan, isReadOnlyRequest, steerToResearch } from "../src/chat/coordinatorChat";
import { eventToEntry } from "../src/chat/eventFeed";
import { extractThinking } from "../src/llm/structured";
import { ChatEntry, ChatMode } from "../src/chat/types";
import { RunOutcome } from "../src/coordinator/orchestrator";
import { changedFilesOf, describeOutcome } from "../src/chat/outcome";
import { Run } from "../src/state/types";
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
    return { controller: new ChatController(conversations, tasks, host), started, provider, usedChecks, savedChecks, tasks };
  }

  it("passes what research found to the planner and to every sub-agent of the next run", async () => {
    await fs.mkdir(path.join(dir, "ws"), { recursive: true });
    await fs.writeFile(path.join(dir, "ws", "README.md"), "# Flight sim\n");
    const worker = (thought: string, call: object) => JSON.stringify({ thought, call });
    const { controller, provider, tasks } = setup(
      [
        JSON.stringify({ reply: "Reading.", action: "research", request: "", questions: ["What does this project do?"] }),
        worker("Done.", { tool: "finish", summary: "It is a flight simulator; physics lives in src/physics.ts." }),
        JSON.stringify({ reply: "It is a flight simulator.", action: "none", request: "" }),
        turn("Plan below.", "plan", "Add wind to the physics."),
        plan,
      ],
      "plan",
    );
    await controller.send("What is this?");
    await controller.send("Add wind");
    const plannerCall = provider.requests.at(-1)!.messages.map((m) => m.content).join("\n");
    expect(plannerCall).toMatch(/What we know so far[\s\S]*physics lives in src\/physics\.ts/);
    const runId = (await controller.state()).current!.entries.find((e) => e.kind === "plan")!.runId!;
    expect((await tasks.load(runId)).briefing).toMatch(/physics lives in src\/physics\.ts[\s\S]*Coordinator concluded: It is a flight simulator/);
  });

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
    // Research never ends with a run summary or Apply buttons.
    expect(entries.some((e) => e.kind === "outcome")).toBe(false);
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

  it("runs a plan that only reads as research, in Plan mode, with no switch to Act", async () => {
    await fs.mkdir(path.join(dir, "ws"), { recursive: true });
    const readPlan = JSON.stringify({ tasks: [{ id: "scan", title: "Scan sources", instructions: "Read the files in src and summarise each module.", dependsOn: [], fileScope: ["src/**"] }] });
    const { controller, started } = setup(
      [
        turn("Plan below.", "plan", "Go through the sources module by module."),
        readPlan,
        JSON.stringify({ thought: "Done.", call: { tool: "finish", summary: "src has one module, index.ts." } }),
        JSON.stringify({ reply: "There is one module, src/index.ts.", action: "none", request: "" }),
      ],
      "plan",
    );
    await controller.send("Go through the sources module by module");
    const state = await controller.state();
    const entries = state.current!.entries;
    expect(started).toEqual([]);
    expect(state.mode).toBe("plan");
    expect(entries.some((e) => e.kind === "plan")).toBe(false);
    expect(entries.some((e) => e.kind === "research")).toBe(true);
    expect(entries.at(-1)).toMatchObject({ author: "coordinator", text: "There is one module, src/index.ts." });
  });

  it("first reads the code base, then plans a refactor that knows what research found", async () => {
    await fs.mkdir(path.join(dir, "ws"), { recursive: true });
    const refactorPlan = JSON.stringify({ tasks: [
      { id: "split-server", title: "Refactor server", instructions: "Refactor webapp/pyserver.py: move the route handlers into webapp/routes.py.", dependsOn: [], fileScope: ["webapp/pyserver.py", "webapp/routes.py"], changes: true },
    ] });
    const { controller, provider, tasks } = setup(
      [
        // 1st message: the model wrongly plans; it becomes research.
        turn("Plan below.", "plan", "Read all files and summarise them."),
        JSON.stringify({ thought: "Done.", call: { tool: "finish", summary: "The server is webapp/pyserver.py; routes are inline." } }),
        JSON.stringify({ thought: "Done.", call: { tool: "finish", summary: "x" } }),
        JSON.stringify({ thought: "Done.", call: { tool: "finish", summary: "x" } }),
        JSON.stringify({ thought: "Done.", call: { tool: "finish", summary: "x" } }),
        JSON.stringify({ reply: "It is a small Python web app.", action: "none", request: "" }),
        // 2nd message: a change, which stays a plan.
        turn("Plan below.", "plan", "Refactor the server so routes live in their own module."),
        refactorPlan,
      ],
      "plan",
    );
    await controller.send("read and understand the code base for this project");
    await controller.send("refactor the project according to my instructions: put the routes in their own module");
    const entries = (await controller.state()).current!.entries;
    expect(entries.filter((e) => e.kind === "research")).toHaveLength(1);
    const planEntry = entries.find((e) => e.kind === "plan")!;
    expect(planEntry.text).toMatch(/Switch to Act mode/);
    expect((await tasks.load(planEntry.runId!)).briefing).toMatch(/routes are inline/);
    expect(provider.requests.at(-1)!.messages.map((m) => m.content).join("\n")).toMatch(/What we know so far[\s\S]*routes are inline/);
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
    expect(entries.at(-1)!.text).toMatch(/What the sub-agents did:\n✓ Add model/);
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

  it("shows a file change before it is written, when edits are not auto-approved", async () => {
    let allowed: boolean | undefined;
    const { controller } = setup(planReplies(), "act", {
      permissions: { editFiles: false },
      during: async (hooks) => {
        allowed = await hooks.approveTool({ id: "add-model", title: "Add model" } as never, "Edit 'src/a.ts'", { tool: "write_file", path: "src/a.ts", content: "x" }, "- old\n+ x");
      },
    });
    const sending = controller.send("add users");
    const card = await waitForCard(controller, "approval");
    expect(card).toMatchObject({ preview: "- old\n+ x", rememberable: false });
    expect(card.text).toMatch(/Nothing is written until you allow it/);
    await controller.decide(card.id, { kind: "deny" });
    await sending;
    expect(allowed).toBe(false);
  });

  it("asks before each check command runs when commands are not auto-approved, and can allow it for the run", async () => {
    const results: boolean[] = [];
    const task = { id: "add-model", title: "Add model" } as never;
    const check = { name: "test", command: "npm test" };
    const { controller } = setup(planReplies(), "act", {
      during: async (hooks) => {
        results.push(await hooks.approveCommand(task, check));
        results.push(await hooks.approveCommand(task, check));
      },
    });
    const sending = controller.send("add users");
    const card = await waitForCard(controller, "approval");
    expect(card.text).toMatch(/npm test/);
    expect(card.rememberLabel).toBe("Allow for the rest of this run");
    await controller.decide(card.id, { kind: "allow", remember: true });
    await sending;
    // The second run of the same command in this run did not ask again.
    expect(results).toEqual([true, true]);
    const cards = (await controller.state()).current!.entries.filter((e) => e.kind === "approval");
    expect(cards).toHaveLength(1);
  });

  it("runs check commands without asking when commands are auto-approved", async () => {
    let allowed: boolean | undefined;
    const { controller } = setup(planReplies(), "act", {
      permissions: { commands: true },
      during: async (hooks) => {
        allowed = await hooks.approveCommand({ id: "add-model", title: "Add model" } as never, { name: "test", command: "npm test" });
      },
    });
    await controller.send("add users");
    expect(allowed).toBe(true);
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
    expect(checkToolCall({ tool: "request_check", name: "t", command: "make t", reason: "" }, ctx).verdict).toBe("ask");
    // Commands that point outside the project are refused, not asked about.
    expect(checkToolCall({ tool: "request_check", name: "t", command: "rm -rf /", reason: "" }, ctx).verdict).toBe("deny");
    // Workspace rules hold whatever is auto-approved.
    expect(checkToolCall({ tool: "write_file", path: "../x", content: "" }, { ...ctx, askBeforeWrites: true }).verdict).toBe("deny");
  });
});

describe("describeOutcome", () => {
  const task = (id: string, status: string, extra: Record<string, unknown> = {}) =>
    ({ id, title: `Task ${id}`, instructions: "x", dependsOn: [], fileScope: [], status, ...extra });
  const run = (tasks: unknown[]) => ({ id: "r1", tasks }) as unknown as Run;

  it("says what changed, which files, and what Apply does", () => {
    const r = run([
      task("a", "done", { summary: "Added the model.", changedFiles: ["src/user.ts"] }),
      task("b", "done", { summary: "Added the API.", changedFiles: ["src/api.ts", "src/user.ts"] }),
    ]);
    const text = describeOutcome(r, { done: ["a", "b"], failed: [], blocked: [] } as unknown as RunOutcome);
    expect(text).toMatch(/^All 2 task\(s\) are done\./);
    expect(text).toMatch(/✓ Task a: Added the model\./);
    expect(text).toMatch(/Changed files: src\/api\.ts, src\/user\.ts\./);
    expect(text).toMatch(/Apply to my branch/);
    expect(text).not.toMatch(/integration/);
    expect(changedFilesOf(r)).toEqual(["src/api.ts", "src/user.ts"]);
  });

  it("says when nothing changed and counts failures", () => {
    const r = run([task("a", "done", { summary: "Read it." }), task("b", "failed", { error: "Model gave up." }), task("c", "pending")]);
    const text = describeOutcome(r, { done: ["a"], failed: ["b"], blocked: ["c"] } as unknown as RunOutcome);
    expect(text).toMatch(/1 of 3 task\(s\) are done\. 1 failed\. 1 could not start/);
    expect(text).toMatch(/✕ Task b: Model gave up\./);
    expect(text).toMatch(/nothing to apply/);
  });
});

describe("commands stay inside the project", () => {
  it("allows ordinary project commands", () => {
    for (const c of ["npm test", "npm run lint -- --fix", "python -m pytest tests/test_api.py -q", "cd web && npm test", "cargo test 2>/dev/null", "make test"]) {
      expect(commandLeavesProject(c), c).toBeUndefined();
    }
  });
  it("refuses commands that point outside it", () => {
    for (const c of ["rm -rf /", "cat ../secret", "cd .. && ls", "ls ~", "cat ~/.ssh/id_rsa", "echo $HOME", "cat $(pwd)/../x", "ls `pwd`", "type C:\\x", "cp a /tmp/b", "sudo make install", "ssh host ls", "a\nb"]) {
      expect(commandLeavesProject(c), c).toBeDefined();
    }
  });
  it("the runner refuses such a command even if it was configured", async () => {
    const res = await runCheck({ name: "bad", command: "cat ../x" }, dir);
    expect(res).toMatchObject({ passed: false });
    expect(res.output).toMatch(/Refused to run/);
  });
  it("a check the user does not approve is skipped, not run", async () => {
    const res = await runAllChecks([{ name: "t", command: "node -e process.exit(1)" }], dir, undefined, async () => false);
    expect(res).toEqual([expect.objectContaining({ name: "t", skipped: true, passed: true })]);
  });
});

describe("previewChange", () => {
  it("shows new files, replacements and edits as removed and added lines", async () => {
    await fs.mkdir(path.join(dir, "p", "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "p", "src", "a.ts"), "one\ntwo\nthree\n");
    const sandbox = await WorkspaceSandbox.create(path.join(dir, "p"));
    expect(await previewChange({ tool: "write_file", path: "src/new.ts", content: "hi" }, sandbox)).toBe("New file:\n+ hi");
    expect(await previewChange({ tool: "replace_in_file", path: "src/a.ts", search: "two", replace: "2" }, sandbox)).toBe("- two\n+ 2");
    expect(await previewChange({ tool: "write_file", path: "src/a.ts", content: "one\n2\nthree\n" }, sandbox)).toBe("@@ line 2 @@\n- two\n+ 2");
    // Nothing was written.
    expect(await fs.readFile(path.join(dir, "p", "src", "a.ts"), "utf8")).toBe("one\ntwo\nthree\n");
  });
});

describe("questions about the project become research", () => {
  it("tells questions from change requests", () => {
    for (const t of ["Analyze this project, understand what it does, and repport back to me", "How do I run the tests?", "Explain the auth flow", "where is the config loaded?", "Förklara projektet"]) {
      expect(isReadOnlyRequest(t), t).toBe(true);
    }
    for (const t of ["Add a dark mode toggle", "Can you fix the login bug?", "Refactor the parser and explain it", "go ahead", ""]) {
      expect(isReadOnlyRequest(t), t).toBe(false);
    }
  });

  it("turns a plan for a question into read-only research with focused questions", () => {
    const turn = { reply: "Switch to Act mode to run this.", action: "plan" as const, request: "Analyze the whole project and write a report" };
    const out = steerToResearch(turn, "Analyze this project, understand what it does, and report back to me", 3);
    expect(out.action).toBe("research");
    expect(out.questions).toHaveLength(3);
    expect(out.reply).toMatch(/Nothing will be changed/);
    expect(out.overridden).toMatch(/Plan mode too/);
  });

  it("also catches a reply that only tells the user to switch to Act mode", () => {
    const out = steerToResearch({ reply: "Please switch to Act mode so I can read the files.", action: "none", request: "" }, "What does src/app.ts do?");
    expect(out).toMatchObject({ action: "research", questions: ["What does src/app.ts do?"] });
  });

  it("sees a plan whose tasks only read as research", () => {
    expect(isReadOnlyPlan([
      { title: "Read the source", instructions: "Read the files in src/ and summarise what each module does." },
      { title: "Inspect config", instructions: "Look at package.json and tsconfig.json and report the build setup." },
    ])).toBe(true);
    expect(isReadOnlyPlan([
      { title: "Read the source", instructions: "Read src/ and report." },
      { title: "Add docs", instructions: "Write docs/overview.md describing the modules." },
    ])).toBe(false);
  });

  it("catches Oskar's reading plan, including the task that combines the findings", () => {
    expect(isReadOnlyPlan([
      { title: "Summarize root documentation files", instructions: "Read README.md, tryapp_readme.md and .gitmodules and write a short summary of what they say." },
      { title: "Explain shell scripts and dead-code report", instructions: "Read the shell scripts and DEAD_CODE_REPORT.md and explain what each one does." },
      { title: "Summarize webapp Python server and test data", instructions: "Read webapp/*.py and describe the server, its routes and the test data." },
      { title: "Combine findings into final project summary", instructions: "Combine the findings of the other tasks into one project overview for the user." },
    ])).toBe(true);
    // The planner's own flag decides when it is given.
    expect(isReadOnlyPlan([{ title: "Tidy", instructions: "Update the README wording.", changes: false }])).toBe(true);
    // "changes": true alone is not trusted; small models copy it from the example.
    expect(isReadOnlyPlan([{ title: "Summarize", instructions: "Read src and summarise it.", changes: true }])).toBe(true);
    // A report written to a file is a change.
    expect(isReadOnlyPlan([{ title: "Report", instructions: "Read src and write a report to docs/report.md." }])).toBe(false);
    expect(isReadOnlyRequest("Go through the project and make me a summary of what it does")).toBe(true);
  });

  it("catches Oskar's 6-task Read/Explore plan, even with changes: true on every task", () => {
    const tasks = [
      ["Read README and documentation files", "Read README.md, README_busshack.txt, tryapp_readme.md and DEAD_CODE_REPORT.md. Report what the project is for and how to set it up and run it."],
      ["Explore Python server files", "Explore webapp/pyserver.py and the protoserver package. Describe how the server starts, which port it uses, and how commands are handled."],
      ["Explore frontend structure", "Look through index.html, map.html, map.js and shared/utils.js. Explain how the pages are built and what changes when the map updates."],
      ["Explore flight instrument panels", "Read the flight, FTI, FTF and termination panel HTML files and describe what each panel shows and how it gets its data."],
      ["Explore data parsers", "Read flightplanparser.py, routeparser.py and restrictionsparser.py. Summarise what each parser reads and returns, and make sure to note the input formats."],
      ["Explore configuration files", "Inspect configuration.json, proto/README.md and command.proto and explain the settings and message types."],
    ].map(([title, instructions], i) => ({ id: `t${i}`, title, instructions, dependsOn: [], fileScope: ["webapp/**"], changes: true }));
    expect(tasks.map(editingReason)).toEqual(tasks.map(() => undefined));
    expect(isReadOnlyPlan(tasks)).toBe(true);
  });

  it("writing a summary to a file is a change, not a question", () => {
    for (const t of ["write the summary to a file", "Write the summary into SUMMARY.md", "save the overview", "put the report in docs/overview.md", "skriv sammanfattningen till en fil", "make a report and save it as notes.md"]) {
      expect(isReadOnlyRequest(t), t).toBe(false);
    }
    expect(steerToResearch({ reply: "A sub-agent will write it.", action: "plan", request: "Write the project summary to SUMMARY.md." }, "write the summary to a file").action).toBe("plan");
    expect(editingReason({ title: "Write summary file", instructions: "Write the project summary from the research into SUMMARY.md." })).toBeDefined();
    // Reading files and summarising them in the answer is still reading.
    expect(isReadOnlyPlan([{ title: "Read docs", instructions: "Read README.md and docs/setup.md and write a short summary of what they say." }])).toBe(true);
    expect(isReadOnlyRequest("read README.md and give me a summary")).toBe(true);
  });

  it("still sees real change plans as changes", () => {
    expect(editingReason({ title: "User model", instructions: "Create src/model.ts with a User type." })).toMatch(/Create src/);
    expect(editingReason({ title: "Wind", instructions: "Read src/physics.ts, then add a wind force to the step function." })).toMatch(/add a wind force/);
    expect(editingReason({ title: "Docs", instructions: "You should update the README with the new flags." })).toMatch(/update the README/);
  });

  it("leaves change requests and plain answers alone", () => {
    const plan = { reply: "Plan below.", action: "plan" as const, request: "Add a dark mode toggle to settings." };
    expect(steerToResearch(plan, "Add a dark mode toggle")).toBe(plan);
    const none = { reply: "It is a flight simulator, as the research found.", action: "none" as const, request: "" };
    expect(steerToResearch(none, "What is it again?")).toBe(none);
  });

  it("runs as research in Plan mode end to end, with no switch to Act", async () => {
    const provider = scripted([JSON.stringify({ reply: "Switch to Act mode and I'll start.", action: "plan", request: "Read every file and summarise the project." })]);
    const out = await coordinatorTurn(provider, { mode: "plan", entries: [{ id: "1", time: "", author: "user", text: "Analyze this project and tell me what it does" }] });
    expect(out.action).toBe("research");
  });
});
