import { promises as fs } from "fs";
import * as vscode from "vscode";
import { CheckConfig } from "../checks/runner";
import { createProvider, readPermissions, readRunConfig } from "../config";
import { acceptChange, rejectChange } from "../changes/review";
import { Orchestrator, RunOutcome } from "../coordinator/orchestrator";
import { RetryingProvider } from "../providers/retrying";
import { TaskStore } from "../state/taskStore";
import { Run, Task } from "../state/types";
import { isAutoApproved, isChangeAutoAccepted } from "../tools/policy";
import { ChangeViews } from "./changeViews";
import { ToolCall } from "../tools/protocol";
import { TaskTreeProvider } from "./taskTree";
import { RunHooks } from "../chat/chatController";

export interface RunControl {
  /** Runs a plan for the chat, with the checks and callbacks the chat chose. Errors are thrown, not shown. */
  start(runId: string, hooks: RunHooks): Promise<RunOutcome | undefined>;
  cancel(runId: string): void;
}

type RunNode = { kind: "run"; run: Run } | { kind: "task"; run: Run; task: Task } | undefined;

/**
 * A run may only touch the folder it was planned in, and only while that
 * folder is open in VS Code. This re-checks it before anything runs.
 */
export async function confinedFolder(run: Pick<Run, "workspaceRoot">): Promise<vscode.WorkspaceFolder> {
  if (!run.workspaceRoot) throw new Error("This run has no workspace folder recorded.");
  const want = await fs.realpath(run.workspaceRoot);
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (f.uri.scheme === "file" && (await fs.realpath(f.uri.fsPath).catch(() => "")) === want) return f;
  }
  throw new Error(`This run belongs to ${run.workspaceRoot}, which is not open. Open that folder to run it.`);
}

async function pickRun(store: TaskStore, node: RunNode): Promise<Run | undefined> {
  if (node) return store.load(node.run.id);
  const runs = await store.listRuns();
  const pick = await vscode.window.showQuickPick(
    runs.map((r) => ({ label: r.request, description: `${r.tasks.length} task(s)`, run: r })),
    { placeHolder: "Choose a run" },
  );
  return pick?.run;
}

async function approveTool(task: Task, reason: string, call: ToolCall, preview?: string): Promise<boolean> {
  if (autoApproved(call)) return true;
  const target = "path" in call ? `change ${call.path}` : call.tool === "request_check" ? `run \`${call.command}\`` : call.tool;
  const choice = await vscode.window.showWarningMessage(
    `"${task.title}" wants to ${target}`,
    { modal: true, detail: preview ? `${reason}\n\n${preview.slice(0, 1500)}` : reason },
    "Allow once",
  );
  return choice === "Allow once";
}

/** Asks before each check command runs, unless commands are auto-approved. "Allow for this run" is kept per run. */
function commandApprover(): (task: Task, check: CheckConfig) => Promise<boolean> {
  const allowed = new Set<string>();
  return async (task, check) => {
    if (readPermissions().commands || allowed.has(check.command)) return true;
    const choice = await vscode.window.showWarningMessage(
      `"${task.title}" wants to run \`${check.command}\``,
      { modal: true, detail: `Check "${check.name}". It starts in the project folder, but like any command it runs as you and can read files elsewhere or use the network, so only allow it if you trust it.` },
      "Allow once",
      "Allow for this run",
    );
    if (choice === "Allow for this run") allowed.add(check.command);
    return choice !== undefined;
  };
}

export function autoApproved(call: ToolCall): boolean {
  return isAutoApproved(call, readPermissions());
}

/** Offers to resume runs that stopped mid-way, for example when VS Code was closed. */
export async function offerResume(store: TaskStore): Promise<void> {
  const unfinished = new Set<string>(["running", "verifying"]);
  for (const run of await store.listRuns()) {
    if (run.kind === "research" || !run.tasks.some((t) => unfinished.has(t.status))) continue;
    if (!(await confinedFolder(run).catch(() => undefined))) continue;
    const choice = await vscode.window.showInformationMessage(`"${run.request}" was interrupted.`, "Resume", "Later");
    if (choice === "Resume") await vscode.commands.executeCommand("agentic.runPlan", { kind: "run", run });
    return;
  }
}

export function registerRunCommands(
  context: vscode.ExtensionContext,
  store: TaskStore,
  tree: TaskTreeProvider,
  output: vscode.LogOutputChannel,
  views: ChangeViews,
): RunControl {
  const active = new Map<string, { abort: AbortController; orchestrator: Orchestrator }>();

  /**
   * Runs a plan with sub-agents. Resolves undefined if the user chose not to
   * start it. With `fromChat`, errors are thrown to the chat instead of shown.
   */
  async function execute(run: Run, fromChat: boolean, hooks?: RunHooks): Promise<RunOutcome | undefined> {
    if (active.has(run.id)) throw new Error("This run is already in progress.");
    if (run.kind === "research") throw new Error("This is a research run. It only read files, so there is nothing to run or apply.");
    const folder = await confinedFolder(run);
    const config = readRunConfig(folder.uri);
    // The chat has already asked the user which checks to use.
    if (hooks) config.checks = hooks.checks;
    else if (config.checks.length === 0) {
      const go = await vscode.window.showWarningMessage(
        "No checks are configured, so nothing will verify the workers' changes.",
        { modal: true, detail: "Add tests, lint or type checks under agentic.checks in your settings." },
        "Run anyway",
      );
      if (go !== "Run anyway") return undefined;
    }
    const abort = new AbortController();
    const orchestrator = new Orchestrator({
      store,
      runId: run.id,
      provider: new RetryingProvider(createProvider(folder.uri, output)),
      workspaceRoot: folder.uri.fsPath,
      checks: config.checks,
      maxParallel: config.maxParallel,
      maxTurns: config.maxTurns,
      maxFixRounds: config.maxFixRounds,
      linkDirs: config.linkDirs,
      signal: abort.signal,
      approveTool: hooks?.approveTool ?? approveTool,
      approveCommand: hooks?.approveCommand ?? commandApprover(),
      onChanges: hooks?.onChanges ?? (async (_task, changes) => {
        // Outside the chat: accept what the switches allow, and leave the rest for "Review pending changes".
        for (const c of changes) {
          if (isChangeAutoAccepted(c.path, readPermissions())) await acceptChange(store, run.id, c.path, folder.uri.fsPath, { auto: true });
        }
      }),
      askUser: hooks?.askUser,
      inbox: hooks?.inbox,
      onChange: () => tree.refresh(),
    });
    active.set(run.id, { abort, orchestrator });
    try {
      output.info(`Running "${run.request}" in ${folder.uri.fsPath}`);
      const outcome = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Agentic: running tasks" },
        () => orchestrator.run(),
      );
      output.info(`Done: ${outcome.done.join(", ") || "none"}. Failed: ${outcome.failed.join(", ") || "none"}. Blocked: ${outcome.blocked.join(", ") || "none"}.`);
      if (!fromChat) {
        const pending = ((await store.load(run.id)).changes ?? []).filter((c) => c.status === "pending").length;
        const summary = `${outcome.done.length} done, ${outcome.failed.length} failed, ${outcome.blocked.length} blocked.${pending ? ` ${pending} change(s) wait for your review.` : ""}`;
        void vscode.window.showInformationMessage(summary, ...(pending ? ["Review changes"] : []), "Show log").then(async (next) => {
          if (next === "Review changes") await vscode.commands.executeCommand("agentic.reviewChanges", { kind: "run", run });
          if (next === "Show log") output.show();
        });
      }
      return outcome;
    } finally {
      active.delete(run.id);
      tree.refresh();
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("agentic.runPlan", async (node: RunNode) => {
      const run = await pickRun(store, node);
      if (!run) return;
      try {
        await execute(run, false);
      } catch (err) {
        output.error((err as Error).message);
        vscode.window.showErrorMessage(`Run failed: ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("agentic.cancelRun", async (node: RunNode) => {
      const run = node ? node.run : undefined;
      const target = run ? active.get(run.id) : [...active.values()][0];
      if (!target) {
        vscode.window.showInformationMessage("No run is in progress.");
        return;
      }
      target.abort.abort();
      output.warn("Cancelling run. Pending changes are kept for review.");
    }),
    vscode.commands.registerCommand("agentic.cancelTask", (node: RunNode) => {
      if (node?.kind !== "task") return;
      if (!active.get(node.run.id)?.orchestrator.cancelTask(node.task.id)) {
        vscode.window.showInformationMessage("That task is not running.");
        return;
      }
      output.warn(`Cancelling task ${node.task.id}.`);
    }),
    vscode.commands.registerCommand("agentic.retryTask", async (node: RunNode) => {
      if (node?.kind !== "task") return;
      try {
        await store.retryTask(node.run.id, node.task.id);
        tree.refresh();
        if (!active.has(node.run.id)) await vscode.commands.executeCommand("agentic.runPlan", { kind: "run", run: node.run });
      } catch (err) {
        vscode.window.showErrorMessage((err as Error).message);
      }
    }),
    vscode.commands.registerCommand("agentic.retryFailed", async (node: RunNode) => {
      const run = await pickRun(store, node);
      if (!run) return;
      const failed = run.tasks.filter((t) => t.status === "failed" || t.status === "cancelled");
      if (failed.length === 0) {
        vscode.window.showInformationMessage("No failed tasks to retry.");
        return;
      }
      for (const t of failed) await store.retryTask(run.id, t.id);
      tree.refresh();
      if (!active.has(run.id)) await vscode.commands.executeCommand("agentic.runPlan", { kind: "run", run });
    }),
    vscode.commands.registerCommand("agentic.showTaskLog", async (node: RunNode) => {
      if (!node) return;
      const events = await store.readLog(node.run.id);
      const taskId = node.kind === "task" ? node.task.id : undefined;
      const lines = events
        .filter((e) => !taskId || e.taskId === taskId)
        .map((e) => `${e.time}  ${e.taskId ?? "-"}  ${e.type}: ${e.message}${e.data ? `  ${JSON.stringify(e.data)}` : ""}`);
      const doc = await vscode.workspace.openTextDocument({ language: "log", content: lines.join("\n") || "No events yet." });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand("agentic.deleteRun", async (node: RunNode) => {
      const run = await pickRun(store, node);
      if (!run) return;
      if (active.has(run.id)) {
        vscode.window.showWarningMessage("Cancel the run before deleting it.");
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        "Delete this run from the history?",
        { modal: true, detail: "Its log and any changes still waiting for review are removed. Files already written to your project stay as they are." },
        "Delete",
      );
      if (choice !== "Delete") return;
      await store.deleteRun(run.id);
      tree.refresh();
    }),
    vscode.commands.registerCommand("agentic.reviewChanges", async (node: RunNode) => {
      const run = await pickRun(store, node);
      if (!run) return;
      for (;;) {
        const pending = ((await store.load(run.id)).changes ?? []).filter((c) => c.status === "pending");
        if (pending.length === 0) {
          vscode.window.showInformationMessage("No changes are waiting for review in this run.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          pending.map((c) => ({ label: c.path, description: c.original === null ? "new file" : "edit", change: c })),
          { placeHolder: "Choose a change to review" },
        );
        if (!pick) return;
        await views.show(run.id, pick.change.path);
        const action = await vscode.window.showQuickPick(["Accept", "Reject", "Back"], { placeHolder: `${pick.change.path}: accept or reject?` });
        try {
          const folder = await confinedFolder(run);
          if (action === "Accept") {
            const res = await acceptChange(store, run.id, pick.change.path, folder.uri.fsPath);
            if (!res.ok && res.reason === "changed_on_disk") {
              const again = await vscode.window.showQuickPick(["Overwrite", "Keep my version"], { placeHolder: res.message });
              if (again === "Overwrite") await acceptChange(store, run.id, pick.change.path, folder.uri.fsPath, { overwrite: true });
            } else if (!res.ok) vscode.window.showWarningMessage(res.message);
          }
          if (action === "Reject") await rejectChange(store, run.id, pick.change.path);
          if (action === "Accept" || action === "Reject") await views.close(run.id, pick.change.path);
        } catch (err) {
          vscode.window.showErrorMessage((err as Error).message);
        }
      }
    }),
  );

  return {
    start: async (runId, hooks) => execute(await store.load(runId), true, hooks),
    cancel: (runId) => {
      active.get(runId)?.abort.abort();
    },
  };
}
