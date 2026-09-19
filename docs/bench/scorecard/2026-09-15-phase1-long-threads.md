# Scorecard, 15 Sep 2026: main vs Phase 1 part 1 (long threads)

Recipe: `docs/verification/harness-scorecard.md`, run by `scripts/bench/scorecard.ts`, now with
T5 (ten turns that each append and print a growing file). Builds: main `50398337` and
`phase-1/long-threads` at `72755920`, each as a standalone harness on its own port and data
folder, run one after the other. Engine: Claude Code 2.1.268, `claude-sonnet-5`; Codex for T4.
Default budget: 60% of a 200,000 window = 120,000 input tokens.

## T5, the long thread

| Turn | main: in / cached / $ / s | Phase 1: in / cached / $ / s |
| --- | --- | --- |
| 1 | 88,687 / 43,850 / 0.193 / 9.8 | 88,600 / 43,848 / 0.198 / 15.1 |
| 2 | 91,205 / 89,789 / 0.026 / 7.5 | 92,166 / 90,183 / 0.028 / 6.0 |
| 3 | 94,541 / 92,613 / 0.029 / 7.5 | 95,521 / 93,577 / 0.029 / 6.1 |
| 4 | 98,877 / 96,461 / 0.031 / 7.5 | 99,876 / 97,457 / 0.032 / 6.8 |
| 5 | 104,201 / 101,285 / 0.034 / 7.5 | 105,248 / 102,287 / 0.035 / 6.8 |
| 6 | 110,525 / 107,109 / 0.038 / 8.3 | 111,644 / 108,201 / 0.038 / 6.8 |
| 7 | 117,861 / 113,933 / 0.041 / 8.3 | 119,080 / 115,079 / 0.042 / 6.8 |
| 8 | 126,197 / 121,781 / 0.044 / 7.5 | 127,692 / 123,073 / 0.048 / 9.1 |
| 9 | 135,521 / 130,605 / 0.048 / 7.5 | **95,330** / 84,317 / 0.066 / **22.9** ← compacted first |
| 10 | 145,846 / 140,429 / 0.052 / 7.5 | **105,732** / 100,289 / 0.045 / 9.9 |
| **input at turn 10** | **145,846** | **105,732 (−27%)** |
| **total over ten turns** | **1,116,143** | **1,044,493 (−6%)** |
| correct | 10 / 10 | 10 / 10 |

Turn 8 settled at 127,692 input, over the 120,000 budget, so turn 9 compacted first: the
harness folded the first six exchanges into a record (a model summary from the one-shot helper
plus the deterministic digest record), started a fresh Claude session, and replayed the summary
with the last two exchanges. The next turns grew again from that lower base.

What it cost: the compaction turn took 22.9 s (about 12 s for the model summary, the rest the
fresh session's cache write) and $0.066 instead of $0.048. On a thread that keeps going, every
turn after the compaction is cheaper than it would have been; over exactly ten turns the saving
is 6% of tokens and it grows with length.

## T1 to T4 (must not change)

| Task | main | Phase 1 | Correct |
| --- | --- | --- | --- |
| T1 file task, in / $ | 131,994 / 0.199 | 88,093 / 0.191 (the engine made one model call fewer; not the harness) | both |
| T2 follow-ups 1–3, in | 43,727 · 43,788 · 43,851 | 43,690 · 43,888 · 43,951 | both |
| T2 follow-ups 2–3, wall | 2.3 · 3.0 s | 1.5 · 1.5 s | both |
| T3 big output, in | 88,589 | 88,642 | both |
| T4 Codex takes over, in | 22,319 | 22,402 | both |

Under budget, nothing changed.

## After rebasing onto main's context reading (same day, later)

Main gained `usage.context.tokens` (what filled the window on the last model call) while this
was being built; the budget now reads that instead of its own field. Re-measured on the
reconciled branch (`docs/plans/2026-09-15-phase-1.md`, F9):

| Setting | Compactions | Input at turn 10 | Total over ten turns | Correct |
| --- | --- | --- | --- | --- |
| main (no compaction) | — | 145,846 | 1,116,143 | 10 / 10 |
| Phase 1, default budget (60% of 200k) | turn 9 | 105,881 (−27%) | 1,037,864 (−7%) | 10 / 10 |
| Phase 1, budget 30% (60k), before the floor guard | every turn from 4 to 10 | 94,325 | 927,537 (−17%), but 17–30 s per turn | 10 / 10 |
| Phase 1, budget 30% (60k), with the floor guard | turns 4 and 9 | 105,187 | 997,704 (−11%) | 10 / 10 |

The third row is why the floor guard exists: a budget below what the system prompt plus the
kept exchanges cost (about 90k here) would otherwise compact on every turn, paying the model
summary and a cache write each time. With the guard the next compaction waits until the
context has regrown a quarter past the first post-compaction reading.

## Two bugs this run found, both fixed on the branch before the PR

1. **The fresh session was not fresh (Claude).** The first branch run compacted at turns 9 and
   10 but input kept climbing to 149,916: the Claude driver reuses its idle live process whenever
   no session id is passed, which is exactly what a "start fresh" turn looks like since Phase 0's
   process reuse. The same has applied to edits (rewinds) since then. A new contract field,
   `SendTurnInput.sessionReset`, now closes the live process; Codex, pi and the ACP family already
   start a new session when no cursor is passed.
2. **The summary guessed the working directory.** With the session fixed, turns 9 and 10 were
   wrong: the one-shot summariser is its own Claude Code call whose prompt names *its* working
   directory (the server's), and it wrote "presumably in the working directory …" into the
   summary; the fresh session then ran its command there and found no file. The prompt now
   forbids any environment detail not in the conversation, and the one-shot runs in the task's
   folder.

## How to repeat

```sh
OMB_DATA_DIR=$HOME/.openmausbot-score-phase1 OMB_PORT=28831 node --experimental-strip-types server/index.ts &
node --experimental-strip-types scripts/bench/scorecard.ts --url http://127.0.0.1:28831 \
  --data-dir $HOME/.openmausbot-score-phase1 --label phase1 --engine claude --only-long
```
