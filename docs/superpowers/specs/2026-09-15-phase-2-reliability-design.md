# Phase 2, part 2: reliability — tools that fail honestly, engines that fall back

Status: design taken on the recommendation (Omkar, Sep 15, 2026; decision 12 in force). Builds on #1184's quota card (brought onto the chain: `server/quota-switch.ts`, the card that offers other engines after a quota error and re-dispatches the exact message that failed) and on Phase 0's digests and Phase 1's fresh-session replay. Plan pointer: `docs/plans/2026-09-15-phase-2.md`, part 2.

## Goal

A harness tool that hangs, dies or floods no longer costs the model its turn or its context, and a bot whose engine fails on a provider error continues on the engine the person named, with the reason on the task, instead of the thread dying at 2 a.m. Measured by the proxy suite (bounded calls, a capped result read back in slices) and an end-to-end run where the fake engine fails with a quota error and the turn completes on the alternate.

## What earlier PRs taught (`AGENTS.md` rule 2)

- **#1184 (open, this account):** the quota card is exactly decision 12's "approval before degrading": a person chooses the engine. Its two card commits are imported; its replay-tool-history commits are not (Phase 0's digests carry that, finding in part 1). Part 2 adds the silent rung under the card.
- **#422 (open, external, "bound tool output, detect anti-bot challenges"):** an output bound on the browser tool; part 2's cap is on the harness's own tools and keeps the whole result readable, which #422 did not. Stated in the PR.
- **#59 (open, external):** wall-clock and retry budgets per task; part 2's bounds are per call and live in the proxy, so they compose.

## Decision

**Tools (the agents proxy, every engine).**
1. Every harness call a tool makes is bounded: 60 seconds total (`AbortSignal.timeout`), and a read that fails on the network (never a write) is tried once more after 750 ms. `session_search` and `task_list` are the only POSTs treated as reads.
2. Errors teach: a timeout says which tool, how long, whether it was retried, and the next move ("continue with what you have, and tell the person"); an unreachable harness says it is the app, not the model's input.
3. Output cap with spill: a result over 24,000 characters is cut to its first 16,000; the whole text (redacted, bounded at the hook spill cap) is kept by the harness under the thread's `tool-results` folder at 0600 and the note names its id. `tool_result_read(id, offset)` returns 16,000-character slices. Ids are per conversation; another thread's id reads as missing.

**Engines (decision 12).**
4. A bot may name an alternate: `fallback.alternate` (a model selection) through `PATCH /api/bots/:id`, validated like `modelSelection`. On a terminal provider failure of a direct turn (quota, auth, overloaded, rate-limited past the driver's own retries, server error, unknown model, timeout) the harness switches the task to the alternate, records `task.fallback = { from, to, reason, at }`, posts a chip "continuing on <engine> after <reason>", and re-dispatches the exact user message that failed; the fresh-session replay (Phase 1) carries the history. Silent, same as decision 12's first rung.
5. Two things stop the silent rung and leave the person to decide: the failed turn had a side effect (any tool call recorded on that turn's activity rows), or there is no alternate. Then, for a quota error, the card from #1184 is raised as before; for every other terminal failure the thread shows the error chip and is parked, as today.
6. Never twice in a row: a task that already fell back once keeps its record and gets the card, not a second silent switch. The reason on the task is what `list_tasks` and the board show, so a fallback never reads as a success.

## Non-goals

Live swap mid-turn for the HTTP family (the retry layer inside the driver covers transient failures; a terminal one takes the same path as the CLIs). Degrading without a person (decision 12 says approval first). Cross-bot fallbacks.

## Engines

| Item | Claude Code | Codex | pi | ACP family | HTTP family | Box agent |
| --- | --- | --- | --- | --- | --- | --- |
| tool bounds, teaching errors, output cap, `tool_result_read` | full (every engine calls the same proxy) |
| fallback to the named alternate | full: the failed turn's message is re-dispatched on the alternate with the fresh-session replay; the alternate can be any engine the workspace has |

## Failure boundaries

A spill that fails leaves the head with a plain note. A fallback whose re-dispatch fails posts the error chip, as the quota card's own dispatch does. `task.fallback` is patchable and persisted with the task like `contextReset`.

## Testing

Proxy suite: the cap, the spill, the slices, the missing id, the teaching errors. Store: `fallback` on the task round-trips. E2E (`fallback.e2e.test.ts`, fake Claude in a mode that fails with a quota error, fake ACP as the alternate): a bot with `fallback.alternate` set gets its reply from the alternate, the task carries the record, the chip is there, and the ledger's row names the alternate's driver; the same bot with a side-effecting failed turn gets the card instead; a bot without an alternate gets the card.

## Acceptance

All of the above green; `pnpm typecheck`, `pnpm lint`, `pnpm i18n:check`; T1–T10 and the recall set unchanged (no fallback is set on the scorecard bots; the tool bounds do not fire on a healthy harness).
