# Phase 2, part 1: the task object — owner, due date, a money budget, results as digests

Status: design taken on the recommendation (Omkar, Sep 15, 2026; decision 11 in force). Builds on #1185's task board (brought onto the chain unchanged: `server/task-board.ts`, `task-dispatcher.ts`, `task-dispatch-bot.ts`, `task-turn-watch.ts`, `task_create` / `task_list`, all behind `features.board`) and on Phase 0's usage rows and digests. Plan pointer: `docs/plans/2026-09-15-phase-2.md`, part 1.

## Goal

A board task carries who owns it, when it is due, how much money it may spend, and what its turn did, so a person can read the board and a bot can be stopped by money before it runs away. Measured by a bench task whose turns cost more than its cap: it pauses with "paused, needs a budget increase", never fails, and a raised cap resumes it; T1–T10 unchanged (the board is off by default).

## What earlier PRs taught (`AGENTS.md` rule 2)

- **#1185 (open, this account):** the board core; imported as is, twelve commits plus two follow-ups. Its rule that completion is observed by the harness and never self-reported is kept: the budget is booked by the harness from usage rows, never from a bot's claim.
- **#59 (open, external): per-task execution budgets** on the event stream (tokens, tool calls, wall clock). Its rule "never enforce a limit from a fabricated estimate" is taken: a turn that reports no cost books nothing against the cap. Money was not in #59; the two do not share code.
- **#1054 (merged): the monthly spend limit.** The task cap sits under it: the monthly cap refuses a turn at admission, the task cap pauses a task at settle.
- **#60 / #888 (open, external):** checkpoints and restart recovery; Phase 1 part 4's remainder, not this.

## Decision

1. **Three columns on the task row:** `owner` (a bot id, or `person`), `dueAt` (ms), `budgetUsd` (nullable; no cap when null). Settable at creation (`task_create`, `POST /api/tasks`) and by a person through `PATCH /api/tasks/:id`. `task_list` shows them. A board created before this part gains the columns on open (`ALTER TABLE … ADD COLUMN`, idempotent).
2. **Spend, booked by the harness.** `spentUsd` on the row, added to at every settle of a turn that ran in the task's thread, from the same usage row the ledger books (the fingerprinted harness calls count too, since they book rows on the thread). A turn that reports no cost adds nothing (#59's rule) and the row says how many turns were unpriced.
3. **Warn at 70%, pause at 100% (decision 11).** Crossing 70% posts one comment on the task ("70% of its budget spent"), once. Reaching the cap moves the task `running → blocked` with `blockedReason: "paused, needs a budget increase"` and posts a comment; a task at or over its cap is never dispatched again (`canDispatch` declines it before a claim, so no attempt is spent). Raising `budgetUsd` above `spentUsd` on a task blocked for budget moves it back to `ready`. Only a person raises it: the agents tools carry no budget field on patch; a bot may comment.
4. **A default cap for unattended work.** `board.defaultBudgetUsd` in config (null by default = no cap) applies to a task created without one when it is first dispatched; board dispatch is unattended by definition, which is decision 11's "lower default for unattended bots".
5. **The result is the turn's digest.** When the digest for a board task's turn is written, the task's `result` becomes the digest line (tools, files, memory, reply), replacing the reply-only text the watch stored at settle. A task read from `task_list` therefore says what was done, not only what was said.

## Non-goals

The Kanban UI (Phase 2's board view is a later part; the routes are the surface for now). Token or step budgets (#59's shape; money is the cap that decision 11 chose). A bot raising its own budget. Owner as a person's identity beyond the literal `person`.

## Engines

Harness-side, every engine full: spend is booked from the usage row every driver produces; a driver that reports no cost books nothing and the row says so. The digest exists on every engine (Phase 0); tool-less engines' digests carry reply and usage only, as before.

## Failure boundaries

Booking never fails a turn (same rule as the ledger). A missing task for a thread is a no-op. A budget patch below what is already spent is refused with 400.

## Testing

Unit (`task-board.test.ts`): columns round-trip and migrate on an old file; `bookSpend` warns once at 70% and pauses at 100% with the stated reason; a paused task is not promotable/dispatchable; raising the cap resumes it; a patch below spend is refused; `setResult`. Dispatch policy (`task-dispatch-bot.test.ts`): a task at its cap is not eligible. E2E (`task-budget.e2e.test.ts`, fake Claude reporting `total_cost_usd` 0.01 per turn): a board task with `budgetUsd: 0.015` runs one turn, is at 67% after it, runs a second turn and pauses with the reason and a comment; a PATCH to 0.05 resumes it; the result carries the digest line.

## Acceptance

All of the above green; `pnpm typecheck`, `pnpm lint`, `pnpm i18n:check`; T1–T10 and the recall set unchanged (the board is off by default); the PR body names #1185, #59, #1054, #60, #888 with the verdicts above.
