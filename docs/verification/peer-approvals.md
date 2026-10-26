# Peer approval outcomes

Run the focused regression tests and the isolated HTTP workflow:

```sh
pnpm exec vitest run server/peer-approval.test.ts server/runtime-coordinator.test.ts server/peer-approval.e2e.test.ts
```

The HTTP test uses `launchVerificationServer` and `control-omb` with disposable
data and the repository's fake Claude engine. It stops the initial server and
restarts that same fixture with a provider turn that stays open. Unit tests
advance fake timers by days to prove a card never expires.

The checks cover:

- User approval permits work; denial and cancellation block it. A card has no
  deadline: it stays pending until the person answers or the turn is cancelled.
- Deleted peers and interrupted threads cancel approvals without attributing
  a decision to the user; late answers cannot revive settled requests.
- Every hand-off asks first (`coordinate_bots`, from a routine turn or a
  chat): the refusal names
  each teammate's outcome (`approvals[]`: denied by the user, or cancelled)
  and its source, and writes no assignment on the job
  runtime — nothing can dispatch it later (docs/runtime-contract.md §2, §9).
- Ordinary chat's multi-target `coordinate_bots` preserves mixed allow/denial
  results and sends no work when any required approval fails.
- A peer hidden and renamed while its approval is open is never dispatched;
  the failure receipt does not disclose its newly private name.

The fixture writes safe response/receipt evidence to
`<server-log>.peer-approval.json` alongside the shared launcher's retained log.
It stops its owned server before removing temporary app data. Evidence excludes
the internal bearer token and provider environment.

This proves server behavior, not native UI rendering or real-model reasoning.
