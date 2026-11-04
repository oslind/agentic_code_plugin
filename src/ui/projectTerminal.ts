import { realpathSync } from "fs";
import * as vscode from "vscode";
import { CommandTerminals, ScreenEvents, TerminalScreen } from "../checks/commandTerminal";

/**
 * Opens one of the extension's own terminals. It is not a shell: it shows the
 * commands the extension runs inside the project and their output. Ctrl+C in
 * it stops the running command, and closing it does too.
 */
function openScreen(name: string, projectRoot: string, events: ScreenEvents): TerminalScreen {
  const write = new vscode.EventEmitter<string>();
  let opened = false;
  let early = "";
  let disposed = false;
  const pty: vscode.Pseudoterminal = {
    onDidWrite: write.event,
    open: () => {
      opened = true;
      write.fire(`\x1b[2mCommands from Agentic Code run here, inside ${projectRoot}. Ctrl+C stops the running command.\x1b[0m\r\n\r\n${early}`);
      early = "";
    },
    close: () => {
      if (disposed) return;
      disposed = true;
      events.onClose();
      write.dispose();
    },
    handleInput: (data) => {
      if (data === "\x03") events.onInterrupt();
    },
  };
  const terminal = vscode.window.createTerminal({ name, pty, iconPath: new vscode.ThemeIcon("terminal") });
  return {
    // Text written before VS Code opens the terminal would be lost, so it waits.
    write: (text) => {
      if (disposed) return;
      if (opened) write.fire(text);
      else early += text;
    },
    show: () => terminal.show(true),
    dispose: () => {
      disposed = true;
      terminal.dispose();
      write.dispose();
    },
  };
}

/** One set of terminals per project folder, created when the first command runs. */
export class ProjectTerminals implements vscode.Disposable {
  private readonly byRoot = new Map<string, CommandTerminals>();

  for(folder: string): CommandTerminals {
    let projectRoot = folder;
    try {
      projectRoot = realpathSync(folder);
    } catch {
      // Not on disk any more; show paths as given.
    }
    let t = this.byRoot.get(projectRoot);
    if (!t) {
      const label = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1 ? `Agentic Code: ${projectRoot.split(/[\\/]/).pop()}` : "Agentic Code";
      t = new CommandTerminals(projectRoot, (name, events) => openScreen(name, projectRoot, events), label);
      this.byRoot.set(projectRoot, t);
    }
    return t;
  }

  dispose(): void {
    for (const t of this.byRoot.values()) t.dispose();
    this.byRoot.clear();
  }
}
