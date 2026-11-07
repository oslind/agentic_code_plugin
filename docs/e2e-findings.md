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

## Run 6: phases A to F on the newest fixes after each phase

| Phase | Commit | Result |
| --- | --- | --- |
| A | 47cad0a | 0 of 3 (the run 5 failures, each on a new cause) |
| B | 47cad0a | 14 of 15 (regression check; parallel-changes failed) |
| C | 34b9c5b | 2 of 4: dependent-changes passed for the first time, no-json-mode passed |
| D | 0dd9fc3 | 1 of 2: stop-then-continue passed |
| E | c85ff3e | 0 of 1: parallel-changes |

Every scenario passed at least once in run 6 except parallel-changes, which failed in phases B to F and H1 on a different cause each time, then passed in H2 (893021c).

| Where | What happened | Fix |
| --- | --- | --- |
| Verification | Chased a test that was failing before the change. | Failed commands are rerun on a copy without drafts; failures that were there before are not missing work. |
| Fix-up rounds | Re-planned all three tasks when one was left; later made two tasks on the same file that undid each other. | The planner leads with the count of what is left and is capped at it; tasks on the same file are merged. |
| Supervisor and reviews | Said a file was "already fixed by another sub-agent" when that draft had failed review; asked to undo a change the diff no longer had; accepted while asking for a fix. | The team list says whose drafts passed review; reviews judge only the current diff; feedback that asks for a fix means revise. |
| Sub-agents | An edit left half an old function after the closing brace; another only added `toKelvin` to `module.exports`. | write_file and replace_in_file warn when a JS file stops loading; exports of names defined nowhere count as a draft problem (read by rule, never run). |
| Verification | Called a run done while a task's review had said the function was missing. | A task whose latest review ended "not accepted" holds "done" and becomes missing work. |
| Tests vs code | Verification asked to change the code to fit a test's made-up error message. | When a test and the code disagree on a detail the user did not name, the test is fixed. |
| Slow calls | Review, verification and plan calls sometimes thought for about 6 minutes and returned nothing. | Token caps: 4096 for verdicts, 6144 for plans; the retry asks for no thinking. Worker calls are not capped. |

## Run 7: all 18 on 893021c: 15 of 18 passed; the 3 failures then passed on 2ae5efe and 635d9cc

| Scenario | Run 7 | Rerun | Fix |
| --- | --- | --- | --- |
| draft-for-review | Fail: "I want to review it before it is saved" was answered with the text in chat. | Pass (7B) | Writing a file is always a change plan; drafts wait under Changes. |
| stop-then-continue | Fail (timeout): reviews sent the stats.js task back for tests in test.js; three empty verification calls. | Pass (7C) | Send-back sentences naming only files outside the task are dropped by rule; retries ask the server not to think. |
| research-not-change | Fail: listed files from the file tree without researching. | Pass twice (7C) | "Which files would change / how would I add" starts with research. |

Ollama 0.40.13 ignores "/no_think" in the prompt and `think: false` on /v1, but honours `reasoning_effort: "none"` (12 tokens instead of 174 for "Say hi"). Since 807c87b, retries after a reply that thought until the cap send it.

## Run 8: all 18 on 9457cf5: 16 of 18 passed; both failures then passed on newer commits

| Scenario | Run 8 | Rerun | Fix |
| --- | --- | --- | --- |
| parallel-changes | Partial: told to undo an average() change, the sub-agent deleted average(); verification then asked to remove it. | Pass (8B, 1b24703) | Send-backs show the drafts against the original file; reviews ask to restore, never delete; verification never asks to remove code. |
| question-then-answer | Partial: verification and coordinator answers invented test/thermostat.test.js (the tests are in test.js). | Pass twice (8C, c95b93d) | Verification and answers get the file tree; fix-up tasks for files that do not exist are left out. |

Seen in 8C: turn 1 asked for the amount in only 1 of 2 runs (the other let a worker pick 5 degrees), and a test task switched test.js to mocha. Prompt rules for both are in 18677b2, not yet run live.

## Run 9: all 18 on b591bb8 (in progress)

- **project-skill-trusted failed:** it passed in runs 5 to 8. The sub-agent had the trusted AGENTS.md and wrote a JSDoc, but inside the function body. The review accepted it: the review prompt never contained the convention, and neither did verification. Fixed: `conventionsText()` (src/skills/catalog.ts) gives the trusted AGENTS.md and .clinerules, fenced, to the review and the verification.

## Still open

1. The coordinator answers project questions from memory and invents names instead of researching.
2. Reviews sometimes send back correct work with nonsense requests.
3. A reply cut off at the 8192 cap gives the user no visible sign; the step is retried quietly.
4. Final replies of parallel runs can contradict themselves.
5. Worker calls can still think for about 6 minutes with nothing to show; parallel-changes and stop-then-continue run close to the 30-minute limit.
6. Reviews sometimes contradict each other on code outside the task (average() in stats.js).
