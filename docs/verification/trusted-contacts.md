# Trusted contacts: isolated server verification

This recipe uses the repository's `launchVerificationServer` helper described
in [the verification guide](README.md). It creates temporary homes and data,
starts only the fake engine, chooses an isolated API/webhook port pair, and
removes the fixtures after each test. No live account, calendar, phone number,
Inkbox recipient, or normal application data is used.

Run the actual server acceptance tests with Node 24:

```sh
pnpm exec vitest run server/trusted-contacts.e2e.test.ts
```

The first test creates real admin and client sessions through pairing,
creates a bot and contact, and configures manual free-time windows. A contact
must present its own credential on the separate webhook receiver and have an
unexpired grant covering both the requested capability and time window.
Missing credentials, workspace-session credentials, requests outside the
grant, extra instruction fields, and changed duplicate request bodies are
rejected. Exact duplicates return their existing results.

The test submits a meeting proposal and checks the durable private JSON file
before restarting only its own server child. After restart, the proposal is
still pending and the availability response is unchanged. An admin approves
the proposal through the app API; the contact can then poll the result, and
the app can download an escaped `text/calendar` invitation. That confirmed
time is removed from later availability. A second proposal is denied and
does not yield an invitation. Confirmation reserves time locally and exports
ICS; it does not add an event to an external calendar.

Eleven management operations are refused for the paired client session,
including listing contacts, changing the calendar, granting/revoking access,
deciding a proposal, and exporting an invitation. Contact-token plaintext and
hashes are absent from app snapshots. Revocation denies new requests and
polling even previously completed results. The bot's task list and transcript
are compared with their baseline to verify that scheduling requests never
start an unrestricted agent turn.

The second test launches two separate Mausbot instances. The first records a
peer using the second's contact credential and actual webhook origin. Through
the app API it requests the second instance's availability, creates a pending
proposal there, and refreshes that proposal after an owner decision in the
second app. Both instances keep their own durable records. A revoked remote
grant produces a visible uncertain outbound result and no new remote request.
Peer credentials are private on disk and absent from app snapshots.

The fixtures save logs and sanitized JSON evidence in the system temporary
`openmausbot-verification-evidence` directory. Evidence filenames append
`.trusted-contacts.json` or `.trusted-peer.json` to the server log path.
Request IDs, statuses, available slots, and fixture URLs are included; session
and contact credentials are omitted.

For the carrier adapter, also run:

```sh
pnpm exec vitest run server/inkbox-channel.test.ts
```

See [Inkbox verification](inkbox.md) for signature format, channel restrictions,
delivery uncertainty, restart behavior, and API key scope checks. These server
tests do not prove external network reachability, connected Google Calendar
availability, or actual iMessage/SMS carrier delivery. The separate
`server/inkbox-owner.e2e.test.ts` fixture proves signed owner ingress creates
unselected Ask tasks, returns a successful canonical final, suppresses exact
duplicates, keeps API/signing secrets out of the fake CLI, and treats a later
`YES` as its own new Ask task while older native approval work stays pending.
Complete project checks are verified separately.

## Settings UI evidence

The implementation was checked by driving the real renderer against an isolated server. The
verified flow was create contact → grant access → configure manual slots →
test availability (two slots) → propose meeting → approve → inspect download
link → revoke → confirm a subsequent test was refused. No browser errors were
observed. At 390px width, the settings content stayed within the viewport.

The reusable fixture script starts an isolated server and renderer preview
with temporary application data. With Node 24, run it in the foreground:

```sh
node --experimental-strip-types scripts/verify-trusted-contacts.ts
```

Open its printed `previewUrl`, exercise Settings → Trusted contacts, and press Ctrl-C
in the fixture terminal to close its owned server and preview.

- [Approved proposal screenshot](evidence/trusted-contacts/approved.jpg)
- [Narrow viewport screenshot](evidence/trusted-contacts/narrow.jpg)

The UI fixture log was `server-1791281633390-52682.log` in the temporary
verification evidence directory; the owned server child was closed after
verification. These screenshots prove the browser renderer; packaged Electron
behavior and external carrier delivery are not established by this UI check.

## Scope of this first version

Contacts use explicit `free`, `meet`, and `status` commands. Known contacts get
safe help or a permission refusal for invalid messages; unexpected internal
errors are kept in the local delivery history. Owner messages share one persistent conversation with phone questions, approvals, and background replies. See [the Inkbox release guide](inkbox-release.md) for the current owner flow and optional automatic messaging approvals.

Google Calendar uses the existing connected-app account/session and your
calendar IDs, with a fixed free/busy query. It never shares event titles,
descriptions or attendees. A failed or unreadable calendar is an error, not
free time. The provider contract is covered by synthetic tests; live accounts,
including account selection when multiple Google accounts are connected, still
need local verification. Select the same account ID or alias shown in Connected Apps
in the calendar configuration when the provider requires an explicit choice. Manual availability works without a provider account.

Contacts, peer credentials and phone delivery receipts stay on the local
machine and are excluded from transferred workspace backups. The contact
history holds at most 10,000 requests; the carrier inbox holds 1,000 events.
They stop accepting new work when full rather than removing duplicate-delivery
evidence. There is no automatic history archival or uncertain-send replay.

The Google read is sent as a single fixed tool through Composio's existing
session executor, with workbench offloading disabled and strict response
validation. Protocol sources: [sessions over MCP](https://docs.composio.dev/docs/sessions-via-mcp)
and [multi-tool executor](https://docs.composio.dev/toolkits/meta-tools/multi_execute_tool).
Only `GOOGLECALENDAR_FREE_BUSY_QUERY` is requested; no message text can select
a tool or provide its arguments.

## Local acceptance record (2026-10-06)

- Feature branch refreshed to `origin/main` at `c40c488d2` after four new
  upstream commits arrived during implementation. The original dirty checkout
  was left untouched.
- After that refresh, 197 tests passed across 13 focused feature and adjacent
  regression files; 17 further route-structure, documentation and upstream
  engine-removal checks passed across three files.
- TypeScript, repository lint and locale validation passed.
- Production web build and packaged backend smoke passed again after the
  upstream refresh; the web build reported CSS and large-chunk warnings.
- Independent review reproduced and verified fixes for approval/revocation
  races and calendar configuration capacity. Safe message help, request rate
  limits, source restoration and token rotation are covered by regressions.
- Before the final upstream refresh, broker tests passed (11), Electron unit
  tests passed (578, three skipped), and the packaged backend smoke passed.
  The full repository run was stopped to update the branch after about 45
  minutes. It had four failures in unchanged tests: environment PATH, Claude
  login timeout, phone claims, and the Electron local-computer proxy (which
  waited for a binary download). All four files passed separate reruns. This
  is not a passing full-suite result.
- Real Inkbox delivery, live Google Calendar responses and a packaged Electron
  run are still unverified. All automated providers here are synthetic.
