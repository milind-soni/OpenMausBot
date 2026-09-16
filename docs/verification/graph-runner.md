# Graph runner v1 (Phase 3 part 4)

What it proves: a routine run is a graph of nodes with a checkpoint per node
(intake → work → check → judge → ship), so the run is checked and judged after its turn, and a
restart resumes at the next node instead of failing the run.

- Unit: `server/graph-runner.test.ts` — nodes start pending in order; checkpoints with output and
  reuse; a failed node fails the run; the last node completes it; the resumable set (turn done,
  later node pending or interrupted); reopen.
- End to end: `server/routine-graph.e2e.test.ts` (fake engine) — a run completes with
  `verdict` "Verified: complete" and its own report untouched, nodes intake/work done, check
  skipped (no folder), judge/ship done; a run whose prompt carries `[[fake:incomplete]]` fails with
  the verdict as its error; a run put back to `running` with judge interrupted and ship pending,
  then a server restart, completes from the checkpoint and the fake engine's prompt log gains no
  new turn.
- The existing routine suites (continuity, results, delegation, cron, startup) stay green: the
  turn itself is unchanged, and a verifier call's dump goes beside the turn's dump.

Config: `verify.routines` (default on; also off when `verify.auto` is off). Room-goal runs are
not graphs in v1.

By hand: run a routine on a bot; the run's card shows the verdict on completion, or the verdict
line as the failure reason when the judge rejects it.
