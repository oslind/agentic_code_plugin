import { Task } from "../state/types";
import { ChatEntry } from "./types";

/**
 * What the coordinator has learned in this conversation, for planning and for
 * every sub-agent of the next run: sub-agent reports (research answers and
 * finished work) and its own answers after research, newest first, kept small
 * for local models. Every line is labelled with its source. It is untrusted:
 * pass it on only through untrustedSection(), never as instructions.
 */
export function learnedSoFar(entries: ChatEntry[], maxChars = 3000): string | undefined {
  const lines: string[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    let line: string | undefined;
    // Each line says where it came from. None of it was checked by the user, and all of it
    // was written by models that read project files, so callers pass it on as untrusted data.
    if (e.kind === "report" && e.author === "coordinator") line = `- [run summary with sub-agent reports] ${e.text}`;
    else if (e.kind === "report") line = `- [report from sub-agent "${e.agentName ?? "unnamed"}"] ${e.text}`;
    // The coordinator's answer right after research reports sums them up.
    else if (e.author === "coordinator" && e.tag === "from research") line = `- [answer combined from research reports] ${e.text}`;
    // What the user decided when a sub-agent's question was passed on to them.
    else if (e.author === "coordinator" && e.kind === "question" && e.quote && e.decided?.startsWith("You answered: "))
      line = `- [the user's answer to a sub-agent's question] Q: ${e.quote} A: ${e.decided.slice("You answered: ".length)}`;
    if (!line) continue;
    line = line.replace(/\s+/g, " ").slice(0, 800);
    if (used + line.length > maxChars) break;
    lines.unshift(line);
    used += line.length;
  }
  return lines.length ? lines.join("\n") : undefined;
}

const isPrompt = (e: ChatEntry) => e.author === "user" && e.kind !== "direct";

/**
 * The part of a conversation that belongs to one run, for what the
 * coordinator may use when a sub-agent of that run asks it something or
 * when it checks on one. It starts at the user's message that led to the
 * run, and takes in the message before that only when the coordinator
 * answered it with a question and no run (a clarifying question, which the
 * user's next message answers). Earlier, unrelated tasks and chat of the
 * conversation are left out, so a sub-agent cannot draw them out of the
 * coordinator. It ends before the user's next message to the coordinator,
 * so later tasks are out of reach too. Empty if the run is not in it.
 */
export function runScope(entries: ChatEntry[], runId: string): ChatEntry[] {
  const at = entries.findIndex((e) => e.runId === runId && (e.kind === "plan" || e.kind === "research"));
  if (at < 0) return [];
  let start = at;
  while (start > 0 && !isPrompt(entries[start]!)) start--;
  for (;;) {
    let prev = start - 1;
    while (prev >= 0 && !isPrompt(entries[prev]!)) prev--;
    if (prev < 0) break;
    const between = entries.slice(prev, start);
    const reply = between.filter((e) => e.author === "coordinator").at(-1);
    if (between.some((e) => e.runId) || !reply?.text.trim().endsWith("?")) break;
    start = prev;
  }
  let end = at + 1;
  while (end < entries.length && !isPrompt(entries[end]!)) end++;
  return entries.slice(start, end);
}

/** The user's own messages to the coordinator, oldest first. Direct messages to sub-agents are left out. */
export function userMessagesOf(entries: ChatEntry[]): string[] {
  return entries.filter(isPrompt).map((e) => e.text);
}

/**
 * Questions sub-agents asked the coordinator in this conversation and how
 * they were answered, newest last, so a later question gets a consistent
 * answer and a decision the user made is not asked again.
 */
export function earlierAnswers(entries: ChatEntry[], maxChars = 2000): string | undefined {
  const lines: string[] = [];
  for (const e of entries) {
    if (!e.quote || e.author !== "coordinator") continue;
    const q = e.quote.replace(/\s+/g, " ").slice(0, 200);
    if (e.kind === "consult") lines.push(`- "${e.agentName ?? "A sub-agent"}" asked: ${q} You answered: ${e.text.replace(/\s+/g, " ").slice(0, 300)}`);
    else if (e.kind === "question" && e.decided?.startsWith("You answered: ")) lines.push(`- "${e.agentName ?? "A sub-agent"}" asked: ${q} The user decided: ${e.decided.slice("You answered: ".length).replace(/\s+/g, " ").slice(0, 300)}`);
  }
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  return out || undefined;
}

/**
 * What a sub-agent did, rebuilt from the chat, for reopening one whose
 * conversation was not saved (runs from before follow-ups existed).
 */
export function earlierWork(task: Task, entries: ChatEntry[], runId: string, maxChars = 4000): string {
  const steps = entries
    // The coordinator's own entries about this sub-agent (check-ins, answers) are left out: they quote what
    // a sub-agent's tool calls said, which is untrusted, and they are not the sub-agent's own work.
    .filter((e) => e.runId === runId && e.taskId === task.id && e.author !== "coordinator" && e.kind !== "spawn" && e.kind !== "report")
    .map((e) => (e.author === "user" ? `- The user said: ${e.text}` : `- ${e.tag ? `${e.tag}: ` : ""}${e.thought || e.text}`).replace(/\s+/g, " ").slice(0, 300));
  let shown = steps.join("\n");
  if (shown.length > maxChars) shown = `[… earlier steps left out]\n${shown.slice(-maxChars)}`;
  return [
    task.summary ? `Your report when you finished:\n${task.summary}` : task.error ? `Your task ended with: ${task.error}` : "",
    shown ? `Your steps:\n${shown}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
