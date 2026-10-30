import { promises as fs } from "fs";
import * as vscode from "vscode";
import { readModelConfig, readRunConfig } from "../config";
import { applyRun, integrationBranchFor, MergeRequest, Orchestrator } from "../coordinator/orchestrator";
import { OpenAICompatibleProvider } from "../providers/openaiCompatible";
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

export function registerRunCommands(
  context: vscode.ExtensionContext,
  store: TaskStore,
  tree: TaskTreeProvider,
  output: vscode.LogOutputChannel,
): void {
  const active = new Map<string, AbortController>();

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
        active.set(run.id, abort);
        const orchestrator = new Orchestrator({
          store,
          runId: run.id,
          provider: new OpenAICompatibleProvider(readModelConfig()),
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
      target.abort();
      output.warn("Cancelling run. Branches are kept.");
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
