/**
 * Plan mode only discusses and proposes plans. Act mode also starts
 * sub-agents to carry plans out. In both modes the coordinator itself never
 * touches files: every change is delegated to a sub-agent with a file scope.
 */
export type ChatMode = "plan" | "act";

export type ChatAuthor = "user" | "coordinator" | "agent" | "system";

export interface ChatEntry {
  id: string;
  time: string;
  author: ChatAuthor;
  text: string;
  /** What the entry shows besides its text. A plan or outcome entry refers to a run. */
  kind?: "message" | "plan" | "outcome" | "error" | "spawn" | "report" | "research" | "answer" | "checks" | "approval" | "question" | "direct" | "review" | "consult" | "checkin" | "command";
  runId?: string;
  /** For agent entries: the task the sub-agent works on. */
  taskId?: string;
  agentName?: string;
  /** Short label such as the tool a sub-agent called. */
  tag?: string;
  tone?: "info" | "success" | "warning" | "error";
  /** The agent's own one-line reason for what it did. */
  thought?: string;
  /** Set on a coordinator reply that stopped before it was complete. Shown as "cut off", never as a finished answer. */
  cutOff?: boolean;
  /** The model's full thinking for this step, when it produced any. Shown collapsed. */
  thinking?: string;
  /** For a checks card: the proposed or chosen verification commands. */
  checks?: { name: string; command: string; source?: string }[];
  /** For an approval card: whether a second "allow and remember" button is offered. */
  rememberable?: boolean;
  /** For an approval card: the label of that button. */
  rememberLabel?: string;
  /** For an approval card: the file change waiting for approval, as removed (-) and added (+) lines. */
  preview?: string;
  /** For a run summary: what can be applied or retried. */
  outcome?: { changedFiles: string[]; failed: number };
  /**
   * For the coordinator's answer to a sub-agent (kind "consult"), or a
   * question it passed on to the user: the sub-agent's question.
   */
  quote?: string;
  /** For a command entry: the command that ran, and the end of its output as plain text. The terminal has all of it. */
  command?: { line: string; output: string };
  /** For a card that waits on the user: what was decided, once it was. */
  decided?: string;
}

export interface Conversation {
  id: string;
  title: string;
  /** The only folder this conversation's agents may work in. */
  workspaceRoot: string;
  mode: ChatMode;
  createdAt: string;
  updatedAt: string;
  entries: ChatEntry[];
  /** Runs (plans) created in this conversation, oldest first. */
  runIds: string[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  workspaceRoot: string;
}
