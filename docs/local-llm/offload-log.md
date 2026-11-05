# Local model log

Every run of the end-to-end suite against a local model adds a line here (written by `npm run e2e`; set `AGENTIC_E2E_NO_LOG=1` to skip). Same idea as the flight sim's offload log: date, model, task, outcome.

| Date (UTC) | Model | Task | Outcome |
| --- | --- | --- | --- |
| 2026-11-05 13:01 | qwen3-8b-16k (qwen3:8b, num_ctx 16384) | e2e: research-answer, change-final-reply, command-use, verify-fix, draft-for-review | 3/5 passed, 39 min, unloaded. change-final-reply: a request hung 27 min; draft-for-review: promise with action none |
