import * as vscode from "vscode";
import { z } from "zod";
import { readModelConfig } from "./config";
import { callStructured } from "./llm/structured";
import { OpenAICompatibleProvider } from "./providers/openaiCompatible";
import { TaskStore } from "./state/taskStore";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Agentic Code", { log: true });
  const store = new TaskStore(context.globalStorageUri.fsPath);

  context.subscriptions.push(
    output,
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
    vscode.commands.registerCommand("agentic.showLog", async () => {
      const runs = await store.listRuns();
      output.info(`${runs.length} saved run(s) in ${context.globalStorageUri.fsPath}`);
      output.show();
    }),
  );
}

export function deactivate(): void {}
