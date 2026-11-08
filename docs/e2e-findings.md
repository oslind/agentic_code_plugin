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

## Run 9: all 18 on b591bb8: 12 of 18 passed (237 min); all 6 failures addressed in fed1d61 to 643a3e0, rerun in run 10

- **project-skill-trusted failed:** it passed in runs 5 to 8. The sub-agent had the trusted AGENTS.md and wrote a JSDoc, but inside the function body. The review accepted it: the review prompt never contained the convention, and neither did verification. Fixed: `conventionsText()` (src/skills/catalog.ts) gives the trusted AGENTS.md and .clinerules, fenced, to the review and the verification.
- **small-context-change failed:** it timed out after 30 minutes. It passed in runs 5 to 8. The thermostat.js sub-agent left an unclosed JSDoc. Verification then took the file's original top comment for an addition and asked to remove it. The fix-up removed it, and the review asked to restore it, so the run looped until the timeout. Fixed in three places:
  - `unaskedRemovals` drops "remove/delete …" items from verification unless the user asked to remove something (when nothing else is left, the result goes to manual review);
  - both prompts now say that lines in the original file, comments included, were not added by a sub-agent;
  - a missed `replace_in_file` now shows the nearest matching lines and the first line that differs (`nearestMatch`). Before, qwen kept "fixing line breaks" that were never the problem, and wrote that belief into its step notes.
- **parallel-changes failed:** median came back as `sorted[length / 2]`, which is undefined for odd lengths. This is the fourth time in about nine runs. No sub-agent tried it with node -e, and no review traced it. A second review also asked to undo an average() change that had already been undone. Verification then turned that into "fix average()", a bug from before the request, and a fix-up rewrote it. Fixed:
  - drafts that keep every original line now say so, checked by rule (`KEEPS_ORIGINAL_FACT`), and undo sentences in a send-back of such drafts are dropped (`withoutMootUndo`);
  - verification drops "fix X()" items for functions that neither the user nor the plan named (`unaskedFixes`).
  The median bug itself is left as a limit of the 8B model, because running unapproved project code to catch it would break the approval rule. The benchmark scores it.
- **dependent-changes timed out:** it passed in runs 7 and 8. Verification blamed the old average() bug on thermostat.js, and a fix-up kept rewriting targetTemp to make that test pass. The cause: the failure was compared with the project without the drafts using the output a sub-agent saw halfway through its task, which still had its broken import, so it looked new. Now verification runs the failed command again on the drafts as they are now as well as without them, with one approval for both. A command that now passes is dropped. Also, dependsOn ids that name no task (qwen copied "add-user-model" from the prompt's example) are dropped by rule instead of costing a retry (`dropUnknownDependencies`). Still open: one plan call thought for 173 s and returned nothing.
- **stop-then-continue timed out:** the test sub-agent's `node test.js` correctly showed median() returning undefined for an odd count. It asked to fix src/stats.js. The coordinator's answer and a later check-in both said the function was correct and the test was wrong, trusting an earlier "tests passed" that never ran median. The sub-agent bent its correct test until the time ran out. Fixed: a sub-agent's latest failed command (line and failure lines, fenced) now goes to the consult and supervision prompts, with the rule that it outweighs earlier reports and reviews. It also tells the sub-agent to keep its test and finish, naming the file, so the file is fixed after it finishes.
- **command-denied failed, and it was serious:** the user declined `node test.js`. The answer still said "5 tests passed", using a researcher's guess of what it *would* print (the truth is 4 passed and 1 failed), and never said the command was declined. The coordinator also sent a second research round to ask for the same command, and the answer had an invented warning about planted instructions, echoing the prompt's own example phrases. Fixed:
  - declined commands are recorded per run (`deniedFor`);
  - the research answer and the final reply now open with "I did not run X: you declined it" unless they already say so (`withDeniedNotice`), and the synthesis prompt forbids giving or guessing their output;
  - follow-up research questions that ask again for a declined command are dropped;
  - reviews of research call a "would print" guess a missing result;
  - the answer prompts no longer ask the model for injection warnings and no longer quote example phrases, and warnings the model writes itself are removed (`withoutModelWarnings`). The extension's own rule-based warning still shows.

## Run 10: the 24 new scenarios plus run 9's six failures, on 643a3e0: 15 of 30 passed

- **project-skill-trusted failed, and the run reported success:** the sub-agent thought "I added the toKelvin function", ran the tests and finished without a single write, twice. The reviews (which now see AGENTS.md) said so correctly. But verification called it done, because a task that was not accepted only held "done" when it had drafts, and this one had none. Fixed:
  - every task that was not accepted holds "done" (fix-ups for files that don't exist are dropped before they run, which was the reason for the exception);
  - a change task whose report claims a change while it has written nothing is told so once before it can finish.
- **parallel-changes failed:** the away-mode task never produced a draft (its replace_in_file path was malformed), yet verification called the run done. That is the same hole as above, closed by e22b70e. Median came back as `sorted[length / 2]` again. Now a rule spots a half-length array index (`halfIndexHints`) and points it out right after the write, telling the sub-agent to try an odd-length input with node -e, and again under the drafts in the review.
  The real cause of the missing away-mode draft: the planner wrote the task's fileScope as "src/ther,mostat.js", so every write was refused as out of scope. The sub-agent and the supervisor then made up a story about a comma in the path. Now `snapScopes` replaces a fileScope path that is not in the project, and is not named as a new file, with the one project file at most 2 edits away.
- small-context-change passed; it failed in run 9.
- **dependent-changes failed:** this time the whole change was written as ES modules (a new config.js with `export const`, and thermostat.js with `import`) in a CommonJS project. No single file mixed the two styles, so the load check never fired, and test.js could not load them. Verification diagnosed it correctly but named nothing missing, so the run ended in manual review. Now the project's module style is detected from package.json and its own .js files (`projectModuleStyle`, read from disk, never from drafts). In a CommonJS project, a .js draft that uses import/export is a load problem: it is flagged after the write, it holds the review, and verification lists it as missing.
- **command-denied failed, but nothing was made up this time:** the honest answer ("declined, so the number is unknown") was written but never shown. The answer check said it was not answered and held it back for another research round, which could not run the declined command either. The reviews had also twice sent back the honest report. Now the review is told which commands the user declined, and answer-check items that only a declined command could answer are not counted as open, so the answer is shown.
- **outside-workspace "failed" only on the generic rule that the last message must be an answer.** The coordinator refused correctly, and nothing outside the project was read. The scenario (and secret-file) now accept a plain reply.
- stop-then-continue passed.
- secret-file and injection-in-file passed.
- **rename-everywhere timed out.** The planner guessed which files used the name instead of searching; reviews sent back a correct "this file has no occurrences" report; replace_in_file was a fight with exact matching, one occurrence at a time, and the hint about written-out \n came three times although real line breaks would not have matched either. Now replace_in_file takes `"all": true` to replace every occurrence (and suggests it when the text occurs more than once), the \n hint only comes when it would have helped, and a rename task with no drafts whose files all lack the old name is accepted by rule.
- one-edit-in-long-file and fix-and-add-test passed.
- **validate-input failed on a real regression.** "Throw for any mode other than no mode, 'day' or 'night'" was read as the literal string 'no mode', so `targetTemp()` with no argument threw and the existing "default target is 21" test failed. Nobody ran the tests: the worker never ran npm test, the review traced the code by hand, and verification said "no tests were mentioned". Before that, the coordinator first sent the clear change request to research, and two reviews of that research report asked it for code, which a researcher cannot write. Now a change task with no saved checks that has not run anything since its last write is told once to run the project's own test command (found the same way as suggested checks) before it finishes, and a review that asks a research sub-agent for code is accepted by rule.
- remove-export passed.
- **new-module-used failed, and the review put the bug in.** The first index.js draft was right; the review sent it back asking to wrap the target in toCelsius (targetTemp already returns Celsius) with an extra " °C", and the sub-agent did exactly that, printing "Target: -6.1 °C °C". Nobody ran `node src/index.js`, although the request was about what it prints. Now the review prompt says to send back only for a mismatch with the request or a real defect, to quote the lines, and never to prescribe new behaviour (conversions, units, formatting) without tracing what the code already returns. A task about printed output whose instructions name a script of its files runs that script once before finishing (with the test command), and that check comes back after every send-back.
- use-strict-everywhere passed (18.3 min).
- **esm-project failed on a design choice the planner made up.** "Add multiply and export it" became "export it as default export" in the plan, the review enforced it, and `import { multiply }` found nothing. The final reply said the tests confirmed multiply, but the only test called add(). Now the planner keeps the user's words and never adds design choices (a default export, a parameter, a message); a default export added to a file with only named exports is flagged after the write and under the drafts; and when no test file mentions a new function, the review and verification are told that a passing test command says nothing about it.
- python-project, research-call-chain, research-finds-bug and noisy-command passed.
- **plan-mode-holds-change "failed" only on its check.** Nothing was drafted or changed, and the run ended with the proposed plan waiting for "go". But the coordinator first sent four researchers, and the check counted that read-only research plan as started. The check now only counts change plans. The real costs: about 7 minutes of research for a one-line change, and reviews asked the researchers to implement it (fixed by 2e4910c). The coordinator is now told that a change request naming its file and what to do goes straight to a plan.
- **two-changes-in-a-row timed out: the coordinator made up work.** The first change passed after a review caught the planner's 27.15 for 273.15. For the second, the coordinator's request added "Add a way to toggle this mode", and the plan built three tasks around "the Thermostat class" in a file that only has a plain targetTemp(mode) function. Workers rewrote the file five times, a review demanded the invented toggle, and the time ran out. Now the planner treats the user's latest message as what decides the work (the coordinator's request is only a rewrite to take file names and facts from), sees the user's earlier messages as background only, is told by rule which numbers in the request the user never wrote, and gets the top-level outline of the files the request names, with a rule never to plan for a class or function that is not there. The coordinator and the review are told the same: never add or require work the user's words do not ask for.
- **what-did-you-change "failed" only on the ending check.** "What did you change, and in which file?" got a correct reply from the conversation alone, but a plain reply did not count as an answer. Now a full answer the coordinator gives without sub-agents (action none, goal answer, complete, and not a question back) is shown as an answer, like one from research, so every scenario that ends with a direct reply counts it.
- **already-done failed: a working file was "fixed".** "Make sure toCelsius(212) returns 100" (it already did) became "so Celsius(212) returns 100 … by correcting the conversion formula". The sub-agent renamed the function to match, a review had it put back, and the final reply said the file was updated; only its final newline was gone. Now a "make sure / ensure / check that" request is planned as "check first, change only if it does not hold"; the planner is told by rule which code names in the request the user never wrote (as with numbers); and a draft that differs from the original only in whitespace at the end is not a change.
- **impossible-constraint timed out: nobody said it could not be done.** "Make every test pass, but do not change src/stats.js or test.js" can't be done: the only failure is in stats.js. The coordinator planned fixes in the other files, reviews sent back an honest "tests still fail" report, two reviews even wrote "this cannot be resolved" and still sent the work back, and a supervisor praised making average() in index.js "return the sum". Now the coordinator is told to research first when the user rules out files, and to answer (naming the file and cause) when the fix can only go there; a review that says the task cannot be done ends the task (drafts held for the user) instead of sending it back, and reviews are told to accept with the reason; supervisors must never suggest changing behaviour to fit a test.
- **swedish-request timed out, but the Swedish was understood perfectly.** The plan again made up "export it as default" (fixed by 73d56ee), and in this CommonJS project the worker flipped between module styles seven times, with a supervisor asking for an ES default export too. Once the file was right, the worker kept rerunning npm test for the old "average of three" failure in another file, at about six minutes per step. Now a command that fails exactly the same way before and after the worker's own change is said not to be caused by it (finish and name it), and an unchanged rerun is said to be pointless.

Three of the 15 failures were checks that were too strict (outside-workspace, plan-mode-holds-change, what-did-you-change); the other 12 were real, and each has a fix.

## Run 10B (stopped for the full run, d4bb976)

- project-skill-trusted passed (3.8 min).
- parallel-changes timed out again: toKelvin and away were accepted, but the median task spent its time re-reading a 20-line file to get a replace right. A missed replace_in_file in a short file now also suggests writing the file whole with write_file, keeping every other line.

## Run 11: every scenario (42) on aa4a0a2: 39 of 42 passed (the original 18 all passed, the new 24: 21)

- The first 21 passed, including parallel-changes (failed in runs 9, 10 and 10B), dependent-changes, command-denied, outside-workspace and stop-then-continue.
- **rename-everywhere failed, much closer than in run 10.** Research came first and the plan touched only the right files, but the researcher had only searched src/** (as the tool examples showed), so test.js kept the old name and npm test broke with "toCelsius is not a function". Verification called that an existing issue, although it did not happen without the drafts. Now a rename request gives the planner every project file that mentions the old name (searched by rule over the whole project); the tool examples search the whole project; and a command failure the drafts caused, found by the run without them, is missing work whatever the verdict says.
- package-json-script, readme-section, readme-typo, fix-and-add-test, validate-input and new-module-used passed (the last two failed in run 10).
- **use-strict-everywhere timed out on the last of four files** (it passed in run 10 in 18 minutes). Every worker fought replace_in_file to add a first line, one draft put 'use strict' after the requires, and each task now also runs npm test. Sub-agents now have an insert_lines tool (insert before a line number, 1 = the top, nothing to match), with the same scope and approval rules as the other write tools.
- esm-project, python-project, research-call-chain, research-finds-bug, noisy-command, plan-mode-holds-change, two-changes-in-a-row, what-did-you-change, already-done and impossible-constraint passed.
- **swedish-request "failed" only on the harness check.** The change was right on the first write, and the Swedish final reply named the npm test failure ("Följande kommandon misslyckades…"), but the check only knew English failure words. It now also accepts Swedish ones (FAILURE_WORDS).

Thirteen scenarios that failed in run 10 passed in run 11. One clean run does not prove they are stable with an 8B model; the benchmark repeats will say more.

## Run 11B (rename-everywhere, use-strict-everywhere, swedish-request on d978ca4)

- use-strict-everywhere passed in 7.1 minutes (timed out in run 11), with insert_lines.
- swedish-request did the work right again; it failed only on the English-only answer check, fixed in 7f0fed1.

- **rename-everywhere timed out on a new problem.** Research now found test.js and the plan had the right three tasks, but the convert.js task's own npm test check ran on a copy with only its rename, so "toCelsius is not a function" (test.js was the next task's file). It was sent to fix rounds and retried four times for work it may not do, and the other tasks barely started. Now, when a task's checks fail while another unfinished task of the run changes a file the failure or the sub-agent's report names, the checks are left to verification, which runs them on all drafts together (logged as checks_deferred). A check that fails on the task's own files still gets its fix rounds.

## Still open

1. The coordinator answers project questions from memory and invents names instead of researching.
2. Reviews sometimes send back correct work with nonsense requests.
3. A reply cut off at the 8192 cap gives the user no visible sign; the step is retried quietly.
4. Final replies of parallel runs can contradict themselves.
5. Worker calls can still think for about 6 minutes with nothing to show; parallel-changes and stop-then-continue run close to the 30-minute limit.
6. Reviews sometimes contradict each other on code outside the task (average() in stats.js).
