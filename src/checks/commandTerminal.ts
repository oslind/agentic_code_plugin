import * as path from "path";

/**
 * Where commands show up while they run. The extension puts them in its own
 * VS Code terminal, opened at the project folder, so the user sees every
 * command, the folder it runs in and its output. The process itself is still
 * started by the extension, with an explicit working folder inside the project:
 * whatever folder another terminal is in never matters, and Stop can end it.
 */
export interface CommandSink {
  /** Called when a command starts. The returned view receives its output and its result. */
  start(command: string, cwd: string): CommandView;
}

export interface CommandView {
  output(chunk: string): void;
  end(result: CommandEnd): void;
  /** Aborts when the user presses Ctrl+C in the terminal or closes it. */
  signal?: AbortSignal;
}

export interface CommandEnd {
  code: number | null;
  timedOut?: boolean;
  stopped?: boolean;
  /** Set when the command could not start or was refused. */
  error?: string;
  durationMs: number;
}

/** The part of a VS Code terminal the pool needs, so it can be tested without VS Code. */
export interface TerminalScreen {
  write(text: string): void;
  show(): void;
  dispose(): void;
}

export interface ScreenEvents {
  /** The user pressed Ctrl+C in the terminal. */
  onInterrupt(): void;
  /** The user closed the terminal. */
  onClose(): void;
}

export type ScreenFactory = (name: string, events: ScreenEvents) => TerminalScreen;

/** Terminals expect \r\n; child processes print \n. */
export function toTerminalText(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

/** How a folder is shown in the terminal: relative to the project, since that is the only place commands run. */
export function shownFolder(projectRoot: string, cwd: string): string {
  const rel = path.relative(projectRoot, cwd);
  if (!rel) return path.basename(projectRoot) || projectRoot;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return cwd;
  return `${path.basename(projectRoot)}/${rel.split(path.sep).join("/")}`;
}

const SCRATCH = /(^|\/)\.agentic\/scratch(\/|$)/;

export function commandHeader(projectRoot: string, cwd: string, command: string): string {
  const folder = shownFolder(projectRoot, cwd);
  const note = SCRATCH.test(folder) ? "\x1b[2m  (a copy of the project with the pending changes; your files are not touched)\x1b[0m\r\n" : "";
  return `\x1b[1;36m${folder}\x1b[0m\r\n${note}\x1b[1m$ ${command}\x1b[0m\r\n`;
}

export function commandFooter(end: CommandEnd): string {
  const secs = `${(end.durationMs / 1000).toFixed(1)}s`;
  if (end.error) return `\x1b[31m${toTerminalText(end.error)}\x1b[0m\r\n\r\n`;
  if (end.stopped) return `\x1b[33mStopped after ${secs}.\x1b[0m\r\n\r\n`;
  if (end.timedOut) return `\x1b[31mTimed out after ${secs}.\x1b[0m\r\n\r\n`;
  if (end.code === 0) return `\x1b[32mPassed in ${secs}.\x1b[0m\r\n\r\n`;
  return `\x1b[31mFailed (exit code ${end.code ?? "none"}) after ${secs}.\x1b[0m\r\n\r\n`;
}

interface Slot {
  screen?: TerminalScreen;
  name: string;
  busy?: AbortController;
}

/**
 * The extension's own terminals for one project. A command goes to a free
 * terminal, and a new one is opened only when all are busy, so parallel
 * sub-agents never mix their output.
 */
export class CommandTerminals implements CommandSink {
  private readonly slots: Slot[] = [];

  constructor(
    private readonly projectRoot: string,
    private readonly create: ScreenFactory,
    private readonly baseName = "Agentic Code",
  ) {}

  start(command: string, cwd: string): CommandView {
    const slot = this.freeSlot();
    const abort = new AbortController();
    slot.busy = abort;
    const screen = this.screenFor(slot);
    screen.show();
    screen.write(commandHeader(this.projectRoot, cwd, command));
    let ended = false;
    return {
      signal: abort.signal,
      output: (chunk) => {
        if (!ended) slot.screen?.write(toTerminalText(chunk));
      },
      end: (result) => {
        if (ended) return;
        ended = true;
        slot.screen?.write(commandFooter(result));
        if (slot.busy === abort) slot.busy = undefined;
      },
    };
  }

  /** Terminals currently open, for tests and for disposing. */
  get open(): number {
    return this.slots.filter((s) => s.screen).length;
  }

  dispose(): void {
    for (const s of this.slots) {
      s.busy?.abort();
      s.screen?.dispose();
      s.screen = undefined;
    }
    this.slots.length = 0;
  }

  private freeSlot(): Slot {
    const free = this.slots.find((s) => !s.busy);
    if (free) return free;
    const name = this.slots.length === 0 ? this.baseName : `${this.baseName} (${this.slots.length + 1})`;
    const slot: Slot = { name };
    this.slots.push(slot);
    return slot;
  }

  private screenFor(slot: Slot): TerminalScreen {
    if (slot.screen) return slot.screen;
    slot.screen = this.create(slot.name, {
      onInterrupt: () => slot.busy?.abort(),
      onClose: () => {
        // Closing the terminal stops what runs in it; the next command opens it again.
        slot.busy?.abort();
        slot.screen = undefined;
      },
    });
    return slot.screen;
  }
}
