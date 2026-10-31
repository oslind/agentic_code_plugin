# agentic_code_plugin

A Cline-like VS Code extension that coordinates a main agent and multiple specialized sub-agents, designed to work well with small local models (for example qwen3.8-27b served by Ollama, LM Studio or vLLM).

## Status

All four planned steps are in: skeleton, coordinator, parallel workers and recovery.

What works now:

- A provider for any OpenAI-compatible server (Ollama, LM Studio, vLLM, llama.cpp).
- Structured output built for small models: strips `<think>` blocks, code fences and prose, validates against a schema, and retries with the error as feedback.
- A coordinator that turns a request into at most 8 dependency-ordered tasks, each with a file scope. Plans are checked for duplicate ids, unknown dependencies, cycles and paths outside the workspace, and the model is asked to fix them. Tasks that could write the same files are ordered automatically so they never run at the same time.
- Context budgeting that fits prompts into the configured context window, dropping or cutting low-priority context first.
- A one-tool-per-turn worker protocol with a policy check: writes must stay in the task's file scope, secrets and `.git` are off limits, `package.json`, lockfiles and CI files need approval, and only configured checks can run.
- A workspace sandbox: agents can only reach the folder open in VS Code. Every path is resolved to its real location on disk, so symlinks that point outside are refused for reads, writes and listings. Writes open files with `O_NOFOLLOW`. The extension only runs in trusted workspaces.
- Parallel workers. Each task runs in its own git worktree and branch under `.agentic/` in the project, with a sandbox rooted at that worktree. A worker makes one tool call per turn and keeps its history inside the context window.
- Verification by your own checks, not the worker's word. The commands in `agentic.checks` run in the worktree, and failures go back to the worker to fix (`agentic.worker.maxFixRounds`). Only files in the task's scope are committed.
- Approval before integration. Each verified task waits for you to approve the merge, with the diff available. Merges into a per-run integration branch happen one at a time, and the checks run again after each one. A merge that conflicts or breaks the checks is undone, and its branch is kept.
- Your branch is only changed when you choose **Apply run to my branch**, and only if it has no uncommitted changes.
- Recovery:
  - **Resume.** When VS Code starts, runs that were interrupted are offered for resume. Running tasks start again, and verified work waiting for approval is offered for approval again without being redone.
  - **Retry.** Failed or cancelled tasks can be retried one at a time or all together. A retry gets a new `-tryN` branch, and the worker is told why the last attempt failed and shown its diff. This is also how merge conflicts are resolved: the retry starts from the current integration branch and reapplies the earlier work.
  - **Nothing is lost.** Unfinished work from a failed attempt is committed to its branch before the worktree is reused.
  - **Transient failures.** When the model server is briefly unreachable, requests are retried with backoff, and tasks are retried automatically up to 3 attempts.
  - **Cancel one task** without stopping the run, or cancel the whole run.
  - **Clean up.** Remove a run's worktrees and keep its branches, or delete everything.
- An **Agentic** sidebar showing saved runs and their task tree.
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
5. Open the **Agentic** sidebar and click **+** to plan a request. Review the tasks, then press **Run** on the plan.

The workspace folder must be the root of a git repository. Checks are commands you configure, and they run with your permissions like any VS Code task. Workers can only start them by name.

Settings live under `agentic.model.*`. If your server rejects `json_schema` response formats, set `agentic.model.structuredOutput` to `json_object` or `none`.

## Development

```
npm run check   # typecheck, lint and tests
```
