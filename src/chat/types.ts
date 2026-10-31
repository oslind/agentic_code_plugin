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
  kind?: "message" | "plan" | "outcome" | "error";
  runId?: string;
  /** For agent entries: the task the sub-agent works on. */
  taskId?: string;
  agentName?: string;
  /** Short label such as the tool a sub-agent called. */
  tag?: string;
  tone?: "info" | "success" | "warning" | "error";
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
