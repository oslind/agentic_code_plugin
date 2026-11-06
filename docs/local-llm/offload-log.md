# Local model log

Every run of the end-to-end suite against a local model adds a line here (written by `npm run e2e`; set `AGENTIC_E2E_NO_LOG=1` to skip). Same idea as the flight sim's offload log: date, model, task, outcome.

| Date (UTC) | Model | Task | Outcome |
| --- | --- | --- | --- |
| 2026-11-05 13:01 | qwen3-8b-16k (qwen3:8b, num_ctx 16384) | e2e: research-answer, change-final-reply, command-use, verify-fix, draft-for-review | 3/5 passed, 39 min, unloaded. change-final-reply: a request hung 27 min; draft-for-review: promise with action none |
| 2026-11-05 18:51 | qwen3-8b-16k | e2e: research-answer, change-final-reply, command-use, verify-fix, draft-for-review | 2/5 passed, unloaded qwen3-8b-16k (row written by hand from the run report) |
| 2026-11-05 20:23 | qwen3-8b-16k | e2e: new scenarios (run 2) | stopped on "pause" after 8 scenarios, 5 passed; unloaded (row written by hand from the run report) |
| 2026-11-06 00:41 | qwen3-8b-16k | e2e: command-use, verify-fix, draft-for-review, project-skill-trusted, long-conversation, dependent-changes, stop-then-continue, command-denied, missing-script, question-then-answer, no-json-mode, research-not-change | 6/12 passed, 129.3 min, unloaded qwen3-8b-16k |
| 2026-11-06 07:24 | qwen3-8b-16k | e2e: verify-fix, long-conversation, dependent-changes, stop-then-continue, question-then-answer, research-not-change | 3/6 passed, 88.5 min, unloaded qwen3-8b-16k |
| 2026-11-06 09:03 | qwen3-8b-16k | e2e: research-answer, change-final-reply, command-use, draft-for-review, project-skill-trusted, project-skill-untrusted, small-context-change, cut-off-answer, parallel-changes, command-denied, missing-script, no-json-mode | 10/12 passed, 98.7 min, unloaded qwen3-8b-16k |
| 2026-11-06 13:47 | qwen3-8b-16k | e2e: research-answer, change-final-reply, command-use, verify-fix, draft-for-review, project-skill-trusted, project-skill-untrusted, long-conversation, small-context-change, cut-off-answer, parallel-changes, dependent-changes, stop-then-continue, command-denied, missing-script, question-then-answer, no-json-mode, research-not-change | 15/18 passed, 223.0 min, unloaded qwen3-8b-16k |
| 2026-11-06 14:51 | qwen3-8b-16k | e2e: dependent-changes, stop-then-continue, no-json-mode | 0/3 passed, 62.0 min, unloaded qwen3-8b-16k |
| 2026-11-06 17:27 | qwen3-8b-16k | e2e: research-answer, change-final-reply, command-use, verify-fix, draft-for-review, project-skill-trusted, project-skill-untrusted, long-conversation, small-context-change, cut-off-answer, parallel-changes, command-denied, missing-script, question-then-answer, research-not-change | 14/15 passed, 155.9 min, unloaded qwen3-8b-16k |
| 2026-11-06 18:58 | qwen3-8b-16k | e2e: parallel-changes, dependent-changes, stop-then-continue, no-json-mode | 2/4 passed, 90.5 min, unloaded qwen3-8b-16k |
| 2026-11-06 19:27 | qwen3-8b-16k | e2e: parallel-changes, stop-then-continue | 1/2 passed, 28.3 min, unloaded qwen3-8b-16k |
| 2026-11-06 19:57 | qwen3-8b-16k | e2e: parallel-changes | 0/1 passed, 30.0 min, unloaded qwen3-8b-16k |
