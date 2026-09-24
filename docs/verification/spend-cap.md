# Spend cap and sell prices

## Sub-features

- Refuse every new turn once the month's cost (reported, plus estimates for
  engines that report tokens but no price) reaches the workspace cap: the
  message routes answer 409 with `code: "spend_cap"`, and a routine, peer hop
  or webhook stops in `startTurn` with the same refusal.
- Notify admins once a month when the month crosses the warning percentage and
  once when it reaches the cap (`notify` frames of kind `spend`, withheld from
  client sessions), remembered across restarts in `<data>/usage/alerts.json`.
- Count a turn the moment it settles, not when the ledger's append lands or a
  cache expires, however long the turn ran: a booked turn counts from memory
  until its row lands, and never twice once it has.
- Price turns from the operator's list (`driver/model`, then model, then
  `default`) into a billable column in `/api/usage` and its CSV.
- Do nothing at all without the `budgets` / `billing` entitlements.

## User path

Settings → Usage → **Monthly spend limit** and **Sell prices** (enterprise).
The History card shows a billable column once prices exist; the composer's
send is refused with the limit message once the cap is reached.

## Driving it

```sh
pnpm exec vitest run --no-file-parallelism server/spend-cap-api.test.ts
```

The test writes a stand-in enterprise layer (the folder shape core loads,
granting `budgets` and `billing`) and launches the `control-omb` fixture with
it through `launchVerificationServer(..., { dir, licenseKey })`. It sets a
$0.015 cap and a default price list, sends two turns that the fake engine
books at $0.01 each, and checks the third is refused with 409 `spend_cap`,
that `/api/usage` reports the cap exceeded, warned, and priced, that the CSV
carries `billable_usd`, and that raising the cap lets the next turn through.
It also holds an admin and a chat-only event stream open across the two turns
and checks the admin gets exactly one warning and one cap notice and the
chat-only device gets neither.
It prints the fixture's server log path and removes its temporary homes.

For the same by hand, launch a fixture with `OMB_ENTERPRISE_DIR` pointing at a
folder whose `server/index.js` exports such a `register()`, and
`OMB_LICENSE_KEY` set to any value, then use the normal chat-turn commands.

## Unit regressions

```sh
pnpm exec vitest run server/spend.test.ts server/model-prices.test.ts server/prices.ts server/config.test.ts src/components/UsageBudget.test.ts server/usage-ledger.test.ts src/lib/notify.test.ts
```

These cover price precedence and cached-input pricing, month-to-date sums
with the short cache and the just-booked note, inert behaviour without an
entitlement or a cap, the warning threshold, the 409 shape, the saver
persisting `anthropic`, `budgets` and `billing`, the cards rendering only
with their entitlements, the billable column in summaries and CSV, estimated
costs counting against the cap, the list-price table (every entry sourced and
dated, unknown models unpriced, the operator's per-model price winning), and
the once-a-month notices surviving a restart.

## Gotchas

- The cap counts what engines report (real cost on workspace keys, an
  equivalent on personal subscriptions) plus list-price estimates for engines
  that report none. A workspace on subscriptions alone can hit a cap without a
  bill, and a turn on a model the list does not know counts nothing.
- Rows written before estimates existed keep `costUsd: null` and stay
  unpriced; only turns settled after the upgrade are estimated, so the month
  of the upgrade can undercount Codex/OpenRouter spend.
- The renderer's cards are proven from fixtures, not driven headlessly here.
