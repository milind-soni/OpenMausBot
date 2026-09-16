# SIGTERM audit — codex child termination paths

Scope: every path that can terminate or kill a codex app-server child on
`feat/steer-vs-queue`, against SPEC criterion (c) of
[steer-vs-queue.md](./steer-vs-queue.md): the raw
`codex exited null (signal SIGTERM) before turn/completed` runtime error must
be unreachable from steer, queue, and explicit Stop.

## Kill sites

Every process kill goes through `killCliTree`. There are exactly three import
sites that can touch a codex child:

| # | Site | Trigger | Mid-turn? | Class | Evidence | Residual risk |
|---|------|---------|-----------|-------|----------|---------------|
| 1 | Catalog probe reap | model catalog query finishes | No — separate probe process, never the turn child | Kill (reap of an answered probe) | server/drivers/codex-catalog.ts:87 | none for (c) |
| 2 | Auth/sign-out probe reap | identity probe answers or times out (1s) | No — separate probe process | Kill (reap) | server/drivers/codex-identity.ts:44,52 | none for (c) |
| 3 | Turn-child funnel `terminate()` | the only kill path for a turn's app-server | Yes (Stop semantics) | Kill, but see callers below | server/drivers/codex.ts:783 | see per-caller rows |

### Callers of the turn-child funnel (`terminate`, codex.ts:783)

| Caller | Trigger | Mid-turn? | Graceful or kill | Evidence | Residual risk |
|--------|---------|-----------|------------------|----------|---------------|
| `stop()` escalation | any interruptTurn: Stop button, group/room cancel, stall watchdog, room deadline, routine cancel, speaker cancel, shutdown | Yes | Graceful first: `turn/interrupt` with a grace window (750ms default; `FAKE_CODEX_INTERRUPT_GRACE_MS` in tests), then kill | codex.ts:795-816 (escalation at :813) | a wedged server still dies by SIGTERM after the grace window — but the close handler settles it quietly as `interrupted` |
| `settle()` → `stop()` post-turn teardown | normal turn completion | No — after `turn.completed` | Kill (the per-turn app-server never exits on its own) | codex.ts:818-833 | if the kill fails, a different honest error fires ("did not shut down"), never the SIGTERM one |
| Retry relaunch, pre-ack exit | child exited transiently before the turn was acknowledged | Yes, but nothing streamed yet (`codexTurnId === null`) | Kill of the dead/wedged attempt; `abandoned = true` is set first | codex.ts:1290-1296 | quiet by design: the close handler returns immediately for abandoned attempts |
| Retry relaunch, handshake failure | transient 5xx/overload on initialize/kickoff, nothing streamed | Same guard (`sawStreamDelta === false`) | Kill of the failed attempt, abandoned first | codex.ts:1469-1487 | same quiet-settle reasoning |

## Every `interruptTurn` caller (all funnel into `stop()`, graceful-first)

server/index.ts: explicit Stop endpoint :1023; stall watchdog :3359; direct-turn
dispatch abort :6134; group stop :6404 and :6439; routine cancel facade :6525
(routines.ts:1111,1306,1361); room turn deadline :7804; stop that raced adapter
auth :7869; speaker cancellation batch :9812; group cancel batches :13402,
:14032, :14129, :14986. Also engine swap/instance removal: persistProviderInstance →
`registry.dispose` :9838; provider reload and server shutdown →
`registry.disposeAll` :9863 and :17028. All reach codex `dispose`
(codex.ts:1594-1598 → `stop()` for each active turn) or the adapter's
`interruptTurn` (codex.ts:1571-1573 → `stop()`).

Thread deletion (`deleteBotWithLifecycle`, index.ts:6647) refuses while a
routine, group turn, Local VM turn, or Box-configured busy turn is active
(409 "stop this bot's work…"); a plain busy turn is torn down through the same
graceful-first stop when its instance is disposed. No deletion path calls
`killCliTree` directly.

## Close handler attribution (codex.ts:1239-1256)

1. `abandoned` → return silently (:1240) — retired retry attempts cannot report.
2. `state.settled` → `void stop()` and return (:1241-1244) — post-turn
   teardown; no error emission.
3. `stopRequested` → `settle(false, "interrupted")` (:1250-1252) — an
   intentional Stop's kill settles quietly; the SIGTERM runtime error is
   unreachable from Stop. The race is closed because `stop()` sets
   `stopRequested = true` synchronously at entry (:796) before its first await,
   so a close event can never arrive between the flag and the interrupt.
4. Otherwise → honest crash attribution (:1254 onward), including the signal
   text for externally killed children. Reachable only from outside
   steer/queue/Stop (OOM, user `kill -9`), which is correct.

## Steer and queue paths contain no kill calls (static proof)

- `steerActiveTurn` (codex.ts:840-858) issues one `turn/steer` request and
  returns false on any guard or refusal — no `terminate`/`killCliTree` call.
- The queue/steer endpoint (index.ts:14707-14751) calls `adapter.steer()` only;
  a refusal restores the queue (`restoreHeldSteeredQueue`) and may drain it as
  a new turn. No interrupt or kill.
- The queue drain (index.ts:5055-5075) subscribes to `turn.completed` and calls
  `startTurn`; it never touches the previous child.
- `rg -n "kill|interrupt|stop\(" server/steer-queue.ts` matches nothing
  (only comments/warns).
- The room queue/steer endpoint (index.ts:13355-13437) rides the same
  contract: it lifts the channel queue atomically (holdChannelQueue),
  calls adapter.steer() on the engine that owns the running room turn,
  and restores or settles the held queue (restoreHeldChannelQueue /
  settleHeldChannelQueueHead) without any interrupt or kill call. A room
  whose running engine cannot steer keeps its queue, exactly like an
  incapable 1:1 engine.

## Criterion (c) test proof

- Steer never kills: codex.test.ts:1411 (child liveness + no runtime.error) and
  :1438 (refusal keeps the child alive).
- Queue never kills: codex.test.ts:1454 (refused steer → queue → drained turn;
  spy on `killCliTree` sees neither the turn child nor its drain successor,
  both children verified alive mid-turn).
- Stop is graceful: codex.test.ts:1491 (`turn/interrupt` observed, no signal
  error).
- Escalation settles quietly: codex.test.ts:1507 (wedged server killed after
  the grace window, `stopReason: "interrupted"`, no runtime.error).
- End-to-end: steer-e2e.test.ts:294/:335/:368 (live steer, Stop without the
  SIGTERM error, queue preserved on incapable engines).

