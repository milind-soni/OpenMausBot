# Capture connection plan

Capture is intentionally installed with every routine paused. This lets
Shane authorize accounts and browser sessions without an unattended routine
starting against the wrong identity.

## Required setup

| Source ids | Preferred path | User action still required |
| --- | --- | --- |
| `gmail-account-1` through `gmail-account-3` | Connected apps / Composio Gmail | Sign in to each intended Google identity and assign a stable alias |
| `calendar-account-1` through `calendar-account-3` | Connected apps / Composio Google Calendar | Authorize each intended identity; do not silently reuse a Gmail slot |
| `drive` | Connected apps / Composio Google Drive | Authorize Drive and keep it read-only |
| `plaud`, `google-messages`, `monarch`, `youtube` | Dedicated browser session | Sign in once in the browser profile used by Capture |
| `chrome-history`, `local-inbox` | Local read-only adapter | Choose the history profile and inbox folder |
| `whoop` | Reviewed local pull | Select the approved export/API path; never paste a token into a routine prompt |

The source catalog in `server/capture-source-catalog.ts` is the canonical list.
Each source has an independent cursor and health receipt. A connector being
authorized does not prove that all three account slots are assigned.

## Safe enablement order

1. Authorize the three Gmail accounts, three Calendar accounts, and Drive.
2. Verify each alias by performing a manual read and checking the returned
   account identity. Record a quiet result as `empty`, not as `ok` with a fake
   cursor.
3. Sign in to the browser-only sources and confirm their domains in the
   dedicated profile.
4. Select local history/inbox/WHOOP sources and run a manual Capture sweep.

## Local source setup

Local collectors are read-only and require no account connection. Select paths
in the Capture source settings (the app stores the selection, not the file
contents), then run a manual sweep before enabling a routine.

- **Chrome history:** choose a Chrome profile's `History` file. On Windows the
  default is `%LOCALAPPDATA%\Google\Chrome\User Data\Default\History`.
  OpenMausBot copies this locked SQLite database to a temporary read-only copy,
  emits domains and page titles only, and keeps a tie-safe incremental cursor.
  It never writes to the Chrome profile or includes query strings/fragments.
- **Local inbox:** choose a folder you review for ingestion. The collector
  reconciles the whole tree at startup, skips symlinks/reparse points, limits
  depth/files/bytes, and reads text only for `.txt`, `.md`, `.json`, `.csv`, and
  `.log` files by default. Binary files contribute metadata only.
- **WHOOP:** export JSON or CSV from WHOOP, extract it to a reviewed folder (or
  select a single file), and choose that path. Credential-shaped keys (tokens,
  cookies, secrets, passwords, and authorization fields) are dropped before a
  receipt is produced. The collector does not use or request a WHOOP token.

The first run performs reconciliation and may return many items. Later runs
return only changed/new files or history rows. Missing paths are reported as
`needs-config`; read failures remain `failed` and do not advance the cursor.

The installed `shane-grok-capture-replica` package receives a narrowly scoped
read-only local-capture grant, so Capture can use these collectors while its
full computer-control setting remains off. Other bots still need an explicit
`This computer` grant. This exception does not enable CUA, browser clicking,
typing, authentication, or any write operation.
5. Review the Chief report. Only then enable the weekday fast watch and the
   hourly refresh.

If an account, browser session, or local adapter is unavailable, Capture must
record `needs-auth` or `failed`, preserve the last committed cursor, finish the
run, and deliver a degraded report to Chief. It must never report an all-clear
or advance a cursor after a failed read.
