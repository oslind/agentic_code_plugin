import { promises as fs } from "fs";
import * as vscode from "vscode";
import { readModelConfig, readRunConfig } from "../config";
import { applyRun, cleanupRun, integrationBranchFor, MergeRequest, Orchestrator } from "../coordinator/orchestrator";
import { OpenAICompatibleProvider } from "../providers/openaiCompatible";
import { RetryingProvider } from "../providers/retrying";
import { TaskStore } from "../state/taskStore";
import { Run, Task } from "../state/types";
import { ToolCall } from "../tools/protocol";
import { TaskTreeProvider } from "./taskTree";

type RunNode = { kind: "run"; run: Run } | { kind: "task"; run: Run; task: Task } | undefined;

/**
 * A run may only touch the folder it was planned in, and only while that
 * folder is open in VS Code. This re-checks it before anything runs.
 */
async function confinedFolder(run: Run): Promise<vscode.WorkspaceFolder> {
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

async function showDiff(request: MergeRequest): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ language: "diff", content: request.diff });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function approveMerge(request: MergeRequest): Promise<boolean> {
  const files = request.changedFiles.join(", ");
  const checks = request.checks.length ? request.checks.map((c) => `${c.name} passed`).join(", ") : "no checks configured";
  for (;;) {
    const choice = await vscode.window.showInformationMessage(
      `Merge "${request.task.title}"?`,
      { modal: true, detail: `${request.task.summary ?? ""}\n\nFiles: ${files}\nChecks: ${checks}` },
      "Merge",
      "Show diff",
      "Reject",
    );
    if (choice === "Show diff") {
      await showDiff(request);
      continue;
    }
    return choice === "Merge";
  }
}

async function approveTool(task: Task, reason: string, call: ToolCall): Promise<boolean> {
  const target = "path" in call ? call.path : call.tool;
  const choice = await vscode.window.showWarningMessage(
    `"${task.title}" wants to change ${target}`,
    { modal: true, detail: reason },
    "Allow once",
  );
  return choice === "Allow once";
}

/** Offers to resume runs that stopped mid-way, for example when VS Code was closed. */
export async function offerResume(store: TaskStore): Promise<void> {
  const unfinished = new Set<string>(["running", "verifying", "awaiting_approval"]);
  for (const run of await store.listRuns()) {
    if (!run.tasks.some((t) => unfinished.has(t.status))) continue;
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
): void {
  const active = new Map<string, { abort: AbortController; orchestrator: Orchestrator }>();

  context.subscriptions.push(
    vscode.commands.registerCommand("agentic.runPlan", async (node: RunNode) => {
      const run = await pickRun(store, node);
      if (!run) return;
      if (active.has(run.id)) {
        vscode.window.showWarningMessage("This run is already in progress.");
        return;
      }
      try {
        const folder = await confinedFolder(run);
        const config = readRunConfig(folder.uri);
        if (config.checks.length === 0) {
          const go = await vscode.window.showWarningMessage(
            "No checks are configured, so nothing will verify the workers' changes.",
            { modal: true, detail: "Add tests, lint or type checks under agentic.checks in your settings." },
            "Run anyway",
          );
          if (go !== "Run anyway") return;
        }
        const abort = new AbortController();
        const orchestrator = new Orchestrator({
          store,
          runId: run.id,
          provider: new RetryingProvider(new OpenAICompatibleProvider(readModelConfig())),
          workspaceRoot: folder.uri.fsPath,
          checks: config.checks,
          maxParallel: config.maxParallel,
          maxTurns: config.maxTurns,
          maxFixRounds: config.maxFixRounds,
          linkDirs: config.linkDirs,
          signal: abort.signal,
          approveMerge,
          approveTool,
          onChange: () => tree.refresh(),
        });
        active.set(run.id, { abort, orchestrator });
        output.info(`Running "${run.request}" in ${folder.uri.fsPath}`);
        const outcome = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: "Agentic: running tasks" },
          () => orchestrator.run(),
        );
        output.info(`Done: ${outcome.done.join(", ") || "none"}. Failed: ${outcome.failed.join(", ") || "none"}. Blocked: ${outcome.blocked.join(", ") || "none"}.`);
        const summary = `${outcome.done.length} done, ${outcome.failed.length} failed, ${outcome.blocked.length} blocked. Work is on ${outcome.integrationBranch}.`;
        const next = await vscode.window.showInformationMessage(summary, "Apply to my branch", "Show log");
        if (next === "Apply to my branch") await vscode.commands.executeCommand("agentic.applyRun", { kind: "run", run });
        if (next === "Show log") output.show();
      } catch (err) {
        output.error((err as Error).message);
        vscode.window.showErrorMessage(`Run failed: ${(err as Error).message}`);
      } finally {
        active.delete(run.id);
        tree.refresh();
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
      output.warn("Cancelling run. Branches are kept.");
    }),
    vscode.commands.registerCommand("agentic.cancelTask", (node: RunNode) => {
      if (node?.kind !== "task") return;
      if (!active.get(node.run.id)?.orchestrator.cancelTask(node.task.id)) {
        vscode.window.showInformationMessage("That task is not running.");
        return;
      }
      output.warn(`Cancelling task ${node.task.id}. Its branch is kept.`);
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
    vscode.commands.registerCommand("agentic.cleanupRun", async (node: RunNode) => {
      const run = await pickRun(store, node);
      if (!run) return;
      if (active.has(run.id)) {
        vscode.window.showWarningMessage("Cancel the run before cleaning it up.");
        return;
      }
      try {
        const folder = await confinedFolder(run);
        const choice = await vscode.window.showWarningMessage(
          "Clean up this run?",
          {
            modal: true,
            detail:
              "Removing worktrees frees disk space and keeps all branches, so work can still be recovered. Deleting branches and the saved run cannot be undone.",
          },
          "Remove worktrees",
          "Delete everything",
        );
        if (!choice) return;
        const all = choice === "Delete everything";
        const result = await cleanupRun(folder.uri.fsPath, run.id, all);
        if (all) await store.deleteRun(run.id);
        else await store.log({ runId: run.id, type: "cleanup", message: `Removed ${result.worktrees} worktree(s)` });
        output.info(`Cleaned up run: ${result.worktrees} worktree(s), ${result.branches.length} branch(es) deleted.`);
        tree.refresh();
      } catch (err) {
        vscode.window.showErrorMessage((err as Error).message);
      }
    }),
    vscode.commands.registerCommand("agentic.applyRun", async (node: RunNode) => {
      const run = await pickRun(store, node);
      if (!run) return;
      try {
        const folder = await confinedFolder(run);
        const branch = integrationBranchFor(run.id);
        const ok = await vscode.window.showWarningMessage(
          `Merge ${branch} into your current branch?`,
          { modal: true, detail: "This changes your working tree. Your branch must have no uncommitted changes." },
          "Merge",
        );
        if (ok !== "Merge") return;
        const conflicts = await applyRun(folder.uri.fsPath, branch);
        if (conflicts.length) {
          vscode.window.showErrorMessage(`Merge stopped on conflicts in ${conflicts.join(", ")}. Nothing was changed.`);
        } else {
          await store.log({ runId: run.id, type: "applied", message: branch });
          vscode.window.showInformationMessage(`Merged ${branch} into your branch.`);
        }
      } catch (err) {
        vscode.window.showErrorMessage((err as Error).message);
      }
    }),
  );
}
