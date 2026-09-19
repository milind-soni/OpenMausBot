# Peer approval outcomes

Run the focused regression tests and the isolated HTTP workflow:

```sh
pnpm exec vitest run server/peer-approval.test.ts server/delegations.test.ts server/peer-approval.e2e.test.ts
```

The HTTP test uses `launchVerificationServer` and `control-omb` with disposable
data and the repository's fake Claude engine. It stops the initial server and
restarts that same fixture with a test-only import hook. The hook releases the
real peer-approval timeout callback after the test observes its card; it changes
no authorization or dispatch decisions. Unit tests independently advance the
production fifteen-minute deadline with fake timers.

The checks cover:

- User approval permits work; denial, expiry, and cancellation block it.
- Deleted peers and interrupted threads cancel approvals without attributing
  a decision to the user; late answers cannot revive settled requests.
- Routine `ask_bot` distinguishes an explicit denial from an unanswered card.
- A routine delegation expires without dispatching its target. Its durable
  receipt and HTTP readback preserve the approval outcome and decision source.
- Ordinary chat's multi-target `coordinate_bots` preserves mixed denial/expiry
  results and sends no work when any required approval fails.
- Receipt metadata survives reload, while old receipts remain readable.

The fixture writes safe response/receipt evidence to
`<server-log>.peer-approval.json` alongside the shared launcher's retained log.
It stops its owned server before removing temporary app data. Evidence excludes
the internal bearer token and provider environment.

This proves server behavior, not native UI rendering or real-model reasoning.
