import { matchesAny, normalizeWorkspacePath } from "./paths";
import { ToolCall } from "./protocol";

export interface PolicyContext {
  /** Globs the task may write, from its plan entry. */
  fileScope: string[];
  /** Names of checks configured by the user. Workers cannot run arbitrary commands. */
  allowedChecks: string[];
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
      return { verdict: "allow" };
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
      if (matchesAny(p, SENSITIVE)) {
        return { verdict: "ask", reason: `Changing '${p}' needs approval`, path: p };
      }
      return { verdict: "allow", path: p };
    }
  }
}

