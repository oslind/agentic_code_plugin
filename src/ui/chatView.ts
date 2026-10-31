import { randomBytes } from "crypto";
import * as vscode from "vscode";
import { ChatController } from "../chat/chatController";
import { TaskStore } from "../state/taskStore";

/** Messages the webview may send. Anything else is ignored. */
type FromView =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "newTask" }
  | { type: "setMode"; mode: "plan" | "act" }
  | { type: "open"; id: string }
  | { type: "delete"; id: string }
  | { type: "runPlan"; runId: string }
  | { type: "cancel" }
  | { type: "settings" }
  | { type: "runCommand"; command: "applyRun" | "showTaskLog" | "retryFailed" | "cleanupRun"; runId: string };

const RUN_COMMANDS = new Set(["applyRun", "showTaskLog", "retryFailed", "cleanupRun"]);

function isId(x: unknown): x is string {
  return typeof x === "string" && /^[\w-]{1,100}$/.test(x);
}

/**
 * The chat sidebar: an input at the top, then the conversation with the
 * coordinator and its sub-agents. The page only renders state and sends user
 * actions; everything else happens in ChatController.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "agentic.chat";
  private view?: vscode.WebviewView;
  private pending?: NodeJS.Timeout;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
    private readonly store: TaskStore,
    private readonly output: vscode.LogOutputChannel,
  ) {
    controller.onChange(() => this.schedulePush());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m: unknown) => void this.handle(m as FromView));
    view.onDidChangeVisibility(() => view.visible && this.schedulePush());
    view.onDidDispose(() => (this.view = undefined));
  }

  /** Puts the cursor in the input box, starting a new conversation if asked. */
  async focus(newTask = false): Promise<void> {
    if (newTask) this.controller.newTask();
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    void this.view?.webview.postMessage({ type: "focusInput" });
  }

  private schedulePush(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      void this.push();
    }, 60);
  }

  private async push(): Promise<void> {
    if (!this.view) return;
    try {
      await this.view.webview.postMessage({ type: "state", state: await this.controller.state() });
    } catch (err) {
      this.output.warn(`Could not update the chat view: ${(err as Error).message}`);
    }
  }

  private async handle(m: FromView): Promise<void> {
    try {
      switch (m?.type) {
        case "ready":
          return this.push();
        case "send":
          if (typeof m.text === "string") await this.controller.send(m.text.slice(0, 20000));
          return;
        case "newTask":
          return this.controller.newTask();
        case "setMode":
          if (m.mode === "plan" || m.mode === "act") await this.controller.setMode(m.mode);
          return;
        case "open":
          if (isId(m.id)) await this.controller.open(m.id);
          return;
        case "delete":
          if (isId(m.id)) await this.controller.delete(m.id);
          return;
        case "runPlan":
          if (isId(m.runId)) await this.controller.runPlan(m.runId);
          return;
        case "cancel":
          return this.controller.cancel();
        case "settings":
          await vscode.commands.executeCommand("agentic.openSettings");
          return;
        case "runCommand":
          if (RUN_COMMANDS.has(m.command) && isId(m.runId)) {
            const run = await this.store.load(m.runId);
            await vscode.commands.executeCommand(`agentic.${m.command}`, { kind: "run", run });
          }
          return;
      }
    } catch (err) {
      this.output.error((err as Error).message);
      vscode.window.showErrorMessage((err as Error).message);
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString("base64");
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.js"));
    // Model output is shown as text only; the page cannot load anything but its own files.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Agentic chat</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
