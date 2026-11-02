import { CheckConfig } from "./runner";

export interface DetectedCheck extends CheckConfig {
  /** Why this command was suggested, e.g. "package.json script". */
  source: string;
}

/** Reads a file relative to the project root, or undefined if it is missing or unreadable. */
export type ReadFile = (path: string) => Promise<string | undefined>;

/** The npm default "test" script, which always fails. */
const NPM_PLACEHOLDER = /no test specified/;

/**
 * Suggests check commands from the files a project has. Deterministic, so it
 * works the same with any model, and the user approves before anything runs.
 * `files` is the project's file list (relative paths); only top-level and
 * well-known files are read.
 */
export async function detectChecks(files: string[], read: ReadFile): Promise<DetectedCheck[]> {
  const has = new Set(files);
  const top = (name: string) => has.has(name);
  const any = (re: RegExp) => files.some((f) => re.test(f));
  const out: DetectedCheck[] = [];
  const add = (name: string, command: string, source: string) => {
    if (!out.some((c) => c.name === name)) out.push({ name, command, source });
  };

  // JavaScript / TypeScript
  if (top("package.json")) {
    const runner = top("pnpm-lock.yaml") ? "pnpm" : top("yarn.lock") ? "yarn" : top("bun.lockb") || top("bun.lock") ? "bun" : "npm";
    const run = (script: string) => (runner === "npm" ? (script === "test" ? "npm test" : `npm run ${script}`) : `${runner} ${script}`);
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse((await read("package.json")) ?? "{}") as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      // A broken package.json just means no script suggestions.
    }
    if (scripts.test && !NPM_PLACEHOLDER.test(scripts.test)) add("test", run("test"), "package.json script");
    if (scripts.lint) add("lint", run("lint"), "package.json script");
    const typecheck = ["typecheck", "type-check", "tsc", "check-types"].find((s) => scripts[s]);
    if (typecheck) add("typecheck", run(typecheck), "package.json script");
    else if (top("tsconfig.json")) add("typecheck", "npx tsc --noEmit", "tsconfig.json");
  }

  // Python
  const pyproject = top("pyproject.toml") ? ((await read("pyproject.toml")) ?? "") : "";
  const isPython = top("pyproject.toml") || top("setup.py") || top("setup.cfg") || top("requirements.txt") || any(/^[^/]+\.py$/);
  if (isPython) {
    if (top("pytest.ini") || /\[tool\.pytest/.test(pyproject) || any(/(^|\/)tests?\/.*\.py$/) || any(/(^|\/)test_[^/]*\.py$/)) {
      add("test", "python -m pytest -q", "Python tests found");
    }
    if (top("ruff.toml") || top(".ruff.toml") || /\[tool\.ruff/.test(pyproject)) add("lint", "ruff check .", "ruff config");
    else if (top(".flake8") || /\[flake8\]/.test((await read("setup.cfg")) ?? "")) add("lint", "python -m flake8", "flake8 config");
    if (top("mypy.ini") || /\[tool\.mypy/.test(pyproject)) add("typecheck", "python -m mypy .", "mypy config");
  }

  // Rust
  if (top("Cargo.toml")) {
    add("test", "cargo test", "Cargo.toml");
    add("typecheck", "cargo check", "Cargo.toml");
  }

  // Go
  if (top("go.mod")) {
    add("test", "go test ./...", "go.mod");
    add("lint", "go vet ./...", "go.mod");
  }

  // .NET
  if (any(/^[^/]+\.(sln|csproj|fsproj)$/)) add("test", "dotnet test", ".NET project");

  // JVM
  if (top("gradlew")) add("test", "./gradlew test", "Gradle wrapper");
  else if (top("pom.xml")) add("test", "mvn -q test", "pom.xml");

  // Make, as a fallback for anything else
  if (top("Makefile") && !out.some((c) => c.name === "test")) {
    if (/^test:/m.test((await read("Makefile")) ?? "")) add("test", "make test", "Makefile target");
  }

  return out;
}
