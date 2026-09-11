# Spend cap and sell prices

## Sub-features

- Refuse every new turn once the month's reported cost reaches the workspace
  cap: the message routes answer 409 with `code: "spend_cap"`, and a routine,
  peer hop or webhook stops in `startTurn` with the same refusal.
- Count a turn the moment it settles, not when the ledger's append lands or a
  cache expires.
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
It prints the fixture's server log path and removes its temporary homes.

For the same by hand, launch a fixture with `OMB_ENTERPRISE_DIR` pointing at a
folder whose `server/index.js` exports such a `register()`, and
`OMB_LICENSE_KEY` set to any value, then use the normal chat-turn commands.

## Unit regressions

```sh
pnpm exec vitest run server/spend.test.ts server/prices.ts server/config.test.ts src/components/UsageBudget.test.ts server/usage-ledger.test.ts
```

These cover price precedence and cached-input pricing, month-to-date sums
with the short cache and the just-booked note, inert behaviour without an
entitlement or a cap, the warning threshold, the 409 shape, the saver
persisting `anthropic`, `budgets` and `billing`, the cards rendering only
with their entitlements, and the billable column in summaries and CSV.

## Gotchas

- The cap counts what engines report: real cost on workspace keys, an
  equivalent on personal subscriptions. A workspace on subscriptions alone can
  hit a cap without a bill.
- The renderer's cards are proven from fixtures, not driven headlessly here.
