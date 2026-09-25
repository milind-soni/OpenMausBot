# Profile proposal and credential cards

Run the launcher-managed fake-engine fixture:

```sh
pnpm exec vitest run server/profile-card-lifecycle.e2e.test.ts
```

The test starts a disposable server, obtains a real turn capability from its
fake engine, and proposes notification and spoken-reply preferences. It checks
that confirmation saves both toggles, older profile cards expire with no
options, duplicate answers cannot revive them, and eight expired cards neither
block a settled wait nor consume the quota for new proposals. Two credential requests
produce distinct cards; the superseded card refuses provide, resume, and dismiss,
while the newest card remains actionable.

The fixture retains action/response evidence, `wait`, and `messages` output in
`<server-log>.profile-cards.json`, then stops its child and removes its temporary
data. It records no internal bearer token. This proves server behavior; rendering
is covered separately by the ApprovalCard and SecretRequestCard component tests.
