# Phase 3 part 5 — the benchmark track: the engine bake-off

## The problem

The scorecard compares one build against another on one engine. Nothing compares engines on
the same harness, and picking an engine from one run of one task is guesswork.

## What is built

`scripts/bench/bakeoff.ts`: the same tasks through N bots that differ only in `modelSelection`,
filed on the board so every run gets the harness's own gates (part 1) and verifier (part 3),
one bot per (engine, trial) so every trial starts cold, engines in parallel, a bot's tasks in
sequence. Scored per task and per engine, averaged over trials:

| Column | Source |
| --- | --- |
| Correct | the task's own deterministic check (a file's contents, a number in the reply, a tool used) |
| Judged complete | the verifier's verdict on the board task |
| Agree | how often the judge and the check match — the judge's quality |
| Attempts | board attempts (a retry after "not complete" counts) |
| In / Out / Cost | the usage ledger rows of the run thread, harness calls excluded |
| Wall s | from "ready" to the verdict, dispatch tick included |
| Cards | human interventions: question or permission cards raised in the run thread |
| Denials | policy denials recorded on the ledger rows |

Three tasks in v1: write a file with exact contents, a multiplication answered with the number
only, and a count of the board through a tool. Output: one markdown table, written with
`--out` under `docs/bench/scorecard/`.

## Deferred, with reasons

- **Planner/executor split and best-of-N with a judge on a hard subset.** Both need a hard task
  subset with ground truth; the three v1 tasks are not that. Add when a subset exists (the
  SWE-bench Pro run, which needs a runner box).
- **Surfacing the table in the app.** A screen; the harness rule from Sep 16 is screens only
  when a harness part needs a place to show something, kept minimal. The markdown record is the
  deliverable for now.

## Engines

Any engine the harness lists in `/api/instances`; the script refuses an unknown one. A run on an
engine without a one-shot call has no verdict (judged "—") and is still scored on the rest.

## Measured

A smoke run on the fake engine (the script's flow, the table's shape); a live run on the engines
installed on this machine recorded under `docs/bench/scorecard/`.
