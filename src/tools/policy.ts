import { matchesAny, normalizeWorkspacePath } from "./paths";
import { ToolCall } from "./protocol";
import { commandLeavesProject } from "./commandGuard";

export interface PolicyContext {
  /** Globs the task may write, from its plan entry. */
  fileScope: string[];
  /** Names of checks configured by the user. Workers cannot run arbitrary commands. */
  allowedChecks: string[];
  /** Commands of the allowed checks by name, so a known check can be requested again without asking. */
  knownCommands?: Map<string, string>;
}

export type PolicyDecision =
  | { verdict: "allow"; path?: string }
  | { verdict: "deny"; reason: string }
  | { verdict: "ask"; reason: string; path?: string };

/** Never readable or writable: likely to hold secrets or repository internals. */
const SECRET = [".git/**", ".git", "**/.env", "**/.env.*", "**/*.pem", "**/*.key"];

/** Never writable, whatever a task's scope says. */
const PROTECTED = [...SECRET, ".vscode/settings.json", ".agentic/**"];

/** Writable only with the user's approval. */
const SENSITIVE = ["package.json", "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml", ".github/**"];

export function checkToolCall(call: ToolCall, ctx: PolicyContext): PolicyDecision {
  switch (call.tool) {
    case "finish":
    case "ask_user":
      return { verdict: "allow" };
    case "request_check": {
      const outside = commandLeavesProject(call.command);
      if (outside) return { verdict: "deny", reason: `The command \`${call.command}\` is not allowed. ${outside} Commands run in the project folder.` };
      // A new command always needs the user's go-ahead; workers cannot run commands on their own.
      return ctx.allowedChecks.includes(call.name) && ctx.knownCommands?.get(call.name) === call.command
        ? { verdict: "allow" }
        : { verdict: "ask", reason: `Run the command \`${call.command}\` as check "${call.name}": ${call.reason}` };
    }
    case "run_check":
      return ctx.allowedChecks.includes(call.name)
        ? { verdict: "allow" }
        : { verdict: "deny", reason: `Unknown check '${call.name}'. Available: ${ctx.allowedChecks.join(", ") || "none"}` };
    case "list_files":
    case "search": {
      const glob = call.glob;
      if (glob !== undefined && !normalizeWorkspacePath(glob)) {
        return { verdict: "deny", reason: `'${glob}' must be a relative glob inside the workspace` };
      }
      return { verdict: "allow" };
    }
    case "read_file": {
      const p = normalizeWorkspacePath(call.path);
      if (!p) return { verdict: "deny", reason: `'${call.path}' is outside the workspace` };
      if (matchesAny(p, SECRET)) {
        return { verdict: "deny", reason: `'${p}' may contain secrets and cannot be read` };
      }
      return { verdict: "allow", path: p };
    }
    case "write_file":
    case "replace_in_file": {
      const p = normalizeWorkspacePath(call.path);
      if (!p) return { verdict: "deny", reason: `'${call.path}' is outside the workspace` };
      if (matchesAny(p, PROTECTED)) return { verdict: "deny", reason: `'${p}' is protected` };
      if (!matchesAny(p, ctx.fileScope)) {
        return {
          verdict: "deny",
          reason: `'${p}' is outside this task's file scope (${ctx.fileScope.join(", ")}). Only change files in scope.`,
        };
      }
      // Writes stay pending until the user accepts them (or an auto-approve switch does), so they need no question here.
      return { verdict: "allow", path: p };
    }
  }
}


/** package.json, lockfiles and CI files: accepted only by the user, or by the "sensitive files" switch. */
export function isSensitivePath(path: string): boolean {
  const p = normalizeWorkspacePath(path);
  return p !== undefined && p !== null && matchesAny(p, SENSITIVE);
}

/** The auto-approve switches, mirrored from settings. */
export interface AutoApprove {
  editFiles: boolean;
  sensitiveFiles: boolean;
  commands: boolean;
}

/** Never writable, whatever is accepted: .git, secrets, .agentic and VS Code settings. */
export function isProtectedPath(path: string): boolean {
  const p = normalizeWorkspacePath(path);
  return !p || matchesAny(p, PROTECTED);
}

/** Whether a pending change may be written without the user, given the switches. */
export function isChangeAutoAccepted(path: string, auto: AutoApprove): boolean {
  return isSensitivePath(path) ? auto.sensitiveFiles : auto.editFiles;
}

/** Whether the user's auto-approve switches already allow a call the policy flagged. */
export function isAutoApproved(call: ToolCall, auto: AutoApprove): boolean {
  if (call.tool === "request_check") return auto.commands;
  if (call.tool === "write_file" || call.tool === "replace_in_file") return isSensitivePath(call.path) ? auto.sensitiveFiles : auto.editFiles;
  return false;
}
