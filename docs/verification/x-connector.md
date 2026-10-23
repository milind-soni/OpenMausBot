# X (Twitter) card

The X card in Apps shows whether bots can search and read X, and through what:
a MausBot Cloud plan's included calls (with this month's use from the relay's
`GET <OMB_CLOUD_X_URL>/usage`), or the person's own treg key, which is used
first. The card reads `GET /api/x/status`, which resolves the credential with
the same function as the X tools' own routes.

## Isolated browser verification

Use an installed Playwright module and Chromium executable, as for the
[Whop fixture](whop.md), then run:

```sh
OMB_UI_EVIDENCE_DIR=/tmp/omb-x-connector-evidence \
  node --experimental-strip-types scripts/verify-x-connector.ts
```

It starts two fake-engine servers, one without a plan and one wired to a
loopback stand-in for the relay, with the same stand-in as treg
(`OMB_TREG_URL`). It drives the real Apps pop-up and checks:

- With neither a key nor a plan, the card asks for a treg key and links to
  treg.to. The managed install's Composio Twitter tile, which cannot connect
  there, is gone.
- Saving a key tests it at once ("treg is working ✓ Balance: $4.25."), and
  **Remove key** takes the card back.
- On a plan, the card shows "Included with your plan" and the month's use.
- With both, the card says the own key is used first. Removing it falls back
  to the plan.
- A used-up month says when it resets and opens the key field.
- At 390 px wide the pop-up does not scroll sideways.

It saves a screenshot of each state. No real treg key, account or relay is
used.
