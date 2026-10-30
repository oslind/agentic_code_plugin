import * as vscode from "vscode";
import { z } from "zod";
import { readModelConfig } from "./config";
import { fileTree } from "./context/budget";
import { parallelWaves } from "./coordinator/plan";
import { planRequest } from "./coordinator/planner";
import { callStructured } from "./llm/structured";
import { OpenAICompatibleProvider } from "./providers/openaiCompatible";
import { TaskStore } from "./state/taskStore";
import { TaskTreeProvider } from "./ui/taskTree";

const FILE_LIMIT = 2000;
const EXCLUDE = "**/{node_modules,.git,out,dist,build,.venv,__pycache__,.agentic}/**";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Agentic Code", { log: true });
  const store = new TaskStore(context.globalStorageUri.fsPath);
  const tree = new TaskTreeProvider(store);

  context.subscriptions.push(
    output,
    vscode.window.registerTreeDataProvider("agentic.tasks", tree),
    vscode.commands.registerCommand("agentic.refreshTasks", () => tree.refresh()),
    vscode.commands.registerCommand("agentic.testModelConnection", async () => {
      const config = readModelConfig();
      const provider = new OpenAICompatibleProvider(config);
      output.info(`Testing ${config.model} at ${config.baseUrl}`);
      try {
        // A structured call tests both reachability and that the model can follow a JSON format.
        const reply = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Asking ${config.model}...` },
          () =>
            callStructured({
              provider,
              messages: [{ role: "user", content: 'Reply with the JSON object {"ok": true}.' }],
              schema: z.object({ ok: z.boolean() }),
              schemaName: "ping",
              onAttempt: (n, err) => n > 0 && output.warn(`Retry ${n}: ${err}`),
            }),
        );
        output.info(`Reply: ${JSON.stringify(reply)}`);
        vscode.window.showInformationMessage(`${config.model} answered with valid JSON.`);
      } catch (err) {
        output.error((err as Error).message);
        vscode.window.showErrorMessage(`Model test failed: ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("agentic.plan", async () => {
      const request = await vscode.window.showInputBox({
        prompt: "What should the agents do?",
        placeHolder: "Add a dark mode toggle to the settings page",
        ignoreFocusOut: true,
      });
      if (!request?.trim()) return;
      const config = readModelConfig();
      const provider = new OpenAICompatibleProvider(config);
      try {
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Planning with ${config.model}...`, cancellable: true },
          async (_progress, token) => {
            const abort = new AbortController();
            token.onCancellationRequested(() => abort.abort());
            const files = await vscode.workspace.findFiles("**/*", EXCLUDE, FILE_LIMIT);
            const paths = files.map((f) => vscode.workspace.asRelativePath(f, false));
            return planRequest(
              provider,
              { request, fileTree: paths.length ? fileTree(paths) : undefined },
              { signal: abort.signal, onAttempt: (n, err) => n > 0 && output.warn(`Plan retry ${n}: ${err}`) },
            );
          },
        );
        const run = await store.createRun(request);
        await store.addTasks(run.id, result.plan.tasks);
        for (const r of result.repairs) {
          await store.log({ runId: run.id, taskId: r.taskId, type: "plan_repair", message: `now waits for ${r.addedDependency}: ${r.reason}` });
        }
        const waves = parallelWaves(result.plan.tasks);
        output.info(`Planned ${result.plan.tasks.length} task(s) in ${waves.length} wave(s): ${waves.map((w) => `[${w.join(", ")}]`).join(" ")}`);
        if (result.droppedContext.length) output.warn(`Left out to fit the context window: ${result.droppedContext.join(", ")}`);
        tree.refresh();
        vscode.window.showInformationMessage(`Planned ${result.plan.tasks.length} task(s). See the Agentic Tasks view.`);
      } catch (err) {
        output.error((err as Error).message);
        vscode.window.showErrorMessage(`Planning failed: ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("agentic.showLog", async () => {
      const runs = await store.listRuns();
      output.info(`${runs.length} saved run(s) in ${context.globalStorageUri.fsPath}`);
      output.show();
    }),
  );
}

export function deactivate(): void {}
