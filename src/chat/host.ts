import type { OversightLevel } from "../userSettings";
import { RunOutcome } from "../coordinator/orchestrator";
import { ModelProvider } from "../providers/types";
import { PendingChange, Task } from "../state/types";
import { CheckConfig } from "../checks/runner";
import { CommandSink } from "../checks/commandTerminal";
import { DetectedCheck } from "../checks/detect";
import { ToolCall } from "../tools/protocol";
import { AutoApprove } from "../tools/policy";
import { CoordinatorReply, InboxMessage } from "../worker/worker";
import { ReviewSkip, ReviewVerdict } from "../coordinator/review";
import { ChatMode } from "./types";

/** What the chat needs from VS Code. Kept small so the controller can be tested without it. */
export interface ChatHost {
  /** A provider built from the current settings, scoped to the conversation's folder. */
  provider(workspaceRoot?: string): ModelProvider;
  /** Short description of the model in use, shown in the chat. */
  modelLabel(workspaceRoot?: string): string;
  /** The workspace folder a new conversation's agents are confined to. */
  pickWorkspace(): Promise<string | undefined>;
  fileTree(workspaceRoot: string, signal: AbortSignal): Promise<string | undefined>;
  /** Runs a plan with sub-agents. Resolves undefined if the user declined to start it. */
  runPlan(runId: string, hooks: RunHooks): Promise<RunOutcome | undefined>;
  /**
   * Checks for a folder: the ones the user approved for it before (if any),
   * the defaults from settings, and suggestions from the project's files.
   */
  checksFor(workspaceRoot: string): Promise<{ saved?: CheckConfig[]; defaults: CheckConfig[]; detected: DetectedCheck[] }>;
  saveChecks(workspaceRoot: string, checks: CheckConfig[]): Promise<void>;
  /** The auto-approve switches. */
  permissions(): AutoApprove;
  setPermission(key: keyof AutoApprove, value: boolean): Promise<void>;
  /** How closely the coordinator watches its sub-agents (agentic.delegation.oversight, user settings only). */
  oversight?(): OversightLevel;
  /** Saves the oversight level in the user's settings. */
  setOversight?(level: OversightLevel): Promise<void>;
  cancelRun(runId: string): void;
  defaultMode(): ChatMode;
  setDefaultMode(mode: ChatMode): void;
  log(level: "info" | "warn" | "error", message: string): void;
  /** The real path of the folder if it is open in VS Code right now, else undefined. Research may only read there. */
  openFolder(workspaceRoot: string): Promise<string | undefined>;
  /** The extension's terminal for a project folder, where commands are shown as they run. */
  terminal?(workspaceRoot: string): CommandSink;
  /** Limits for read-only research sub-agents. */
  researchLimits(): { maxTurns: number; maxParallel: number };
  /** How heavily the coordinator may delegate. */
  delegationLimits(): {
    maxTasks: number;
    maxResearchers: number;
    maxResearchRounds?: number;
    checkIns?: number;
    progressEvery?: number;
    reviewRounds?: number;
    /** Most model calls one run may make (sub-agents and the coordinator's calls about them). 0 or unset: no limit. */
    maxModelCallsPerRun?: number;
    /** Whether the coordinator verifies a request before it calls it done. Unset: off. */
    verify?: boolean;
    /** Most fix-up rounds when verification finds work left (from agentic.delegation.oversight). */
    verifyRounds?: number;
  };
  /** Folders linked, not copied, into a scratch copy of the project, such as node_modules. */
  scratchLinkDirs?(workspaceRoot: string): string[];
  /** Most tokens of earlier conversation sent with each coordinator message. 0 or unset: as much as fits. */
  coordinatorHistoryTokens?(): number;
  /** Opens a pending change in VS Code: a new file as its own editor, an edit as a side-by-side diff. */
  showChange(runId: string, filePath: string): Promise<void>;
  /** Closes the editors showing a change once it is decided. */
  closeChange(runId: string, filePath: string): Promise<void>;
  /**
   * After drafts were written: opens the file itself when `open` is set, and
   * returns a warning for each file that an editor holds with unsaved edits,
   * since that editor still shows the old text.
   */
  afterAccept?(workspaceRoot: string, filePaths: string[], open: boolean): Promise<string[]>;
  /** Lets the user pick files to attach to a prompt. Returns paths relative to the folder, and only files inside it. */
  pickFiles?(workspaceRoot: string): Promise<string[]>;
}

/** How a run started from the chat talks back to the user. */
export interface RunHooks {
  /** The checks approved for this run. They replace the settings for it. */
  checks: CheckConfig[];
  approveTool: (task: Task, reason: string, call: ToolCall, preview?: string) => Promise<boolean>;
  /** Asked before every check command runs, unless commands are auto-approved. */
  approveCommand: (task: Task, check: CheckConfig) => Promise<boolean>;
  askUser: (task: Task, question: string) => Promise<string>;
  /** A sub-agent's question to the coordinator. The coordinator answers, or asks the user. */
  askCoordinator: (task: Task, question: string, signal: AbortSignal) => Promise<CoordinatorReply>;
  /** The coordinator reviews a sub-agent's result (its report and drafts as diffs) before it counts as done. */
  reviewResult?: (task: Task, summary: string, drafts: string, signal: AbortSignal, skip?: ReviewSkip) => Promise<ReviewVerdict>;
  inbox: (taskId: string) => InboxMessage[];
  /** Called once the run has started, with what the coordinator may do to its sub-agents while it supervises them. */
  attach?: (control: RunControl) => void;
  /** A task finished with file changes. They are pending until accepted here or by an auto-approve switch. */
  onChanges: (task: Task, changes: PendingChange[]) => Promise<void>;
  /** The model a sub-agent uses, wrapped so the chat can show its calls live. */
  wrapProvider?: (task: Task, provider: ModelProvider) => ModelProvider;
}

/** What the coordinator can do to a running sub-agent of a plan. */
export interface RunControl {
  /** Stops one sub-agent. Its drafts are kept for review. */
  cancelTask(taskId: string): boolean;
  /** A sub-agent's step budget. */
  maxTurns?: number;
}
