import * as vscode from "vscode";
import { TaskStore } from "../state/taskStore";
import { Run, Task, TaskStatus } from "../state/types";

const ICONS: Record<TaskStatus, string> = {
  pending: "circle-outline",
  running: "sync~spin",
  verifying: "beaker",
  awaiting_approval: "question",
  done: "pass",
  failed: "error",
  cancelled: "circle-slash",
};

type Node = { kind: "run"; run: Run } | { kind: "task"; run: Run; task: Task };

/** Shows saved runs and their tasks, one node per run with its tasks below. */
export class TaskTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly store: TaskStore) {}

  refresh(): void {
    this.changed.fire();
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      const runs = await this.store.listRuns();
      return runs.map((run) => ({ kind: "run", run }));
    }
    if (node.kind === "run") {
      return node.run.tasks.map((task) => ({ kind: "task", run: node.run, task }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "run") {
      const done = node.run.tasks.filter((t) => t.status === "done").length;
      const item = new vscode.TreeItem(node.run.request, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${done}/${node.run.tasks.length} done`;
      item.iconPath = new vscode.ThemeIcon("list-tree");
      item.contextValue = "run";
      return item;
    }
    const { task } = node;
    const item = new vscode.TreeItem(task.title, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(ICONS[task.status]);
    item.description = task.dependsOn.length ? `after ${task.dependsOn.join(", ")}` : task.status;
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${task.title}** \`${task.id}\`\n\n`);
    tip.appendText(task.instructions);
    tip.appendMarkdown(`\n\n**Status:** ${task.status} · **Attempts:** ${task.attempts}`);
    tip.appendMarkdown(`\n\n**Files:** ${task.fileScope.map((f) => `\`${f}\``).join(", ")}`);
    if (task.error) tip.appendMarkdown(`\n\n**Error:** ${task.error}`);
    item.tooltip = tip;
    item.contextValue = "task";
    return item;
  }
}
