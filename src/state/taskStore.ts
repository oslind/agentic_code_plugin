import { promises as fs } from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { Mutex } from "../util/mutex";
import { ChatMessage } from "../providers/types";
import { PendingChange, Run, RunEvent, Task, TaskStatus, TRANSITIONS } from "./types";

export type NewTask = Pick<Task, "title" | "instructions"> &
  Partial<Pick<Task, "id" | "parentId" | "dependsOn" | "fileScope">>;

/**
 * Saves runs as JSON on disk so they survive restarts and can be resumed.
 * Layout: <root>/runs/<runId>/state.json and <root>/runs/<runId>/events.jsonl.
 */
export class TaskStore {
  // Workers update tasks in parallel; every read-modify-write goes through this lock.
  private readonly lock = new Mutex();
  private readonly listeners = new Set<(event: RunEvent) => void>();

  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private runDir(runId: string): string {
    if (!/^[\w-]+$/.test(runId)) {
      throw new Error(`Invalid run id: ${runId}`);
    }
    return path.join(this.root, "runs", runId);
  }

  async createRun(request: string, workspaceRoot?: string, kind?: Run["kind"], briefing?: string): Promise<Run> {
    const time = this.now().toISOString();
    const run: Run = { id: randomUUID(), request, kind, workspaceRoot, briefing, createdAt: time, updatedAt: time, tasks: [] };
    await this.save(run);
    await this.log({ runId: run.id, type: "run_created", message: request });
    return run;
  }

  async load(runId: string): Promise<Run> {
    const raw = await fs.readFile(path.join(this.runDir(runId), "state.json"), "utf8");
    return JSON.parse(raw) as Run;
  }

  async listRuns(): Promise<Run[]> {
    const dir = path.join(this.root, "runs");
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const runs = await Promise.all(names.map((n) => this.load(n).catch(() => undefined)));
    return runs.filter((r): r is Run => r !== undefined).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Writes to a temp file and renames it, so a crash never leaves half a file. */
  async save(run: Run): Promise<void> {
    const dir = this.runDir(run.id);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "state.json");
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(run, null, 2), "utf8");
    await fs.rename(tmp, file);
  }

  async log(event: Omit<RunEvent, "time">): Promise<void> {
    const dir = this.runDir(event.runId);
    await fs.mkdir(dir, { recursive: true });
    const full: RunEvent = { time: this.now().toISOString(), ...event };
    await fs.appendFile(path.join(dir, "events.jsonl"), JSON.stringify(full) + "\n", "utf8");
    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch {
        // A broken listener must never stop a run.
      }
    }
  }

  /** Calls `listener` after every logged event. Returns a function that stops it. */
  onEvent(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async readLog(runId: string): Promise<RunEvent[]> {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(this.runDir(runId), "events.jsonl"), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    // A crash mid-append can leave a partial last line; skip anything unparsable.
    return raw
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as RunEvent];
        } catch {
          return [];
        }
      });
  }

  private historyFile(runId: string, taskId: string): string {
    if (!/^[\w-]+$/.test(taskId)) throw new Error(`Invalid task id: ${taskId}`);
    return path.join(this.runDir(runId), "history", `${taskId}.json`);
  }

  /**
   * Saves a sub-agent's conversation when it stops working, so the user can
   * reopen it later and the sub-agent remembers what it did.
   */
  async saveHistory(runId: string, taskId: string, messages: ChatMessage[]): Promise<void> {
    const file = this.historyFile(runId, taskId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(messages), "utf8");
    await fs.rename(tmp, file);
  }

  /** A sub-agent's saved conversation, or undefined if none was saved (older runs, or it never started). */
  async loadHistory(runId: string, taskId: string): Promise<ChatMessage[] | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.historyFile(runId, taskId), "utf8")) as unknown;
      if (!Array.isArray(parsed)) return undefined;
      return parsed.filter(
        (m): m is ChatMessage => !!m && typeof m === "object" && ["system", "user", "assistant"].includes((m as ChatMessage).role) && typeof (m as ChatMessage).content === "string",
      );
    } catch {
      return undefined;
    }
  }

  addTasks(runId: string, newTasks: NewTask[]): Promise<Task[]> {
    return this.lock.run(() => this.addTasksLocked(runId, newTasks));
  }

  private async addTasksLocked(runId: string, newTasks: NewTask[]): Promise<Task[]> {
    const run = await this.load(runId);
    const time = this.now().toISOString();
    const added: Task[] = newTasks.map((t) => ({
      id: t.id ?? randomUUID(),
      title: t.title,
      instructions: t.instructions,
      parentId: t.parentId,
      dependsOn: t.dependsOn ?? [],
      fileScope: t.fileScope ?? [],
      status: "pending",
      attempts: 0,
      createdAt: time,
      updatedAt: time,
    }));
    const all = [...run.tasks, ...added];
    validateGraph(all);
    run.tasks = all;
    run.updatedAt = time;
    await this.save(run);
    for (const t of added) {
      await this.log({ runId, taskId: t.id, type: "task_added", message: t.title });
    }
    return added;
  }

  setStatus(runId: string, taskId: string, status: TaskStatus, error?: string): Promise<Task> {
    return this.lock.run(() => this.setStatusLocked(runId, taskId, status, error));
  }

  /** Records results on a task without changing its status. */
  updateTask(runId: string, taskId: string, patch: Partial<Pick<Task, "changedFiles" | "summary" | "unfinished">>): Promise<Task> {
    return this.lock.run(async () => {
      const run = await this.load(runId);
      const task = run.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Unknown task ${taskId}`);
      Object.assign(task, patch, { updatedAt: this.now().toISOString() });
      run.updatedAt = task.updatedAt;
      await this.save(run);
      return task;
    });
  }

  private async setStatusLocked(runId: string, taskId: string, status: TaskStatus, error?: string): Promise<Task> {
    const run = await this.load(runId);
    const task = run.tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Unknown task ${taskId}`);
    }
    if (!TRANSITIONS[task.status].includes(status)) {
      throw new Error(`Task ${taskId} cannot go from ${task.status} to ${status}`);
    }
    const time = this.now().toISOString();
    if (status === "running") task.attempts += 1;
    // Keep the reason for the last failure so a retry can learn from it.
    if (task.error) task.lastError = task.error;
    task.status = status;
    task.error = error;
    task.updatedAt = time;
    run.updatedAt = time;
    await this.save(run);
    await this.log({ runId, taskId, type: "status", message: status, data: error ? { error } : undefined });
    return task;
  }

  /** Adds a task's proposed file changes. A later change to the same file from the same run replaces the earlier pending one. */
  addChanges(runId: string, changes: PendingChange[]): Promise<Run> {
    return this.lock.run(async () => {
      const run = await this.load(runId);
      const list = (run.changes ??= []);
      for (const c of changes) {
        const i = list.findIndex((x) => x.path === c.path && x.status === "pending");
        if (i >= 0) list.splice(i, 1, { ...c, original: list[i]!.original });
        else list.push(c);
      }
      run.updatedAt = this.now().toISOString();
      await this.save(run);
      return run;
    });
  }

  /** Marks one pending change accepted or rejected. Resolves the change, or undefined if it was not pending. */
  setChangeStatus(runId: string, filePath: string, status: "accepted" | "rejected", auto = false): Promise<PendingChange | undefined> {
    return this.lock.run(async () => {
      const run = await this.load(runId);
      const change = run.changes?.find((c) => c.path === filePath && c.status === "pending");
      if (!change) return undefined;
      change.status = status;
      if (auto) change.auto = true;
      run.updatedAt = this.now().toISOString();
      await this.save(run);
      await this.log({ runId, taskId: change.taskId, type: `change_${status}`, message: filePath, data: auto ? { auto } : undefined });
      return change;
    });
  }

  /** Puts a failed or cancelled task back in the queue. What its last attempt wrote is kept for the retry. */
  async retryTask(runId: string, taskId: string): Promise<Task> {
    const task = await this.setStatus(runId, taskId, "pending");
    await this.log({ runId, taskId, type: "retry_requested", message: task.title });
    return task;
  }

  /** Removes a run's saved state and log.  */
  async deleteRun(runId: string): Promise<void> {
    await fs.rm(this.runDir(runId), { recursive: true, force: true });
  }

  /**
   * After a restart, tasks that were mid-flight have no live worker.
   * Put them back to pending so they can be retried.
   */
  async recoverInterrupted(runId: string): Promise<Task[]> {
    const run = await this.load(runId);
    const stuck = run.tasks.filter((t) => t.status === "running" || t.status === "verifying");
    for (const t of stuck) {
      await this.setStatus(runId, t.id, "pending", "Interrupted by restart");
    }
    return stuck;
  }
}

/** Pending tasks whose dependencies are all done. */
export function readyTasks(run: Run): Task[] {
  const done = new Set(run.tasks.filter((t) => t.status === "done").map((t) => t.id));
  return run.tasks.filter((t) => t.status === "pending" && t.dependsOn.every((d) => done.has(d)));
}

/** Throws if ids repeat, a dependency is missing, or dependencies form a cycle. */
export function validateGraph(tasks: Task[]): void {
  const byId = new Map<string, Task>();
  for (const t of tasks) {
    if (byId.has(t.id)) throw new Error(`Duplicate task id ${t.id}`);
    byId.set(t.id, t);
  }
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!byId.has(d)) throw new Error(`Task ${t.id} depends on unknown task ${d}`);
    }
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, trail: string[]): void => {
    const s = state.get(id);
    if (s === "done") return;
    if (s === "visiting") throw new Error(`Dependency cycle: ${[...trail, id].join(" -> ")}`);
    state.set(id, "visiting");
    for (const d of byId.get(id)!.dependsOn) visit(d, [...trail, id]);
    state.set(id, "done");
  };
  for (const t of tasks) visit(t.id, []);
}
