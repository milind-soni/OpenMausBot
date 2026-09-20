# Self-hosted browser Full access

Run the isolated server/API and store checks:

```sh
pnpm exec vitest run server/browser-approvals.test.ts server/browser-approvals.e2e.test.ts server/store.test.ts server/request-auth.test.ts src/state/store.test.ts src/components/ApprovalModeSelector.test.ts src/components/ChatView.controls.test.ts
pnpm typecheck
pnpm lint
pnpm i18n:check
pnpm build
```

The API fixture starts through `launchVerificationServer` with an explicit
host policy, temporary home/data, and repository fake providers. It covers
default denial, paired admin cookies, client/bearer/loopback/Origin rejection,
missing consent, Custom rejection, unknown threads, busy turns, provider
switches, sibling isolation, persisted grants, real provider dispatch and
session revocation. The store checks prove failed writes cannot activate a
grant and bot-default changes freeze inherited legacy thread modes.

For the real renderer, launch this foreground fixture:

```sh
node --experimental-strip-types scripts/verify-browser-approvals.ts
```

In a second terminal, pass its exact printed `previewUrl`:

```sh
pnpm exec electron scripts/testing/browser-approvals-ui-smoke.cjs http://127.0.0.1:PORT/__browser-approvals.html
```

The smoke runner verifies the fixture marker before any mutation, pairs a
temporary admin browser, and mounts the real Composer and Permissions section.
It checks Full visibility with Custom hidden, Cancel, confirmation, reload,
a real composer send through the fake provider, returning to Ask, and a
bot-default grant that leaves its existing thread in Ask. It writes
`evidence.json` and `permissions.png` to its printed temporary output directory.
Its Electron profile is disposable and has no user browser sessions.

Interrupt the foreground fixture with Ctrl-C to stop its owned server and
remove its temporary app data. API evidence stays beside the server log as
`*.browser-full-access.json`. Tests do not exercise real cloud model credentials
or operating-system permissions. See [approval levels](../approval-levels.md#full-access-in-a-self-hosted-browser)
for deployment policy and scope.
