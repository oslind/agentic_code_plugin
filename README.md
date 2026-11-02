# agentic_code_plugin

A Cline-like VS Code extension that coordinates a main agent and multiple specialized sub-agents, designed to work well with small local models (for example qwen3.8-27b served by Ollama, LM Studio or vLLM).

## Status

All four planned steps are in: skeleton, coordinator, parallel workers and recovery.

What works now:

- A provider for any OpenAI-compatible server (Ollama, LM Studio, vLLM, llama.cpp).
- Structured output built for small models: strips `<think>` blocks, code fences and prose, validates against a schema, and retries with the error as feedback.
- A coordinator that turns a request into at most 8 dependency-ordered tasks, each with a file scope. Plans are checked for duplicate ids, unknown dependencies, cycles and paths outside the workspace, and the model is asked to fix them. Tasks that could write the same files are ordered automatically so they never run at the same time.
- Context budgeting that fits prompts into the configured context window, dropping or cutting low-priority context first.
- A one-tool-per-turn worker protocol with a policy check: writes must stay in the task's file scope, secrets and `.git` are off limits, `package.json`, lockfiles and CI files follow their own switch, and only configured checks can run.
- A workspace sandbox: agents can only reach the folder open in VS Code. Every path is resolved to its real location on disk, so symlinks that point outside are refused for reads, writes and listings. Writes open files with `O_NOFOLLOW`. The extension only runs in trusted workspaces.
- **No git.** The extension never runs git, creates branches or commits. The project folder does not need to be a git repository.
- **You review every change.** A sub-agent's writes stay in memory as pending changes. Nothing is written to your project until you accept it:
  - a new file opens as a new editor tab with the proposed text;
  - an edit to an existing file opens VS Code's side-by-side diff (current file on the left, proposed version on the right), with removed, changed and added lines highlighted;
  - each change has **Accept** and **Reject** buttons in the chat, plus **Accept all** and **Reject all** when there are several. No popups.
  - If you edited the file yourself in the meantime, Accept warns you first, and a second Accept overwrites it.
  - A **Files changed** panel under the Agents panel is the receipt: every file the sub-agents touched in this conversation, with its status (waiting, written, auto-approved, rejected) and the sub-agent that changed it. Switch between **All files** and **By sub-agent**, and click a file to open it or its diff. Each sub-agent in the Agents panel also lists its own files.
- Parallel workers without git. Tasks that run at the same time have separate files (the planner makes tasks that share files wait for each other). A task that depends on another sees that task's pending changes, so it can build on them before you accept anything.
- Verification by your own checks, not the worker's word. The checks run on a scratch copy of the project with the pending changes written in (`.agentic/scratch/`, removed afterwards; `node_modules` is linked, not copied, see `agentic.scratch.linkDirs`). Failures go back to the worker to fix (`agentic.worker.maxFixRounds`). Your files are never touched by a check.
- Recovery:
  - **Resume.** When VS Code starts, runs that were interrupted are offered for resume. Running tasks start again.
  - **Retry.** Failed or cancelled tasks can be retried one at a time or all together. The worker is told why the last attempt failed and shown what it had written.
  - **Transient failures.** When the model server is briefly unreachable, requests are retried with backoff, and tasks are retried automatically up to 3 attempts.
  - **Cancel one task** without stopping the run, or cancel the whole run.
- A **chat sidebar** in the style of Cline. Type a request in the input box at the top; replies from the coordinator and from each sub-agent appear below it, with the plan and each task's status. The green dot opens settings, **+** starts a new agentic task, and the history button (or the dropdown in the chat) switches between conversations. The most recent conversations are kept on disk (`agentic.chat.historySize`, default 10, never fewer than 3).
- **Plan and Act modes.** Plan mode only discusses and proposes plans; nothing runs. Act mode starts sub-agents as soon as a plan is made. Pressing **Run it** on a proposed plan, or typing "go", starts it and switches to Act mode. If a question needs research before a change ("summarize this in a file"), the coordinator reads first and then plans the change in the same turn. A reply that promises to delegate always does.
- **Strict delegation.** The coordinator has no tools at all: it cannot read or change files, and replies containing code are rejected and retried. Its only way to get work done is to hand a request to the planner, which splits it into tasks that sub-agents carry out within their own file scopes. A "run" from the coordinator in Plan mode is refused in code, not just in the prompt.
- An **Agents** panel at the top of each conversation shows the coordinator and every sub-agent, what each is doing, and its latest thought. Expand **Latest thinking** to read the model's full reasoning when it produces any (for example qwen3's `<think>` output). The chat marks each sub-agent the coordinator starts, and shows each sub-agent's final report to the coordinator. The run summary repeats these reports, so the coordinator can use them in its next reply.
- **Shared knowledge.** What sub-agents report, and the coordinator's answers to research questions, are passed on. The planner gets them and copies the facts each task needs into its instructions. Every sub-agent of the next run also gets them as a briefing, and a task that builds on others gets those tasks' reports.
- **Checks per project.** Before the first run in a folder, the chat looks at the project (package.json scripts, pytest and ruff, cargo, go, dotnet, gradle or maven, make) and proposes test, lint and type-check commands. You edit and approve them, and the choice is saved for that folder. The settings stay as defaults, and the beaker button changes the checks later. If nothing is found, the run starts without asking. Research never asks.
- **Sub-agents can ask.** A sub-agent can request a check command it needs (Allow, Allow and remember, or Deny), or ask you a question when it can't continue. You can type a message to any running sub-agent from the Agents panel, and it reads it before its next step.
- **Auto-approve switches** under the input box. A switch that is on means you have given that authority and are not asked. A switch that is off never blocks the work; the step waits for you:
  - **Edit files** (off by default): when on, sub-agents' changes are written as soon as their task is done. When off, they queue for your Accept or Reject in the chat.
  - **Sensitive files** (package.json, lockfiles, `.github`): the same, for those files only. Edit files does not cover them.
  - **Run commands**: when on, checks run without asking. When off, each command is shown and nothing runs until you allow it. "Allow for the rest of this run" stops repeat questions for the same command.

  Workspace confinement and the protected files (.git, secrets, .agentic, .vscode/settings.json) are never writable, whatever is switched on. Commands always run with their working folder inside the project, and commands that point outside it (absolute paths, `..`, `~`, variables, `$(...)`, sudo/ssh) are refused.
- **Heavier delegation.** The planner is told to prefer many small tasks: up to `agentic.delegation.maxTasks` (default 12). Research uses up to `agentic.delegation.maxResearchers` read-only sub-agents (default 5). `agentic.maxParallelWorkers` still sets how many run at the same time.
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
