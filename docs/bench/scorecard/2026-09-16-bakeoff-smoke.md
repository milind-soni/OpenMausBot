# Engine bake-off — smoke (2026-09-16)

Same 3 tasks × 1 trial(s) per engine, filed on the board on bots that differ only in engine; every run judged by the harness's verifier. Averages per task; "correct" is the task's own deterministic check, "judged" is the verifier's verdict, "agree" is how often they match.

| Engine · model | Task | Correct | Judged complete | Agree | Attempts | In | Out | Cost | Wall s | Cards | Denials |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude · claude-sonnet-5 | file | 0% | 100% | 0% | 1.0 | 12 | 5 | $0.0100 | 30 | 0.0 | 0.0 |
| claude · claude-sonnet-5 | arith | 0% | 100% | 0% | 1.0 | 12 | 5 | $0.0100 | 30 | 0.0 | 0.0 |
| claude · claude-sonnet-5 | tool | 0% | 100% | 0% | 1.0 | 12 | 5 | $0.0100 | 30 | 0.0 | 0.0 |
| **claude · all** | | **0%** | 100% | 0% | 1.0 | 12 | 5 | **$0.0100** | 30 | 0.0 | 0.0 |

Rule from the gap analysis §16: report the judge beside the number and average trials; a flaky engine cannot be picked from one run. Wall time includes the board's dispatch tick (up to 30 s).
