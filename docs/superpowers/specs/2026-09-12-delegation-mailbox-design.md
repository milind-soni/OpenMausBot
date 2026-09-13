# Delegation Mailbox: 24-hour handoffs and truthful peer status

**Date:** 2026-09-12
**Branch:** `feat/delegation-mailbox` (off `origin/main` at `7d6844f7`)
**Status:** approved in chat, awaiting written-spec review
**Origin:** learnings from October Bus (github.com/october-dev/october-bus), design ideas only — no code used. See `competitor-profiles/october.md` in the workspace root.

## Goal

Two changes to bot-to-bot handoffs:

1. **A handoff waits for its target, then expires.** Replace the "give up after three busy periods" rule with a 24-hour time limit. A handoff is delivered whenever the target is next free, however many turns the target takes in between.
2. **Teammates can tell "working" from "waiting on the user."** The peer roster, `list_bots`, handoff chips, and `check_delegation` report what a bot is actually doing, using the `activity` state the harness already tracks.

## Background — how it works on `main` today

- `server/delegations.ts` keeps a durable, restart-safe queue (`delegations.json`), capped at `MAX_QUEUED_PER_THREAD = 4` per source thread.
- `holdWhileTargetBusy()` decides whether a queued item waits. It has two branches:
  - **Classic handoff** (no `targetThreadId`): waits while `target.busy`. Each distinct busy period of the target counts one attempt (`attempts`, `waitingOnBusy`). At `MAX_BUSY_ATTEMPTS = 3` it records a `busy_gave_up` receipt and a "canceled — still busy" chip.
  - **Fresh-thread handoff** (`targetThreadId`, from #1021): waits for a free thread slot with **no bound**. It reuses `attempts` only as a "wait chip already shown" marker.
- A `settled` outcome with a receipt calls `drainDelegations`' `onSettled` callback, which `index.ts` wires to `wakeUndispatchedDelegation` — so the delegating bot is woken with a failure prompt. `busy_gave_up` already goes through this path.
- `BotRecord.activity` (`server/store.ts`) is one of `working | waiting-on-you | idle | no-signal | dead`. `busy` is derived from it via `ACTIVITY_BUSY = {working, waiting-on-you, no-signal}`.
- Peers only ever see `busy`:
  - roster line (`peer-roster.ts renderRoster`): `working right now` / `available`
  - `GET /api/internal/agents` (`list_bots`): `busy: boolean`
  - proxy formatting (`drivers/agents-proxy.ts`): appends `, busy`
  - busy chip: `waiting — they're busy (retry n/3 when they finish)`
- So a target parked on an approval card is indistinguishable from one mid-task, and its waiting time burns the delegator's retries.

## Decisions (from the brainstorm)

| Question | Decision |
|---|---|
| What replaces the three-retry limit? | A 24-hour time limit from when the handoff was queued. |
| What happens when the target is waiting on the user? | Report it truthfully. No additional notification — the target's own approval card already notified the user. |
| Does the 24-hour limit apply to fresh-thread handoffs too? | **Yes** — one rule for every queued handoff. This bounds a wait #1021 left unbounded. A slot normally frees within minutes, so the limit only matters when something is wrong, and without it a stuck item holds one of the source thread's 4 queue slots forever. |

## Design

### Part 1 — 24-hour handoffs

**Data (`PendingDelegationItem`)**

- Add `queuedAt: number` (epoch ms), set in `queueDelegation`.
- Remove `attempts`. Its two uses are replaced:
  - classic branch: no longer counts anything
  - fresh-thread branch: "chip already shown" becomes `waitAnnounced?: boolean`
- Keep `waitingOnBusy`. It still marks "this item is parked on the target's current busy period", which `threadsWaitingOn` / `releaseDelegationsWaitingOn` use to re-drain when the target frees up.
- New export `DELEGATION_TTL_MS = 24 * 60 * 60 * 1000`.
- `MAX_BUSY_ATTEMPTS` is deleted.

**Loading old queues (`_loadPending`)**

- An item without a finite `queuedAt` gets `queuedAt = load time`, so an upgrade never expires work on the spot.
- A stored `attempts` is ignored.
- A stored `waitingOnBusy` still loads.

**Outcome type**

- `DelegationOutcome` gains `"expired"`.
- `"busy_gave_up"` stays in the union only so receipts already on disk still type-check; nothing new produces it. The receipt loader already accepts any string status.

**Waiting (`holdWhileTargetBusy`)**

- **Classic branch.** While the target is busy, return `"requeued"`. The first time an item observes a busy period, set `waitingOnBusy` and post one waiting chip for the handoff — never one per busy period. The chip wording depends on the target's activity (Part 2).
- **Fresh-thread branch.** Unchanged except for the marker rename.
- Neither branch can give up. Expiry is the only time bound.

**Expiry**

- `isExpired(item, now) = now - item.queuedAt >= DELEGATION_TTL_MS`. Expiry applies only if the target cannot take the turn right now. At restart, `_loadPending` renews already elapsed windows before dispatching any backlog: relying on all bots initially being idle loses the second queued job as soon as the first occupies its target. Unexpired windows keep their deadline, and renewed timestamps are persisted immediately. This is wall-clock accounting, not an uptime clock; sleep within a running process still counts. See the mailbox regression in `docs/verification/chat-turns.md`.
- `targetCanTakeTurn(bus, target, item)` is the single free/busy test — the same one `holdWhileTargetBusy` uses to decide whether to hold — factored out so the expiry decision and the hold decision can never disagree. A deleted target counts as "cannot take the turn": there is nothing to become free, so such an item still expires.
- `expireDelegation(bus, sourceThreadId, item)` records the receipt, posts the chip, and returns `"settled"`.
  - Receipt: status `"expired"`, result `@<name> was not free to take this for 24 hours`.
  - Chip: `Delegation to @<name> expired — not picked up within 24 hours`, `ok: false`.
- Checked in three places:
  1. **In `processOne`, after `dropIfUnreachable` and `dropIfThreadGone`, gated on `!targetCanTakeTurn(...)`.** It runs after those reachability checks (so a dropped/reassigned peer reports as dropped, not expired) but before `holdWhileTargetBusy` decides whether to hold or announce a wait — an item is never both expired and wait-announced in the same pass. The same rule, in the same order, is applied again on the post-approval path (`heldAfterApproval`), since approval can itself take up to 24 hours via `approvalAlreadyGranted`. The existing `onSettled → wakeUndispatchedDelegation` path wakes the delegating bot with a failure prompt either way.
  2. **`expireStaleDelegations(bus, now, onSettled)`** — a new export that walks every queue, expires only items that are both due AND currently unable to be delivered (same `targetCanTakeTurn` test; a deleted target counts as unable), acknowledges them, persists once, and calls `onSettled(receipt)` for each. It skips any thread currently in `drainingThreads`; that drain will expire the item itself. An over-age item whose target is free is left queued — the next drain or `retryDelegationsWaitingOn` delivers it.
  3. **Callers of the sweep in `index.ts`:**
     - once at boot, just before the existing leftover drain over `pendingThreads()`
     - from one hourly `setInterval(...).unref()`

     Both pass `wakeUndispatchedDelegation`, with the same routine-run lookup `drainThreadDelegations` uses.

**Other surfaces**

- `pendingDelegationInfo` returns `{ sourceThreadId, toBotId, queuedAt }` in place of `attempts`.
- The `ask_bot` busy-fallback comment ("bounded busy retries") is updated to "waits up to 24 hours".
- The `drainDelegations` redrain comment that mentions burning bounded retries is updated to match.
- Behaviour is unchanged.

### Part 2 — truthful peer status

**One mapping** — new export `peerStatus(activity)` in `server/peer-roster.ts`:

| `activity` | `peerStatus` | Roster / `list_bots` wording |
|---|---|---|
| `idle` or absent | `available` | available |
| `working` | `working` | working right now |
| `waiting-on-you` | `waiting-on-user` | waiting on the user |
| `no-signal` | `not-responding` | not responding |
| `dead` | `unavailable` | unavailable (needs setup) |

**Where it shows up**

- `RosterMember` gains `activity?: BotActivity`. `renderRoster` prints the wording above instead of the `busy` ternary.
- `GET /api/internal/agents` adds `status: peerStatus(b.activity)` and keeps `busy` unchanged for compatibility.
- `agents-proxy.ts` `list_bots` formatting prints `, <wording>` for any status other than `available`.
- The `list_bots` tool description changes "whether they're busy" to "what they're doing right now (available, working, waiting on the user, not responding, unavailable)".
- **Waiting chip** in `holdWhileTargetBusy`, classic branch:
  - target `waiting-on-you`: `Waiting for @<name>, who's waiting on you — it'll go through after you answer`
  - otherwise: `Delegation to @<name> waiting — they're busy; it'll go through when they're free`
- **`check_delegation` for a queued item** adds:
  - `targetStatus: peerStatus(target.activity)`
  - `expiresInMs: max(0, queuedAt + DELEGATION_TTL_MS - now)`
- No new notification anywhere.

**Out of scope**

- Dispatching to a `dead` target is unchanged: it dispatches and fails as today. The only change is that the delegator can now see the target is unavailable beforehand.

## Error handling and invariants

- A handoff is never delivered without re-running the existing checks. Expiry only adds a terminal state and never skips `dropIfUnreachable`, `dropIfThreadGone`, or the approval gate.
- The sweep never races a drain: it skips threads in `drainingThreads`, and `acknowledgeDelegation` is idempotent.
- The sweep persists the queue once per run, not once per item.
- No new persisted file. `delegations.json` gains one numeric field per item.
- Receipts remain bounded by `MAX_RECEIPTS` / `RECEIPT_MAX_AGE_MS`.

## Testing

Tests are written first, in Vitest. The fake clock uses `vi.useFakeTimers()` / `vi.setSystemTime()`.

**`server/delegations.test.ts`**, "busy retries and receipts" → renamed "busy waits and expiry":
- *keeps a handoff queued while the target is busy and dispatches on the retry drain* — unchanged intent.
- *gives up after the bounded retries* → replaced by:
  - **survives five busy periods** — still queued with no receipt, dispatched after the fifth settle.
  - **expires after 24 hours** — the drain after `DELEGATION_TTL_MS` records an `expired` receipt and chip, and `onSettled` fires.
- *does not burn busy retries when an unrelated drain is requested* → **posts one waiting chip per handoff, not one per busy period**.
- **waiting chip names a target that is waiting on you.**
- **fresh-thread handoff also expires after 24 hours.**

**`server/delegations.test.ts`**, "delegations survive a restart":
- **an item saved without `queuedAt` loads with a fresh 24-hour window.**
- **`expireStaleDelegations` expires due items across threads, skips a draining thread, and calls `onSettled` once per item.**

**`server/peer-roster.test.ts`**
- `peerStatus` covers all five activities plus absent.
- The roster line for a `waiting-on-you` bot reads "waiting on the user".

**Agents proxy test**
- `list_bots` output line for each non-available status.

**Test floor**
- `TEST_COUNT_FLOOR` is unaffected.

**Manual check** (side-by-side OMB2 build, per the test-locally skill):
1. Bot A delegates to Bot B while B is mid-task → one waiting chip; delivered when B finishes.
2. B has an approval card open → A's chip says B is waiting on you, and A's `list_bots` shows "waiting on the user".
3. Chat with B three or more times before it picks up the handoff → still delivered.

## Files

- `server/delegations.ts`, `server/delegations.test.ts`
- `server/peer-roster.ts`, `server/peer-roster.test.ts`
- `server/drivers/agents-proxy.ts` and its test
- `server/index.ts`:
  - `/api/internal/agents`
  - the `check_delegation` queued branch
  - boot sweep and hourly timer
  - `ask_bot` fallback comment

## Platforms

- Server-only. iOS and Android render these as ordinary activity chips and never read `busy_gave_up`, so the change needs no app update and no mobile release.
