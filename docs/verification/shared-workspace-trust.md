# Shared-workspace trust: loopback, card answerers, decision log

A hosted or shared workspace runs every bot's shell on the server as the
same user, so "a request from 127.0.0.1" no longer means "the owner". These
checks pin what changes there and what does not. The operator-facing
description is in [self-hosting](../self-hosting.md#loopback-trust-owner-or-service).

## Sub-features

- **Loopback trust.** At start-up the server logs `local requests: owner
  trust (…)` or `local requests: service trust (…)`. A hosted workspace (any
  `OMB_ADMIN_*` setting; shared-workspace Full access only works there)
  defaults to `service`; a self-hosted server keeps `owner`;
  `OMB_LOOPBACK_TRUST=owner|service` overrides (anything else means
  `service`); the desktop app always keeps `owner` behind its per-launch
  capability. Under `service` a session-less loopback request may use only
  `SERVICE_ALLOW` (`server/request-auth.ts`): health, who-am-I, edition,
  brand, the bot list, thread messages, attachments, new threads, the guarded
  send, the exact request fence and its stop, withdrawing a queued line,
  `POST /api/threads/:id/respond` (decline only), and the bots' capability
  routes under `/api/internal/*`. Everything else answers 403. That is
  exactly the set the cloud Slack worker calls (checked against the cloud
  repository's worker source, every released version), so the deployed
  worker needs no change.
- **The CLI under service trust.** `openmausbot serve` hands the server it
  starts a per-launch secret over the server's stdin; that secret opens
  `/api/auth/pairing` for that CLI alone, so `serve` still prints the first
  pairing code, and if a code is refused anyway it says why and keeps the
  server running. Later `openmausbot pair` and `openmausbot sessions` are
  refused with an explanation. A browser on an SSH tunnel gets the sign-in
  page, not an app whose every admin call fails.
- **Who may answer a card.** With portal membership or an email sign-in list
  that names members, a card that can be traced to a person — who sent its
  request (`sender.id`), who the thread was opened for, and for a thread a
  bot opened while working on someone's request, that person — may be
  answered only by them, an admin or the owner. A card that names nobody
  (owner-sent, routine, webhook, Slack, pre-upgrade) may be answered by any
  member, as before. A `service` caller may only decline. This applies to
  both respond routes and to "always allow". It adds no card, prompt or
  gate: the provider CLI's own approval is the card. Who a thread was opened
  for lives in `<data>/thread-starters.json` (server-private, never on the
  wire).
- **Who answered.** Each card a person or service settles records
  `card.answeredBy` (`{kind:"session", name}`, `{kind:"loopback"}` or
  `{kind:"worker"}`), and its `user-approved` / `user-denied` decision row
  records `actor` (session id, device label, email, and account id when it is
  not a portal grant).
- **Decision log retention.** Rows go to `<data>/decisions/YYYY-MM.ndjson`. A
  month file is deleted once all of it is older than the window (180 days by
  default; `decisions.retentionDays` or `OMB_DECISION_RETENTION_DAYS`). An
  older server's `decisions.ndjson` and `.1` are still read and age out by
  their last write. `GET /api/decisions?limit=` is unchanged; `GET
  /api/decisions.csv?from=&to=` (admin) exports a date range with formula
  cells neutralised and secrets redacted.
- **Settings on a portal-membership workspace.** `GET /api/config` reports
  `membership {authority, pairingCodes, peopleUrl}`. Settings → People turns
  read-only (who signed in, their spend, "Manage people in Admin" linking to
  `<OMB_ADMIN_URL>/people?workspace=<slug>`); Remote access offers no pairing
  code and says people sign in through the organization's portal.

## Driving it

```sh
pnpm exec vitest run server/request-auth.test.ts server/decision-log.test.ts \
  server/card-answerers.e2e.test.ts server/cli-service-trust.e2e.test.ts \
  server/hosted-access.test.ts server/decision-log-wiring.test.ts server/hosted-models-api.test.ts \
  src/components/PeopleSection.test.ts src/components/ServerPairingCard.test.ts src/lib/session.test.ts
```

- `server/request-auth.test.ts` runs the worker's calls and a list of admin
  calls through the resolver under each trust level, sessions under
  `service`, the desktop capability overriding `service`, the serving CLI's
  secret opening the pairing route and nothing else, and the start-up choice.
- `server/hosted-access.test.ts` ("treats a session-less local caller as a
  service by default") boots a portal-membership workspace with shared Full
  access and no override: the start-up log line, the worker's whole path over
  loopback (health, bot list, a Full-access thread, a guarded send, its
  request fence), 403 for `PUT /api/config`, `POST /api/webhooks`, session
  list and revocation, bot creation and loosening, and an unguarded send,
  with nothing changed afterwards; then an admin portal session saves the
  retention window and reads `membership`. The other cases in that file keep
  `OMB_LOOPBACK_TRUST=owner` because they set fixtures up over loopback.
- `server/card-answerers.e2e.test.ts` boots a server with one admin and two
  members on the sign-in list and the fake ACP engine asking permission every
  turn: another member is refused on both respond routes, the requester
  approves, the thread's opener declines someone else's request, a thread a
  bot opened mid-way through a member's request (through the real
  `/api/internal/threads` handoff) leads back to that member, a card that
  names nobody is answered by any member, an admin and the owner answer
  anyone's card, and under `OMB_LOOPBACK_TRUST=service` a session-less caller
  cannot approve (or use the bot-scoped route or always-allow) but can
  decline, while a Slack-shaped guarded request stays answerable by any
  member. Each answer's decision row and card name who answered.
- `server/cli-service-trust.e2e.test.ts` runs the real `openmausbot serve`
  with `OMB_LOOPBACK_TRUST=service`: it prints a pairing code and keeps
  running, the pairing route refuses every other local caller, and later
  `pair` and `sessions` commands exit with the explanation.

## Not proven here

- The live Slack worker was not run against this build; its calls are pinned
  from its source and exercised route by route above.
- "Always allow" by a refused member is covered by code, not by the fake
  engine, whose cards carry no allow key.
- Not closed: a bot's shell under `service` trust can still use the guarded
  route to post into an existing Full-access thread, or open one while shared
  Full access is on, so a member can get Full-access work done without a
  card. It can also stop a request and decline a card, and read files its
  user owns. A worker-only relay token is the planned fix.
- The Settings screens and the sign-in redirect were checked by rendering and
  unit tests, not in Electron or a browser.

## Observed local result — 2026-09-23

On a disposable worktree rebased onto OpenMausBot main `0bb37982`:
`pnpm typecheck`, `pnpm lint`, `pnpm i18n:check`, `pnpm test:packaged-server`,
and the files above plus `server/index.test.ts`,
`server/chat-followups-restart.test.ts`, `server/steer-e2e.test.ts`,
`server/routines-startup.test.ts`, `server/enterprise.test.ts`,
`server/store.test.ts`, `server/cli-lifecycle.test.ts`,
`server/cli-pair.test.ts`, `server/cli.test.ts` and
`scripts/testing/verification-docs.test.ts` passed on macOS. Mutation checks,
each restored afterwards, turned a named test red: the resolver ignoring
`service`; a hosted workspace defaulting to `owner`; the server gate not
passing the trust level; members answering any card; a service approving;
task creation not recording its opener; a bot-opened thread not traced back
to the person; a card that names nobody refused to members; the CLI secret
ignored, or opening more than the pairing route; `sessions` ignoring the
refusal; an SSH tunnel treated as connected; decision rows without the
answerer; month pruning off by one month; the portal People table offering
edits. Every server, session, engine and identity service was a local
fixture. This is not production qualification: no hosted tenant, Slack
worker, Admin or real email was involved.
