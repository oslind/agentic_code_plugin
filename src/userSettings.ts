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
 * coordinator makes on its own (progress checks, check-ins, result reviews,
 * verification and its fix-up rounds), and the per-run cap on all model
 * calls. A project could otherwise turn a run into many more requests to
 * your model server.
 */
export const USER_ONLY_DELEGATION_KEYS = ["checkIns", "progressEvery", "reviewRounds", "maxModelCallsPerRun", "verify", "verifyRounds", "autoRetries"] as const;

/** Times a failed sub-agent is started again on its own, 0 (off) to 3, default 1. From user settings only: each retry calls the model again. */
export function autoRetriesFrom(section: InspectableSection): number {
  return Math.max(0, Math.min(3, Math.floor(userValue(section, "autoRetries", 1, isNumber))));
}

/** Whether the coordinator verifies a request, and its most fix-up rounds (0 to 5), from user settings only. */
export function verificationFrom(section: InspectableSection): { verify: boolean; verifyRounds: number } {
  return {
    verify: userValue(section, "verify", true, isBoolean),
    verifyRounds: Math.max(0, Math.min(5, Math.floor(userValue(section, "verifyRounds", 2, isNumber)))),
  };
}

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

/** Longest reply in tokens, from user settings only. 0 means no limit. */
export function maxOutputTokensFrom(section: InspectableSection): number {
  return Math.max(0, Math.floor(userValue(section, "maxOutputTokens", 0, isNumber)));
}

/** Most tokens of earlier conversation sent with each coordinator message, from user settings only. 0 means as much as fits. */
export function coordinatorHistoryTokensFrom(section: InspectableSection): number {
  return Math.max(0, Math.floor(userValue(section, "coordinatorHistoryTokens", 12000, isNumber)));
}

export interface OversightLimits {
  /** Looks at a sub-agent that seems stuck, per sub-agent. 0 to 5, default 2. */
  checkIns: number;
  /** Steps between regular progress looks. 0 (off) to 40, default 8. */
  progressEvery: number;
  /** Times a result may be sent back, per task. 0 (no review) to 3, default 1. */
  reviewRounds: number;
  /** Most model calls one run may make, sub-agents and coordinator together. 0 means no limit. Default 500. */
  maxModelCallsPerRun: number;
}

const clampInt = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.floor(v)));

/** How much the coordinator oversees sub-agents, and the per-run model-call cap, from user settings only. */
export function oversightLimitsFrom(section: InspectableSection): OversightLimits {
  return {
    checkIns: clampInt(userValue(section, "checkIns", 2, isNumber), 0, 5),
    progressEvery: clampInt(userValue(section, "progressEvery", 8, isNumber), 0, 40),
    reviewRounds: clampInt(userValue(section, "reviewRounds", 1, isNumber), 0, 3),
    maxModelCallsPerRun: clampInt(userValue(section, "maxModelCallsPerRun", 500, isNumber), 0, 100000),
  };
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
