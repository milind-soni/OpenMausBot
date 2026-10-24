# Usage ledger

## Sub-features

- Append one row per settled turn to `<data>/usage/YYYY-MM.jsonl`: bot, model,
  engine, tokens, the cost with where it came from (`costSource: "reported"`
  from the engine, or `"estimated"` from list prices when the engine reports
  tokens but no price), and who asked.
- Book each turn to the sender of the message that started it, captured when
  the message was accepted. A message that queues behind someone else's turn,
  or is steered into it, or someone pressing Steer, does not re-book that
  turn; the queued message's own turn is booked to its sender. A guarded relay
  (the Slack worker) may name the person it acts for with `onBehalfOf`.
- Name the asker: the email a person signed in with, else their device label;
  this computer for loopback; the routine; or "bot to bot" for a peer hop.
- Read a period back grouped by bot, model, person, day or engine, and export
  one CSV line per turn. Owners only; a chat-only device gets 403.
- Keep message text out of the ledger.
- Record each turn as a trace: its turn id, start and end, the turn that
  started it (a delegation, a resume, a room handoff), its outcome, and one
  span line per AI step and tool call in `<data>/usage/spans/YYYY-MM-DD.jsonl`
  (names, times, token counts and one clipped, redacted detail; no arguments,
  outputs, prompts or replies). Span lines older than 90 days are pruned; the
  per-turn totals on the usage row stay. Rows from before traces show as
  untimed runs.

## User path

Settings → Usage (in Simple mode, on Account) shows the period's totals, where
the money went by bot and by model (with a switch for person, day, provider and
routine), and every run. Opening a run shows its trace waterfall. In a chat, each
turn's work line reads "Worked for …" with **View trace** beside it. **Export
CSV** stays one line per turn.

## Driving it

```sh
pnpm exec vitest run --no-file-parallelism server/usage-ledger-api.test.ts server/usage-attribution.e2e.test.ts
```

The test launches a fresh `control-omb` fixture with the repository's fake
engine, creates a bot, sends one turn as the owner through the control surface
and one as a paired device with a label, waits for both to settle, then checks
the month file has exactly two rows with the right triggers and no message
text, that `GET /api/usage` groups them by person and by bot with the fake
engine's `0.01` per turn, that `GET /api/usage.csv` returns three lines, and
that a client-scoped device is refused. It prints the fixture's server log
path as evidence and removes its temporary home.

`server/usage-attribution.e2e.test.ts` boots the server against the fake Claude, ACP
and Codex engines in a disposable home and reads the month file back: an ACP
turn on `grok-4.7` is booked at xAI's list price and marked estimated while an
unlisted model stays unpriced; a paired person's queued message, a live steer
and a queue Steer leave the owner's running turn booked to the owner, while
the queued message's own turn (1:1 and in a room) is the person's; and a
guarded send with `onBehalfOf` is booked to that person, one without it to
this machine, and a chat-only device cannot reach the route at all. It also
sends two turns to a Claude bot whose fake CLI restores the session's running
cost on `--resume` (`FAKE_CLAUDE_COST_STATE`), the way the real CLI does: the
second turn's result says 0.02, and both rows must still read 0.01.

For the same by hand:

```sh
node --experimental-strip-types scripts/control-omb.ts launch
pnpm control:omb new-bot --name Probe --url http://127.0.0.1:PORT
pnpm control:omb send --bot BOT_ID --text "hello" --url http://127.0.0.1:PORT
pnpm control:omb wait --bot BOT_ID --timeout 30 --url http://127.0.0.1:PORT
cat DATA_DIR/usage/$(date -u +%Y-%m).jsonl
```

Then open the printed preview, go to Settings → Usage, and confirm the run is
listed with its bot, and that **Where it went** shows it under **Bot** and under
**Person** as "This computer".

## Traces

```sh
pnpm exec vitest run server/usage-trace server/usage-traces.e2e.test.ts src/lib/usage-trace.test.ts
```

The e2e sends a person's message to a Chief whose scripted engine delegates to a
teammate that calls two agents tools, then reads `GET /api/usage/traces` and
`GET /api/usage/traces/:id`: one root, the teammate's turn and the Chief's resumed
turn nested under the first, each tool timed by the server, and totals that add
up. The unit tests cover nesting, timing, a tool still open at the end of its
turn, OMB receipts against engine events, Codex's thread totals, old untimed
rows, groups, a parent loop, 2,000 tool calls in one turn and a 500-span trace
read from disk.

To look at the page:

```sh
node --experimental-strip-types scripts/verify-usage-traces.ts
```

It launches a scripted fixture, runs three delegated jobs (one left running for
the Live badge), stretches one into a realistic job with browser and computer
steps, adds two rows from before traces, mounts the Usage page alone and prints
its preview URL.

## Unit regressions

The chat header's input/output breakdown has a separate real-renderer fixture:

```sh
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/usage-details-ui.e2e.test.ts
```

It launches a disposable app, sends one scripted-engine turn through the composer,
waits for settlement, and checks that the tooltip separates 10 uncached input,
2 cached input, and 5 output tokens. The synthetic $0.01 cost remains the compact
headline. Its JSON evidence sits next to the fixture log; no live account is used.

```sh
pnpm exec vitest run server/usage-ledger.test.ts src/lib/usage-trace.test.ts server/request-auth.test.ts
```

These cover month files and 0600 modes, torn lines, clamped tokens, a blocked
directory never failing the turn, range parsing, every grouping, spreadsheet
formula neutralisation in the CSV, the localized person labels, and the admin
scope on both routes.

## Gotchas

- Rows are appended when `turn.completed` folds. A turn that fails before it
  settles can leave no row. That absence does not establish zero usage or a
  free turn. Failed and cancelled completions retain any provider measurements
  the harness observed.
- The cost column is what the engine reported (real on a metered key, an
  equivalent on a subscription) or, for engines that report none, an estimate
  from `server/model-prices.ts`, marked `~` in History and People and labelled
  in the CSV's `cost_source` column. A model with no known price stays
  unpriced; the summary counts those turns separately instead of treating them
  as free.
- Claude's `total_cost_usd` is a running total, not a turn's figure: it grows
  across the turns of one CLI process and, on `--resume`, starts from a cost
  the CLI restored. The driver books each turn's growth. For a resumed
  process it finds the restored state among the session's recent results in
  `<data>/claude-cost-history.json`; without one, that first turn keeps its
  whole figure.
- A member's chat-only device cannot open traces: the routes are owner-only,
  like the rest of Usage, and a trace leaves out turns in threads its viewer
  cannot see.
- The renderer's History card is not driven headlessly here; the fixture
  proves the server side and the table renders from a fixture in its unit test.

## Native job accounting

Attributed rows carry harness-bound root, assignment, execution-attempt and
provider-turn identities. The existing monthly ledger remains authoritative;
the job view joins it to native assignments and Office attempts. Repeated
completion callbacks do not append or charge the same identity twice, including
after a server restart. Parent, child, resumed and reworked executions are
separate attempts of the same native root.

`GET /api/threads/THREAD_ID/job/usage?rootId=ROOT_ID` returns only assignments
accepted by the thread's existing visibility gate. An arbitrary root outside
that authorized native view is refused. The global usage and CSV routes retain
their existing admin scope.

The existing `assignment_status` tool receives this same accounting after its
native conversation-ownership and peer-access checks. It needs no additional
tool grant. Withheld descendants make coverage partial. Final usage from a
captured retired provider turn can be recorded without letting that stale
completion settle a replacement job.

The native Codex driver announces its turn while waiting for launch admission,
before OfficeControl consumes the directive. That event captures a pending
native identity. Completion must reread and verify the exact attempt's durable
consumption before attributing usage. A prelaunch cancellation is not a consumed
execution, even though a provider turn ID was announced.

ACP drivers attach validated per-prompt usage from the `session/prompt` result
to `turn.completed`, including cache normalization. Root `usage` and legacy
`_meta` result fields both feed that final observation. Session context
`usage_update` notifications do not: missing or incomplete prompt metrics stay
unknown. Failed and cancelled prompt results retain their reported final totals.

The response keeps reported USD, estimated USD and unknown-price turn counts
separate. Token totals sum input plus output; cached input is a subset of input
and is never added again. An omitted token measurement has an explicit unknown
counter, even when the legacy numerical column stores zero. A consumed attempt
without a final ledger observation is missing coverage; an active execution is
pending. Neither is reported as a free or fully accounted execution. A
descendant-only view cannot claim coverage of the entire root.

Run these checks on the execution worker:

```sh
pnpm exec vitest run --no-file-parallelism server/job-usage.test.ts server/job-usage-codex.test.ts server/job-usage-api.test.ts server/routes/job-usage.test.ts server/usage-ledger.test.ts server/spend.test.ts
```

These tests exercise aggregation, duplicate observations, failed/cancelled
receipts, cached input, explicit zero versus omitted measurements, unknown
costs, restart gaps, native rework, authorization handoff, and deduplication
rebuilt from the ledger across a month boundary. A restarted module is a unit
test of durable ledger idempotency; a real service restart and in-chat return
still require the isolated recovery fixture and live acceptance receipt.

`server/job-usage-api.test.ts` drives actual fake-provider turns through the
native HTTP server. It verifies two independent roots and a delegated job with
three observations: Chief dispatch, engineer result and Chief final summary.
The completed tree is then read after two real server-process restarts; its
accounting and fake-provider invocation evidence must remain identical. This
does not qualify abrupt interruption of live work or host-power-loss durability.

`server/job-usage-codex.test.ts` composes the real Codex driver, Office execution
wrapper, OfficeControl and native runtime store with the repository's fake
app-server. It proves the pre-consumption announcement is captured, one final
measurement is attributed after consumption, and cancellation before native
process admission creates no usage observation.
