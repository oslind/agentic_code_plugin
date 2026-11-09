# Benchmark pass 1: agentic chat vs one conversation

Run 2026-11-08 19:12 to 23:59 UTC on Oskar's PC: commit e0a0df6, qwen3-8b-16k (Ollama, 16k context), 14 tasks, one attempt per mode, two sub-agents at once in agentic mode, 30-minute limit per attempt, 286.6 min in all. find-throwing scores use the corrected scoring (230a6f5, `npm run bench:rescore`); the only change was find-throwing-5 agentic, 40% to 100%.

**In short:** the agentic chat was more reliable and never claimed a change it had not made, at about 3 times the time and tokens. It clearly wins once a request holds several changes. It did not show that it can cover much more code in one question: on large questions both modes mostly failed. One attempt per task, so these are indications, not proof.

## Totals

| | single | agentic |
|---|---|---|
| Mean score | 68% | 89% |
| Fully correct | 6 of 14 | 9 of 14 (3 hit the time limit) |
| Fully correct and finished | 6 of 14 | 6 of 14 |
| False "done" (a change fell short and the answer did not say so) | 4 of 4 | 0 of 2 |
| Changes to files nobody asked about | 0 | 0 |
| Hit the 30-minute limit | 0 | 4 |
| Median time per task | 3.2 min | 11.5 min |
| Total time | 72 min | 214 min |
| Mean tokens per task | 30k | 91k |
| Largest prompt | 7.5k | 5.2k |

## Changes in one request (agentic wins)

| changes, project files | single | agentic |
|---|---|---|
| 1, 24 files | 100%, 1.9 min | 100%, 5.8 min |
| 3, 24 files | 100%, 8.5 min | 100%, 12.4 min |
| 3, 104 files | 67%, 5.6 min | 100%, 10.6 min |
| 6, 24 files | 0%, 6.7 min, false "done" | 100%, 30 min (limit) |
| 10, 24 files | 50%, 14.7 min, false "done" | 80%, 30 min (limit) |

## Code one question can cover (no real win)

An empty answer scores 56 to 60% here, because most modules do not throw, so the "found" columns are the honest ones.

| modules | throwing found: single | agentic | score: single | agentic |
|---|---|---|---|---|
| 5 | 2 of 2 | 2 of 2 | 100% | 100% |
| 20 | 0 of 8 | 2 of 8 | 60% | 70% |
| 50 | 22 of 22 plus 28 false alarms (listed every file) | 9 of 22, 3 false alarms | 44% | 68% |
| 100 | 0 of 44 | 2 of 44 | 56% | 58% |

## The fixed tasks

| task | single | agentic |
|---|---|---|
| fix-bug | 100%, 2.2 min | 100%, 16.6 min |
| three-changes | 100%, 2.7 min | 100%, 30 min (limit) |
| config-module | 100%, 8.8 min | 100%, 30 min (limit) |
| document-all | 75%, 8.3 min, false "done" | 75%, 8.8 min |
| explain-bug | 0%, 3.0 min (guessed, never ran the tests) | 100%, 3.5 min |

## Reading it

1. Agentic's 89% includes three runs that never finished: the files were right, but there was no verification or final answer. Counting only finished work it is 6 against 6, on different tasks. The 30 minutes is a test setting, not a limit in the extension.
2. Context size limited nothing (largest prompts 7.5k and 5.2k of 16k). The single conversation failed by stopping early and claiming success, not by running out of room.
3. Small tasks favour one conversation: the agentic overhead does not pay for itself on a quick fix.
4. The clearest difference is honesty: every failed single-conversation change claimed success; no agentic one did.
5. Large questions are the clearest thing to improve: at 100 modules the agentic run checked only a few files.

Raw results: `C:\Users\Oskar Lind\Documents\agentic-e2e-results\bench\2026-11-08T19-12-03-bench\` (attempts.jsonl, scoreboard.md, scoreboard-rescored.md).
