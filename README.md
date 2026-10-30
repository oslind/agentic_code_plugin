# agentic_code_plugin

A Cline-like VS Code extension that coordinates a main agent and multiple specialized sub-agents, designed to work well with small local models (for example qwen3.8-27b served by Ollama, LM Studio or vLLM).

## Status

Step 1 of 4: extension skeleton. The coordinator, parallel workers and recovery come in later steps.

What works now:

- A provider for any OpenAI-compatible server (Ollama, LM Studio, vLLM, llama.cpp).
- Structured output built for small models: strips `<think>` blocks, code fences and prose, validates against a schema, and retries with the error as feedback.
- Task state saved on disk with atomic writes, an append-only event log, a dependency graph with cycle checks, and recovery of tasks interrupted by a restart.

## Try it

1. Start a local model, for example `ollama run qwen3.8:27b`.
2. Run `npm install` and `npm run compile`, then press F5 in VS Code to open an Extension Development Host.
3. Run **Agentic: Test model connection** from the command palette.

Settings live under `agentic.model.*`. If your server rejects `json_schema` response formats, set `agentic.model.structuredOutput` to `json_object` or `none`.

## Development

```
npm run check   # typecheck, lint and tests
```
