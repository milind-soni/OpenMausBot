# Engine bake-off — phase-3 live (2026-09-16)

Same 3 tasks × 2 trial(s) per engine, filed on the board on bots that differ only in engine; every run judged by the harness's verifier. Averages per task; "correct" is the task's own deterministic check, "judged" is the verifier's verdict, "agree" is how often they match.

| Engine · model | Task | Correct | Judged complete | Agree | Attempts | In | Out | Cost | Wall s | Cards | Denials |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude · claude-sonnet-5 | file | 100% | 100% | 100% | 1.0 | 69,542 | 265 | $0.0643 | 90 | 0.0 | 0.0 |
| claude · claude-sonnet-5 | arith | 100% | 100% | 100% | 1.0 | 35,200 | 3 | $0.0417 | 24 | 0.0 | 0.0 |
| claude · claude-sonnet-5 | tool | 100% | 100% | 100% | 1.0 | 72,198 | 172 | $0.0426 | 38 | 0.0 | 0.0 |
| **claude · all** | | **100%** | 100% | 100% | 1.0 | 58,980 | 147 | **$0.0496** | 51 | 0.0 | 0.0 |
| codex · gpt-6-astra | file | 100% | 100% | 100% | 1.0 | 56,881 | 274 | $0.0000 | 106 | 0.0 | 0.0 |
| codex · gpt-6-astra | arith | 100% | 100% | 100% | 1.0 | 22,724 | 17 | $0.0000 | 32 | 0.0 | 0.0 |
| codex · gpt-6-astra | tool | 100% | 0% | 0% | 2.0 | 98,640 | 367 | $0.0000 | 98 | 0.0 | 0.0 |
| **codex · all** | | **100%** | 67% | 67% | 1.3 | 59,415 | 219 | **$0.0000** | 79 | 0.0 | 0.0 |

Rule from the gap analysis §16: report the judge beside the number and average trials; a flaky engine cannot be picked from one run. Wall time includes the board's dispatch tick (up to 30 s).

## Reading the table

- **Both engines got every task right by the deterministic check.** Claude was judged complete every time; Codex was judged *not complete* twice on the board-count task although its answer (12) was right. The verifier reads the result digest and the bot's own words, not the tool's output, so it could not see the `task_list` result the count came from and refused an unproven number — which is the rule it was given. Follow-up (F21): give the verifier the tails of the run's last tool results as evidence.
- **Codex reports no price** (subscription), so its cost column is $0.00 by construction; compare tokens instead. Input tokens per task were close (59k vs 59k on average); Codex wrote more output.
- **Wall time** includes the board's dispatch tick (up to 30 s) and, for Codex's rejected task, a second attempt.
- The first run of this bake-off (before `b10a0567`) found that the Codex driver had no one-shot call at all, so nothing on Codex was ever judged (F20); `codex exec` now serves as the one-shot.
- Codex's run thread mentioned a "using-superpowers skill": the Codex CLI reads the machine's own global instructions, which an unattended board run should not inherit. Noted for Phase 5 (computers) — not a harness change here.
