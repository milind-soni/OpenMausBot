# Usage status refresh

Run the isolated real-server check:

```sh
pnpm exec vitest run server/usage-status-refresh.e2e.test.ts
```

The fixture uses `launchVerificationServer`, stops its initial child, and restarts
on the same disposable home with `OMB_TEST_PLAN_USAGE_FILE`. Only fake engines
and synthetic provider rows are used. No user credentials or live app data are
read or changed.

The test seeds four local Codex holds, reads full usage, then changes the fixture
file before the five-minute cache expires. It proves:

- An ordinary read still returns the cached report.
- `GET /api/limit-resets?refresh=1` reads the changed provider report immediately.
- Healthy usage with a moved reset releases the eligible named account and
  removes only that account from the persisted holds.
- A sibling whose reset still matches its refusal stays held.
- A guessed hold stays held despite healthy usage with a moved reset.
- A failed provider row reports its error and retains its previous windows and hold.

The fixture removes its disposable home and prints the persistent server log and
JSON evidence paths. A second isolated workflow sends a turn through a backup
while Codex is held, refreshes recovered usage, then proves the next normal turn
returns to the fake Codex engine. Nothing is replayed or resumed by the refresh
itself. This does not prove a real provider's allowance or authentication.

Focused regressions also cover Settings reconciliation, inverted response
completion, unsupported accounts, permission refusal, and model-held failover
waits:

```sh
pnpm exec vitest run server/limit-resets.test.ts server/limit-failover.test.ts server/limit-reset-requests.test.ts server/routes/usage-status.test.ts src/lib/admin-scope.test.ts src/components/limit-resets.test.ts src/components/ModelPicker.usage.test.ts
```

## Offline renderer smoke

```sh
node --experimental-strip-types scripts/verify-usage-status.ts
```

This mounts the actual `UsageMenuRows` renderer through `mountPreview` and drives
an isolated browser with `ensureUiBrowser`. Its synthetic API rejects unrelated
requests and mutations. It checks the healthy and blocked refresh button,
`refresh=1`, disabled/bounded clicks during a delayed response, provider sign-in
and network failures retaining the displayed limit, and a successful retry
clearing the error. Successful responses identify `checkedEngines` explicitly.

At a 390 × 844 viewport it asserts no horizontal overflow and saves screenshots
under `.omb-scratch/usage-status/refresh-error-mobile.png` and
`.omb-scratch/usage-status/refreshed-mobile.png`, with request evidence in
`result.json`. Network disconnects can cause transport retries; the bounded-click
assertion is made separately against a delayed successful response.

This smoke does not exercise the hover popover or Settings screen, provider
credentials, real provider requests, or server-side reconciliation. The isolated
server integration check above covers the latter.
