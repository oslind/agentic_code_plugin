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

## Run 12: the multi-task scenarios with two sub-agents at once (AGENTIC_E2E_PARALLEL=2, d286e73): 5/8, 103.9 min

Every earlier run used one sub-agent at a time. Here the tasks really overlapped (interleaved steps, two npm test runs at once), and so far no concurrency problem showed: no drafts leaked between tasks.

- research-answer passed.
- **parallel-changes timed out, not because of parallel running.** The median worker wrote correct code and tried it itself with node -e (odd and even length). But a review said average() "should remain unchanged" and "fix the average function" in the same feedback; the fix was then rejected as unasked, verification asked to revert it, and time ran out. A send-back sentence that asks to fix a function neither the user nor the task named is now left out by rule (as verification already did), and when what is left asks for nothing, the result is accepted. With one GPU, two sub-agents at once are not faster: model calls add up to more than the wall time, so the 30-minute limit is tighter.
- dependent-changes (17.8 min) and stop-then-continue passed.
- **rename-everywhere failed, the first finding tied to researchers working side by side.** One researcher correctly found toCelsius in test.js; a review sent it back "as confirmed by earlier reports" (another researcher had only searched src/), and it retracted. The planner had the rule-based list with test.js but followed the reports. Verification then compared npm test with a copy of the project folder, but the accepted drafts were already on disk, so the "without the drafts" copy had them too, and the new failure looked old. Now: the baseline copy puts back what each file held before the run's first change; a rename plan that leaves out a file the search found gets a task for it (coverReferences); and a review never sends a research report back because other reports disagree.
- **new-module-used failed.** The index.js worker printed formatTemp(212) instead of the value the user asked for, and neither the review nor verification compared the printed output with the request. The final reply also still named a module error that a fix-up had already fixed, because the rerun on all drafts was only used to decide, never recorded. Now each rerun is shown in the chat, so the final reply goes by the latest result. Comparing printed output with the request is still open (item 7).
- use-strict-everywhere (7.1 min) passed.
- The scenarios give each task its own file, so same-file merging under real overlap was not exercised. New scenario same-file-parallel: two sub-agents add one function each to src/convert.js at the same time.

### Run 12B (reruns, two at once, b27f1f5): 0/3, 42.8 min

- **parallel-changes failed on one missing export.** median was right (Math.floor) and added with insert_lines, but module.exports further down was never touched; npm test does not call median, and the review and verification accepted it although the user said "and export it". Now a new function that the request says to export, in the same sentence, and that the file does not export is a problem checked by rule: the sub-agent is warned right after the write, and reviews and verification cannot accept it. A review call still took 372 s.
- **rename-everywhere failed on one call.** The plan covered all three files, but the index.js sub-agent renamed only the import and left `toCelsius(70)` on line 4, so node src/index.js threw a ReferenceError. The tests do not run index.js, and the review, verification and final reply all said every call was updated. A rename is now checked by rule: after each write the sub-agent is told which lines still use the old name (and to use replace_in_file with "all": true), and reviews and verification get every file that still uses it, drafted or not, as a problem they cannot accept.
- **new-module-used failed: the two files did not fit together.** format.js became `module.exports = function formatTemp`, index.js took `{ formatTemp }` from it, and the program crashed with "formatTemp is not a function". index.js also lost its targetTemp call. Nobody ran the program: the reminder to run node src/index.js counted the earlier npm test as a run. Now the program a task prints from must itself run after the last write, and a name a draft takes from a project module (require or import with { }) that the module does not export is a problem checked by rule after the write, in the review and at verification. Reviews noticing removed behaviour (the lost targetTemp call) is still open (item 8).

### Run 12C (two at once, 74f45c9): 3/3, 73.4 min

- parallel-changes (26.2 min, its first pass with two sub-agents at once), rename-everywhere (22.2 min) and same-file-parallel (25.0 min) passed.
- same-file-parallel did not overlap: the plan check makes a task wait for another whose files it shares ("file scopes overlap"), so the second sub-agent started from the first one's accepted result and nothing had to be combined. Combining drafts that did overlap (PR #42) stays covered by the scripted tests in test/merge.test.ts, since a real model cannot be made to produce that case reliably.

### Run 12D (two at once, e2f65fa): 1/1

- new-module-used passed (14.9 min). Every scenario of run 12 has now passed with two sub-agents at once, over runs 12, 12C and 12D.

## Benchmark pass 1 (e0a0df6): questions about many files

Results in docs/benchmark-pass1.md. The bigger the question, the less the coordinator split it: find-throwing-5 got one researcher per file, find-throwing-100 got one researcher that opened 3 files, and the answer said the other 97 "lack error-throwing logic" (42 of them throw). The answer check passed it. Fixes:

- A question about every file of a set (a numbered range like mod_000.js to mod_099.js, or "which/all/every ... modules" in a named folder or the whole project) is split by rule: each researcher gets a batch of at most 15 files and the user's own question, and opens every file. Files nobody opened get another round, while rounds are left. Such a question is never answered from memory.
- The answer is told, checked by rule from the logs, how many of the files were opened, and the extension puts "Checked X of N files; the other Y were not opened" in front of it. Such an answer is never tagged verified.
- The scoreboard shows what research answers found and their false alarms next to the score (an empty answer scored 56 to 60%), and "solved and finished" next to "solved".
- A sub-agent that tries a second time to write a file outside its task is told to stop trying (three-changes timed out on that).
- First live check (e0ed452): the split worked, but researchers opened one file per model call (about 30 s each), so find-throwing-20 and -50 hit the 30-minute limit before any answer. New read_files tool: up to 20 files in one call, each cut to its share of a 24,000-character budget; batch questions ask for it.
- Second check (a76e36c, 8 attempts, 60-minute limit, 198.8 min): every attempt answered in time. Throwing modules found in the answer's list: 5 files 2/2 and 1/2, 20 files 6/8 and 8/8, 50 files 21/22 and 22/22, 100 files 44/44 (plus 9 wrong) and 42/44 (pass 1: 2/2, 2/8, 9/22, 2/44). Three lists exactly right. No answer began with "Checked X of N", although files were missed. Fixes:
  - A model review told a 2-file researcher to check all 100 modules; its widened report put 9 wrong modules in the answer. Batch researchers are now reviewed by rule: every file of the batch opened and named in the report, nothing else, at most two send-backs.
  - A researcher looked for mod_002.js without src/, reported "file not found", and the answer repeated it. read_file, read_files and list_files now point to the file with that name when a path has no match; the rule review sends back an unopened file.
  - Files read but in no report (mod_042) were counted as checked. A file now counts as checked only when it was opened and a report names it, so the "Checked X of N" line appears.
  - read_files skips blank paths instead of refusing the whole call; the bench saves model-calls.jsonl per attempt; the scorer does not count "not found" or "no lineTotal" lines as saying a module throws.

## Run 13: every scenario (43) with two sub-agents at once, on 0878a3a: 35 of 43 passed, 394.3 min

The three run-11 failures (rename-everywhere, use-strict-everywhere, swedish-request) pass now. Eight that passed in run 11 (one sub-agent at a time) failed:

- **readme-typo and two-changes-in-a-row: the user was told a change was made that never happened.** "Fix the spelling mistake in README.md." and "Now also add an 'away' mode ..." went to read-only research. A review asked a researcher to "correct the error in the file", it ran `sed -i` in its throwaway copy, reports said "Added 'away' mode", and the answers said "has been fixed" / "was added". Fixed (0ff1707): after research, a reply that claims a change to an edit request goes on to a plan; a research answer to an edit request that still claims one starts with a by-rule "Nothing in your project was changed" and is not verified; research reports that claim a change are sent back by rule; reviews asking a researcher to fix or correct a file are accepted by rule; a read-only agent's file-writing command is answered with a note that it changed nothing.
- **python-project and question-then-answer: a missing program became a gate.** A sub-agent added the check `python -m pytest` (in a Node project, and where only python3 exists); "Command not found: python" failed every attempt. Once the right draft was auto-accepted, later attempts had nothing left to draft and reviews rejected them for "no changes". Verification also blamed the old "average of three" failure instead of the new one. Fixed (f45c1b3, 86108f3): a check whose program does not exist is "could not run (command not found)", never a failure to fix, and a sub-agent's own such check is dropped; a "no changes" send-back for files that already have an accepted change in the run is accepted by rule; verification is told which failure lines are new with the drafts and which were there before.
- **new-module-used: a whole module was one comment line.** write_file content arrived with `\\n` written out, so src/format.js was one line starting with `//` and exported nothing. Fixed (243a3f2): whole-file and inserted text with two or more written-out `\n` and no real line break is read as having line breaks, and the sub-agent is told. The harness now keeps each scenario's run state and src/ in the results.
- **project-skill-trusted: a JSDoc inside the function body** was accepted as "added with JSDoc". Fixed (c211741): `docInsideBody` flags it after the write and in reviews and verification.
- **parallel-changes timed out** in its second verification; the median sub-agent had also changed average() unasked, and it was accepted. Now reviews get a by-rule hint for an existing function a draft changed that neither the user nor the task names (b24cf22).
- **what-did-you-change:** qwen answered without a goal (`{"action":"none","complete":true}`), so the answer was not shown as one. A complete reply with no goal is an answer now (c211741). The reply also misquoted `+ 32` as `+ 3.2` (model error, open).

Big questions (find-throwing 5/20/50/100, agentic, 2 attempts each, 131.8 min): every file was opened in 7 of 8 attempts and no answer named a wrong module. 20 and 50: all found, both attempts; 100: 41 and 37 of 44, each answer starting "Checked 85 of the 100 files".

- **find-throwing-5, attempt 2: answered unread in 18 seconds.** The coordinator chose `none`; the read-every-file rule only started at 6 files. Fixed (e0b9a5a): from 2 files; a set under 6 goes to one researcher.
- **find-throwing-100: 14 files opened but in no report, at the same places in both attempts.** The batch review sent the researcher back, then let it go flagged, and the files counted as done because they were opened. Now a later round goes back to every asked file that no report names, not only unopened ones.
- **Scorer:** names under a "Still unknown:" heading counted as named; such a heading now starts a not-named list.

None of these fixes has run live yet.

## Run 14: all 43 on 916abd2 (41 passed), big questions, and 2 repeats of 12

Scenarios: 41 of 43 passed in 363.9 min (35 the night before). The 12 riskiest over three tries (main, repeat 1, repeat 2): 29 of 36. Always passed: the 4 research scenarios, two-changes-in-a-row, what-did-you-change. 2 of 3: project-skill-trusted, parallel-changes, question-then-answer, readme-typo, python-project. 1 of 3: new-module-used.

- **rename-everywhere (timeout):** a one-file rename task was reviewed against the whole request. Its files no longer using the old name now accepts it by rule (86b3f3f).
- **project-skill-trusted (timeout):** a duplicate toKelvin made every replace_in_file fail. Duplicate declarations are named on write, in reviews and in that error (86b3f3f).
- **Runaway thinking:** 17 of 827 calls thought 340-360 s and gave nothing (4,000+ s). Structured calls stop past 16k characters of thinking and ask again without thinking (32aba48).
- **Big questions:** every file opened, no wrong module named, no guessed answer; 100 modules found 36 and 34 of 44 because the combining call dropped reported matches. Many-file "which" answers are now sorted file by file and missing matches added by rule (e7f86b5).
- **readme-typo, repeat 1:** research answered "has been identified and fixed". The claim wording is wider (90f3cf0), and an edit request that ends in a research answer now always says nothing was changed and is not verified (23b3a83).
- **new-module-used:** formatTemp(70) replaced toCelsius(70); dropped calls are now named on write and in reviews (90f3cf0). Repeat 2 also flipped the export six times; still open.
- **question-then-answer, repeat 2:** a fix-up changed 4 degrees back to 3 to satisfy an old test. A draft that puts back what an accepted change of the run replaced is sent back by rule (3c31462).
- **python-project, repeat 2:** a "Run tests to verify" task was sent back for "no code changes" (now accepted by rule), and fix-up planning failed four times on "at most 1 task" (extra tasks are merged now) (3c31462).
- **parallel-changes, repeat 2:** timeout at 97 s per call.

None of these fixes has run live yet.

## Run 15: all 49 on 8b7edcd, 45 passed, 417.9 min

All 43 original scenarios passed except question-then-answer; no research answer claimed a change anywhere. New: typo-please-correct, research-sed and new-module-esm passed. Runaway thinking now costs 110-210 s per call instead of 340-360 s.

- **rename-then-run-tests (timeout):** the plan was right (one task per file, then a test run), but the convert.js task's review was never accepted: it was judged against the other files and the test run. The by-rule rename acceptance missed it because the task's wording ("Rename the toCelsius function in src/convert.js to ...") yields no name pair; it now falls back to the user's own rename.
- **old-test-pins-value:** the task's scope held only src/thermostat.js, and its check gate failed every attempt on the old "average of three" failure too. The gate now runs the checks once without the sub-agent's changes and lets failures that were there before go to verification. The final reply claimed "changed from 3 to 4" from a run with no drafts; such a reply now starts with "Nothing in your project was changed in this run".
- **question-then-answer:** a fix-up was told to make the test "expect 18 instead of 17", reading Node's "17 !== 18" backwards. Assert lines are now labelled by rule ("the code gave 17; the test expects 18") wherever check output reaches a model. Turn 1 still researched three times instead of asking (open).
- **typo-swedish:** "Rätta stavfelet i README.md." was not seen as an edit request. Swedish edit verbs and change claims are now recognised. The answer was in English, which Oskar said is fine.

None of these fixes has run live yet.

## Run 16: all 49 on 8a0ae0b, 43 passed, 449.6 min

question-then-answer and typo-swedish passed, and rename-then-run-tests now plans and accepts all its steps. Fixed after the run (39d0fa2, 5970948, 011954f), not yet run live:

- **old-test-pins-value, rename-then-run-tests, remove-export (one cause):** verification's saved "tests" check failed only on the "average of three" test that had always failed, and "Make the tests check pass" sent fix-ups at that test (one rewrote its inputs and expected value; the review made it undo that) until a timeout or a partial end. A failed saved check now runs once more on the project as it was before the run; a failure that is the same is not missing work, and one with both kinds names only the new lines and says to leave the old ones alone. replace_in_file refuses `all: true` for a search with no name in it ("18" -> "17" had also changed `[18, 20, 22]`).
- **new-module-used (false done):** src/index.js only got `require("./format")`, formatTemp was never called, and the final reply said it was used. A name newly imported from a module the file did not import before and used nowhere else is now a draft problem for review and verification, and a warning right after the write.
- **validate-input:** the plugin was right; sameBehaviour wanted exactly "4 passed, 1 failed" and an added passing test gave "5 passed". It now accepts 4 or more passed with the 1 old failure.
- **parallel-changes (timeout, open):** the median review said the code was correct and sent it back anyway; two thinking cuts at 16k characters took 248 s and 364 s with two workers on the GPU.

### Run 16 repeats: the 8 shaky scenarios twice more (4/8 and 5/8)

Over three tries: same-file-parallel and typo-swedish 3/3; parallel-changes, question-then-answer and new-module-esm 2/3; new-module-used 1/3; old-test-pins-value and rename-then-run-tests 0/3. Three final replies claimed work that did not run (new-module-used twice, new-module-esm once), all verified only by reading the drafts. Fixed after the repeats (ed36e08, 4f80bda, 2830401), not yet run live:

- Verification now runs the program the drafts are part of (a drafted script, or an entry file that loads a drafted module), with and without the drafts; a crash the drafts caused is missing work.
- `const x = require("./m")` called as a function while m exports `{ x }` is a draft problem; so is CommonJS in a new file of a "type": "module" project.
- A finished task's pending draft is protected from fix-ups that undo it (question-then-answer: -4 went back to -3 twice).
- A task that may not edit tests is told not to undo the user's change for a test that pins the old value.

### Review of the run 16 fixes before any run (2026-11-16)

Oskar asked to look for ways these fixes could bring back problems seen before. Found and fixed, each with a unit test (test/run16Review.test.ts) and two new scenarios (fix-old-failing-test, new-module-used-twice), none run live:

- A failure "from before the request" was ignored even when fixing it was the request, so a fix that did not work could be called done. When the user's words (or a task's instructions) ask to fix a failure, old failures count as missing work again.
- The note "keep your change if a test expects the old behaviour" went to every task without a test file in scope. It now goes only with a failed comparison of values, never with a crash, and says any other failure is the sub-agent's to fix.
- The block on undoing an earlier change also stopped tasks asked to remove or drop an unrequested change. Those words now let a task through.
- The program run in verification came after the sub-agents' failed commands and was cut off when there were three. It goes first now.
- The unused-import warning right after a write said "or remove the import" before the call was written. After a write it is now a note to go on; only the review and verification hold it as a problem.

Known gaps, not fixed: the program run only catches crashes, not wrong output with exit code 0; a program that hangs (other than servers and input readers) runs until the command time limit, twice; with "Run commands" off the user gets more approval prompts per verification.

## Run 17: all 51 on 7e77551, 48 passed, 560.4 min

2026-11-17, with 60 minutes per scenario, PR #55 and #56 merged in, and the autopilot answering approvals like a reading user.
rename-then-run-tests passed for the first time, and so did the new fix-old-failing-test and new-module-used-twice.
Gates: 205 allowed, 6 held test changes accepted, 3 denials (all in command-denied, by design), no file changed on disk before review.
One false completion claim (validate-input); every other final reply matched what was done.

| Scenario | What happened | Fix (not run live yet) |
|---|---|---|
| validate-input | `targetTemp()` with no argument threw. The program run caught it, but fix-ups then changed two old expectations in test.js, the autopilot accepted the held test change, and the reply said "The work is complete" while listing the failure. | Whether an old failure is a task's work is decided from the user's own words, not a fix-up's model-written instructions. A final reply for unverified work starts with "This work is not verified as done". The scenario rejects test changes. |
| typo-please-correct | "Which word in README.md would you like corrected?" twice, without reading the file. | The prompt says never to ask for what a file answers. A question identical to the last one becomes read-only research. |
| old-test-pins-value | The one task could only change src/thermostat.js; the old test expects 18, so the saved check failed every attempt (18 spawns) and the draft was dropped each time. The reply honestly said nothing was changed. | After one fix round that was told so, a draft that fails only a comparison of values in a test the task may not change is kept (`checks_pinned`) and left to verification, which sends a fix-up for the test. |

Known risk: a fix-up can edit a test to match wrong code. Such an edit is always held for the user.

### Run 17, big questions (agentic, 2 attempts each, 148.3 min)

Mean 96%, 3 of 8 fully solved, median 17.9 min. Every file was opened in every attempt, no list had a wrong entry, and no answer made a false claim.

| Modules | Attempt 1 | Attempt 2 |
|---|---|---|
| 5 | 2/2 (2.8 min) | 2/2 (3.1 min) |
| 20 | 7/8 (10.8 min), missed 014 | 6/8 (10.3 min), missed 007, 014 |
| 50 | 22/22 (24.9 min) | 21/22 (25.5 min), missed 007 |
| 100 | 36/44 (31.1 min) | 37/44 (39.8 min) |

Most misses are modules that throw through `assertNonNegative` in util: the researcher reports "does not explicitly throw" and does not follow the call. In 100 #2 a whole block (028-030, 035-037) was missed, which looks like one batch's report. Run 14 had 36/44 and 34/44. Not fixed yet.

## Run 18: 10 scenarios twice, to confirm the run 17 fixes

2026-11-17. Pass 1 on d4672d3: 6/10 (164.2 min). Pass 2 on 60ffde4: 8/10 (120.6 min). No file changed on disk before review in either pass.

| Scenario | Pass 1 | Pass 2 |
|---|---|---|
| validate-input | passed | passed |
| typo-swedish | passed | passed |
| old-test-pins-value | passed (first time ever, `checks_pinned`) | passed |
| new-module-esm | passed | passed |
| fix-old-failing-test | passed | passed |
| parallel-changes | failed: a sub-agent said "Restored" without restoring; honestly partial | passed |
| question-then-answer | failed: guessed 2 degrees instead of asking | passed |
| new-module-used | failed: verified with output "(212.0 °C °C)", reply claimed "100.0 °C" | passed |
| typo-please-correct | passed | failed: false "was corrected" from research |
| rename-then-run-tests | failed: fix-up plan had a dependency cycle | failed: a fix-up fixed the old average bug |

What was learned, and the fix for each (those after 60ffde4 are not run live):

- A prompt sentence against asking for what a file answers made question-then-answer guess an amount. Taken back in 60ffde4; pass 2 confirms.
- A repeated question on an edit request went to read-only research, which claimed the change. It is now planned as a change; only a question goes to research.
- Merging two fix-up tasks on one file around a third left a dependency cycle. Cycles are broken by listing order (`breakCycles`).
- A program that runs without crashing was enough for "verified". What it prints with and without the drafts is now shown to verification and added to the evidence.
- The model's own "Still left" named a failure the checks had marked as there before the request. Such items are dropped by rule; when they are all it named, the request counts as done and the old failure is named.

## Run 19: all 51 on 709fa59, 47 passed, 432.1 min

2026-11-18. Every scenario that failed in run 18 passed (typo-please-correct, rename-then-run-tests, question-then-answer, parallel-changes, old-test-pins-value).
Gates: 152 allowed, 6 held test changes accepted, 3 denials (command-denied, by design), no file changed on disk before review.
No claim of a change that did not exist. Two replies said "complete" for work that was not what was asked (new-module-used, readme-section).

| Scenario | What happened | State |
|---|---|---|
| rename-everywhere | The rename was complete. "Still left" named only an index.js review item, but the fix-up planner made "Fix average test" on src/stats.js and fixed the old bug, unasked. | Fixed after the run: such a fix-up task is left out. Not run live. |
| new-module-used | format.js exports the function itself, index.js reads `.formatTemp` from it and prints `formatTemp(212)` on its own line. The program output was in the evidence, and verification still said done. | Open: verification does not compare the output with the specifics of the request. |
| readme-section | The Modes section lists only night mode, with no default mode and no temperatures; verified and called complete. | Open: same cause. |
| new-module-used-twice | A later write_file rewrote index.js without the require ("label is not defined"); a later task changed src/stats.js. The reply honestly said it was not done. | Open. |

## Run 20: all 51 on 7b5cbe5, 45 passed, 494.4 min

2026-11-20, the first run with the "parts" list in verification. new-module-used, readme-section and new-module-used-twice passed again (the reason for the list). Five scenarios that passed in run 19 failed.
Gates: 179 allowed, 6 held test changes accepted, 2 denials (command-denied, by design), no file changed on disk before review. One false completion (fix-and-add-test).

| Scenario | What happened | State |
|---|---|---|
| fix-and-add-test | A fix-up removed both copies of a duplicated test. The verdict was "done" with a part quoting the test line, which was no longer in the drafts. | Fixed: a line quoted as added must be in the drafts (`notInDrafts`). |
| rename-then-run-tests | The convert.js task failed its check ("toCelsius is not a function", no file named), so the tasks after it never started. Later the part "run the tests" was marked not met because of the old average failure. | Fixed: the failure is left to the unfinished task whose file still uses the name (`missingNames`); a part unmet only for failures from before the request is not missing work. |
| rename-everywhere | Three verdicts were "done" with every part met; each was overruled by "its review did not accept its drafts" (the review wanted another task's file; a fix-up then had nothing to draft). | Fixed: with every part shown and nothing else wrong, a review that did not accept is told to the user and sends nobody back. |
| small-context-change | A JSDoc-only request: the worker added a second `average` function; fix-ups fought over stats.js until the time limit. The parts list was right. | Open (model error). |
| stop-then-continue | The median for an even length was wrong in both the code and the new test; "Still left" alternated between fixing the code and fixing the test. | Open. |
| typo-please-correct | "Please provide the specific misspelled word…" without reading the file, and without a question mark, so the scenario ended there. | Open (passed in run 19). |

None of these fixes are run live.

## Run 21: all 51 on 12f56c2, 47 passed, 433.6 min

2026-11-21. All five failures of run 20 that had fixes passed (small-context-change, stop-then-continue, rename-everywhere, fix-and-add-test, rename-then-run-tests).
Gates: 160 allowed, 2 denials (command-denied, by design), 7 held test changes (6 accepted, 1 rejected), no file changed on disk before review. One reply said "verified" for work the scenario's check did not accept (new-module-used-twice).

| Scenario | What happened | State |
|---|---|---|
| readme-section | The section was right. Three verdicts were "done", and each was overruled because the quote was one line with the text `\n+` between the lines, which the quote check did not read as line breaks. The same false alarm showed up in esm-project and stop-then-continue (lines joined with " + "), which still passed. | Fixed: a written-out `\n` is a line break, and a quote joined with " + " is there when each part is. |
| new-module-used-twice | Verified, and the program printed the right lines. label.js has `module.exports = label`; the scenario's check called `require('./src/label').label`. The request does not say how to export it. | Scenario check changed to accept either export shape. |
| validate-input | "no mode" in the request means no argument; the plan wrote it as the string 'no mode', so `targetTemp()` throws. Three rounds kept that reading. A test change to match was held and rejected. The reply started with the not-verified notice and named the failing commands. | Open (model error; passed in runs 19 and 20). |
| typo-please-correct | Asked which word without reading README.md, in one call, with no question mark. | Open. |

The fix for readme-section is not run live. Run 22 repeats 17 scenarios five times on one commit, to get a pass rate per scenario.

## Run 22: 17 scenarios five times on 65b7e52, 78 of 85 passed

2026-11-21 15:00 to 2026-11-22 10:51, five passes in a row on one commit (15, 16, 14, 16 and 17 of 17), to get a pass rate per scenario and tell model randomness from regressions.
Gates over the five passes: 493 allowed, 1 denial (`npx jest`, by design), 30 held test changes accepted, no file changed on disk before review. No "not in the drafts" item in any pass, so the run 21 fix holds.

| Scenario | Passes of 5 |
|---|---|
| small-context-change, parallel-changes, stop-then-continue, question-then-answer, rename-everywhere, fix-and-add-test, validate-input, remove-export, readme-section, same-file-parallel, old-test-pins-value, rename-then-run-tests, new-module-esm, new-module-used-twice | 5 |
| typo-swedish | 4 |
| new-module-used | 2 |
| typo-please-correct | 2 |

Four of the seven failures claimed work that was not there:

| Scenario, pass | What happened | State |
|---|---|---|
| typo-please-correct, 1 and 3 | One call: "Please provide the specific misspelled word…", nothing read, no question mark. | Fixed: an edit request that names a file, answered with neither a question nor work, is planned (routeTurn). |
| typo-please-correct, 2; typo-swedish, 3 | The request went to research, the turn after it gave no goal, and the combined answer said the word "has been corrected". Nothing was drafted. The by-rule notice "Nothing in your project was changed" stood above it. | Fixed: an edit request is not finished by research; the change is planned unless the reply asks the user something (continueChange). |
| new-module-used, 3 | Verified. format.js has `module.exports = function formatTemp`; the check called `.formatTemp`. The request names no export shape. | Scenario check accepts either shape. |
| new-module-used, 4 | False "Verified": index.js printed "Target: 21 C (21.1 °C is 70 F)", so formatTemp was used on the wrong value. | Open: verification does not hold the program's output against the request's wording. |
| new-module-used, 1 | "Target: -6.1 °C C (21.1 C is 70 F)"; correctly not verified, ended partial. | Open (model error). |

From 2026-11-22 the Swedish scenarios (swedish-request, typo-swedish) are note-only: what goes wrong is noted and does not fail them. Without typo-swedish the run is 74 of 80.
None of these fixes are run live.

## Run 23: all 51 on 83d9e4e, 50 of 50 counted passed, 393.4 min

2026-11-23, the first full run with no counted failure and no false or over-claiming completion (no not-verified notice, no "not in the drafts" item).
Gates: 156 allowed, 1 denial (command-denied, by design), 7 held test changes accepted, no file changed on disk before review.
typo-please-correct went to research, then to a plan, and was verified in 3.1 min. The first-turn rule for edit requests in a named file did not fire in any scenario.

Noted, not counted: typo-swedish ("Rätta stavfelet i README.md.") chose research, answered "none" after round 1, and ended in a research answer that claims the correction, with nothing drafted. The logs do not show why the rule that plans an edit request after research held back (a reply with a question mark is the likely reason). That decision is now logged.

One clean run is inside the noise measured in run 22 (two or three scenarios per full run), so it does not yet show the bar is met.

## Many-file questions on fe83016 (2026-11-23)

find-throwing-5/20/50/100, agentic only, twice each, 162.1 min. No attempt missed a module that throws (17 November: 6-7 of 8 at 20 files, 36-37 of 44 at 100). The 100-file question takes about 39 min.

| Files | Attempt 1 | Attempt 2 |
|---|---|---|
| 5 | 2 of 2, 4.5 min | 2 of 2, 1.8 min |
| 20 | 8 of 8, 18.6 min | 8 of 8, 10 min |
| 50 | 22 of 22, 29.6 min | 22 of 22, 20.2 min |
| 100 | 44 of 44, 38.2 min | 44 of 44, 39.1 min |

The scorer first reported 9 false alarms (1 at 5 files, 8 at 100). Each was a line in a second list that says the module does not throw, in words the scorer did not know: "forces qty to non-negative", "uses Math.max(0, qty)", "converts negative quantity to 0 via Math.max()", "TODO to throw but currently does not". The scorer now reads those as "does not throw"; the saved answers have not been rescored yet. The request asked for the list of throwing files only, so the second list is more than was asked for.

## Still open

1. The coordinator answers project questions from memory and invents names instead of researching.
2. Reviews sometimes send back correct work with nonsense requests.
3. A reply cut off at the 8192 cap gives the user no visible sign; the step is retried quietly.
4. Final replies of parallel runs can contradict themselves.
5. Worker calls can still think for about 6 minutes with nothing to show; parallel-changes and stop-then-continue run close to the 30-minute limit.
6. Reviews sometimes contradict each other on code outside the task (average() in stats.js).
7. Reviews and verification read code but do not check program output against the request's wording.
8. Reviews do not notice a draft that removes working behaviour the request did not ask to remove.
