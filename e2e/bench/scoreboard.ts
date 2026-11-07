/**
 * Turns benchmark attempts into a scoreboard: the same tasks done by one
 * plain conversation and by the agentic chat, side by side.
 */
import { RecordedCall } from "../providers";
import { BenchTask, Judged } from "./tasks";

export type Mode = "single" | "agentic";

export interface Attempt {
  task: string;
  group: BenchTask["group"];
  kind: BenchTask["kind"];
  files: number;
  asks: number;
  mode: Mode;
  repeat: number;
  score: number;
  parts: Judged["parts"];
  collateral: string[];
  deleted: string[];
  created: string[];
  falseDone: boolean;
  minutes: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  /** The largest prompt of one call: how full the context got. */
  peakPromptTokens: number;
  /** Replies cut off at the length limit. */
  truncatedReplies: number;
  /** Why it ended early (timed out, out of steps, harness failures), if it did. */
  ended?: string;
  answer: string;
}

export function usageOf(calls: RecordedCall[]): Pick<Attempt, "modelCalls" | "promptTokens" | "completionTokens" | "peakPromptTokens" | "truncatedReplies"> {
  let promptTokens = 0;
  let completionTokens = 0;
  let peak = 0;
  let truncated = 0;
  for (const c of calls) {
    const p = c.response?.promptTokens ?? 0;
    promptTokens += p;
    completionTokens += c.response?.completionTokens ?? 0;
    peak = Math.max(peak, p);
    if (c.response?.truncated) truncated++;
  }
  return { modelCalls: calls.length, promptTokens, completionTokens, peakPromptTokens: peak, truncatedReplies: truncated };
}

export interface Row {
  task: string;
  mode: Mode;
  attempts: number;
  /** Mean partial-credit score, 0..1. */
  score: number;
  /** Attempts that scored 1. */
  solved: number;
  falseDone: number;
  /** Attempts that changed or deleted files the request did not ask for. */
  collateral: number;
  medianMinutes: number;
  medianCalls: number;
  /** Mean prompt plus completion tokens per attempt. */
  tokens: number;
  peakPromptTokens: number;
  ended: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function rowOf(task: string, mode: Mode, attempts: Attempt[]): Row {
  return {
    task,
    mode,
    attempts: attempts.length,
    score: mean(attempts.map((a) => a.score)),
    solved: attempts.filter((a) => a.score === 1).length,
    falseDone: attempts.filter((a) => a.falseDone).length,
    collateral: attempts.filter((a) => a.collateral.length + a.deleted.length > 0).length,
    medianMinutes: median(attempts.map((a) => a.minutes)),
    medianCalls: median(attempts.map((a) => a.modelCalls)),
    tokens: mean(attempts.map((a) => a.promptTokens + a.completionTokens)),
    peakPromptTokens: Math.max(0, ...attempts.map((a) => a.peakPromptTokens)),
    ended: attempts.filter((a) => a.ended).length,
  };
}

const MODES: Mode[] = ["single", "agentic"];
const pct = (x: number) => `${Math.round(x * 100)}%`;
const k = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(x >= 10000 ? 0 : 1)}k` : String(Math.round(x)));

export function rows(attempts: Attempt[]): Row[] {
  const tasks = [...new Set(attempts.map((a) => a.task))];
  return tasks.flatMap((t) => MODES.map((m) => ({ m, list: attempts.filter((a) => a.task === t && a.mode === m) })).filter((x) => x.list.length).map((x) => rowOf(t, x.m, x.list)));
}

/** The scoreboard as Markdown: totals, every task, and the two ladders. */
export function scoreboard(attempts: Attempt[], meta: { model: string; time: string }): string {
  const out: string[] = [`# Benchmark: agentic chat vs one conversation`, "", `Model ${meta.model}, ${meta.time}. Scores are the share of hidden checks passed (partial credit), averaged over attempts.`, ""];

  out.push("## Totals", "", "| | attempts | mean score | solved | false \"done\" | collateral damage | ended early | median min | total min | mean tokens | peak prompt |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const m of MODES) {
    const list = attempts.filter((a) => a.mode === m);
    if (!list.length) continue;
    const changeFails = list.filter((a) => a.kind === "change" && a.score < 1);
    out.push(
      `| ${m} | ${list.length} | ${pct(mean(list.map((a) => a.score)))} | ${list.filter((a) => a.score === 1).length}/${list.length} | ${list.filter((a) => a.falseDone).length}/${changeFails.length} | ${list.filter((a) => a.collateral.length + a.deleted.length > 0).length} | ${list.filter((a) => a.ended).length} | ${median(list.map((a) => a.minutes)).toFixed(1)} | ${list.reduce((s, a) => s + a.minutes, 0).toFixed(0)} | ${k(mean(list.map((a) => a.promptTokens + a.completionTokens)))} | ${k(Math.max(...list.map((a) => a.peakPromptTokens)))} |`,
    );
  }
  out.push("", "False \"done\" counts change attempts that fell short while the answer did not admit it, out of all change attempts that fell short.", "");

  out.push("## Per task", "", "| task | mode | score | solved | false done | collateral | ended early | median min | median calls | mean tokens | peak prompt |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows(attempts)) {
    out.push(`| ${r.task} | ${r.mode} | ${pct(r.score)} | ${r.solved}/${r.attempts} | ${r.falseDone} | ${r.collateral} | ${r.ended} | ${r.medianMinutes.toFixed(1)} | ${r.medianCalls} | ${k(r.tokens)} | ${k(r.peakPromptTokens)} |`);
  }

  /** One ladder: a row per step (sorted by size), score and minutes per mode. */
  const ladder = (group: Attempt["group"], title: string, label: string, step: (a: Attempt) => string) => {
    const list = attempts.filter((a) => a.group === group);
    if (!list.length) return;
    const size = (a: Attempt) => a.asks * 1e6 + a.files;
    const steps = [...new Set([...list].sort((a, b) => size(a) - size(b)).map(step))];
    out.push("", `## ${title}`, "", `| ${label} | ${MODES.map((m) => `${m} score`).join(" | ")} | ${MODES.map((m) => `${m} min`).join(" | ")} |`, `|---|${MODES.map(() => "---").join("|")}|${MODES.map(() => "---").join("|")}|`);
    for (const s of steps) {
      const at = (m: Mode) => list.filter((a) => a.mode === m && step(a) === s);
      out.push(`| ${s} | ${MODES.map((m) => (at(m).length ? pct(mean(at(m).map((a) => a.score))) : "-")).join(" | ")} | ${MODES.map((m) => (at(m).length ? median(at(m).map((a) => a.minutes)).toFixed(1) : "-")).join(" | ")} |`);
    }
  };
  ladder("research-ladder", "How much code one question can cover", "files in the project", (a) => String(a.files));
  ladder("edit-ladder", "How many changes one request can hold", "changes, project files", (a) => `${a.asks} changes, ${a.files} files`);
  return out.join("\n") + "\n";
}
