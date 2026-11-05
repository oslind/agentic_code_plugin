/**
 * Settings a project must never control. VS Code lets a folder's
 * .vscode/settings.json (or a .code-workspace file) override user settings,
 * so a repository could otherwise turn on the auto-approve switches or send
 * model requests, with your API key, to a server of its choice.
 *
 * These settings are declared with "machine" scope in package.json, which
 * stops VS Code from applying workspace values. As a second guard, they are
 * read here from the user level only (user settings, or Remote settings in
 * WSL/SSH) and any workspace or folder value is ignored.
 *
 * Kept free of the vscode module so it can be tested directly.
 */

/** The parts of vscode.WorkspaceConfiguration.inspect() used here. */
export interface SettingInspect<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
  globalLanguageValue?: T;
  workspaceLanguageValue?: T;
  workspaceFolderLanguageValue?: T;
}

export interface InspectableSection {
  inspect<T>(key: string): SettingInspect<T> | undefined;
}

/** Keys under "agentic.autoApprove". */
export const PERMISSION_KEYS = ["editFiles", "sensitiveFiles", "commands"] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/**
 * Keys under "agentic.model" that decide where requests and the API key go,
 * and the limits on how much load and cost one project can cause there.
 */
export const USER_ONLY_MODEL_KEYS = ["baseUrl", "apiKey", "maxConcurrentRequests", "maxOutputTokens"] as const;

/** Keys under "agentic.chat" that limit how much of your conversation is sent to the model. */
export const USER_ONLY_CHAT_KEYS = ["coordinatorHistoryTokens"] as const;

/**
 * Keys under "agentic.delegation" that decide how many extra model calls the
 * coordinator makes on its own (the oversight level: check-ins, progress
 * looks, result reviews, verification and its fix-up rounds), and the
 * per-run cap on all model calls. A project could otherwise turn a run into
 * many more requests to your model server.
 */
export const USER_ONLY_DELEGATION_KEYS = ["oversight", "maxModelCallsPerRun", "autoRetries"] as const;

/** Times a failed sub-agent is started again on its own, 0 (off) to 3, default 1. From user settings only: each retry calls the model again. */
export function autoRetriesFrom(section: InspectableSection): number {
  return Math.max(0, Math.min(3, Math.floor(userValue(section, "autoRetries", 1, isNumber))));
}

/**
 * Settings replaced by agentic.delegation.oversight. They are no longer read;
 * a user who still has one set is told once which level to pick instead.
 */
export const RETIRED_OVERSIGHT_KEYS = ["checkIns", "progressEvery", "reviewRounds", "verify", "verifyRounds"] as const;

export const DEFAULT_BASE_URL = "http://localhost:11434/v1";

/**
 * The user-level value of a setting, or the fallback. Workspace, folder and
 * language-specific values are never used. A value of the wrong type counts
 * as not set.
 */
export function userValue<T>(section: InspectableSection, key: string, fallback: T, isValid: (v: unknown) => v is T): T {
  const i = section.inspect<unknown>(key);
  const v = i?.globalValue;
  return isValid(v) ? v : fallback;
}

/** Keys from the list that a workspace, folder or language override tries to set. They are ignored; this is for warning the user. */
export function workspaceOverrides(section: InspectableSection, keys: readonly string[]): string[] {
  return keys.filter((k) => {
    const i = section.inspect<unknown>(k);
    return (
      i !== undefined &&
      (i.workspaceValue !== undefined ||
        i.workspaceFolderValue !== undefined ||
        i.workspaceLanguageValue !== undefined ||
        i.workspaceFolderLanguageValue !== undefined ||
        i.globalLanguageValue !== undefined)
    );
  });
}

export const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
export const isString = (v: unknown): v is string => typeof v === "string";
export const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Most model requests at once, from user settings only. 1 to 16, default 1. */
export function maxConcurrentRequestsFrom(section: InspectableSection): number {
  return Math.max(1, Math.min(16, Math.floor(userValue(section, "maxConcurrentRequests", 1, isNumber))));
}

/**
 * Default longest reply, thinking included. A step needs a short JSON reply,
 * so this is a lot of thinking (minutes on a local GPU), and it stops a reply
 * that loops: qwen3:8b once thought for 13,900 tokens in one step.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** Longest reply in tokens, from user settings only. 0 means no limit; a project can neither lift nor change it. */
export function maxOutputTokensFrom(section: InspectableSection): number {
  return Math.max(0, Math.floor(userValue(section, "maxOutputTokens", DEFAULT_MAX_OUTPUT_TOKENS, isNumber)));
}

/** Most tokens of earlier conversation sent with each coordinator message, from user settings only. 0 means as much as fits. */
export function coordinatorHistoryTokensFrom(section: InspectableSection): number {
  return Math.max(0, Math.floor(userValue(section, "coordinatorHistoryTokens", 12000, isNumber)));
}

/** How closely the coordinator watches and checks its sub-agents. One setting instead of five overlapping ones. */
export const OVERSIGHT_LEVELS = ["off", "light", "standard", "thorough"] as const;
export type OversightLevel = (typeof OVERSIGHT_LEVELS)[number];
export const DEFAULT_OVERSIGHT: OversightLevel = "standard";

/** What each level does. Every look, review and verification is one model call; fix-up rounds start sub-agents again. */
export interface OversightSteps {
  /** Looks at a sub-agent that seems stuck, per sub-agent. */
  checkIns: number;
  /** Steps between regular progress looks. 0 is off. */
  progressEvery: number;
  /** Times a result may be sent back, per task. 0 is no review. */
  reviewRounds: number;
  /** Whether the coordinator verifies a request before calling it done. */
  verify: boolean;
  /** Fix-up rounds when verification finds work left. */
  verifyRounds: number;
}

export const OVERSIGHT: Record<OversightLevel, OversightSteps> = {
  off: { checkIns: 0, progressEvery: 0, reviewRounds: 0, verify: false, verifyRounds: 0 },
  light: { checkIns: 1, progressEvery: 0, reviewRounds: 0, verify: true, verifyRounds: 1 },
  standard: { checkIns: 2, progressEvery: 8, reviewRounds: 1, verify: true, verifyRounds: 2 },
  thorough: { checkIns: 4, progressEvery: 4, reviewRounds: 2, verify: true, verifyRounds: 4 },
};

export interface OversightLimits extends OversightSteps {
  level: OversightLevel;
  /** Most model calls one run may make, sub-agents and coordinator together. 0 means no limit. Default 500. */
  maxModelCallsPerRun: number;
}

const clampInt = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.floor(v)));
const isOversightLevel = (v: unknown): v is OversightLevel => typeof v === "string" && (OVERSIGHT_LEVELS as readonly string[]).includes(v);

/** The oversight level and the per-run model-call cap, from user settings only. */
export function oversightLimitsFrom(section: InspectableSection): OversightLimits {
  const level = userValue(section, "oversight", DEFAULT_OVERSIGHT, isOversightLevel);
  return {
    level,
    ...OVERSIGHT[level],
    maxModelCallsPerRun: clampInt(userValue(section, "maxModelCallsPerRun", 500, isNumber), 0, 100000),
  };
}

/** Retired oversight settings the user still has in their own settings, so they can be told to use the level instead. */
export function retiredOversightSettings(section: InspectableSection): string[] {
  return RETIRED_OVERSIGHT_KEYS.filter((k) => section.inspect<unknown>(k)?.globalValue !== undefined);
}

/** The auto-approve switches, from user settings only. Anything but an explicit `true` there is off. */
export function permissionsFrom(section: InspectableSection): Record<PermissionKey, boolean> {
  return {
    editFiles: userValue(section, "editFiles", false, isBoolean),
    sensitiveFiles: userValue(section, "sensitiveFiles", false, isBoolean),
    commands: userValue(section, "commands", false, isBoolean),
  };
}

/** Where model requests go, from user settings only. */
export function baseUrlFrom(section: InspectableSection): string {
  const url = userValue(section, "baseUrl", DEFAULT_BASE_URL, isString).trim();
  return url || DEFAULT_BASE_URL;
}

/** The API key kept in plain user settings by older versions. New keys live in VS Code's secret storage. */
export function legacyApiKeyFrom(section: InspectableSection): string | undefined {
  return userValue(section, "apiKey", "", isString).trim() || undefined;
}

/** Keys under "agentic.scratch" that decide what is copied and how much disk the copies may use. */
export const USER_ONLY_SCRATCH_KEYS = ["linkDirs", "maxFiles", "maxMegabytes", "maxTotalMegabytes", "exclude"] as const;

/** Keys under "agentic.commands": how every command is started. */
export const USER_ONLY_COMMAND_KEYS = ["isolation"] as const;

const MB = 1024 * 1024;

function positive(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function stringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * The scratch copy's budget, from user settings only: a project could
 * otherwise lift the limits, or exclude files so its checks pass.
 */
export function scratchLimitsFrom(section: InspectableSection): { maxFiles: number; maxBytes: number; maxTotalBytes: number; exclude: string[] } {
  const maxBytes = Math.floor(userValue(section, "maxMegabytes", 1024, positive) * MB);
  return {
    maxFiles: Math.floor(userValue(section, "maxFiles", 50_000, positive)),
    maxBytes,
    maxTotalBytes: Math.max(maxBytes, Math.floor(userValue(section, "maxTotalMegabytes", 4096, positive) * MB)),
    // Plain relative globs only: nothing absolute, no "..".
    exclude: userValue(section, "exclude", [] as string[], stringList).filter((g) => g.trim() && !g.startsWith("/") && !/^[A-Za-z]:/.test(g) && !g.split(/[\\/]/).includes("..")),
  };
}

/**
 * The command that every command is wrapped in (agentic.commands.isolation),
 * from user settings only. An argument list such as
 * ["docker", "run", "--rm", "-v", "${folder}:/work", "-w", "/work", "node:22", "sh", "-c", "${command}"].
 * Unset, empty, or without ${command} anywhere: undefined (commands run directly).
 */
export function commandIsolationFrom(section: InspectableSection): string[] | undefined {
  const argv = userValue(section, "isolation", [] as string[], stringList);
  if (!argv.length || !argv[0]!.trim() || !argv.some((a) => a.includes("${command}"))) return undefined;
  return argv;
}
