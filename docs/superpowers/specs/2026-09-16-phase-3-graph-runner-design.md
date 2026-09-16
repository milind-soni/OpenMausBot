# Phase 3 part 4 — graph runner v1

## The problem

A routine run is one prompt, one turn, one status. Nothing checks or judges it, and a crash
between the turn ending and the run being recorded loses the run ("OpenMausBot restarted while
this routine was running"). Unattended work needs steps with checkpoints.

## What is built

**Storage and the node machine** (`server/graph-runner.ts`, `graphs.db`): a graph run is a
fixed, ordered list of nodes of kinds `bot_turn / decision / code / check / approval / verify`.
Each node checkpoints its status and output; finishing the last node completes the run; a failed
node fails the run. `resumable(kind)` lists runs still running whose bot turn is done and a later
node is pending or was interrupted; `resetRunningNodes` makes the interrupted node run again. A
finished node's output is reused on resume, never recomputed — a run whose nodes are all
recorded replays with zero model calls, which is the recording driver the roadmap asked for,
at the harness level rather than per engine.

**The first graph: a routine run.** Nodes `intake → work → check → judge → ship`:
- `intake` (decision): records the instructions the run used (the prompt snapshot) as the
  acceptance text. The routine's instructions are the source; the graph is derived from them.
- `work` (bot_turn): the routine's turn, exactly as today.
- `check` (check): part 1's gates in the bot's working folder, when it has one.
- `judge` (verify): part 3's verifier with the instructions as acceptance, the run's output as
  the result, the gates, and the bot's last words.
- `ship` (code): writes the verdict into the run: complete → the run completes with the
  verdict line appended to its output; not complete → the run fails with the verdict line as
  its error (the failure streak counts it, the runs list shows the dot). No automatic re-run:
  a routine runs again on its schedule, and the next run's continuity carry includes the
  verdict.

**Wiring.** `RoutineManagerOptions.afterTurn(run, threadId)` runs check → judge → ship after a
successful turn; the manager keeps the run `running` until it resolves. On boot, before the
manager fails "restarted while running" runs, it asks `resumeAfterRestart(run)`: when the
graph run's `work` node is done, the run stays running and check → judge → ship run from the
checkpoint, without a new turn. Room-goal runs (several turns) are out of scope for v1.

**Config.** `verify.routines` (default on) — off leaves routine runs exactly as before; the
graph is still recorded.

## Engines

Full on every engine: the graph is harness-side; `judge` uses the bot's own engine through the
same one-shot path as the board verifier (an engine without one leaves the run judged "not run"
and completed as before).

## Measured

`server/graph-runner.test.ts` (nodes, checkpoints, reuse, failure, completion, resumable set,
reopen); `server/routine-graph.e2e.test.ts` (fake engine): a routine run completes with the
verdict line in its output; a run whose prompt carries `[[fake:incomplete]]` fails with the
verdict as its error; a run interrupted after `work` (simulated by resetting the checkpoint and
the run to running, then rebooting) resumes at `check` and completes without the engine
starting a turn (the fake's prompt log gains nothing).
