# Scorecard, 15 Sep 2026: main vs Phase 0

Recipe: `docs/verification/harness-scorecard.md`, run by `scripts/bench/scorecard.ts`.
Builds: main `50398337` and Phase 0 `441f2ed3` (PR #1244's tip), each as a standalone
harness on its own port and data folder on the same Mac. Engines: Claude Code 2.1.268
(`claude-sonnet-5`, subscription) for T1–T3, Codex CLI 0.153.4 (`gpt-5.6-sol`) for T4.

Two runs each. Run 1 ran both builds at the same moment; run 2 ran them one after the
other. Read run 2 for latency; run 1's wall times are polluted by the overlap.

## Run 2 (sequential)

**Phase 0**

| Task | Turn | Engine | Wall s | In | Out | Cached | Cost $ | Steps | Correct | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 file-task | 1 | claude | 12.1 | 132,217 | 397 | 87,877 | 0.200 | 2 | yes | full |
| T2 follow-ups | 1 | claude | 7.6 | 43,689 | 380 | 0 | 0.180 | 0 | yes | preview |
| T2 follow-ups | 2 | claude | 2.3 | 44,126 | 3 | 43,687 | 0.190 ⚠ | 0 | yes | preview |
| T2 follow-ups | 3 | claude | 2.3 | 44,189 | 3 | 44,124 | 0.199 ⚠ | 0 | yes | preview |
| T3 big-output | 1 | claude | 9.8 | 88,638 | 171 | 43,815 | 0.191 | 1 | yes | full |
| T4 engine-switch | 1 | codex | 9.1 | 22,381 | 24 | 11,136 | — | 0 | yes | preview |

**main**

| Task | Turn | Engine | Wall s | In | Out | Cached | Cost $ | Steps | Correct | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 file-task | 1 | claude | 10.6 | 87,958 | 407 | 43,687 | 0.191 | 2 | yes | — |
| T2 follow-ups | 1 | claude | 2.3 | 43,708 | 3 | 0 | 0.176 | 0 | yes | — |
| T2 follow-ups | 2 | claude | 2.3 | 43,769 | 3 | 43,706 | 0.009 | 0 | yes | — |
| T2 follow-ups | 3 | claude | 3.0 | 43,832 | 3 | 43,767 | 0.009 | 0 | yes | — |
| T3 big-output | 1 | claude | 9.9 | 88,482 | 227 | 43,709 | 0.191 | 1 | yes | — |
| T4 engine-switch | 1 | codex | 7.6 | 22,207 | 24 | 11,136 | — | 0 | yes | — |

## Run 1 (both builds at once; latency not comparable)

| Build | T1 wall / in | T2 walls / in | T3 wall / in | T4 wall / in | Correct |
| --- | --- | --- | --- | --- | --- |
| Phase 0 | 14.4 s / 137,603 | 4.5, 4.5, 3.8 s / ~45.6k each | 11.3 s / 92,175 | 9.1 s / 22,616 | 6 / 6 |
| main | 8.3 s / 137,497 | 2.3, 3.0, 2.3 s / ~45.5k each | 6.8 s / 92,147 | 14.3 s / 22,584 | 6 / 6 |

## What the numbers say

- **Correctness: equal.** 12 of 12 on both builds. T4 (Codex takes over a Claude
  thread) was already answerable on main because its replay carries the last 40
  messages, tool chips included; Phase 0 answers it from the digest with a
  byte-budgeted replay instead. Same answer, different mechanism.
- **Tokens: equal.** Every turn matches within a few hundred tokens. Phase 0 did not
  set out to cut tokens; it set out to *see* them (`/api/metrics`). The prompt is the
  same size on both builds: the "in" column is dominated by the system prompt and tool
  schemas, roughly 44k tokens per model call, and follow-ups read almost all of it from
  cache on both builds. T1's "in" varies with how many model calls the engine chose to
  make (two or three), not with the harness.
- **Latency: equal** in run 2 (T2 follow-ups 2.3 s on both). Run 1's gap was the two
  runs sharing one machine and one account at the same time.
- **New on Phase 0:** evidence coverage `full` on the tool turns (the harness holds the
  whole tool result, not a preview), and the `/api/metrics` figures per bot, engine and
  trigger. Nothing to compare against on main because main does not record them.
- **Bug found by this run (Phase 0 only):** T2 turns 2 and 3 booked $0.190 and $0.199
  where main booked $0.009. With the Claude CLI now kept alive across turns, its
  `total_cost_usd` is the *session* total, and the driver booked it as the turn's cost.
  Main never saw this because it relaunched the CLI every turn. Fix: book the delta
  since the previous turn on the same live session. Tracked in PR #1243.

## Run 3 (Phase 0 after the cost fix, sequential, alone)

| Task | Turn | Engine | Wall s | In | Out | Cached | Cost $ | Steps | Correct | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 file-task | 1 | claude | 9.8 | 88,158 | 378 | 43,798 | 0.191 | 2 | yes | full |
| T2 follow-ups | 1 | claude | 2.3 | 43,788 | 3 | 0 | 0.176 | 0 | yes | preview |
| T2 follow-ups | 2 | claude | 1.5 | 43,849 | 3 | 43,786 | 0.009 | 0 | yes | preview |
| T2 follow-ups | 3 | claude | 1.5 | 43,912 | 3 | 43,847 | 0.009 | 0 | yes | preview |
| T3 big-output | 1 | claude | 7.6 | 88,764 | 235 | 43,847 | 0.192 | 1 | yes | full |
| T4 engine-switch | 1 | codex | 9.8 | 22,389 | 24 | 11,136 | — | 0 | yes | preview |

The follow-up cost is per turn again. The 1.5 s follow-ups (2.3 s on main in run 2)
are consistent with the CLI process being reused rather than relaunched, but one run
is one sample; repeat before calling it a win.

## How to repeat

```sh
OMB_DATA_DIR=$HOME/.openmausbot-score-phase0 OMB_PORT=28801 node --experimental-strip-types server/index.ts &
node --experimental-strip-types scripts/bench/scorecard.ts --url http://127.0.0.1:28801 \
  --data-dir $HOME/.openmausbot-score-phase0 --label phase0 --engine claude --switch-to codex
```

Run the builds one after the other, never at the same time, and expect a few
thousand tokens and a second or two of variance between runs of the same build.
