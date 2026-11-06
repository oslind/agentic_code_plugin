# Findings from the live e2e runs (2026-11-05 evening)

Model: qwen3:8b with a 16k context (Ollama `qwen3-8b-16k`), RTX 2070, temperature 0.2.
Each run is logged in [local-llm/offload-log.md](local-llm/offload-log.md).

## Run 1: main at 5f96f94, the 5 original scenarios: 2 of 5 passed

| Scenario | Result | What happened | Fix |
| --- | --- | --- | --- |
| research-answer | pass | | |
| change-final-reply | pass | One step hit the 8192-token reply cap after 6 min of thinking; the next step recovered. | none needed |
| verify-fix | fail | Asked to fix a bug, the coordinator researched first, then answered "I've fixed it" without planning any change. | `continueChange` keeps a change request going after research; the research answer prompt forbids claiming changes. |
| command-use | fail | Researchers missed the root `test.js`, and the review sent back a correct `npm test` report, asking it to agree with an earlier wrong one. | The review treats command output as evidence; the research answer trusts command output over "file not found". |
| draft-for-review | fail | The coordinator asked "Would you like me to proceed?" and the harness had no answer. | The harness says "Yes, please go ahead." once, as a user would. |

## Run 2: branch at 027b99f, new scenarios: 5 of 8 that finished passed

| Scenario | Result | What happened | Fix |
| --- | --- | --- | --- |
| project-skill-trusted | fail | The trusted AGENTS.md was never given to the coder, because the planner did not pick it. | Project conventions (AGENTS.md, .clinerules) always go to every coder sub-agent once trusted. |
| project-skill-untrusted | pass | | |
| long-conversation | fail | No compaction: short answers never filled 70% of the 1500-token budget. The last answer was made up from memory (`NIGHT_MODE_OFFSET`, `calculateTarget`, `fToC`) instead of researched. | Budget lowered to 600 so compaction triggers. **Answering from memory is still open.** |
| small-context-change | pass | No sub-agent compaction entry appeared, so the scenario did not prove it triggers. | open |
| cut-off-answer | pass | The cap never triggered visibly. The review asked to "remove stats.js from dependencies", which made no sense. | open |
| parallel-changes | pass | Slow (18.9 min). The final reply contradicted itself. | open |
| dependent-changes | fail | `config.js` written as ESM in a CommonJS project, then `thermostat.js` converted to ESM; the run still said "verified". | **open** |
| stop-then-continue | not finished | Stopped by "pause". | |

The final reply also told the user to "Accept" drafts that were already written: now it only mentions Accept when something is pending.

Not reached yet: command-denied, missing-script, question-then-answer, no-json-mode, research-not-change. Run 3 (retest of the fixes) has not been run.

## Run 3: branch at 23eae0c, 12 scenarios: 6 of 12 passed (129 min)

Passed: command-use and draft-for-review (both failed in run 1), project-skill-trusted (failed in run 2), command-denied, missing-script, no-json-mode.

| Scenario | What happened | Fix (pushed after the run, not retested yet) |
| --- | --- | --- |
| verify-fix | After research, the prompt ended with the coordinator's own report message and no user turn, so the model went on writing an invented plan, fix and passing test run, then chose "none". No goal was given, so nothing kept the change going. The answer check approved "All tests pass" with no file changed. | After research, a user turn repeats the request and asks for the decision; a goal of "change" given after research also keeps the change going. |
| long-conversation | Compaction worked and the answer was right (21). The scenario wrongly required a research answer for a "remind me" reply. | Scenario fixed. |
| dependent-changes | Asked to "import" from a new config.js in a CommonJS project, the sub-agent wrote an ESM import, then converted thermostat.js to ESM to make it load. | Coder rule: keep the project's module style. The scenario now fails a switch to ESM. |
| stop-then-continue | Stop and continue worked. Then a test-writing sub-agent kept bending tests to a broken median() in a file outside its scope until the 30-min timeout; the coordinator only nudged it. | Sub-agents finish and name the broken file instead, and the coordinator's note says so. |
| question-then-answer | "Change how much night mode lowers the target" gave no amount; the coordinator planned without asking, and sub-agents tried 2, 1.5, then 3. The harness also wrongly required the second prompt's reply to repeat the first prompt's test failure. | Harness fixed. **Asking when an amount is missing is still open.** |
| research-not-change | Researchers ran npm test (failed), and the answer never said so. | Research answers now get the failed commands and mention them. |

## Run 4: b90369d, all 18 scenarios: 13 of 18 passed

The run 3 fixes held for verify-fix, long-conversation and stop-then-continue. New fixes after it:

| Scenario | What happened | Fix |
| --- | --- | --- |
| dependent-changes | An ES import went into a CommonJS file again; review and verification saw only the diff. | Reviews and verification see small files whole. |
| question-then-answer | The coordinator asked for the amount and planned in the same reply; verification passed although the sub-agent's npm test failed (no checks set up). | Never plan in the same reply as a question; verification sees failed commands. |
| research-not-change | A code question answered from file names alone. | Code questions need research. |
| draft-for-review | "Write docs/usage.md" came back from the planner as read-only, ran as research and claimed it created the file. | A change request stays a plan; reviews reject claimed files with no drafts. |
| project-skill-trusted | The coordinator rewrote 273.15 as 27.3.15 for the planner. | The planner gets the user's own words. |

## Run 5: 2845de7, all 18 scenarios: 15 of 18 passed

| Scenario | What happened | Fix |
| --- | --- | --- |
| dependent-changes | A correct config.js was blocked over a typo in the report; a review accepted an ES import in a CommonJS file with the whole file in view. | Drafts that mix module styles are rejected by rule; reviews judge drafts, not report typos. |
| stop-then-continue | test.js got tests pasted after the closing brace; verification called an earlier test run a pass. | CommonJS drafts with a syntax error are rejected by rule (compiled, never run); earlier test runs do not count. |
| no-json-mode | Without structured output the worker wrote `\\n` in replace_in_file search text, so nothing matched for 30 minutes. | Written-out `\n` is read as line breaks when only that matches, and the error says so. |

Also seen: some worker calls ran about 350 s and returned nothing, which made a few scenarios slow.

## Still open

1. The coordinator answers project questions from memory and invents names instead of researching.
2. The verification judge says "verified" for a change that broke the module format (ESM in CommonJS).
3. Reviews send back correct work with nonsense requests.
4. A reply cut off at the 8192 cap gives the user no visible sign; the step is retried quietly.
5. Final replies of parallel runs can contradict themselves.
