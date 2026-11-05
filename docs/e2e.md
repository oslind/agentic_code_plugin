# End-to-end tests with a real model

Most bugs found so far (stalls, no final reply, no commands, stopping halfway) only showed up with a real local model. The scripted unit tests feed the controller perfect replies, so they cannot catch them. This suite runs the real chat controller, coordinator and sub-agents against a real model, headless (no VS Code), in a throwaway copy of a tiny project. An autopilot plays the user: it allows what is asked, answers questions, and accepts drafts at the end.

It is opt-in. `npm test` and CI never need a model server; they only run a self-test of the harness with a fake model (`test/e2eHarness.test.ts`).

## Running it

From the repo in WSL, with Ollama running. It needs Node 20 or newer: if `node --version` in a login shell says 12, run `nvm use 20` first.

```bash
AGENTIC_E2E_MODEL=qwen3:8b npm run e2e
# one scenario:
AGENTIC_E2E_MODEL=qwen3:8b AGENTIC_E2E_ONLY=command-use npm run e2e
```

When it ends it prints a table and writes everything to `e2e/results/<time>-live/` (ignored by git):

- `summary.json`, and `e2e/results/latest-live.json`, which the next run compares against, so a scenario that passed last time and fails now is marked `REGRESSED`.
- `<scenario>/transcript.md`: the whole chat as the user would have seen it, with failures at the top.
- `<scenario>/model-calls.jsonl`: every model request and reply, with timings.
- `<scenario>/commands.log`: every command the agents ran and its output.

With Ollama, the model is unloaded at the end (`keep_alive: 0`) so it does not hold the GPU, and a line is added to `docs/local-llm/offload-log.md`. Running a scenario takes a few minutes on an 8B model; the whole suite can take half an hour or more. The GPU is busy for that time.

### Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENTIC_E2E_MODEL` | (unset: suite skipped) | Model name, e.g. `qwen3:8b`. |
| `AGENTIC_E2E_BASE_URL` | `http://localhost:11434/v1` | Any OpenAI-compatible server (Ollama, LM Studio, vLLM, llama.cpp). |
| `AGENTIC_E2E_API_KEY` | none | Bearer key, if the server needs one. |
| `AGENTIC_E2E_CONTEXT` | `16384` | Context window the extension plans its prompts for. |
| `AGENTIC_E2E_STRUCTURED` | `json_schema` | Structured output mode (`json_schema`, `json_object`, `none`). |
| `AGENTIC_E2E_TEMPERATURE` | `0.2` | Sampling temperature. |
| `AGENTIC_E2E_ONLY` | all | Comma-separated scenario names. |
| `AGENTIC_E2E_PARALLEL` | `1` | Sub-agents at once. One GPU serves one request at a time anyway. |
| `AGENTIC_E2E_STALL_MIN` | `3` | Fail as stalled when no model call runs and the chat has not changed for this many minutes. |
| `AGENTIC_E2E_SILENCE_MIN` | `5` | Fail when one model request sends nothing back (not even thinking) for this many minutes. The first live run had a request hang for 27 minutes. |
| `AGENTIC_E2E_TIMEOUT_MIN` | `30` | Fail a scenario that takes longer than this. |
| `AGENTIC_E2E_RECORD` | off | `1`: a passing scenario's model calls become its recording in `e2e/recordings/`. |
| `AGENTIC_E2E_KEEP_LOADED` | off | `1`: leave the model loaded afterwards. |
| `AGENTIC_E2E_NO_LOG` | off | `1`: do not add a line to the offload log. |

### Ollama's context length

Ollama's OpenAI-compatible endpoint uses the server's default context length, which is often 4096 tokens, and silently cuts longer prompts. The coordinator's prompts are longer than that. The suite warns when Ollama reports a shorter context than `AGENTIC_E2E_CONTEXT`. To fix it without touching the Ollama service, make a model variant with a larger context once:

```bash
printf 'FROM qwen3:8b\nPARAMETER num_ctx 16384\n' > /tmp/Modelfile.e2e && ollama create qwen3-8b-16k -f /tmp/Modelfile.e2e
AGENTIC_E2E_MODEL=qwen3-8b-16k npm run e2e
```

## Replays

`AGENTIC_E2E_RECORD=1` saves the model calls of each passing live scenario to `e2e/recordings/<scenario>.jsonl`. `npm run e2e:replay` then plays those replies back in order, with no model, in seconds. That checks the controller still handles what the real model actually said (odd formatting, an unexpected action) after a code change. Prompts that changed since the recording are listed as drift; if the flow changed enough that the run asks for more replies than were recorded, the scenario fails and needs a new recording. Scenarios without a recording are skipped.

## Scenarios

All in `e2e/scenarios.ts`, on a small thermostat project in plain Node (its `node test.js` has one failing test). Every scenario must end: no stall, no timeout, nothing still waiting for the user, no error in the chat, a Finished bar, and the coordinator's last message must be an answer or final reply. On top of that:

| Scenario | Mode | Checks |
| --- | --- | --- |
| `research-answer` | Plan | A read-only question is researched by a sub-agent and the answer names `src/thermostat.js` and the default of 21. No drafts. |
| `change-final-reply` | Act, Edit files on | `toFahrenheit` is added and works (`toFahrenheit(100) === 212`), and the run ends with the coordinator's final reply. |
| `command-use` | Act | `node test.js` is actually run, the answer names the failing `average` test, and no file is changed. |
| `verify-fix` | Act, Edit files and Run commands on, `node test.js` approved | The bug is fixed so `node test.js` passes, the coordinator ran the checks on the drafts, and the Finished bar says whether it was verified. |
| `draft-for-review` | Act, Edit files off | `docs/usage.md` waits as a pending draft, and no sub-agent asks the user to review it instead of finishing. |

To add one: give it a small project, a prompt that once went wrong, and checks on the outcome (files, commands, the answer's facts), not on wording.
