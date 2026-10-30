# agentic_code_plugin

A Cline-like VS Code extension that coordinates a main agent and multiple specialized sub-agents, designed to work well with small local models (for example qwen3.8-27b served by Ollama, LM Studio or vLLM).

## Status

Steps 1 and 2 of 4: extension skeleton and coordinator. Parallel workers and recovery come in later steps.

What works now:

- A provider for any OpenAI-compatible server (Ollama, LM Studio, vLLM, llama.cpp).
- Structured output built for small models: strips `<think>` blocks, code fences and prose, validates against a schema, and retries with the error as feedback.
- A coordinator that turns a request into at most 8 dependency-ordered tasks, each with a file scope. Plans are checked for duplicate ids, unknown dependencies, cycles and paths outside the workspace, and the model is asked to fix them. Tasks that could write the same files are ordered automatically so they never run at the same time.
- Context budgeting that fits prompts into the configured context window, dropping or cutting low-priority context first.
- A one-tool-per-turn worker protocol with a policy check: writes must stay in the task's file scope, secrets and `.git` are off limits, `package.json`, lockfiles and CI files need approval, and only configured checks can run.
- An **Agentic** sidebar showing saved runs and their task tree.
- Task state saved on disk with atomic writes, an append-only event log, a dependency graph with cycle checks, and recovery of tasks interrupted by a restart.

## Try it

1. Start a local model, for example `ollama run qwen3.8:27b`.
2. Run `npm install` and `npm run compile`, then press F5 in VS Code to open an Extension Development Host.
3. Run **Agentic: Test model connection** from the command palette.
4. Open the **Agentic** sidebar and click **+** to plan a request. The tasks appear in the tree; running them comes in step 3.

Settings live under `agentic.model.*`. If your server rejects `json_schema` response formats, set `agentic.model.structuredOutput` to `json_object` or `none`.

## Development

```
npm run check   # typecheck, lint and tests
```
