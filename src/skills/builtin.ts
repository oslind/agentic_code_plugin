import { hashText, Skill, SkillRole } from "./skill";

/**
 * Skills shipped with the extension. Written for small local models: short
 * numbered steps that name the tools to use, and one or two "never" rules.
 * Each stays well under MAX_SKILL_CHARS.
 */
const BUILTIN: { name: string; description: string; roles: SkillRole[]; body: string }[] = [
  // ---- task skills ----
  {
    name: "run-tests",
    description: "Find the project's test command, run the tests that cover a change, and read the failures",
    roles: ["coder", "research"],
    body: `1. Find the test command: look in package.json "scripts", Makefile, CMakeLists.txt, pyproject.toml, setup.cfg, tox.ini, Cargo.toml or go.mod. Prefer a configured check (run_check) when one fits.
2. Run the tests nearest to the changed files first (one test file or one test name), then the whole suite.
3. Read the output from the first failure, not the last line. Note the test name, the file and line, and the expected and actual values.
4. If the test command itself fails (missing tool, missing dependency), say so in your summary instead of guessing.
5. Never change or delete a test only to make it pass. Never skip tests. If a test is wrong, say why in your summary.`,
  },
  {
    name: "fix-failing-test",
    description: "Reproduce a failing test or error, find its cause and make the smallest fix",
    roles: ["coder"],
    body: `1. Reproduce first: run the failing test or command with run_command and keep its exact output.
2. Read the error or stack trace and find the first frame in the project's own code. Open that file with read_file around that line.
3. Find the cause before changing anything: read the function, its callers (use search) and the test's expectation.
4. Make the smallest change that fixes the cause, with replace_in_file. Do not rewrite unrelated code.
5. Run the same command again. If it still fails, read the new output; do not repeat the same fix.
6. Then run the related tests so the fix breaks nothing else.
7. In the summary, say what the cause was, what you changed and which command now passes.`,
  },
  {
    name: "small-refactor",
    description: "Change the structure of code without changing what it does",
    roles: ["coder"],
    body: `1. Read the code and write down (in your thought) what it does now: inputs, outputs, errors.
2. Find every use of what you rename or move with search, including tests and docs.
3. Change one thing at a time with replace_in_file, and update every caller in your files.
4. Keep behaviour the same: same results, same errors, same public names unless the task says otherwise.
5. Run the type check or build after the change, then the tests.
6. If a caller is outside the files you may change, do not change it: ask the coordinator.
7. In the summary, list what moved or was renamed, and anything left for another task.`,
  },
  {
    name: "add-feature-with-test",
    description: "Add new behaviour together with a test for it, in the project's own style",
    roles: ["coder"],
    body: `1. Find where similar code lives (search, list_files) and read one nearby example.
2. Find an existing test for similar code and copy its style: file name, imports, how it sets up and asserts.
3. Write the code, then a test that fails without it: the normal case and one edge case (empty input, error, limit).
4. Run only the new test first, then the whole suite.
5. Do not add new dependencies unless the task asks; if you need one, ask the coordinator.
6. In the summary, name the new code, the new test and the command that runs it.`,
  },
  {
    name: "write-docs",
    description: "Write or update README files, guides and doc comments without changing code",
    roles: ["coder"],
    body: `1. Read the existing docs first and match their headings, tone and formatting.
2. Only document what the code really does: read the code, and check every command you mention in package.json, the Makefile or the build files.
3. Keep it short: what it is, how to install, how to use, with one example that works.
4. Do not change code in a docs task. If you find a bug, mention it in your summary.
5. Do not add tests or checks for documentation.`,
  },
  // ---- research skills ----
  {
    name: "explore-codebase",
    description: "Map an unfamiliar project: what it does, how it is built, where the main code is",
    roles: ["research"],
    body: `1. Read README.md and the package or build file (package.json, CMakeLists.txt, pyproject.toml, Cargo.toml, go.mod).
2. list_files with a broad glob, then narrow down to the source folders.
3. Find the entry points: main files, exported modules, CLI commands, server routes.
4. Find how to build, test and lint it, from the scripts or build files.
5. Report a short map: the main folders and files with one line each, the entry points, and the build and test commands. Name files; do not paste whole files.`,
  },
  {
    name: "review-code",
    description: "Review code or a change for bugs and risks, and report findings with file and line",
    roles: ["research"],
    body: `Read the code, then go through this list:
1. Correctness: wrong conditions, off-by-one, missing returns, wrong types, unhandled null or empty input.
2. Errors: exceptions swallowed, errors not checked, resources not closed.
3. Edge cases: empty lists, large input, concurrency, time zones, encodings.
4. Security: input used in shell commands, SQL, file paths or HTML without escaping; secrets in code.
5. Tests: is the changed behaviour tested?
Report each finding as: file:line, what is wrong, why it matters, a suggested fix. Most important first. Say clearly when you found nothing serious. Do not change files.`,
  },
  // ---- language skills ----
  {
    name: "cpp",
    description: "Work in a C or C++ project: build system, compiler errors, tests",
    roles: ["coder", "research"],
    body: `1. Find the build system: CMakeLists.txt (CMake), Makefile, meson.build, or a build script. The cmake and make skills say how to work with those.
2. Build with it before and after a change, so you know which errors are yours.
3. Read the FIRST compiler error, not the last: later errors often follow from it. Note file, line and message.
4. Keep headers and sources in step: a changed signature in a .h/.hpp must match the .cpp and every caller (use search).
5. Tests: "ctest --test-dir build --output-on-failure", or the project's test target. Run one test with ctest -R name.
6. Follow the project's style: its C++ standard (CMAKE_CXX_STANDARD), .clang-format, naming, and smart pointers instead of new/delete in modern code.
7. Never commit build output, and do not add new libraries without asking the coordinator.`,
  },
  {
    name: "javascript-typescript",
    description: "Work in a JavaScript or TypeScript project: package scripts, type check, lint, tests",
    roles: ["coder", "research"],
    body: `1. Read package.json: "scripts" tells you how to build, test and lint. Use the package manager the lock file names: package-lock.json = npm, pnpm-lock.yaml = pnpm, yarn.lock = yarn, bun.lockb = bun.
2. Run scripts as "npm run <name>" (or pnpm/yarn). Do not install packages unless the task asks for it.
3. TypeScript: run "npx tsc --noEmit" (or the typecheck script) after a change and fix type errors; do not use "any" or @ts-ignore to silence them.
4. Lint: run the lint script (eslint) on the files you changed.
5. Tests: jest or vitest. Run one file first ("npx vitest run path" or "npx jest path"), then the whole suite.
6. Follow the project's module style (import/export or require), its formatter (.prettierrc) and its file layout.
7. Never edit node_modules, dist or other build output, and never add a dependency without saying so in your summary.`,
  },
  {
    name: "python",
    description: "Work in a Python project: environment, pytest, linters and formatter",
    roles: ["coder", "research"],
    body: `1. Find the setup: pyproject.toml, setup.cfg, requirements*.txt, tox.ini, uv.lock or poetry.lock. Use the project's environment: .venv/bin/python if it exists, or "uv run", or "poetry run".
2. Tests: "python -m pytest -x -q path/to/test_file.py" first, then the whole suite. -x stops at the first failure so the output stays short.
3. Read a failure from the "E" lines and the last frame in the project's code.
4. Lint and types if the project uses them: "ruff check", "flake8", "mypy" (look in pyproject.toml or the CI config).
5. Format with the project's formatter only: "ruff format" or "black", matching its config.
6. Follow the existing style: type hints if the code has them, the same import order, and pathlib or os.path as the code already does.
7. Do not install packages or change requirements unless the task asks, and never edit files inside the virtual environment.`,
  },
  // ---- build system skills ----
  {
    name: "cmake",
    description: "Work with CMake builds: configure, build, targets, CMakeLists.txt changes, ctest",
    roles: ["coder", "research"],
    body: `1. Read the top CMakeLists.txt first, then the one in the folder you work in. Look for project(), add_executable/add_library, target_link_libraries, add_subdirectory, enable_testing/add_test.
2. Use an existing build folder (build/, out/build/*, cmake-build-*) or a preset (CMakePresets.json: "cmake --preset <name>"). Otherwise configure with "cmake -S . -B build".
3. Build with "cmake --build build" (add "--target <name>" for one target, "-j 4" for speed). After a CMakeLists.txt change, configure again before building.
4. Read the first error. A "No such file" for a header usually means a missing target_include_directories; an "undefined reference" usually means a missing target_link_libraries or a source file not listed in the target.
5. Prefer target-based commands (target_sources, target_include_directories, target_compile_options with PRIVATE/PUBLIC) over global ones (include_directories, add_definitions, CMAKE_CXX_FLAGS).
6. A new source file must be added to its target; a new test to add_test (or the project's test helper). Run tests with "ctest --test-dir build --output-on-failure", one test with -R name.
7. Never edit files inside the build folder or CMakeCache.txt, and do not add find_package or FetchContent dependencies without asking the coordinator.`,
  },
  {
    name: "make",
    description: "Work with Makefiles: targets, rules, variables, and reading make output",
    roles: ["coder", "research"],
    body: `1. Read the Makefile (also GNUmakefile, *.mk files it includes). Find the targets: all, build, test, check, clean, install. "make -n <target>" shows the commands without running them.
2. Build with "make" or "make <target>"; "make -j4" builds in parallel. Use "make -C sub" for a Makefile in a subfolder.
3. Read the first error: make prints "make: *** [target] Error N" after the real error from the compiler or command above it.
4. Recipe lines must start with a TAB, not spaces. "missing separator" means spaces were used.
5. Know the variables: CC, CXX, CFLAGS, CXXFLAGS, LDFLAGS, LDLIBS; $@ is the target, $< the first prerequisite, $^ all prerequisites. Mark targets that are not files with .PHONY.
6. A new source file must be added where the Makefile lists sources (a SRCS variable, or a wildcard). Keep the existing style: the same variable names and pattern rules.
7. If the Makefile is generated (by CMake, autotools, or qmake), change the source (CMakeLists.txt, Makefile.am, configure.ac) instead. Do not run "make install" or anything that writes outside the project.`,
  },
  // ---- coordinator skills ----
  {
    name: "plan-bug-fix",
    description: "How to split a bug report into tasks",
    roles: ["coordinator"],
    body: `For a bug: if the cause is not known yet, start with one task that reproduces it and finds the cause (it may run commands). Then one fix task per file that has to change, depending on the first task. Give the fix tasks the skill fix-failing-test, and a language skill that matches their files. Put the exact error message and the steps to reproduce in each task's instructions.`,
  },
  {
    name: "plan-refactor",
    description: "How to split a refactor or rename across many files into tasks",
    roles: ["coordinator"],
    body: `For a refactor or a rename across files: one task per module or folder. A task that changes a shared definition (a type, an interface, a header) comes first; tasks that update its callers depend on it. Copy the exact old and new names into every task's instructions. Give the tasks the skill small-refactor and a language skill that matches their files.`,
  },
];

export function builtinSkills(): Skill[] {
  return BUILTIN.map((s) => ({ ...s, source: "builtin" as const, hash: hashText(s.body) }));
}
