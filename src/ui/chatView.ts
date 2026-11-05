import { randomBytes } from "crypto";
import * as vscode from "vscode";
import { ChatController, Decision } from "../chat/chatController";
import { checkLink } from "../chat/links";
import { PERMISSION_KEYS } from "../config";
import { TaskStore } from "../state/taskStore";
import { OVERSIGHT_LEVELS, type OversightLevel } from "../userSettings";
import { ConflictChoice } from "../state/types";

/** Messages the webview may send. Anything else is ignored. */
type FromView =
  | { type: "ready" }
  | { type: "send"; text: string; attachments?: unknown }
  | { type: "attach" }
  | { type: "newTask" }
  | { type: "compact" }
  | { type: "setMode"; mode: "plan" | "act" }
  | { type: "open"; id: string }
  | { type: "delete"; id: string }
  | { type: "runPlan"; runId: string }
  | { type: "resumeRun"; runId: string }
  | { type: "cancel" }
  | { type: "settings" }
  | { type: "runCommand"; command: "showTaskLog" | "retryFailed"; runId: string }
  | { type: "review"; runId: string; action: "show" | "open" | "accept" | "reject" | "resolve" | "revert"; path?: string; taskId?: string; choice?: ConflictChoice }
  | { type: "decide"; entryId: string; decision: unknown }
  | { type: "messageAgent"; runId: string; taskId: string; text: string }
  | { type: "endAgentChat"; runId: string; taskId: string }
  | { type: "setPermission"; key: string; value: boolean }
  | { type: "setOversight"; level: string }
  | { type: "editChecks" }
  | { type: "openLink"; url: string };

const RUN_COMMANDS = new Set(["showTaskLog", "retryFailed"]);
const REVIEW_ACTIONS = new Set(["show", "open", "accept", "reject", "resolve", "revert"]);
const CONFLICT_CHOICES = new Set(["other", "draft", "both"]);
/** A workspace-relative path as the page sends it back. The store only holds paths the policy already accepted. */
const isRelPath = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length < 1000 && !x.startsWith("/") && !x.split("/").includes("..");

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
    // Live model output goes on its own small message: a full state push for every few tokens would be far too heavy.
    controller.live.onChange(() => {
      if (this.view?.visible) void this.view.webview.postMessage({ type: "live", live: controller.live.snapshot() }).then(undefined, () => undefined);
    });
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
          if (typeof m.text === "string") {
            const attachments = Array.isArray(m.attachments) ? m.attachments.filter(isRelPath).slice(0, 20) : [];
            await this.controller.send(m.text.slice(0, 20000), attachments);
          }
          return;
        case "attach": {
          const paths = await this.controller.pickAttachments();
          void this.view?.webview.postMessage({ type: "attached", paths });
          return;
        }
        case "newTask":
          return this.controller.newTask();
        case "compact":
          return this.controller.compact();
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
        case "resumeRun":
          if (isId(m.runId)) await this.controller.resumeRun(m.runId);
          return;
        case "cancel":
          return this.controller.cancel();
        case "settings":
          await vscode.commands.executeCommand("agentic.openSettings");
          return;
        case "decide": {
          const d = parseDecision(m.decision);
          if (isId(m.entryId) && d) await this.controller.decide(m.entryId, d);
          return;
        }
        case "messageAgent":
          if (isId(m.runId) && isId(m.taskId) && typeof m.text === "string") await this.controller.messageAgent(m.runId, m.taskId, m.text.slice(0, 4000));
          return;
        case "endAgentChat":
          if (isId(m.runId) && isId(m.taskId)) await this.controller.endAgentChat(m.runId, m.taskId);
          return;
        case "setPermission":
          if ((PERMISSION_KEYS as readonly string[]).includes(m.key) && typeof m.value === "boolean") {
            await this.controller.setPermission(m.key as (typeof PERMISSION_KEYS)[number], m.value);
          }
          return;
        case "setOversight":
          if ((OVERSIGHT_LEVELS as readonly string[]).includes(m.level)) await this.controller.setOversight(m.level as OversightLevel);
          return;
        case "editChecks":
          await this.controller.editChecks();
          return;
        case "openLink":
          return this.openLink(m.url);
        case "review":
          if (
            isId(m.runId) &&
            REVIEW_ACTIONS.has(m.action) &&
            (m.path === undefined || isRelPath(m.path)) &&
            (m.taskId === undefined || isId(m.taskId)) &&
            (m.action !== "resolve" || (m.path !== undefined && CONFLICT_CHOICES.has(m.choice as string)))
          ) {
            await this.controller.review(m.runId, m.action, m.path, m.taskId, m.action === "resolve" ? m.choice : undefined);
          }
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

  /**
   * Opens a link from a model reply only after the user has seen where it really goes: the
   * link text is written by the model, so the dialog names the host and the full address and
   * warns about local, private and other unusual destinations.
   */
  private async openLink(raw: unknown): Promise<void> {
    const link = checkLink(raw);
    if (!link) return;
    const detail = [
      `Site: ${link.host}`,
      `Full address: ${link.url}`,
      "",
      "The link comes from a model reply. Its text may not match where it goes.",
      ...link.warnings.map((w) => `⚠ ${w}`),
    ].join("\n");
    const open = "Open in browser";
    const copy = "Copy address";
    const pick = await vscode.window.showWarningMessage(link.warnings.length ? "Open this link? Check the address first." : "Open this link?", { modal: true, detail }, open, copy);
    if (pick === open) {
      this.output.info(`Opening a link from a reply: ${link.url}`);
      await vscode.env.openExternal(vscode.Uri.parse(link.url, true));
    } else if (pick === copy) {
      await vscode.env.clipboard.writeText(link.url);
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString("base64");
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.js"));
    const md = webview.asWebviewUri(vscode.Uri.joinPath(media, "markdown.js"));
    const hl = webview.asWebviewUri(vscode.Uri.joinPath(media, "highlight.js"));
    // Model output is never inserted as HTML (markdown is built as DOM nodes); the page cannot load anything but its own files.
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
<script nonce="${nonce}" src="${md}"></script>
<script nonce="${nonce}" src="${hl}"></script>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

/** Checks a decision from the page. Commands become checks, so their shape is validated strictly. */
function parseDecision(x: unknown): Decision | undefined {
  if (!x || typeof x !== "object") return undefined;
  const d = x as Record<string, unknown>;
  switch (d.kind) {
    case "skip":
    case "deny":
      return { kind: d.kind };
    case "allow":
      return { kind: "allow", remember: d.remember === true };
    case "answer":
      return typeof d.text === "string" && d.text.trim() ? { kind: "answer", text: d.text.slice(0, 4000) } : undefined;
    case "checks": {
      if (!Array.isArray(d.checks)) return undefined;
      const checks = d.checks
        .filter((c): c is { name: string; command: string } => !!c && typeof c.name === "string" && typeof c.command === "string")
        .map((c) => ({ name: c.name.trim().slice(0, 40), command: c.command.trim().slice(0, 500) }))
        .filter((c) => c.name && c.command)
        .slice(0, 20);
      return { kind: "checks", checks, remember: d.remember !== false };
    }
    default:
      return undefined;
  }
}
