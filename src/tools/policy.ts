import { matchesAny, normalizeWorkspacePath } from "./paths";
import { ToolCall } from "./protocol";
import { commandLeavesProject } from "./commandGuard";

export interface PolicyContext {
  /** Globs the task may write, from its plan entry. */
  fileScope: string[];
  /** Names of checks configured by the user. Other commands (run_command) always go to the user or the "Run commands" switch. */
  allowedChecks: string[];
  /** Commands of the allowed checks by name, so a known check can be requested again without asking. */
  knownCommands?: Map<string, string>;
  /**
   * The user reopened this sub-agent after its task ended. Its conversation
   * may carry text it read from project files (possible prompt injection), so
   * every write and every new command needs the user's explicit go-ahead,
   * whatever the auto-approve switches say.
   */
  followUp?: boolean;
}

export type PolicyDecision =
  | { verdict: "allow"; path?: string }
  | { verdict: "deny"; reason: string }
  | { verdict: "ask"; reason: string; path?: string };

/**
 * Never readable or writable: likely to hold secrets or repository internals.
 * Matched without regard to case, because Windows and macOS treat `.ENV` and
 * `.env` as the same file.
 */
export const SECRET = [
  "**/.git",
  "**/.git/**",
  // Environment files
  "**/.env",
  "**/.env.*",
  "**/.envrc",
  // Keys and certificates
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.p8",
  "**/*.jks",
  "**/*.keystore",
  "**/*.ppk",
  "**/*.kdbx",
  "**/id_rsa*",
  "**/id_dsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
  // Credential stores and tool configs that carry tokens
  "**/.ssh",
  "**/.ssh/**",
  "**/.aws",
  "**/.aws/**",
  "**/.azure",
  "**/.azure/**",
  "**/.gnupg",
  "**/.gnupg/**",
  "**/.kube/config",
  "**/.docker/config.json",
  "**/.npmrc",
  "**/.yarnrc.yml",
  "**/.pypirc",
  "**/.netrc",
  "**/_netrc",
  "**/.git-credentials",
  "**/.htpasswd",
  "**/credentials",
  "**/credentials.json",
  "**/client_secret*.json",
  "**/service-account*.json",
  "**/secrets.json",
  "**/secrets.yaml",
  "**/secrets.yml",
  "**/secrets.toml",
  "**/.config/gcloud",
  "**/.config/gcloud/**",
  "**/application_default_credentials.json",
  "**/.config/gh/hosts.yml",
  "**/.config/hub",
  "**/.terraformrc",
  "**/.terraform.d/credentials.tfrc.json",
  "**/*.tfvars",
  "**/*.tfstate",
  "**/*.tfstate.*",
];

/** More secret patterns from the user's setting agentic.protectedFiles. Treated like the built-in list. */
let extraSecrets: string[] = [];

export function setExtraSecretPatterns(globs: unknown): void {
  extraSecrets = Array.isArray(globs) ? globs.filter((g): g is string => typeof g === "string" && g.trim() !== "").map((g) => g.trim().replace(/\\/g, "/")) : [];
}

/** Templates that only show which variables exist. They are safe to read and change. */
const SECRET_EXCEPTIONS = ["**/.env.example", "**/.env.sample", "**/.env.template", "**/.env.dist"];

/**
 * Never writable, whatever a task's scope says or a switch allows: secrets,
 * the extension's own state, and files that make VS Code change settings or
 * run commands on its own.
 */
const PROTECTED_EXTRA = [".agentic", ".agentic/**", ".vscode/settings.json", ".vscode/tasks.json", "**/*.code-workspace"];

/**
 * Writable only with the user's approval (or the "sensitive files" switch):
 * files that decide which commands run, such as package scripts, lockfiles,
 * build files of other languages, CI, dev containers, git hooks and the rest
 * of .vscode. A change to one of these can make `npm test`, `make` or
 * `pytest` run something new, so it is never accepted with ordinary edits.
 */
const SENSITIVE = [
  "**/package.json",
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/bun.lockb",
  "**/.yarnrc",
  "**/.pnpmfile.cjs",
  "**/.pnpmfile.js",
  // Make, CMake, just, Task and other task runners
  "**/Makefile",
  "**/GNUmakefile",
  "**/*.mk",
  "**/CMakeLists.txt",
  "**/CMakePresets.json",
  "**/*.cmake",
  "**/meson.build",
  "**/justfile",
  "**/.justfile",
  "**/Taskfile.yml",
  "**/Taskfile.yaml",
  "**/Taskfile.dist.yml",
  "**/Taskfile.dist.yaml",
  "**/Rakefile",
  "**/Gemfile",
  "**/Gemfile.lock",
  "**/*.gemspec",
  // Bazel, SCons
  "**/BUILD",
  "**/BUILD.bazel",
  "**/WORKSPACE",
  "**/WORKSPACE.bazel",
  "**/MODULE.bazel",
  "**/*.bzl",
  "**/.bazelrc",
  "**/SConstruct",
  "**/SConscript",
  // Python
  "**/pyproject.toml",
  "**/setup.py",
  "**/setup.cfg",
  "**/tox.ini",
  "**/noxfile.py",
  "**/pytest.ini",
  "**/conftest.py",
  "**/requirements*.txt",
  "**/Pipfile",
  "**/Pipfile.lock",
  "**/poetry.lock",
  "**/uv.lock",
  // JVM
  "**/build.gradle",
  "**/build.gradle.kts",
  "**/settings.gradle",
  "**/settings.gradle.kts",
  "**/gradle.properties",
  "**/gradlew",
  "**/gradlew.bat",
  "**/gradle/wrapper/**",
  "**/pom.xml",
  "**/mvnw",
  "**/mvnw.cmd",
  "**/.mvn/**",
  "**/build.sbt",
  // Rust, Go, .NET, PHP, containers
  "**/Cargo.toml",
  "**/Cargo.lock",
  "**/build.rs",
  "**/.cargo/config",
  "**/.cargo/config.toml",
  "**/go.mod",
  "**/go.sum",
  "**/Directory.Build.props",
  "**/Directory.Build.targets",
  "**/*.csproj",
  "**/composer.json",
  "**/composer.lock",
  "**/Dockerfile",
  "**/Dockerfile.*",
  "**/docker-compose*.yml",
  "**/docker-compose*.yaml",
  "**/compose.yml",
  "**/compose.yaml",
  ".pre-commit-config.yaml",
  // CI outside .github
  "**/Jenkinsfile",
  "**/azure-pipelines.yml",
  "**/azure-pipelines.yaml",
  ".circleci/**",
  ".buildkite/**",
  "bitbucket-pipelines.yml",
  ".travis.yml",
  ".github/**",
  ".gitlab-ci.yml",
  ".devcontainer/**",
  ".husky/**",
  ".githooks/**",
  ".vscode/**",
  ".gitmodules",
];

/**
 * The form of a path used for matching against the lists above: Windows
 * ignores trailing dots and spaces in names (".env." is ".env") and treats
 * "name:stream" as the file "name".
 */
function matchForm(p: string): string {
  return p
    .split("/")
    .map((seg) => seg.replace(/:.*$/, "").replace(/[. ]+$/, "") || seg)
    .join("/");
}

function matchesNoCase(p: string, globs: string[]): boolean {
  const m = matchForm(p);
  return matchesAny(m, globs, { nocase: true }) || matchesAny(p, globs, { nocase: true });
}

/** Whether a workspace-relative path may hold secrets. Such files are never read, searched, copied to the scratch copy or written. */
export function isSecretPath(path: string): boolean {
  const p = normalizeWorkspacePath(path);
  if (!p) return false;
  if (extraSecrets.length && matchesNoCase(p, extraSecrets)) return true;
  return matchesNoCase(p, SECRET) && !matchesAny(p, SECRET_EXCEPTIONS, { nocase: true });
}

export function checkToolCall(call: ToolCall, ctx: PolicyContext): PolicyDecision {
  switch (call.tool) {
    case "finish":
    case "ask_user":
    case "ask_coordinator":
    case "load_skill":
      // load_skill reads text the extension already holds: no file access, no command.
      return { verdict: "allow" };
    case "request_check": {
      const outside = commandLeavesProject(call.command);
      if (outside) return { verdict: "deny", reason: `The command \`${call.command}\` is not allowed. ${outside} Commands run in the project folder.` };
      // A new command always needs the user's go-ahead; workers cannot run commands on their own.
      return !ctx.followUp && ctx.allowedChecks.includes(call.name) && ctx.knownCommands?.get(call.name) === call.command
        ? { verdict: "allow" }
        : { verdict: "ask", reason: `Run the command \`${call.command}\` as check "${call.name}": ${call.reason}` };
    }
    case "run_command": {
      const outside = commandLeavesProject(call.command);
      if (outside) return { verdict: "deny", reason: `The command \`${call.command}\` is not allowed. ${outside} Commands run in the project folder.` };
      // Every command is shown first; only the user's "Run commands" switch, or the user's own approval, lets it run.
      return { verdict: "ask", reason: `Run \`${call.command}\`${call.reason ? `: ${call.reason}` : ""}` };
    }
    case "run_check":
      if (!ctx.allowedChecks.includes(call.name)) {
        return { verdict: "deny", reason: `Unknown check '${call.name}'. Available: ${ctx.allowedChecks.join(", ") || "none"}` };
      }
      // A reopened sub-agent runs even a configured check only with the user's go-ahead for that one run.
      if (ctx.followUp) {
        const command = ctx.knownCommands?.get(call.name);
        return { verdict: "ask", reason: `Run the check "${call.name}"${command ? ` (\`${command}\`)` : ""}` };
      }
      return { verdict: "allow" };
    case "list_files":
    case "search": {
      const glob = call.glob;
      if (glob !== undefined && !normalizeWorkspacePath(glob)) {
        return { verdict: "deny", reason: `'${glob}' must be a relative glob inside the workspace` };
      }
      return { verdict: "allow" };
    }
    case "read_files": {
      // Check 2026-11-09: blank entries (" ") made whole calls fail; they are skipped instead.
      const paths = call.paths.filter((x) => x.trim());
      if (!paths.length) return { verdict: "deny", reason: "read_files needs at least one file path" };
      for (const raw of paths) {
        const p = normalizeWorkspacePath(raw);
        if (!p) return { verdict: "deny", reason: `'${raw}' is outside the workspace` };
        if (isSecretPath(p)) return { verdict: "deny", reason: `'${p}' may contain secrets and cannot be read; leave it out` };
      }
      return { verdict: "allow" };
    }
    case "read_file": {
      const p = normalizeWorkspacePath(call.path);
      if (!p) return { verdict: "deny", reason: `'${call.path}' is outside the workspace` };
      if (isSecretPath(p)) {
        return { verdict: "deny", reason: `'${p}' may contain secrets and cannot be read` };
      }
      return { verdict: "allow", path: p };
    }
    case "write_file":
    case "replace_in_file":
    case "insert_lines": {
      const p = normalizeWorkspacePath(call.path);
      if (!p) return { verdict: "deny", reason: `'${call.path}' is outside the workspace` };
      if (isProtectedPath(p)) return { verdict: "deny", reason: `'${p}' is protected` };
      if (!matchesAny(p, ctx.fileScope)) {
        return {
          verdict: "deny",
          reason: `'${p}' is outside this task's file scope (${ctx.fileScope.join(", ")}). Only change files in scope.`,
        };
      }
      if (ctx.followUp) {
        return { verdict: "ask", path: p, reason: `Draft a change to ${p} in a reopened conversation` };
      }
      // Writes stay pending until the user accepts them (or an auto-approve switch does), so they need no question here.
      return { verdict: "allow", path: p };
    }
  }
}


/** package.json files, lockfiles, build files, CI, dev containers, git hooks and .vscode: accepted only by the user, or by the "sensitive files" switch. */
export function isSensitivePath(path: string): boolean {
  const p = normalizeWorkspacePath(path);
  return p !== undefined && matchesNoCase(p, SENSITIVE);
}

/** The auto-approve switches, mirrored from settings. */
export interface AutoApprove {
  editFiles: boolean;
  sensitiveFiles: boolean;
  commands: boolean;
}

/** Never writable, whatever is accepted: .git, secrets, .agentic, VS Code settings and tasks, workspace files. */
export function isProtectedPath(path: string): boolean {
  const p = normalizeWorkspacePath(path);
  return !p || isSecretPath(p) || matchesNoCase(p, PROTECTED_EXTRA);
}

/** Whether a pending change may be written without the user, given the switches. */
export function isChangeAutoAccepted(path: string, auto: AutoApprove): boolean {
  return isSensitivePath(path) ? auto.sensitiveFiles : auto.editFiles;
}

/** Whether the user's auto-approve switches already allow a call the policy flagged. */
export function isAutoApproved(call: ToolCall, auto: AutoApprove): boolean {
  if (call.tool === "request_check" || call.tool === "run_command") return auto.commands;
  if (call.tool === "write_file" || call.tool === "replace_in_file" || call.tool === "insert_lines") return isSensitivePath(call.path) ? auto.sensitiveFiles : auto.editFiles;
  return false;
}

/**
 * Whether a configured check may run without asking. The "Run commands"
 * switch covers only commands from the user's own settings or ones the user
 * approved; a command a project supplies in its own settings is always shown.
 */
export function isCheckAutoApproved(commandsSwitch: boolean, trusted: ReadonlySet<string>, command: string): boolean {
  return commandsSwitch && trusted.has(command);
}
