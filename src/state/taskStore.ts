import { promises as fs } from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { Mutex } from "../util/mutex";
import { Run, RunEvent, Task, TaskStatus, TRANSITIONS } from "./types";

export type NewTask = Pick<Task, "title" | "instructions"> &
  Partial<Pick<Task, "id" | "parentId" | "dependsOn" | "fileScope">>;

/**
 * Saves runs as JSON on disk so they survive restarts and can be resumed.
 * Layout: <root>/runs/<runId>/state.json and <root>/runs/<runId>/events.jsonl.
 */
export class TaskStore {
  // Workers update tasks in parallel; every read-modify-write goes through this lock.
  private readonly lock = new Mutex();

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

  async createRun(request: string, workspaceRoot?: string): Promise<Run> {
    const time = this.now().toISOString();
    const run: Run = { id: randomUUID(), request, workspaceRoot, createdAt: time, updatedAt: time, tasks: [] };
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
    const line = JSON.stringify({ time: this.now().toISOString(), ...event }) + "\n";
    await fs.appendFile(path.join(dir, "events.jsonl"), line, "utf8");
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
  updateTask(runId: string, taskId: string, patch: Partial<Pick<Task, "branch" | "commit" | "changedFiles" | "summary">>): Promise<Task> {
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
    task.status = status;
    task.error = error;
    task.updatedAt = time;
    run.updatedAt = time;
    await this.save(run);
    await this.log({ runId, taskId, type: "status", message: status, data: error ? { error } : undefined });
    return task;
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
