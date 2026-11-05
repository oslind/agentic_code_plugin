import { z } from "zod";
import { estimateTokens, truncateToTokens } from "../context/budget";
import { dataBlock, DATA_REMINDER, DATA_RULE, untrustedSection } from "../context/untrusted";
import { callStructured } from "../llm/structured";
import { ChatMessage, ModelProvider } from "../providers/types";
import { RunEvent, Task } from "../state/types";

/**
 * How the coordinator keeps tabs on its sub-agents. Every step a sub-agent
 * logs is observed here, without any model call. When a step pattern looks
 * like trouble (going in circles, blocked by the rules, many steps without a
 * draft, checks that keep failing, guessing instead of asking), the
 * coordinator looks at the sub-agent with one model call and decides to let it
 * be, send it a note, or stop it. Besides trouble, it also reads each
 * sub-agent's progress every few steps (its thoughts are its progress
 * reports), and right after another sub-agent finishes, so it can pass on what
 * the sub-agent does not know: research findings, what the others found or
 * changed. Small models rarely ask on their own, so the coordinator comes to them.
 */

export type ConcernKind = "looping" | "blocked" | "no_progress" | "checks_failing" | "guessing" | "progress";

export interface Concern {
  kind: ConcernKind;
  /**
   * Plain words, shown to the user and to the coordinator model as its own
   * observation. Built only from fixed wording and counts, never from
   * anything a sub-agent wrote, so it is trusted.
   */
  detail: string;
  /**
   * What the sub-agent did that shows it, such as the call it repeated. Its
   * arguments came from a model that may have read planted text, so this is
   * untrusted and only ever passed to a model inside a data fence.
   */
  evidence?: string;
}

export const CONCERN_LABEL: Record<ConcernKind, string> = {
  looping: "going in circles",
  blocked: "blocked by the rules",
  no_progress: "many steps without progress",
  checks_failing: "checks keep failing",
  guessing: "guessing instead of asking",
  progress: "regular progress check",
};

/** A thought that says the sub-agent is about to assume or guess, instead of asking the coordinator. */
const GUESSING = /\b(i'?ll assume|i will assume|i assume|assuming|let'?s assume|i'?m not sure|i am not sure|not sure (what|which|whether|if|how)|unclear (what|which|whether|if|how)|i guess|i don'?t know (what|which|whether|if|how))\b/i;

interface Step {
  key: string;
  label: string;
  thought?: string;
  denied?: boolean;
}

interface Tracked {
  taskId: string;
  title: string;
  research: boolean;
  fileScope: string[];
  turns: number;
  steps: Step[];
  drafts: Set<string>;
  /** Writes it made that the rules did not refuse. Drafts only become events at the end of a task. */
  writes: number;
  checksFailed: number;
  questions: number;
  /** Notes the coordinator sent it. */
  notes: number;
  /** Times the coordinator looked at it because of a concern. */
  checkIns: number;
  raised: Set<ConcernKind>;
  lastAt: number;
  /** Its step count when the coordinator last looked at it, for any reason. */
  lastLookTurn: number;
  /** Regular progress checks so far. */
  progressChecks: number;
  /** Another sub-agent finished since the last look: the coordinator may have news for it. */
  news: boolean;
  /** A thought that sounded like a guess, kept until raised. */
  guess?: string;
}

const RECENT = 8;

function callLabel(call: Record<string, unknown> | undefined, tool: string): string {
  if (!call) return tool;
  for (const key of ["path", "glob", "query", "name", "question"]) {
    const v = call[key];
    if (typeof v === "string" && v) return `${tool} ${v.replace(/\s+/g, " ").slice(0, 80)}`;
  }
  return tool;
}

export interface MonitorOptions {
  /** A sub-agent's step budget, to judge "many steps". */
  maxTurns: number;
  now?: () => number;
}

export class AgentMonitor {
  private readonly agents = new Map<string, Tracked>();
  private readonly now: () => number;

  constructor(private readonly opts: MonitorOptions) {
    this.now = opts.now ?? Date.now;
  }

  private get(taskId: string, task?: Pick<Task, "title" | "fileScope">): Tracked {
    let t = this.agents.get(taskId);
    if (!t) {
      t = {
        taskId,
        title: task?.title ?? taskId,
        research: (task?.fileScope.length ?? 1) === 0,
        fileScope: task?.fileScope ?? [],
        turns: 0,
        steps: [],
        drafts: new Set(),
        writes: 0,
        checksFailed: 0,
        questions: 0,
        notes: 0,
        checkIns: 0,
        raised: new Set(),
        lastAt: this.now(),
        lastLookTurn: 0,
        progressChecks: 0,
        news: false,
      };
      this.agents.set(taskId, t);
    } else if (task) {
      t.title = task.title;
      t.fileScope = task.fileScope;
      t.research = task.fileScope.length === 0;
    }
    return t;
  }

  /** Feeds one logged event of the run. Events without a task are ignored. */
  observe(event: RunEvent, task?: Pick<Task, "title" | "fileScope">): void {
    if (!event.taskId) return;
    const t = this.get(event.taskId, task);
    t.lastAt = this.now();
    const data = event.data ?? {};
    switch (event.type) {
      case "status":
        // A new attempt or fix round starts over: earlier steps say little about it.
        if (event.message === "running") t.steps = [];
        return;
      case "tool_call": {
        const call = data.call as Record<string, unknown> | undefined;
        t.turns++;
        if (event.message === "ask_coordinator") t.questions++;
        if (event.message === "write_file" || event.message === "replace_in_file") t.writes++;
        if (typeof data.thought === "string" && !t.guess && event.message !== "ask_coordinator" && event.message !== "finish" && GUESSING.test(data.thought)) {
          t.guess = data.thought.replace(/\s+/g, " ").slice(0, 300);
        }
        t.steps.push({
          key: JSON.stringify(call ?? event.message),
          label: callLabel(call, event.message),
          thought: typeof data.thought === "string" ? data.thought.replace(/\s+/g, " ").slice(0, 200) : undefined,
        });
        if (t.steps.length > RECENT) t.steps.shift();
        return;
      }
      case "denied": {
        const lastStep = t.steps.at(-1);
        if (lastStep && !lastStep.denied) {
          lastStep.denied = true;
          if (/^(write_file|replace_in_file)\b/.test(lastStep.label)) t.writes = Math.max(0, t.writes - 1);
        }
        return;
      }
      case "changes_pending":
        for (const f of Array.isArray(data.files) ? (data.files as string[]) : []) t.drafts.add(f);
        return;
      case "checks":
        if (event.message === "failed") t.checksFailed++;
        return;
      case "coordinator_checkin":
        if (event.message === "message") t.notes++;
        return;
      case "coordinator_review":
        if (event.message === "revise") t.notes++;
        return;
      default:
        return;
    }
  }

  /** Whether it drafted anything yet. Drafts only become events at the end, so writes are counted as they happen. */
  private drafted(t: Tracked): boolean {
    return t.drafts.size > 0 || t.writes > 0;
  }

  /** Concerns about this sub-agent that have not been raised yet. Raising one is up to the caller (markRaised). */
  concerns(taskId: string): Concern[] {
    const t = this.agents.get(taskId);
    if (!t) return [];
    const found: Concern[] = [];
    const recent = t.steps.slice(-6);
    const counts = new Map<string, number>();
    for (const s of recent) counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
    const repeated = [...counts.entries()].find(([, n]) => n >= 3);
    if (repeated) {
      const label = recent.find((s) => s.key === repeated[0])!.label;
      found.push({ kind: "looping", detail: `It made the same tool call ${repeated[1]} times in its last ${recent.length} steps.`, evidence: `The repeated call: ${label}` });
    }
    let deniedInRow = 0;
    for (let i = t.steps.length - 1; i >= 0 && t.steps[i]!.denied; i--) deniedInRow++;
    if (deniedInRow >= 3) found.push({ kind: "blocked", detail: `Its last ${deniedInRow} steps were refused by the rules (for example files outside its task).` });
    const many = Math.max(8, Math.ceil(this.opts.maxTurns * (t.research ? 0.6 : 0.5)));
    if (t.turns >= many && (t.research || !this.drafted(t))) {
      found.push({
        kind: "no_progress",
        detail: t.research
          ? `It has taken ${t.turns} of at most ${this.opts.maxTurns} steps and has not reported yet.`
          : `It has taken ${t.turns} of at most ${this.opts.maxTurns} steps and has not drafted any change yet.`,
      });
    }
    if (t.checksFailed >= 2) found.push({ kind: "checks_failing", detail: `The checks failed ${t.checksFailed} times after its changes.` });
    // Asking the coordinator first would have been better; asking at all settles it.
    if (t.guess && t.questions === 0) found.push({ kind: "guessing", detail: "Its thought says it is assuming or unsure, and it has not asked you anything.", evidence: `Its thought: ${t.guess}` });
    return found.filter((c) => !t.raised.has(c.kind));
  }

  markRaised(taskId: string, kind: ConcernKind): void {
    const t = this.get(taskId);
    t.raised.add(kind);
    t.checkIns++;
    t.lastLookTurn = t.turns;
    t.news = false;
  }

  /**
   * A regular look at its progress is due: every `every` steps since the
   * last look, or after two steps when another sub-agent has finished since.
   * 0 turns regular checks off.
   */
  progressDue(taskId: string, every: number): Concern | undefined {
    const t = this.agents.get(taskId);
    if (!t || every <= 0) return undefined;
    const since = t.turns - t.lastLookTurn;
    if (t.news && since >= 2) return { kind: "progress", detail: `Another sub-agent finished since you last looked; it has taken ${t.turns} steps.` };
    if (since >= every) return { kind: "progress", detail: `A regular look after ${t.turns} of at most ${this.opts.maxTurns} steps. Nothing looks wrong.` };
    return undefined;
  }

  markProgressCheck(taskId: string): void {
    const t = this.get(taskId);
    t.progressChecks++;
    t.lastLookTurn = t.turns;
    t.news = false;
  }

  /** Another sub-agent finished: every other tracked one may get news at its next look. */
  finished(taskId: string): void {
    for (const t of this.agents.values()) if (t.taskId !== taskId) t.news = true;
  }

  checkIns(taskId: string): number {
    return this.agents.get(taskId)?.checkIns ?? 0;
  }

  notesSent(taskId: string): number {
    return this.agents.get(taskId)?.notes ?? 0;
  }

  /** One sub-agent's recent activity in plain text, for the coordinator model. Holds model-written thoughts: untrusted. */
  describe(taskId: string): string {
    const t = this.agents.get(taskId);
    if (!t) return "No activity recorded yet.";
    const lines = [
      `Steps taken: ${t.turns} of at most ${this.opts.maxTurns}.`,
      t.research ? "Read-only researcher." : `May change: ${t.fileScope.join(", ") || "nothing"}.`,
      t.research ? "" : `Drafts so far: ${t.drafts.size ? [...t.drafts].join(", ") : this.drafted(t) ? "some, not yet handed in" : "none"}.`,
      t.questions ? `Questions it asked you: ${t.questions}.` : "",
      t.notes ? `Notes you already sent it: ${t.notes}.` : "",
      t.checksFailed ? `Failed check rounds: ${t.checksFailed}.` : "",
      "Its recent steps, oldest first:",
      ...t.steps.map((s) => `- ${s.label}${s.denied ? " (refused)" : ""}${s.thought ? `: ${s.thought}` : ""}`),
    ];
    return lines.filter(Boolean).join("\n");
  }

  /** Every sub-agent of the run in a line each, for answering questions about the team. Holds reports: untrusted. */
  teamStatus(tasks: Task[], exceptTaskId?: string): string | undefined {
    const lines = tasks
      .filter((x) => x.id !== exceptTaskId)
      .map((x) => {
        const t = this.agents.get(x.id);
        const steps = t ? `, ${t.turns} steps` : "";
        const drafts = t?.drafts.size ? `, drafts: ${[...t.drafts].join(", ")}` : "";
        const said = x.summary ? `, reported: ${x.summary.replace(/\s+/g, " ").slice(0, 200)}` : t?.steps.at(-1) ? `, now: ${t.steps.at(-1)!.label}` : "";
        return `- "${x.title}" (${x.fileScope.length ? x.fileScope.join(", ") : "read-only"}): ${x.status.replace("_", " ")}${steps}${drafts}${said}`;
      });
    return lines.length ? lines.join("\n") : undefined;
  }
}

/** What the coordinator decides after looking at a sub-agent. */
export const superviseSchema = z.object({
  thought: z.string().max(600).optional().describe("One sentence on what you see. Shown to the user."),
  action: z.enum(["continue", "message", "stop"]),
  message: z.string().max(1500).describe('For "message": your note to the sub-agent. Otherwise "".'),
});

export type SuperviseDecision = z.infer<typeof superviseSchema>;

export interface SuperviseContext {
  /** The user's own messages, newest last. Trusted. */
  userMessages: string[];
  request: string;
  agent: { title: string; instructions: string };
  concern: Concern;
  /** AgentMonitor.describe() of the sub-agent. Untrusted. */
  activity: string;
  /** Notes already sent to it. Stop is only allowed after one. */
  notesSent: number;
  /** What the coordinator learned (research, reports). Untrusted. */
  learned?: string;
  /** How the other sub-agents are doing, with reports of finished ones. Untrusted. */
  team?: string;
}

const SUPERVISE_SYSTEM = `You are the coordinator of a team of coding sub-agents. You keep an eye on them while they work. One sub-agent shows a sign of trouble. Look at its recent steps and decide:
- "continue": it is fine, or it is about to sort it out itself.
- "message": send it a short, concrete note that gets it unstuck: what to try instead, which file to look at, or to finish with what it has. Write the note in message.
- "stop": stop it. Only if a note did not help and it keeps going nowhere, or it is working against the user's request. Its drafts are kept for the user's review.
Never tell it to change files outside its task, run commands, or skip the user's review.

Reply with JSON only. Example:
{"thought":"It keeps reading the same file without editing it.","action":"message","message":"You have read src/app.ts three times. Make the edit with replace_in_file now, then finish."}`;

const PROGRESS_SYSTEM = `You are the coordinator of a team of coding sub-agents. You check on each one regularly while it works. Nothing looks wrong with this one; this is a regular look at its progress. Its thoughts are its progress reports to you. You know things it does not: what the user said, what research found, and what the other sub-agents found or changed.
- "message": send a short note when you can add something useful: a fact from your notes it is missing, what another sub-agent found or changed that affects its task, or a correction when it drifts from the user's request. Name files and names. You can also confirm briefly that it is on the right track when that helps it go on.
- "continue": it is on track and you have nothing it needs.
Never tell it to change files outside its task, run commands, or skip the user's review. Never repeat its own steps back to it.

Reply with JSON only. Example:
{"thought":"It is adding the route, but the auth sub-agent renamed the middleware.","action":"message","message":"The other sub-agent renamed requireUser to requireSession in src/auth/middleware.ts. Use the new name in your route."}`;

/** Builds the prompt for one look at one sub-agent. */
export function buildSuperviseMessages(ctx: SuperviseContext, contextWindow: number): ChatMessage[] {
  const routine = ctx.concern.kind === "progress";
  const system = routine ? PROGRESS_SYSTEM : SUPERVISE_SYSTEM;
  let budget = Math.max(1024, contextWindow - 768) - estimateTokens(system);
  const fit = (text: string, max: number) => {
    const cut = truncateToTokens(text, Math.max(50, Math.min(max, budget - 200))) ?? "";
    budget -= estimateTokens(cut);
    return cut;
  };
  const said = ctx.userMessages.slice(-4).map((m) => `- ${m.replace(/\s+/g, " ")}`).join("\n");
  const parts = [
    said ? `What the user asked (newest last):\n${fit(said, 800)}` : "",
    `The work you planned: ${fit(ctx.request, 400)}`,
    `The sub-agent: "${ctx.agent.title}". Its task: ${fit(ctx.agent.instructions, 400)}`,
    // Only the fixed wording is the coordinator's own observation; what the sub-agent did goes in the fence.
    routine ? `Why you look now: ${ctx.concern.detail}` : `What you noticed: ${CONCERN_LABEL[ctx.concern.kind]}. ${ctx.concern.detail}`,
    routine
      ? ctx.notesSent ? `You already sent it ${ctx.notesSent} note(s).` : ""
      : ctx.notesSent ? `You already sent it ${ctx.notesSent} note(s).` : 'You have not sent it a note yet, so "stop" is not available.',
    ctx.learned || ctx.team
      ? `Your notes:\n${DATA_RULE}\n${[
          ctx.learned ? dataBlock("earlier research and sub-agent reports", fit(ctx.learned, 800)) : "",
          ctx.team ? dataBlock("what the other sub-agents are doing", fit(ctx.team, 600)) : "",
        ].filter(Boolean).join("\n")}`
      : "",
    untrustedSection(
      "Its activity (its own thoughts and tool arguments are in it):",
      `recent steps of sub-agent "${ctx.agent.title}"`,
      fit([ctx.concern.evidence, ctx.activity].filter(Boolean).join("\n"), 1500),
    ),
    `Decide with JSON only. ${DATA_REMINDER}`,
  ];
  return [
    { role: "system", content: system },
    { role: "user", content: parts.filter(Boolean).join("\n\n") },
  ];
}

export interface SuperviseResult extends SuperviseDecision {
  thinking?: string;
  /** Set when the model's choice was changed by a rule, and why. */
  adjusted?: string;
}

/**
 * One model call that decides what to do about a sub-agent. A small model
 * may jump to "stop", so stopping is only allowed after a note was sent, and
 * an empty note means "continue".
 */
export async function superviseAgent(provider: ModelProvider, ctx: SuperviseContext, opts: { signal?: AbortSignal } = {}): Promise<SuperviseResult> {
  let thinking: string | undefined;
  const decision = await callStructured({
    provider,
    messages: buildSuperviseMessages(ctx, provider.contextWindow),
    schema: superviseSchema,
    schemaName: "supervise_agent",
    signal: opts.signal,
    onThinking: (t) => (thinking = t),
  });
  return { ...guardDecision(decision, ctx.notesSent, ctx.concern.kind === "progress"), thinking };
}

/** The rules a supervision decision must follow, whatever the model said. */
export function guardDecision(d: SuperviseDecision, notesSent: number, routine = false): SuperviseDecision & { adjusted?: string } {
  const message = d.message.trim();
  // A regular look is not about trouble, so it never stops anyone.
  if (routine && d.action === "stop") {
    return message
      ? { ...d, action: "message", message, adjusted: "A regular progress check never stops a sub-agent, so the note was sent instead." }
      : { ...d, action: "continue", message: "", adjusted: "A regular progress check never stops a sub-agent." };
  }
  if (d.action === "stop" && notesSent === 0) {
    return message
      ? { ...d, action: "message", message, adjusted: "Stopping is only allowed after a note, so a note was sent instead." }
      : { ...d, action: "message", message: "You seem stuck. Try a different approach, or finish now with what you have and say what is left.", adjusted: "Stopping is only allowed after a note, so a note was sent instead." };
  }
  if (d.action === "message" && !message) return { ...d, action: "continue", message: "", adjusted: "The note was empty, so nothing was sent." };
  return { ...d, message };
}
