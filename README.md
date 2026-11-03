# agentic_code_plugin

A Cline-like VS Code extension that coordinates a main agent and multiple specialized sub-agents, designed to work well with small local models (for example qwen3.8-27b served by Ollama, LM Studio or vLLM).

## Status

All four planned steps are in: skeleton, coordinator, parallel workers and recovery.

What works now:

- A provider for any OpenAI-compatible server (Ollama, LM Studio, vLLM, llama.cpp).
- Structured output built for small models: strips `<think>` blocks, code fences and prose, validates against a schema, and retries with the error as feedback.
- A coordinator that turns a request into at most 8 dependency-ordered tasks, each with a file scope. Plans are checked for duplicate ids, unknown dependencies, cycles and paths outside the workspace, and the model is asked to fix them. Tasks that could write the same files are ordered automatically so they never run at the same time.
- Context budgeting that fits prompts into the configured context window, dropping or cutting low-priority context first.
- A one-tool-per-turn worker protocol with a policy check: writes must stay in the task's file scope, secrets and `.git` are off limits, `package.json` files, lockfiles, CI and other files that decide which commands run follow their own switch, and only configured checks can run.
- A workspace sandbox: agents can only reach the folder open in VS Code. Every path is resolved to its real location on disk, so symlinks that point outside are refused for reads, writes and listings. Writes open files with `O_NOFOLLOW`. The extension only runs in trusted workspaces.
- **No git.** The extension never runs git, creates branches or commits. The project folder does not need to be a git repository.
- **You review every change.** A sub-agent's writes stay in memory as pending changes. Nothing is written to your project until you accept it:
  - a new file opens as a new editor tab with the proposed text;
  - an edit to an existing file opens VS Code's side-by-side diff (current file on the left, proposed version on the right), with removed, changed and added lines highlighted;
  - each change has **Accept** and **Reject** buttons in the chat, plus **Accept all** and **Reject all** when there are several. No popups.
  - If you edited the file yourself in the meantime, Accept warns you first, and a second Accept overwrites it.
  - Changes show up when a sub-agent finishes, and also right before it asks you a question, so you can see the draft the question is about. If you accept a draft and the sub-agent keeps editing that file, its next draft is a diff on top of what you accepted.
  - The **Drafts** tab is the receipt: every draft in this conversation as a card with its status (**Draft** = waiting for you, **Accepted** = written to the project, **Rejected** = discarded), the sub-agent that drafted it and its +/- line counts. Switch between **All files** (default) and **By agent**, click a file to open its diff or the drafted new file, and use **Accept all drafts** / **Reject all** at the bottom. Decided drafts fold away under **Decided**. An unaccepted draft is never called written, created or modified.
- Parallel workers without git. Tasks that run at the same time have separate files (the planner makes tasks that share files wait for each other). A task that depends on another sees that task's pending changes, so it can build on them before you accept anything.
- Verification by your own checks, not the worker's word. The checks run on a scratch copy of the project with the pending changes written in (`.agentic/scratch/`, removed afterwards; `node_modules` is linked, not copied, see `agentic.scratch.linkDirs`). Failures go back to the worker to fix (`agentic.worker.maxFixRounds`). Your files are never touched by a check.
- Recovery:
  - **Resume.** When VS Code starts, runs that were interrupted are offered for resume. Running tasks start again.
  - **Retry.** Failed or cancelled tasks can be retried one at a time or all together. The worker is told why the last attempt failed and shown what it had written.
  - **Transient failures.** When the model server is briefly unreachable, requests are retried with backoff, and tasks are retried automatically up to 3 attempts.
  - **Cancel one task** without stopping the run, or cancel the whole run.
  - **Stop all.** While anything is running, the **Stop all** button in the execution summary (always visible at the top of Overview) or **Esc** stops the coordinator and every sub-agent at once: model calls are aborted, running check commands are killed together with everything they started, and open questions are closed. What the sub-agents had drafted stays under **Drafts** to Accept or Reject; nothing is written, even with Edit files on.
  - **Finished banner.** When the coordinator has dealt with the last prompt, a **Finished** banner shows under the execution summary, with the time, how many drafts await review, how many were rejected and how many checks ran, plus **Review drafts**. Finished does not mean the drafts were accepted. It turns amber when you stopped the work or some tasks did not complete, and red when it failed. It disappears as soon as you send a new prompt.
- A **chat sidebar** laid out as an orchestration dashboard that works at 350-400px. The prompt is fixed at the bottom with the Plan/Act switch, **Attach files** (paths inside the project only; the coordinator passes them to its sub-agents), the model and version, and what is auto-approved. Above it are four tabs:
  - **Overview**: an execution summary that stays at the top (what the prompt does, read-only analysis or drafted changes, completed/running/queued tasks, drafts, the coordinator's own status and **Stop all**), the Finished banner, a **Needs you** section with every approval or question waiting for you, and the conversation with the coordinator. Sub-agent steps are kept out of it.
  - **Agents**: the coordinator and one card per sub-agent, with a state (Queued, Starting, Working, Running checks, Needs you, Completed, Failed, Stopped), what it is doing now, and its files. Expand a card for its report, its latest thinking (collapsed) and its drafts. **Chat** opens that sub-agent's own conversation, where you can message it while it works.
  - **Drafts**: see above.
  - **Checks**: command approvals (**Approve and run**), the checks for this folder (**Edit checks**), recent check results, and the auto-approval permissions as **Ask first** / **Auto-approve**.
  Tabs show badges for what needs you, so nothing waits unseen. **+** starts a new task, the gear opens settings, and the dropdown switches between conversations. The most recent conversations are kept on disk (`agentic.chat.historySize`, default 10, never fewer than 3).
- **Plan and Act modes.** Plan mode only discusses and proposes plans; nothing runs. Act mode starts sub-agents as soon as a plan is made. Pressing **Run it** on a proposed plan, or typing "go", starts it and switches to Act mode. If a question needs research before a change ("summarize this in a file"), the coordinator reads first and then plans the change in the same turn. A reply that promises to delegate always does.
- **Strict delegation.** The coordinator has no tools at all: it cannot read or change files, and replies containing code are rejected and retried. Its only way to get work done is to hand a request to the planner, which splits it into tasks that sub-agents carry out within their own file scopes. A "run" from the coordinator in Plan mode is refused in code, not just in the prompt.
- The **Agents** tab shows the coordinator and every sub-agent, what each is doing, and its latest thought. Expand **Latest thinking** to read the model's full reasoning when it produces any (for example qwen3's `<think>` output). The chat marks each sub-agent the coordinator starts, and shows each sub-agent's final report to the coordinator. The run summary repeats these reports, so the coordinator can use them in its next reply.
- **Shared knowledge.** What sub-agents report, and the coordinator's answers to research questions, are passed on. The planner gets them and copies the facts each task needs into its instructions. Every sub-agent of the next run also gets them as a briefing, and a task that builds on others gets those tasks' reports.
- **Checks per project.** Before the first run in a folder, the chat looks at the project (package.json scripts, pytest and ruff, cargo, go, dotnet, gradle or maven, make) and proposes test, lint and type-check commands. You edit them (**+ Add a command** adds a row with a name and a command, ✕ removes one, the tick box leaves one out) and press **Use these checks**; with **Remember for this folder** ticked, the choice is saved for that folder. **Edit checks** in the Checks tab (or the beaker button) changes them later. The settings stay as defaults, and the beaker button changes the checks later. If nothing is found, the run starts without asking. Research never asks.
- **Sub-agents can ask.** A sub-agent can request a check command it needs (Allow, Allow and remember, or Deny), or ask you a question when it can't continue. You can message any running sub-agent from its **Chat** in the Agents tab, and it reads it before its next step.
- **Reopen a finished sub-agent.** A sub-agent whose task ended (completed, failed or stopped) can still be messaged from its **Chat**. The first message reopens the conversation: it resumes with its saved conversation (`.agentic` run state keeps it), so it remembers what it read and did, and answers you. It can look at files again and, if you ask, draft more changes in its own files; those are drafts under the usual permissions, shown under **Drafts**. When you're done, press **End chat and update coordinator**, or simply message the coordinator: the sub-agent sends a short update with what is new, which shows in Overview, is added to its report and is used by the coordinator, the planner and later sub-agents. Ending it while it is still answering (or pressing **Stop all**) stops it and passes its replies so far on as they are. A sub-agent can't be reopened while the rest of its run is still working.
- **Auto-approval permissions** in the Checks tab (Ask first / Auto-approve). A switch that is on means you have given that authority and are not asked. A switch that is off never blocks the work; the step waits for you:
  - **Edit files** (off by default): when on, sub-agents' changes are written as soon as their task is done. When off, they queue for your Accept or Reject in the chat.
  - **Sensitive files** (package.json files, lockfiles, `.github`, `.devcontainer`, git hooks, `.vscode`): the same, for those files only. Edit files does not cover them.
  - **Run commands**: when on, checks run without asking. When off, each command is shown and nothing runs until you allow it. "Allow for the rest of this run" stops repeat questions for the same command.

  Workspace confinement and the protected files (.git, secrets, .agentic, `.vscode/settings.json`, `.vscode/tasks.json`, `*.code-workspace`) are never writable, whatever is switched on.

  The switches, the model server address and the API key only count in your **user settings** (or Remote settings in WSL/SSH). A project's own `.vscode/settings.json` or `.code-workspace` cannot turn a switch on or send your code and key to another server; if it tries, the extension ignores it and tells you. Set the API key with **Agentic: Set API key**: it is kept in VS Code's secret storage, not in a settings file.

- **What commands can do.** Check commands start in the project folder, and the extension refuses ones that obviously point outside it (absolute paths, `..`, `~`, variables, `$(...)`, sudo/ssh). This is a text check, not a sandbox: a command runs as you, so `python -c ...`, `node -e ...`, `curl`, or a script in the project can still read other files and use the network. That is why each command waits for your approval unless you turn on **Run commands**; only do that for projects you trust. Simple commands such as `npm test` run directly, without a shell; commands with pipes, `&&` or redirects (and all commands on Windows) go through the shell.
- **Secrets.** Files that may hold secrets (`.env` files, private keys and certificates, `.npmrc`, `.pypirc`, `.netrc`, cloud credentials such as `.aws`, Terraform state and variables) cannot be read, searched or changed by sub-agents, and are left out of the scratch copy in `.agentic/scratch` where checks run against pending changes. The rules apply to where a path really leads, so a link with an ordinary name (`src/build-info.txt -> ../.env`, or a linked folder pointing into `.git`) cannot be used to read, search or write a protected file, and such links are left out of the scratch copy. Templates such as `.env.example` can be read. Add your own patterns with `agentic.protectedFiles`; a project can add patterns there but cannot remove yours.
- **Project-supplied commands and links.** Checks in a project's own `.vscode/settings.json` (`agentic.checks`) are only suggestions. They show up for your approval, and **Run commands** never runs them without asking. In the chat and outside it, the switch covers the same things: checks from your user settings, checks you approved for the folder, and new checks a sub-agent requests during a run. That last part means a project's files could talk the model into requesting a command, so keep the switch off for projects you don't trust. `agentic.scratch.linkDirs` is read from your user settings only and can name dependency folders only (`node_modules`, `.venv`, `vendor` and similar), so a project folder such as `src` is always copied through the secret filter, never linked. Pending changes are written into the copy only: before a change is written, any linked folder or file on its way is replaced by a real one, so a change can never reach your project through a link before you accept it. Secret files anywhere inside a linked dependency folder, including behind links inside it, are left out: a folder that holds one is rebuilt in the copy with its other entries linked one by one. A link with an ordinary name that leads to `package.json`, a lockfile, CI or a git hook is refused, so those files are changed only by their real name and always go through the **Sensitive files** approval.
- **Known limits (accepted).** A file-name list can never know every credential format, so keep secrets you care about out of project folders or add them to `agentic.protectedFiles`. The scratch copy is not a security boundary: an approved command runs as you and can still open the real files or anything else your account can reach. Environment variables whose names look like credentials (`*_TOKEN`, `*_SECRET*`, `*API_KEY`, `*PASSWORD*` and similar), and ones that point to credential files or agents (`GOOGLE_APPLICATION_CREDENTIALS`, `KUBECONFIG`, `DOCKER_CONFIG`, `SSH_AUTH_SOCK`, `GIT_ASKPASS`, `CLOUDSDK_CONFIG` and more), are removed before a check runs. Other variables are kept, and a command can still find credentials on disk. Shell-free running only stops shell tricks; `python -c`, `node -e` or the project's own `npm test` script can still do anything. The only real protection for commands is your approval, so keep **Run commands** off for projects you don't trust. File access re-checks after opening that the file is the one that was checked, which narrows but cannot fully close a race where something else swaps a folder for a link at the same moment; true isolation would need an OS-level sandbox.
- **Heavier delegation.** The planner is told to prefer many small tasks: up to `agentic.delegation.maxTasks` (default 12). Research uses up to `agentic.delegation.maxResearchers` read-only sub-agents per round (default 8). When the first reports are too general (for example you asked for unused functions or dead code), the coordinator sends narrower researchers, such as one per file, that build on what the first round found: up to `agentic.delegation.maxResearchRounds` rounds per message (default 3). `agentic.maxParallelWorkers` still sets how many run at the same time.
- A **Run history (advanced)** view, collapsed under the chat, lists every saved run as a tree of its tasks. Right-click a run or task there to retry, cancel, view its log, review its changes, or delete the run.
- Task state saved on disk with atomic writes, an append-only event log, a dependency graph with cycle checks, and recovery of tasks interrupted by a restart.

## Try it

1. Start a local model, for example `ollama run qwen3.8:27b`.
2. Run `npm install` and `npm run compile`, then press F5 in VS Code to open an Extension Development Host.
   To install it as a regular extension instead, build a `.vsix` and install that file:
   ```sh
   npm install
   npm run package
   code --install-extension agentic-code-plugin.vsix --force
   ```
   `npm run package` compiles first and always writes `agentic-code-plugin.vsix` in the repo root. In WSL, run these in the WSL terminal and the extension installs into the WSL side of VS Code.
3. Run **Agentic: Test model connection** from the command palette.
4. Add your checks to settings, for example:
   ```json
   "agentic.checks": [
     { "name": "test", "command": "npm test" },
     { "name": "lint", "command": "npm run lint" },
     { "name": "typecheck", "command": "npx tsc --noEmit" }
   ]
   ```
5. Open the **Agentic** sidebar and type a request in the chat. In Plan mode the coordinator proposes a plan; switch to Act (or press **Run plan**) to let the sub-agents do it. Their changes wait for your Accept in the chat unless Edit files is on.

Any folder works; git is not needed. Checks are commands you configure, and they run with your permissions like any VS Code task. Workers can only start them by name.

Settings live under `agentic.model.*`. If your server rejects `json_schema` response formats, set `agentic.model.structuredOutput` to `json_object` or `none`.

## Development

```
npm run check   # typecheck, lint and tests
```
