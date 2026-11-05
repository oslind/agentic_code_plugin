import { ChangeViews } from "./ui/changeViews";
import { promises as fs } from "fs";
import { relativeInside } from "./tools/paths";
import * as vscode from "vscode";
import { z } from "zod";
import { setExtraSecretPatterns } from "./tools/policy";
import { API_KEY_SECRET, createProvider, ignoredProjectSettings, readProtectedFiles, PERMISSION_KEYS, readCoordinatorHistoryTokens, readModelConfig, readOversightLimits, readPermissions, readRunConfig, setSecretApiKey } from "./config";
import { legacyApiKeyFrom, verificationFrom } from "./userSettings";
import { fileTree } from "./context/budget";
import { parallelWaves } from "./coordinator/plan";
import { planRequest } from "./coordinator/planner";
import { callStructured } from "./llm/structured";
import { OpenAICompatibleProvider } from "./providers/openaiCompatible";
import { RetryingProvider } from "./providers/retrying";
import { TaskStore } from "./state/taskStore";
import { WorkspaceSandbox } from "./tools/sandbox";
import { ChatController } from "./chat/chatController";
import { CheckConfig } from "./checks/runner";
import { DetectedCheck, detectChecks } from "./checks/detect";
import { ConversationStore } from "./chat/conversationStore";
import { ChatMode } from "./chat/types";
import { ChatViewProvider } from "./ui/chatView";
import { confinedFolder, offerResume, registerRunCommands } from "./ui/runCommands";
import { ProjectTerminals } from "./ui/projectTerminal";
import { TaskTreeProvider } from "./ui/taskTree";

const FILE_LIMIT = 2000;

function checksKey(root: string): string {
  return `agentic.checks:${root}`;
}

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

/**
 * Loads the API key from secret storage. An older version kept it in user
 * settings in plain text; that key is moved into secret storage and removed
 * from the settings file.
 */
async function loadApiKey(context: vscode.ExtensionContext, output: vscode.LogOutputChannel): Promise<void> {
  let key = await context.secrets.get(API_KEY_SECRET);
  const legacy = legacyApiKeyFrom(vscode.workspace.getConfiguration("agentic.model"));
  if (!key && legacy) {
    await context.secrets.store(API_KEY_SECRET, legacy);
    key = legacy;
    output.info("Moved the API key from agentic.model.apiKey in your settings into VS Code's secret storage.");
  }
  if (legacy) {
    await vscode.workspace
      .getConfiguration("agentic.model")
      .update("apiKey", undefined, vscode.ConfigurationTarget.Global)
      .then(undefined, (err: Error) => output.warn(`Could not remove agentic.model.apiKey from your settings: ${err.message}`));
  }
  setSecretApiKey(key);
}

/** Says, once per folder and session, that the project's own settings tried to change security settings and were ignored. */
function warnAboutProjectSettings(output: vscode.LogOutputChannel): vscode.Disposable {
  const warned = new Set<string>();
  const check = () => {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const keys = ignoredProjectSettings(folder.uri);
      const id = `${folder.uri.toString()}|${keys.join(",")}`;
      if (!keys.length || warned.has(id)) continue;
      warned.add(id);
      const message = `The project "${folder.name}" tries to set ${keys.join(", ")} in its own settings. Agentic Code ignores this: these settings only count in your user settings, so a project cannot approve work for you, redirect model requests, or raise the limits on model load, on how many model calls a run makes, and on how much of your conversation is sent.`;
      output.warn(message);
      void vscode.window.showWarningMessage(message);
    }
  };
  check();
  return vscode.Disposable.from(
    vscode.workspace.onDidChangeWorkspaceFolders(check),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentic.autoApprove") || e.affectsConfiguration("agentic.model") || e.affectsConfiguration("agentic.chat") || e.affectsConfiguration("agentic.delegation")) check();
    }),
  );
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Agentic Code", { log: true });
  void loadApiKey(context, output).catch((err) => output.warn(`Could not read the API key from secret storage: ${(err as Error).message}`));
  context.subscriptions.push(warnAboutProjectSettings(output));
  setExtraSecretPatterns(readProtectedFiles());
  const store = new TaskStore(context.globalStorageUri.fsPath);
  const tree = new TaskTreeProvider(store);

  const views = ChangeViews.register(context, store);
  const terminals = new ProjectTerminals();
  context.subscriptions.push(terminals);
  const runs = registerRunCommands(context, store, tree, output, views, terminals);

  const conversations = new ConversationStore(context.globalStorageUri.fsPath, () =>
    vscode.workspace.getConfiguration("agentic.chat").get<number>("historySize", 10),
  );
  const chat = new ChatController(conversations, store, {
    // Gateway errors (a 504 from a proxy) and brief outages are retried after a wait, as for runs.
    provider: (root) =>
      new RetryingProvider(createProvider(root ? vscode.Uri.file(root) : undefined, output), 3, 1000, (n, ms, err) =>
        output.warn(`Model request failed (${err.message.slice(0, 200)}). Trying again in ${Math.round(ms / 1000)} s (attempt ${n + 1}).`),
      ),
    coordinatorHistoryTokens: () => readCoordinatorHistoryTokens(),
    modelLabel: (root) => {
      const c = readModelConfig(root ? vscode.Uri.file(root) : undefined);
      // The version shows which build is installed, which helps when trying a new VSIX.
      return `${c.model} at ${c.baseUrl} · v${context.extension.packageJSON.version as string}`;
    },
    pickWorkspace: async () => (await pickWorkspaceFolder())?.uri.fsPath,
    // Only paths inside the conversation's folder can be attached, and only the paths are sent.
    pickFiles: async (root) => {
      const folder = await confinedFolder({ workspaceRoot: root }).catch(() => undefined);
      if (!folder) return [];
      const picked = await vscode.window.showOpenDialog({ defaultUri: folder.uri, canSelectMany: true, canSelectFiles: true, canSelectFolders: false, openLabel: "Attach" });
      return relativeInside(await fs.realpath(folder.uri.fsPath), (picked ?? []).map((u) => u.fsPath));
    },
    // The coordinator only ever sees the file list of a folder that is open right now.
    fileTree: async (root) => {
      const folder = await confinedFolder({ workspaceRoot: root }).catch(() => undefined);
      if (!folder) return undefined;
      const sandbox = await WorkspaceSandbox.create(folder.uri.fsPath);
      const paths = await sandbox.listFiles("**", FILE_LIMIT);
      return paths.length ? fileTree(paths) : undefined;
    },
    runPlan: (runId, hooks) => runs.start(runId, hooks),
    // Checks the user approved are kept per folder, so switching projects switches checks.
    checksFor: async (root) => {
      const folder = await confinedFolder({ workspaceRoot: root }).catch(() => undefined);
      const defaults = readRunConfig(folder?.uri).checks;
      const saved = context.workspaceState.get<CheckConfig[]>(checksKey(root));
      let detected: DetectedCheck[] = [];
      if (folder) {
        const sandbox = await WorkspaceSandbox.create(folder.uri.fsPath);
        const files = await sandbox.listFiles("**", FILE_LIMIT).catch(() => [] as string[]);
        detected = await detectChecks(files, (p) => sandbox.readFile(p).catch(() => undefined));
      }
      return { saved, defaults, detected };
    },
    permissions: () => readPermissions(),
    setPermission: async (key, value) => {
      if (!PERMISSION_KEYS.includes(key)) return;
      await vscode.workspace.getConfiguration("agentic.autoApprove").update(key, value, vscode.ConfigurationTarget.Global);
    },
    saveChecks: async (root, checks) => {
      await context.workspaceState.update(checksKey(root), checks);
      output.info(`Saved ${checks.length} check(s) for ${root}: ${checks.map((c) => `${c.name} = ${c.command}`).join("; ") || "none"}`);
    },
    cancelRun: (runId) => runs.cancel(runId),
    defaultMode: () =>
      context.globalState.get<ChatMode>("agentic.chatMode") ??
      vscode.workspace.getConfiguration("agentic.chat").get<ChatMode>("defaultMode", "plan"),
    setDefaultMode: (mode) => void context.globalState.update("agentic.chatMode", mode),
    log: (level, message) => output[level](message),
    openFolder: async (root) => (await confinedFolder({ workspaceRoot: root }).catch(() => undefined))?.uri.fsPath,
    showChange: (runId, filePath) => views.show(runId, filePath),
    closeChange: (runId, filePath) => views.close(runId, filePath),
    afterAccept: async (root, filePaths, open) => {
      const warnings: string[] = [];
      for (const rel of filePaths) {
        const uri = vscode.Uri.joinPath(vscode.Uri.file(root), ...rel.split("/"));
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === uri.fsPath);
        // VS Code reloads an open file that has no unsaved edits; one with unsaved edits keeps showing them.
        if (doc?.isDirty) warnings.push(`${rel} has unsaved edits in an editor, so that editor still shows your text, not the accepted draft. The draft is on disk: use "File: Revert File" to see it, or save to keep your version.`);
      }
      if (open && filePaths[0]) {
        const uri = vscode.Uri.joinPath(vscode.Uri.file(root), ...filePaths[0].split("/"));
        await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true }).then(undefined, (err) => output.warn(`Could not open ${filePaths[0]}: ${(err as Error).message}`));
      }
      return warnings;
    },
    delegationLimits: () => {
      const c = vscode.workspace.getConfiguration("agentic.delegation");
      return {
        maxTasks: c.get<number>("maxTasks", 12),
        maxResearchers: c.get<number>("maxResearchers", 8),
        maxResearchRounds: c.get<number>("maxResearchRounds", 3),
        // These add model calls on their own, so only user settings count (a project cannot raise them).
        ...readOversightLimits(),
        ...verificationFrom(c),
      };
    },
    scratchLinkDirs: (workspaceRoot) => readRunConfig(vscode.Uri.file(workspaceRoot)).linkDirs,
    terminal: (workspaceRoot) => terminals.for(workspaceRoot),
    researchLimits: () => {
      const c = readRunConfig();
      return { maxTurns: Math.min(c.maxTurns, 30), maxParallel: c.maxParallel };
    },
  });
  const chatView = new ChatViewProvider(context.extensionUri, chat, store, output);
  void offerResume(store).catch((err) => output.warn(`Could not check for interrupted runs: ${(err as Error).message}`));
  context.subscriptions.push(
    output,
    { dispose: () => chat.dispose() },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentic.protectedFiles")) setExtraSecretPatterns(readProtectedFiles());
      if (e.affectsConfiguration("agentic.autoApprove")) chat.settingsChanged();
      if (!e.affectsConfiguration("agentic.model")) return;
      // The user may have switched model or server; try the configured format again.
      OpenAICompatibleProvider.resetFallbacks();
      const c = readModelConfig();
      output.info(`Model settings changed: now ${c.model} at ${c.baseUrl} (${c.source})`);
      chat.settingsChanged();
    }),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("agentic.newTask", () => chatView.focus(true)),
    vscode.commands.registerCommand("agentic.editChecks", async () => {
      await chatView.focus();
      await chat.editChecks();
    }),
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
    context.secrets.onDidChange(async (e) => {
      if (e.key !== API_KEY_SECRET) return;
      setSecretApiKey(await context.secrets.get(API_KEY_SECRET));
      chat.settingsChanged();
    }),
    vscode.commands.registerCommand("agentic.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        prompt: `API key for ${readModelConfig().baseUrl}. It is kept in VS Code's secret storage, not in a settings file. Leave empty to remove the key.`,
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) return;
      if (key.trim()) await context.secrets.store(API_KEY_SECRET, key.trim());
      else await context.secrets.delete(API_KEY_SECRET);
      setSecretApiKey(key);
      vscode.window.showInformationMessage(key.trim() ? "API key saved in secret storage." : "API key removed.");
    }),
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
              {
                request,
                fileTree: paths.length ? fileTree(paths) : undefined,
                maxTasks: vscode.workspace.getConfiguration("agentic.delegation").get<number>("maxTasks", 12),
              },
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
