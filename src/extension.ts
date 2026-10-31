import * as vscode from "vscode";
import { z } from "zod";
import { createProvider, readModelConfig } from "./config";
import { fileTree } from "./context/budget";
import { parallelWaves } from "./coordinator/plan";
import { planRequest } from "./coordinator/planner";
import { callStructured } from "./llm/structured";
import { OpenAICompatibleProvider } from "./providers/openaiCompatible";
import { TaskStore } from "./state/taskStore";
import { WorkspaceSandbox } from "./tools/sandbox";
import { ChatController } from "./chat/chatController";
import { ConversationStore } from "./chat/conversationStore";
import { ChatMode } from "./chat/types";
import { ChatViewProvider } from "./ui/chatView";
import { confinedFolder, offerResume, registerRunCommands } from "./ui/runCommands";
import { TaskTreeProvider } from "./ui/taskTree";

const FILE_LIMIT = 2000;

/**
 * Agents may only work inside the folder open in VS Code. With several
 * folders open, the user picks one, and the run is confined to it.
 */
async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file");
  if (folders.length === 0) {
    vscode.window.showErrorMessage("Open a project folder first. Agents can only work inside the open folder.");
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  return vscode.window.showWorkspaceFolderPick({ placeHolder: "Which folder may the agents work in?" });
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Agentic Code", { log: true });
  const store = new TaskStore(context.globalStorageUri.fsPath);
  const tree = new TaskTreeProvider(store);

  const runs = registerRunCommands(context, store, tree, output);

  const conversations = new ConversationStore(context.globalStorageUri.fsPath, () =>
    vscode.workspace.getConfiguration("agentic.chat").get<number>("historySize", 10),
  );
  const chat = new ChatController(conversations, store, {
    provider: (root) => createProvider(root ? vscode.Uri.file(root) : undefined, output),
    modelLabel: (root) => {
      const c = readModelConfig(root ? vscode.Uri.file(root) : undefined);
      return `${c.model} at ${c.baseUrl}`;
    },
    pickWorkspace: async () => (await pickWorkspaceFolder())?.uri.fsPath,
    // The coordinator only ever sees the file list of a folder that is open right now.
    fileTree: async (root) => {
      const folder = await confinedFolder({ workspaceRoot: root }).catch(() => undefined);
      if (!folder) return undefined;
      const sandbox = await WorkspaceSandbox.create(folder.uri.fsPath);
      const paths = await sandbox.listFiles("**", FILE_LIMIT);
      return paths.length ? fileTree(paths) : undefined;
    },
    runPlan: (runId) => runs.start(runId),
    cancelRun: (runId) => runs.cancel(runId),
    defaultMode: () =>
      context.globalState.get<ChatMode>("agentic.chatMode") ??
      vscode.workspace.getConfiguration("agentic.chat").get<ChatMode>("defaultMode", "plan"),
    setDefaultMode: (mode) => void context.globalState.update("agentic.chatMode", mode),
    log: (level, message) => output[level](message),
  });
  const chatView = new ChatViewProvider(context.extensionUri, chat, store, output);
  void offerResume(store).catch((err) => output.warn(`Could not check for interrupted runs: ${(err as Error).message}`));
  context.subscriptions.push(
    output,
    { dispose: () => chat.dispose() },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("agentic.model")) return;
      // The user may have switched model or server; try the configured format again.
      OpenAICompatibleProvider.resetFallbacks();
      const c = readModelConfig();
      output.info(`Model settings changed: now ${c.model} at ${c.baseUrl} (${c.source})`);
      chat.settingsChanged();
    }),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("agentic.newTask", () => chatView.focus(true)),
    vscode.commands.registerCommand("agentic.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${context.extension.id}`),
    ),
    vscode.commands.registerCommand("agentic.showHistory", async () => {
      const list = await conversations.list();
      const pick = await vscode.window.showQuickPick(
        [
          { label: "$(add) New task", id: "" },
          ...list.map((c) => ({ label: c.title, description: new Date(c.updatedAt).toLocaleString(), detail: c.workspaceRoot, id: c.id })),
        ],
        { placeHolder: "Switch conversation" },
      );
      if (!pick) return;
      if (pick.id) await chat.open(pick.id);
      await chatView.focus(!pick.id);
    }),
    vscode.window.registerTreeDataProvider("agentic.tasks", tree),
    vscode.commands.registerCommand("agentic.refreshTasks", () => tree.refresh()),
    vscode.commands.registerCommand("agentic.testModelConnection", async () => {
      const config = readModelConfig();
      const provider = createProvider(undefined, output);
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
      const folder = await pickWorkspaceFolder();
      if (!folder) return;
      const config = readModelConfig(folder.uri);
      const provider = createProvider(folder.uri, output);
      try {
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Planning with ${config.model}...`, cancellable: true },
          async (_progress, token) => {
            const abort = new AbortController();
            token.onCancellationRequested(() => abort.abort());
            const sandbox = await WorkspaceSandbox.create(folder.uri.fsPath);
            const paths = await sandbox.listFiles("**", FILE_LIMIT);
            return planRequest(
              provider,
              { request, fileTree: paths.length ? fileTree(paths) : undefined },
              { signal: abort.signal, onAttempt: (n, err) => n > 0 && output.warn(`Plan retry ${n}: ${err}`) },
            );
          },
        );
        const run = await store.createRun(request, folder.uri.fsPath);
        await store.addTasks(run.id, result.plan.tasks);
        for (const r of result.repairs) {
          await store.log({ runId: run.id, taskId: r.taskId, type: "plan_repair", message: `now waits for ${r.addedDependency}: ${r.reason}` });
        }
        const waves = parallelWaves(result.plan.tasks);
        output.info(`Planned ${result.plan.tasks.length} task(s) in ${waves.length} wave(s): ${waves.map((w) => `[${w.join(", ")}]`).join(" ")}`);
        if (result.droppedContext.length) output.warn(`Left out to fit the context window: ${result.droppedContext.join(", ")}`);
        tree.refresh();
        const next = await vscode.window.showInformationMessage(`Planned ${result.plan.tasks.length} task(s). Review them in the Agentic view.`, "Run now");
        if (next === "Run now") await vscode.commands.executeCommand("agentic.runPlan", { kind: "run", run: await store.load(run.id) });
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
