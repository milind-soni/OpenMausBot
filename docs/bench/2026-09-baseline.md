# Bench baseline — September 2026 (Phase 0)

This is the first entry of the benchmark track the Phase 0 plan asks for
(`docs/plans/2026-09-14-phase-0-foundation.md`, item 0.8). It records what
exists, what was measured, and what has **not** been measured yet. Nothing
below is estimated: a number appears only when a run produced it.

## What exists

- `POST /api/bench/run` and `GET /api/bench/runs/:id` (server/index.ts):
  one task on one bot as an unattended launch, a budget in steps, tokens and
  minutes, a result and a trajectory.
- `scripts/bench/run.ts` (`pnpm bench:run -- --url … --bot … --task … --out …`):
  drives the routes and writes `result.json` + `trajectory.json`.
- The numbers a run reports come from the same ledger every chat turn
  writes (`/api/metrics`): tokens in and out, cached input where the engine
  reports it, cost as the engine reports it, duration, tool steps, prompt
  shape (stable vs volatile bytes, replay), evidence coverage, filtered
  commands.

## Fixture baseline (deterministic, every fake engine)

Run by `server/bench.e2e.test.ts` on every push. The fakes report fixed
token counts, so these rows prove the driver and the budget, not model
quality.

Rows below were produced on Sep 15, 2026 by `pnpm bench:run` against a throwaway harness
(temp home, the repository's fakes), one run per engine, budget `steps=50,tokens=100000,minutes=2`.

| Engine (fake) | Task | Status | Turns | Steps | Tokens in / out (cached) | Cost | Duration | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code (`fake-claude-cli`, 2 scripted calls) | list files, say done | settled | 1 | 2 | 12 / 5 (2) | 0.01 | 76 ms | preview |
| Codex (`fake-codex-app-server`) | list files, say done | settled | 1 | 2 | 7 / 3 (4) | — | 104 ms | preview |
| ACP (`fake-acp-cli`, grokAgent) | list files, say done | settled | 1 | 1 | 0 / 0 (fake reports none) | — | 77 ms | preview |
| pi (`fake-pi-cli`, tooluse) | list files, say done | settled | 1 | 1 | 12 / 2 (0) | — | 80 ms | preview |

The budget paths are proven by `server/bench.e2e.test.ts` with a Claude fake whose reply is
held behind a gate nobody writes: three tool calls against `steps=2` ends as
`budget_exceeded` / `steps`; a gated reply against `minutes=0.02` ends as `budget_exceeded` /
`minutes`, and the bot is idle afterwards.

## Terminal-Bench 2.0 through Harbor — not yet run

The real baseline needs a live engine and a paid account, so it is not run
by tests and was not run while building Phase 0. When it is, this is the
recipe, and the table below is what to fill in.

1. Start a harness on a machine with the engine CLI signed in, with an
   isolated data directory:
   `openmausbot serve --port 8799 --data-dir /tmp/omb-bench --no-pair`.
2. Create one bot per engine under test (`/api/bots`, then `PATCH` its
   `modelSelection`), each pointed at a scratch project folder.
3. Write a Harbor agent adapter that, per task, copies the task's workspace
   into a fresh folder, calls `pnpm bench:run -- --url http://127.0.0.1:8799
   --bot BOT --task @instruction.md --cwd FOLDER --budget
   steps=200,tokens=400000,minutes=30 --out OUT`, and hands the folder back
   to Harbor's own tests. The adapter lives in the Terminal-Bench repository
   format (a Python `BaseAgent` whose `run` shells out to the script); it is
   not part of this repository yet.
4. Run `harbor run -d terminal-bench@2.0 -a <adapter> -m <model>` with
   `N ≥ 3` trials per task and record everything the result files carry.

| Engine | Model | Trials (N) | Tasks | Pass rate | Tokens per task (mean) | Cost per task (mean) | Budget hits | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | | | | | | | | |
| Codex | | | | | | | | |
| one ACP engine | | | | | | | | |

Two comparisons are already wired for when these rows exist:

- **Command filters (step 9, finding F5):** run the same suite with the bot's
  `commandFilters` on and off; `filteredCommands` and tokens per task in
  `/api/metrics` answer whether the filter earns its default.
- **Process reuse (finding F1):** `stablePrefixChanges` and cache-hit share
  per engine before and after a change to the stable prompt half.
