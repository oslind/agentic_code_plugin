import * as vscode from "vscode";
import { OpenAICompatibleConfig, OpenAICompatibleProvider } from "./providers/openaiCompatible";
import { StructuredOutputMode } from "./providers/types";
import { CheckConfig } from "./checks/runner";
import { safeLinkDirs } from "./changes/scratch";
import { AutoApprove } from "./tools/policy";
import { baseUrlFrom, legacyApiKeyFrom, PERMISSION_KEYS, permissionsFrom, USER_ONLY_MODEL_KEYS, workspaceOverrides } from "./userSettings";

export { PERMISSION_KEYS } from "./userSettings";

/** Where the API key is kept in VS Code's secret storage (the OS keychain), never in settings files. */
export const API_KEY_SECRET = "agentic.model.apiKey";

let secretApiKey: string | undefined;

/** Keeps the API key from secret storage in memory, so building a request stays synchronous. */
export function setSecretApiKey(key: string | undefined): void {
  secretApiKey = key?.trim() || undefined;
}

/**
 * Reads the model settings fresh on every call, so changes apply to the next
 * request without a reload. Pass the workspace folder so folder-level
 * settings in a multi-root workspace are honoured for the model name and
 * tuning. The server address and the API key come from the user only: a
 * project can never change where your code and key are sent.
 */
export function readModelConfig(scope?: vscode.Uri): OpenAICompatibleConfig {
  const c = vscode.workspace.getConfiguration("agentic.model", scope);
  return {
    source: modelNameSource(scope),
    baseUrl: baseUrlFrom(c),
    model: c.get<string>("name", "qwen3.8:27b"),
    apiKey: secretApiKey ?? legacyApiKeyFrom(c),
    contextWindow: c.get<number>("contextWindow", 32768),
    temperature: c.get<number>("temperature", 0.2),
    requestTimeoutMs: c.get<number>("requestTimeoutMs", 300000),
    structuredOutput: c.get<StructuredOutputMode>("structuredOutput", "json_schema"),
    stream: c.get<boolean>("stream", true),
    maxConcurrentRequests: Math.max(1, Math.min(16, c.get<number>("maxConcurrentRequests", 1))),
    maxOutputTokens: Math.max(0, c.get<number>("maxOutputTokens", 0)),
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
  /** Checks from every settings level, including the project's own. Project checks are only suggestions. */
  checks: CheckConfig[];
  /** Commands of the checks in the user's own settings. Only these may run without asking when "Run commands" is on. */
  trustedCommands: Set<string>;
  maxParallel: number;
  maxTurns: number;
  maxFixRounds: number;
  linkDirs: string[];
}

export function readRunConfig(scope?: vscode.Uri): RunConfig {
  const c = vscode.workspace.getConfiguration("agentic", scope);
  const valid = (list: unknown): CheckConfig[] =>
    (Array.isArray(list) ? (list as CheckConfig[]) : []).filter((x) => typeof x?.name === "string" && typeof x?.command === "string" && x.name && x.command);
  const checks = valid(c.get<unknown>("checks", []));
  return {
    checks,
    trustedCommands: new Set(valid(c.inspect<unknown>("checks")?.globalValue).map((x) => x.command)),
    maxParallel: Math.max(1, Math.min(8, c.get<number>("maxParallelWorkers", 2))),
    maxTurns: c.get<number>("worker.maxTurns", 40),
    maxFixRounds: c.get<number>("worker.maxFixRounds", 2),
    // User settings only: a project must not choose what gets linked into the scratch copy.
    linkDirs: safeLinkDirs(c.inspect<unknown>("scratch.linkDirs")?.globalValue ?? ["node_modules"]),
  };
}

/**
 * What happens without asking. A switch that is off means the user approves
 * each step in the chat. Workspace confinement and the protected files
 * (.git, secrets, .agentic) are never affected by these.
 */
export interface Permissions extends AutoApprove {
  /** Sub-agents' file changes are written to the project without review. */
  editFiles: boolean;
  /** The same for package.json, lockfiles and CI files. */
  sensitiveFiles: boolean;
  /** Check commands run without asking. */
  commands: boolean;
}

/**
 * Extra secret file patterns. Values from every level are combined, so a
 * project can add patterns but never remove the user's.
 */
export function readProtectedFiles(): string[] {
  const i = vscode.workspace.getConfiguration("agentic").inspect<unknown>("protectedFiles");
  const all = [i?.globalValue, i?.workspaceValue, i?.workspaceFolderValue].flatMap((v) => (Array.isArray(v) ? v : []));
  return [...new Set(all.filter((g): g is string => typeof g === "string"))];
}

/** The switches from user settings only. A project's .vscode/settings.json cannot turn them on. */
export function readPermissions(): Permissions {
  return permissionsFrom(vscode.workspace.getConfiguration("agentic.autoApprove"));
}

/**
 * Security settings that the open project tries to set, for a warning. Their
 * values are ignored either way.
 */
export function ignoredProjectSettings(scope?: vscode.Uri): string[] {
  return [
    ...workspaceOverrides(vscode.workspace.getConfiguration("agentic.autoApprove", scope), PERMISSION_KEYS).map((k) => `agentic.autoApprove.${k}`),
    ...workspaceOverrides(vscode.workspace.getConfiguration("agentic.model", scope), USER_ONLY_MODEL_KEYS).map((k) => `agentic.model.${k}`),
  ];
}
