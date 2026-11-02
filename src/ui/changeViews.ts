import * as vscode from "vscode";
import { changeKind } from "../changes/review";
import { TaskStore } from "../state/taskStore";
import { PendingChange } from "../state/types";

export const CHANGE_SCHEME = "agentic-change";

/**
 * Shows pending changes in VS Code without writing them: a new file opens as
 * its own read-only editor, and a change to an existing file opens the
 * side-by-side diff (the file as it was on the left, the proposal on the right).
 */
export class ChangeViews implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly store: TaskStore) {}

  static register(context: vscode.ExtensionContext, store: TaskStore): ChangeViews {
    const views = new ChangeViews(store);
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(CHANGE_SCHEME, views));
    return views;
  }

  private uri(runId: string, filePath: string, side: "original" | "proposed"): vscode.Uri {
    // The file name stays last in the path so VS Code picks the right language and tab title.
    return vscode.Uri.from({ scheme: CHANGE_SCHEME, path: `/${filePath}`, query: new URLSearchParams({ run: runId, side }).toString() });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = new URLSearchParams(uri.query);
    const runId = q.get("run") ?? "";
    const filePath = uri.path.replace(/^\//, "");
    const change = await this.find(runId, filePath);
    if (!change) return "";
    return q.get("side") === "original" ? (change.original ?? "") : change.proposed;
  }

  private async find(runId: string, filePath: string): Promise<PendingChange | undefined> {
    const run = await this.store.load(runId).catch(() => undefined);
    const all = (run?.changes ?? []).filter((c) => c.path === filePath);
    return all.find((c) => c.status === "pending") ?? all.at(-1);
  }

  /** Opens the change. `preview` keeps several opened at once from replacing each other when false. */
  async show(runId: string, filePath: string, preview = false): Promise<void> {
    const change = await this.find(runId, filePath);
    if (!change) throw new Error(`No change to ${filePath} in this run.`);
    const proposed = this.uri(runId, filePath, "proposed");
    this.changed.fire(proposed);
    if (changeKind(change) === "new") {
      const doc = await vscode.workspace.openTextDocument(proposed);
      await vscode.window.showTextDocument(doc, { preview, preserveFocus: true });
      return;
    }
    const original = this.uri(runId, filePath, "original");
    this.changed.fire(original);
    await vscode.commands.executeCommand("vscode.diff", original, proposed, `${filePath} (proposed change)`, { preview, preserveFocus: true });
  }

  /** Closes the editors showing a change, once it is accepted or rejected. */
  async close(runId: string, filePath: string): Promise<void> {
    const want = new Set([this.uri(runId, filePath, "proposed").toString(), this.uri(runId, filePath, "original").toString()]);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => {
      const input = t.input;
      if (input instanceof vscode.TabInputText) return want.has(input.uri.toString());
      if (input instanceof vscode.TabInputTextDiff) return want.has(input.modified.toString());
      return false;
    });
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
  }
}
