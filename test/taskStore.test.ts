import { mkdtemp, rm, appendFile } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readyTasks, TaskStore } from "../src/state/taskStore";

let dir: string;
let store: TaskStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "agentic-"));
  store = new TaskStore(dir);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("TaskStore", () => {
  it("persists runs and tasks across instances", async () => {
    const run = await store.createRun("add login");
    await store.addTasks(run.id, [{ id: "a", title: "A", instructions: "do a", fileScope: ["src/a/**"] }]);
    const reloaded = await new TaskStore(dir).load(run.id);
    expect(reloaded.tasks.map((t) => t.id)).toEqual(["a"]);
    expect(reloaded.tasks[0]?.fileScope).toEqual(["src/a/**"]);
  });

  it("only offers tasks whose dependencies are done", async () => {
    const run = await store.createRun("r");
    await store.addTasks(run.id, [
      { id: "a", title: "A", instructions: "" },
      { id: "b", title: "B", instructions: "", dependsOn: ["a"] },
    ]);
    expect(readyTasks(await store.load(run.id)).map((t) => t.id)).toEqual(["a"]);
    for (const s of ["running", "verifying", "awaiting_approval", "done"] as const) {
      await store.setStatus(run.id, "a", s);
    }
    expect(readyTasks(await store.load(run.id)).map((t) => t.id)).toEqual(["b"]);
  });

  it("rejects cycles and unknown dependencies", async () => {
    const run = await store.createRun("r");
    await expect(
      store.addTasks(run.id, [
        { id: "a", title: "A", instructions: "", dependsOn: ["b"] },
        { id: "b", title: "B", instructions: "", dependsOn: ["a"] },
      ]),
    ).rejects.toThrow(/cycle/);
    await expect(store.addTasks(run.id, [{ id: "c", title: "C", instructions: "", dependsOn: ["zzz"] }])).rejects.toThrow(
      /unknown/,
    );
  });

  it("rejects invalid status changes", async () => {
    const run = await store.createRun("r");
    await store.addTasks(run.id, [{ id: "a", title: "A", instructions: "" }]);
    await expect(store.setStatus(run.id, "a", "done")).rejects.toThrow(/cannot go/);
  });

  it("counts attempts and resets interrupted tasks to pending", async () => {
    const run = await store.createRun("r");
    await store.addTasks(run.id, [{ id: "a", title: "A", instructions: "" }]);
    await store.setStatus(run.id, "a", "running");
    const stuck = await store.recoverInterrupted(run.id);
    expect(stuck.map((t) => t.id)).toEqual(["a"]);
    const task = (await store.load(run.id)).tasks[0]!;
    expect(task.status).toBe("pending");
    expect(task.attempts).toBe(1);
  });

  it("writes an event log and skips a torn last line", async () => {
    const run = await store.createRun("r");
    await appendFile(path.join(dir, "runs", run.id, "events.jsonl"), '{"broken":');
    const events = await store.readLog(run.id);
    expect(events.map((e) => e.type)).toEqual(["run_created"]);
  });

  it("refuses run ids that could escape the store", async () => {
    await expect(store.load("../etc")).rejects.toThrow(/Invalid run id/);
  });
});
