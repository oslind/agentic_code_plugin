import * as vscode from "vscode";
import { OpenAICompatibleConfig, OpenAICompatibleProvider } from "./providers/openaiCompatible";
import { StructuredOutputMode } from "./providers/types";
import { CheckConfig } from "./checks/runner";

/**
 * Reads the model settings fresh on every call, so changes apply to the next
 * request without a reload. Pass the workspace folder so folder-level
 * settings in a multi-root workspace are honoured too.
 */
export function readModelConfig(scope?: vscode.Uri): OpenAICompatibleConfig {
  const c = vscode.workspace.getConfiguration("agentic.model", scope);
  return {
    source: modelNameSource(scope),
    baseUrl: c.get<string>("baseUrl", "http://localhost:11434/v1"),
    model: c.get<string>("name", "qwen3.8:27b"),
    apiKey: c.get<string>("apiKey", "") || undefined,
    contextWindow: c.get<number>("contextWindow", 32768),
    temperature: c.get<number>("temperature", 0.2),
    requestTimeoutMs: c.get<number>("requestTimeoutMs", 300000),
    structuredOutput: c.get<StructuredOutputMode>("structuredOutput", "json_schema"),
  };
}

/** A provider for the current settings. Logs when the server forces a weaker structured output mode. */
export function createProvider(scope: vscode.Uri | undefined, log: { warn(message: string): void }): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(readModelConfig(scope), fetch, (from, to, error) =>
    log.warn(`The model server rejected structured output "${from}" (${error}). Using "${to}" instead; replies are still checked against the schema.`),
  );
}

/** Says which settings scope the model name comes from, for error messages. */
export function modelNameSource(scope?: vscode.Uri): string {
  const i = vscode.workspace.getConfiguration("agentic.model", scope).inspect<string>("name");
  if (!i) return "agentic.model.name";
  const where: [unknown, string][] = [
    [i.workspaceFolderLanguageValue ?? i.workspaceFolderValue, "Folder settings"],
    [i.workspaceLanguageValue ?? i.workspaceValue, "Workspace settings"],
    [i.globalLanguageValue ?? i.globalValue, "User settings (includes Remote settings in WSL/SSH)"],
  ];
  const hit = where.find(([v]) => v !== undefined);
  return hit ? `agentic.model.name from ${hit[1]}` : "agentic.model.name, which is not set anywhere, so the built-in default is used";
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
