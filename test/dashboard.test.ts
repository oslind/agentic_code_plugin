import { describe, expect, it } from "vitest";
import { buildDashboard } from "../src/chat/dashboard";
import { agentState, coordinatorState, draftState, DRAFT_LABEL, DRAFT_TRANSITIONS, lineCounts } from "../src/chat/lifecycle";
import { relativeInside } from "../src/tools/paths";
import type { PlanView } from "../src/chat/chatController";
import type { ChatEntry } from "../src/chat/types";

let n = 0;
const entry = (e: Partial<ChatEntry>): ChatEntry => ({ id: `e${++n}`, time: new Date(0).toISOString(), author: "coordinator", text: "", ...e });

function plan(over: Partial<PlanView> = {}): PlanView {
  return {
    kind: "change",
    started: true,
    waves: 1,
    tasks: [
      { id: "a", title: "Fix parser", status: "done", fileScope: ["src/p.ts"], dependsOn: [] },
      { id: "b", title: "Add tests", status: "running", fileScope: ["test/p.test.ts"], dependsOn: [] },
      { id: "c", title: "Docs", status: "pending", fileScope: ["README.md"], dependsOn: ["a"] },
    ],
    changes: [
      { path: "src/p.ts", taskId: "a", agentName: "Fix parser", kind: "edit", status: "pending", state: "draft", added: 3, removed: 1 },
      { path: "old.ts", taskId: "a", agentName: "Fix parser", kind: "edit", status: "rejected", state: "discarded", added: 0, removed: 2 },
    ],
    ...over,
  };
}

describe("draft lifecycle", () => {
  it("only an accepted change is applied, and a draft is never called written", () => {
    expect(draftState("pending")).toBe("draft");
    expect(draftState("accepted")).toBe("applied");
    expect(draftState("rejected")).toBe("discarded");
    expect(Object.values(DRAFT_LABEL).join(" ")).not.toMatch(/written|created|modified/i);
    expect(DRAFT_TRANSITIONS.draft).toEqual(["applied", "discarded"]);
    expect(DRAFT_TRANSITIONS.applied).toEqual([]);
  });

  it("counts added and removed lines like a diff", () => {
    expect(lineCounts("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({ added: 2, removed: 1 });
    expect(lineCounts(null, "x\ny\n")).toEqual({ added: 2, removed: 0 });
    expect(lineCounts("same\n", "same\n")).toEqual({ added: 0, removed: 0 });
    expect(lineCounts("a\nb\n", "")).toEqual({ added: 0, removed: 2 });
  });
});

describe("agent and coordinator lifecycles", () => {
  it("maps task statuses to what the user sees", () => {
    const o = { planStarted: true, hasActivity: true, waitingOnUser: false };
    expect(agentState("pending", { ...o, planStarted: false })).toBe("planned");
    expect(agentState("pending", o)).toBe("queued");
    expect(agentState("running", { ...o, hasActivity: false })).toBe("initializing");
    expect(agentState("running", o)).toBe("working");
    expect(agentState("running", { ...o, waitingOnUser: true })).toBe("needs_you");
    expect(agentState("verifying", o)).toBe("verifying");
    expect(agentState("done", o)).toBe("completed");
    expect(agentState("failed", o)).toBe("failed");
    expect(agentState("cancelled", o)).toBe("stopped");
  });

  it("keeps the coordinator working while sub-agents run, and finished only once the prompt is dealt with", () => {
    expect(coordinatorState({ busy: "x", stopping: false, runningRun: true, waitingOnUser: false })).toBe("supervising");
    expect(coordinatorState({ busy: "x", stopping: false, runningRun: false, waitingOnUser: false })).toBe("thinking");
    expect(coordinatorState({ busy: "x", stopping: true, runningRun: true, waitingOnUser: false })).toBe("stopping");
    expect(coordinatorState({ busy: "x", stopping: false, runningRun: true, waitingOnUser: true })).toBe("needs_you");
    expect(coordinatorState({ stopping: false, runningRun: false, waitingOnUser: false })).toBe("idle");
    expect(coordinatorState({ stopping: false, runningRun: false, waitingOnUser: false, done: "finished" })).toBe("finished");
  });
});

describe("buildDashboard", () => {
  it("counts this prompt's agents and the conversation's drafts", () => {
    const entries = [
      entry({ author: "user", text: "fix it" }),
      entry({ kind: "plan", runId: "r1" }),
      entry({ author: "agent", runId: "r1", taskId: "b", text: "Reading p.ts", thought: "Reading p.ts" }),
      entry({ author: "agent", runId: "r1", taskId: "a", kind: "report", text: "Fixed the parser." }),
    ];
    const d = buildDashboard({ entries, plans: { r1: plan() }, runIds: ["r1"], waiting: [], busy: "Working", stopping: false, runningRunId: "r1" });
    expect(d.kind).toBe("changes");
    expect(d.counts).toMatchObject({ total: 3, completed: 1, running: 1, queued: 1 });
    expect(d.drafts).toEqual({ awaiting: 1, accepted: 0, rejected: 1 });
    expect(d.coordinator.state).toBe("supervising");
    const [a, b, c] = d.agents;
    expect(a).toMatchObject({ state: "completed", activity: "Fixed the parser.", drafts: 1, draftFiles: 2, report: "Fixed the parser." });
    expect(b).toMatchObject({ state: "working", activity: "Reading p.ts", canMessage: true });
    expect(c).toMatchObject({ state: "queued", canMessage: false });
    expect(d.finished).toBeUndefined();
  });

  it("puts waiting cards in front of the user, with the tab they belong to", () => {
    const cmd = entry({ author: "agent", kind: "approval", runId: "r1", taskId: "b", rememberable: true, text: "I'd like to run `npm test`" });
    const edit = entry({ author: "agent", kind: "approval", runId: "r1", taskId: "b", preview: "+x", text: "Edit p.ts" });
    const q = entry({ author: "agent", kind: "question", runId: "r1", taskId: "b", text: "Which file?" });
    const d = buildDashboard({ entries: [entry({ author: "user" }), entry({ kind: "plan", runId: "r1" }), cmd, edit, q], plans: { r1: plan() }, runIds: ["r1"], waiting: [cmd.id, edit.id, q.id], busy: "x", stopping: false, runningRunId: "r1" });
    expect(d.attention.map((a) => a.tab)).toEqual(["checks", "drafts", "overview"]);
    expect(d.agents[1]!.state).toBe("needs_you");
    expect(d.coordinator.state).toBe("needs_you");
  });

  it("calls a read-only prompt an analysis, and says what is left once finished", () => {
    const research = plan({ kind: "research", changes: [], tasks: [{ id: "q", title: "Map modules", status: "done", fileScope: [], dependsOn: [] }] });
    const d = buildDashboard({
      entries: [entry({ author: "user" }), entry({ kind: "research", runId: "r2" })],
      plans: { r1: plan(), r2: research },
      runIds: ["r1", "r2"],
      waiting: [],
      stopping: false,
      done: { status: "finished", text: "Finished." },
    });
    expect(d.kind).toBe("analysis");
    expect(d.counts.total).toBe(1);
    expect(d.agents[0]).toMatchObject({ title: "Map modules", research: true });
    expect(d.finished).toMatchObject({ status: "finished", detail: "1 draft awaiting review · 1 rejected · 0 checks run" });
  });
});

describe("relativeInside", () => {
  it("keeps only files inside the folder, after following links", async () => {
    const links: Record<string, string> = { "/p/link": "/etc/passwd" };
    const real = async (f: string) => links[f] ?? f;
    expect(await relativeInside("/p", ["/p/src/a.ts", "/p/link", "/other/b.ts", "/p", "/p/src/a.ts"], real)).toEqual(["src/a.ts"]);
  });
});
