# Security notes

What Agentic Code protects, what it cannot protect, and the settings that change it. The README has the short version of each point.

## Scratch copies

Commands (checks, and commands sub-agents run with `run_command`) run in a scratch copy of the project with the pending drafts written in, so they never change your files.

- **Where.** Copies live in VS Code's storage for the extension (`<globalStorage>/scratch/<project>-<hash>/<run>/<task>`), never under the project. In 0.6.1 and earlier they were under `<project>/.agentic/scratch`, and a repository with a tracked link such as `.agentic -> /tmp` could move the copy, and the commands, somewhere else. Nothing in the project decides the location now.
- **Checks on the way.** Every folder level below the extension's folder is checked with `lstat` before anything is created, copied or deleted: a link or anything that is not a plain folder is refused, and the folder may not be inside the project or hold it. Task ids that are not plain names are replaced by a hash, so they cannot add levels.
- **When.** A verification copy is made only after you approve its first check. A sub-agent's copy is made when its first command or check runs.
- **What is left out.** Files that may hold secrets (see below), `.git`, `.agentic`, and anything matching `agentic.scratch.exclude`. Dependency folders named in `agentic.scratch.linkDirs` (empty by default) are linked, not copied; a linked folder is the real one, so a command can change it in the project. Any other link inside the project is copied as the file or folder it points to, never kept as a link, so a command in the copy cannot write through it.
- **Budget.** One copy may hold at most `agentic.scratch.maxFiles` files (default 50,000) and `agentic.scratch.maxMegabytes` (default 1024). All copies that exist at the same time may hold at most `agentic.scratch.maxTotalMegabytes` (default 4096). A project over the budget gets a clear error naming the setting, and the partial copy is removed. All four settings, and `agentic.scratch.exclude`, count in user settings only.
- **Left-over copies.** A copy is removed when its task ends. Copies left behind by a window that closed mid-run are removed after a day, when the extension starts.

## Reading files

Sub-agents read files through the workspace sandbox, which follows links to their real location and refuses anything outside the project or protected.

- A file larger than 16 MB is never read whole; the size is checked on the opened file and no more than the limit is ever read.
- `read_file` reads at most the first 2 MB of a file and says so when a file is longer.
- `search` skips files over 256 KB without reading the rest of them, and stops after 64 MB in total.

## File names in prompts

The project's file list goes to the coordinator and the planner inside `<untrusted_data source="workspace file listing">` tags, with the same rule as research reports: what is inside is data, never instructions. Control characters (including line breaks), Unicode format characters (right-to-left overrides, zero-width characters) and line/paragraph separators in a name are shown as `\u{...}` escapes, in the file list and in `list_files` and `search` results. When the list has to be cut to fit the model's context, it is cut inside its tags, so the fence always closes.

## Secret files: what file names can and cannot do

Sub-agents cannot read, search or change files whose names suggest secrets, and those files are left out of scratch copies. The built-in list covers `.env` files, SSH keys and config, private keys and certificates, `.npmrc`, `.pypirc`, `.netrc`, git credentials, AWS, Azure and Google Cloud credentials, GitHub CLI and Docker credentials, Terraform state and variables, and more (see `src/tools/policy.ts`). The rules apply to the name you ask for and to where a link really leads.

**This is protection by file name, not secret detection.** The extension never looks inside a file to decide whether it holds a secret. A password in `config/local-development.json`, a token in `scripts/deploy.sh` or a key pasted into `README.md` is readable by sub-agents, can end up in a model prompt and in a sub-agent's report, and is copied into scratch copies.

What to do about it:

- Keep secrets out of project folders where you can: environment variables set outside the project, your OS keychain, or a secrets manager.
- Add patterns for your own secret files with `agentic.protectedFiles` (globs relative to the project, such as `config/local-*.json` or `**/*.secrets.yml`). Patterns from your user settings and the project's settings are combined, so a project can add patterns but never remove yours.
- If the model server is not on your own machine, remember that everything a sub-agent reads may be sent to it.

## Commands

**The command runner is not a sandbox.** A check or a command a sub-agent runs starts in the scratch copy, but it runs as you: `npm test`, `python -c ...` or a script in the project can read files elsewhere, use your network, and find credentials on disk. What the extension does:

- Every command needs your approval unless **Run commands** is on in your user settings. Checks from a project's own settings are only suggestions and always ask.
- Commands that obviously point outside the project (absolute paths, `..`, `~`, variables, `$(...)`, `sudo`, `ssh`) are refused. This is a text check, not a boundary.
- Simple commands run without a shell. Environment variables whose names look like credentials, ones that point at credential files or agents, and VS Code's own git and IPC channels are removed.
- Commands have a time limit, can be stopped, and their output is limited and sanitized before it reaches the terminal.

Keep **Run commands** off for projects you do not trust.

### Optional isolation: `agentic.commands.isolation`

For real isolation, set `agentic.commands.isolation` in your user settings to a command that runs another command in a container or sandbox. It is a list of arguments, with three placeholders:

| Placeholder | Filled in with |
| --- | --- |
| `${command}` | The command line, as one argument (required) |
| `${folder}` | The folder the command runs in: the scratch copy, or the project |
| `${project}` | The real project folder (linked folders such as `node_modules` in the copy point into it) |

The wrapper itself is started without a shell, so nothing in it is expanded by the extension. Approval, the outside-the-project text check and the environment clean-up still apply to the command. The terminal shows which wrapper ran it.

Docker or Podman, with no network and only the copy and the project's `node_modules` (read-only) mounted:

```json
"agentic.commands.isolation": [
  "docker", "run", "--rm", "--network=none",
  "-v", "${folder}:${folder}",
  "-v", "${project}/node_modules:${project}/node_modules:ro",
  "-w", "${folder}",
  "node:22", "sh", "-c", "${command}"
]
```

bubblewrap on Linux, with the system read-only, only the copy writable and no network:

```json
"agentic.commands.isolation": [
  "bwrap", "--ro-bind", "/usr", "/usr", "--ro-bind", "/etc", "/etc",
  "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/bin", "/bin",
  "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
  "--bind", "${folder}", "${folder}",
  "--ro-bind", "${project}/node_modules", "${project}/node_modules",
  "--unshare-all", "--die-with-parent", "--chdir", "${folder}",
  "sh", "-c", "${command}"
]
```

Things to know:

- The isolation is only as strong as the wrapper you configure. Mounting your home folder or the whole project (with its `.env` files) into the container gives those back.
- Tools the command needs must exist inside the container or sandbox, and `--network=none` breaks commands that download dependencies.
- The setting counts in user settings only; a project's own settings cannot set or change it. An entry without `${command}` is ignored.

## Skills

Skill text reaches every sub-agent's prompt, so where it comes from matters:

- Built-in skills ship with the extension. User skills are read from the extension's own storage folder (Agentic: Open my skills folder), never from a project or your home folder, and only plain `.md` files directly in it.
- Project skills (`.agentic/skills/*.md`, `AGENTS.md`, `.clinerules`) are read through the workspace sandbox: links that lead outside the project and secret files are refused, files over 32 KB are skipped, and at most 30 files per folder are read. They are used only after the user trusts them in Settings. Trust is stored per folder with a sha256 of each file, so any change to a file needs trust again. `agentic.skills.projectSkills` set to `on` skips that step, and `off` never reads them.
- Project skills are passed to models fenced in `<untrusted_data>` tags with the data rule, both in the planner's skill list and as text in a sub-agent's prompt. Every skill, trusted or not, comes with the rule that a skill is advice and never permission.
- A skill cannot do anything a model could not already ask for. `load_skill` only returns text the extension already holds. Commands a skill mentions go through `run_command` or a check and the usual approval. A skill cannot approve a command, add a check, change the file scope or change a setting. A project skill never replaces a built-in or user skill: on a name clash it is renamed `project-<name>`.
- Agents can never write `.agentic/` (it is protected), so a sub-agent cannot plant a project skill for a later run. It can still draft `AGENTS.md`, which you review like any other change, and a changed file needs trust again anyway.
- Skill names and descriptions are cut to one line with control and invisible formatting characters removed, and bodies to about 600 tokens.

## Settings a project cannot change

These count only in your user settings (or Remote settings in WSL/SSH). A project's `.vscode/settings.json` or `.code-workspace` cannot set them, and the extension warns when one tries: the `agentic.autoApprove.*` switches, `agentic.model.baseUrl`, the API key (kept in VS Code's secret storage), model load limits, `agentic.chat.coordinatorHistoryTokens`, `agentic.chat.autoCompact`, `agentic.delegation.oversight`, `agentic.delegation.maxModelCallsPerRun`, `agentic.delegation.autoRetries`, `agentic.delegation.compactSubAgents`, all `agentic.scratch.*` settings, `agentic.commands.isolation`, `agentic.skills.enabled` and `agentic.skills.projectSkills`.
