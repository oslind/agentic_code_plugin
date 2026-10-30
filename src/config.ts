import * as vscode from "vscode";
import { OpenAICompatibleConfig } from "./providers/openaiCompatible";
import { StructuredOutputMode } from "./providers/types";
import { CheckConfig } from "./checks/runner";

export function readModelConfig(): OpenAICompatibleConfig {
  const c = vscode.workspace.getConfiguration("agentic.model");
  return {
    baseUrl: c.get<string>("baseUrl", "http://localhost:11434/v1"),
    model: c.get<string>("name", "qwen3.8:27b"),
    apiKey: c.get<string>("apiKey", "") || undefined,
    contextWindow: c.get<number>("contextWindow", 32768),
    temperature: c.get<number>("temperature", 0.2),
    requestTimeoutMs: c.get<number>("requestTimeoutMs", 300000),
    structuredOutput: c.get<StructuredOutputMode>("structuredOutput", "json_schema"),
  };
}

export interface RunConfig {
  checks: CheckConfig[];
  maxParallel: number;
  maxTurns: number;
  maxFixRounds: number;
  linkDirs: string[];
}

export function readRunConfig(scope?: vscode.Uri): RunConfig {
  const c = vscode.workspace.getConfiguration("agentic", scope);
  const checks = c
    .get<CheckConfig[]>("checks", [])
    .filter((x) => typeof x?.name === "string" && typeof x?.command === "string" && x.name && x.command);
  return {
    checks,
    maxParallel: Math.max(1, Math.min(8, c.get<number>("maxParallelWorkers", 2))),
    maxTurns: c.get<number>("worker.maxTurns", 40),
    maxFixRounds: c.get<number>("worker.maxFixRounds", 2),
    linkDirs: c.get<string[]>("worktree.linkDirs", ["node_modules"]),
  };
}
