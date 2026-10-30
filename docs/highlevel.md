# HighLevel CRM (native integration)

One card, **HighLevel**, in Connected apps, on desktop and on a Cloud home alike. It also covers Growably and every
other HighLevel-based white-label CRM: the sign-in uses HighLevel's white-label page, so those users never see the
HighLevel brand. Composio is not involved; the server (`server/highlevel/*`) talks to
`https://services.leadconnectorhq.com` itself.

## How it works

```
OMB server (desktop or Cloud home)         accounts.openmausbot.com (relay)              HighLevel
  POST /api/highlevel/sign-in ───────────▶ POST /v1/highlevel/start → state + auth URL
  app opens the auth URL in the browser ─────────────────────────────────────────────▶ sign in, pick a location
                                            ◀── GET /v1/highlevel/callback?code&state ── redirect
                                            exchanges the code (client secret lives there only)
  polls POST /v1/highlevel/claim every 2 s ◀── tokens, once (404 before, 410 after)
  stores the tokens, encrypted, in DATA_DIR
  calls services.leadconnectorhq.com with the access token (Version: 2021-07-28; conversations 2021-04-15)
  on 401 or near expiry: POST /v1/highlevel/refresh {refreshToken} → new pair, stored (the refresh token rotates)
```

- **Connect** starts a flow and returns `{flowId, authorizationUrl, expiresAt}`; the app opens the link and polls the
  flow. The server polls the relay for up to 10 minutes; the flow lives in memory only.
- **Private Integration token** (for agencies that hide the Marketplace): `POST /api/highlevel/token {token, locationId}`.
  The token is created inside the sub-account (Settings → Private Integrations) with the permissions under
  [Permissions](#permissions-scopes), and checked with `GET /locations/{locationId}` before it is saved, so it needs
  **View Locations**. A refused check says which case it is (`tokenCheckError` in `server/highlevel/client.ts`), adds
  HighLevel's own reason (secrets redacted, at most 160 characters) and never repeats the token:
  - 401 "not authorized for this scope": the token is missing View Locations; turn it on (the token stays the same).
  - any other 401: the token was not accepted (mistyped, rotated or deleted), or lacks View Locations.
  - 403: the token belongs to another sub-account, or is an agency-level token.
  - 404: no location with that ID.

  The token never refreshes. A 401 that rejects the token itself signs it out; a 401 for a missing scope does not (see
  [Permissions](#permissions-scopes)).
- **Storage:** `DATA_DIR/highlevel.json.enc`, AES-256-GCM under `DATA_DIR/highlevel-key` (0600), the same scheme as
  saved logins. No keychain in the path, so a Cloud home works the same way. Stored: kind (`oauth` | `token`), access
  token, refresh token, expiry, locationId, companyId, userId, location name, scopes, state (`signed-in` |
  `needs-sign-in`) and the plain-sentence problem when a new sign-in is needed. No route ever returns a token.
- **Reconnect:** when the relay rejects a refresh (`401 highlevel_refresh_rejected`: revoked, app uninstalled) the
  store is marked `needs-sign-in`, the card shows "Signed out. Reconnect to keep using it.", and every tool call
  answers the plain signed-out note until the person reconnects.
- **Disconnect** (`DELETE /api/highlevel`) removes the tokens. HighLevel's own uninstall is a link in the UI.

### "Please reach out to the agency admin for assistance with installation"

HighLevel's Marketplace install page shows this when the agency that owns the sub-account (often a white-label agency,
e.g. Growably) does not let sub-account users install apps. It comes from HighLevel, not OpenMausBot, and Connect
cannot get past it. Either ask the agency admin to install the app for that sub-account (or to allow sub-account
installs), or use **Use a Private Integration token instead** on the card: a sub-account admin can create one under Settings →
Private Integrations when the agency allows it.

## Owner routes (`server/routes/highlevel.ts`, admin or owner session only)

| Route | Answer |
|---|---|
| `GET /api/highlevel` | `{ state: unavailable \| signed-out \| connecting \| connected \| needs-sign-in, kind?, location?: {id, name}, connectedAt?, flow?: {flowId, authorizationUrl, expiresAt}, problem? }` |
| `POST /api/highlevel/sign-in` | `{ flowId, authorizationUrl, expiresAt }` |
| `GET /api/highlevel/sign-in/:flowId` | `{ phase: waiting \| connected \| failed \| expired, message? }`; 404 `{error}` for an unknown flow |
| `DELETE /api/highlevel/sign-in/:flowId` | cancels |
| `POST /api/highlevel/token` | body `{ token, locationId }` → the status; errors are `{ error: "<plain sentences>" }` with HighLevel's status (401, 403, 404) or 400 |
| `DELETE /api/highlevel` | disconnects → the status |

`GET /api/connectors/tools` also carries a `highlevel` entry with the twenty tool names. Bot settings do not use it for
HighLevel (see [Per-bot scope](#per-bot-scope)). Cloud health merges `{ highlevel: { connected } }` into its connectors
report while a HighLevel connection is saved (signed in, or needing sign-in again); a HighLevel never connected is not
listed.

## Environment

| Variable | Meaning |
|---|---|
| `OMB_HIGHLEVEL_RELAY_URL` | The relay. Default `https://accounts.openmausbot.com`. `off` disables the integration (`state: "unavailable"`); a Private Integration token still works. Loopback `http://` is accepted for tests. |
| `OMB_HIGHLEVEL_API_URL` | Tests only: a fake HighLevel in place of `https://services.leadconnectorhq.com`. |

## Tools (bots)

Mounted as the MCP server `highlevel` through the harness proxy (`/api/internal/highlevel/mcp`, token env
`OMB_MCP_TOKEN_HIGHLEVEL`), so drivers see `mcp__highlevel__HIGHLEVEL_GET_CONTACT` and the like. Every call carries the
turn's capability; the server re-reads the live bot on every call for the verdict.

| Tool | Does | Read/write |
|---|---|---|
| `HIGHLEVEL_SEARCH_CONTACTS` | free text + exact tag/email/phone filters, page | read |
| `HIGHLEVEL_GET_CONTACT` | one contact, custom fields by name | read |
| `HIGHLEVEL_CREATE_CONTACT` / `HIGHLEVEL_UPDATE_CONTACT` | name, email, phone, company, tags, source, address, custom fields by name | write |
| `HIGHLEVEL_ADD_TAGS` / `HIGHLEVEL_REMOVE_TAGS` | tags on a contact | write |
| `HIGHLEVEL_LIST_NOTES` / `HIGHLEVEL_ADD_NOTE` | notes on a contact | read / write |
| `HIGHLEVEL_LIST_TASKS` / `HIGHLEVEL_ADD_TASK` | tasks on a contact (title, due date, description, assignee) | read / write |
| `HIGHLEVEL_LIST_PIPELINES` | pipelines with stages | read |
| `HIGHLEVEL_SEARCH_OPPORTUNITIES` / `HIGHLEVEL_GET_OPPORTUNITY` | by pipeline, stage, contact, status, text; one by id | read |
| `HIGHLEVEL_CREATE_OPPORTUNITY` / `HIGHLEVEL_UPDATE_OPPORTUNITY` | pipeline, stage, contact, name, value, status (open/won/lost/abandoned) | write |
| `HIGHLEVEL_SEARCH_CONVERSATIONS` / `HIGHLEVEL_READ_CONVERSATION` | conversation summaries; the messages of one | read |
| `HIGHLEVEL_LIST_CALENDARS` / `HIGHLEVEL_LIST_EVENTS` | calendars; events in a date range | read |
| `HIGHLEVEL_GET_LOCATION` | name, timezone, contact details, custom field definitions | read |

Outputs are trimmed objects (ids, names, email, phone, tags, dates, custom fields by name), never raw API dumps.
Errors are one plain sentence: "HighLevel refused this (403): the connection lacks the contacts.write permission.",
"HighLevel refused this (401): the connection lacks the View Custom Fields permission (locations/customFields.readonly).",
"HighLevel has no contact with that id (404).", "HighLevel is rate-limiting; try again in a few seconds."

**Never:** no tool sends SMS, email or WhatsApp, starts a campaign or workflow, books or changes appointments, deletes a
record (except removing tags) or touches payments. The guard is in the client (`assertAllowedPath` and
`FORBIDDEN_PATHS` in `server/highlevel/client.ts`), so no later tool can grow a path to those endpoints; a test asserts
the client has no such method. The system prompt tells the bot the same.

## Per-bot scope

The same rules as other connected apps, with slug `highlevel`:

- `bot.composio === false` → no HighLevel tools.
- `connectorScopes.apps.highlevel`: `read` allows SEARCH/GET/LIST/READ only; `write` allows everything; a scopes record
  without `highlevel` mounts nothing.
- In the app: **Bot settings → Access → Connected apps**, with "Limit this bot to specific apps" on, gives HighLevel
  **Off**, **Read** or **Read & write** per bot (`connectorScopes.apps.highlevel`). There is no per-tool picker for
  HighLevel: the tool-grants picker lists Composio apps only (`AccessSection.tsx` filters `highlevel` out).
- `connectorTools.highlevel.tools`: `"*"` or a list of tool names, still honoured on every call when a bot record carries
  one. `shared/highlevel.ts` `HIGHLEVEL_TOOL_GROUPS` defines four groups (*Contacts and notes*, *Pipelines and deals*,
  *Conversations (read)*, *Calendars (read)*; `HIGHLEVEL_GET_LOCATION` is in every group) for such grants; no screen
  shows them yet.
- Whatever the level, sending messages, campaigns, workflows and payments stay blocked for every bot
  (`FORBIDDEN_PATHS`; see **Never** above).
- `tools/list` shows only what the bot may run; a refused call answers the connector scope text ("HighLevel is
  read-only for <bot>, and Add note would write to it…") and writes a decision row (`source: connector-scope`).
- CRM record changes are not messages: no outbound card, no daily allowance; the write scope is the control.

## Permissions (scopes)

Each call needs one HighLevel scope. A Private Integration is given them by name on HighLevel's Private Integrations
page; the Marketplace app asks for `HIGHLEVEL_SCOPES` (`cloudflare/control-plane/wrangler.jsonc`), which must match the
scopes approved for the app in HighLevel's developer dashboard. That list does not include
`locations/customFields.readonly` or `conversations/message.readonly` yet, so a Marketplace connection reads custom
fields keyed by id and, per HighLevel's API reference, cannot read a conversation's messages until both are added in
both places.

| Permission (Private Integrations page) | Scope | Used by |
|---|---|---|
| View Locations | `locations.readonly` | the token check, `HIGHLEVEL_GET_LOCATION` |
| View Contacts | `contacts.readonly` | contact search and reads, notes and tasks lists |
| Edit Contacts | `contacts.write` | contact create and update, tags, add note, add task |
| View Opportunities | `opportunities.readonly` | pipelines, opportunity search and reads |
| Edit Opportunities | `opportunities.write` | opportunity create and update |
| View Custom Fields | `locations/customFields.readonly` | naming custom fields in contact reads and `HIGHLEVEL_GET_LOCATION`; writing custom fields by name |
| View Conversations | `conversations.readonly` | `HIGHLEVEL_SEARCH_CONVERSATIONS` |
| View Conversation Messages | `conversations/message.readonly` | `HIGHLEVEL_READ_CONVERSATION` |
| View Calendars | `calendars.readonly` | `HIGHLEVEL_LIST_CALENDARS` |
| View Calendar Events | `calendars/events.readonly` | `HIGHLEVEL_LIST_EVENTS` |

The first six cover contacts, notes, tags, tasks and deals; add the last four for conversations and calendars.

HighLevel answers **401** both for a dead token (`Invalid JWT`) and for a live token missing a scope (`The token is not
authorized for this scope.`). Only the first signs the connection out (and, for OAuth, is refreshed first). A missing
scope answers the bot "HighLevel refused this (401): the connection lacks the Edit Contacts permission
(contacts.write)." and the connection stays signed in. The custom-field lookup inside contact reads is optional: without
View Custom Fields, contacts still read (their custom fields keyed by id), the refusal is cached for 10 minutes, and only
a write that names a custom field fails, naming the missing permission.

## Writes in the activity

Every successful write appends an activity row to the thread: `tool.name` `mcp__highlevel__HIGHLEVEL_<ACTION>`, and
`tool.summary` with the record id and the field names changed (`contact abc123: email, tags`), never the values.

## Limits

- HighLevel: 100 requests / 10 s and 200,000 / day per app per location. The client keeps under **90 / 10 s** per
  location, waits per `Retry-After` / `X-RateLimit-Interval-Milliseconds` (at most 10 s) and retries once on 429,
  retries once on 5xx, refreshes once on a dead-token 401 (and ahead of expiry) and retries the call; a missing-scope
  401 is answered at once.
- A call that creates a contact, note, task or opportunity is never sent twice. HighLevel takes no idempotency key and
  may have saved the record before a 5xx or a lost answer. The bot gets an error that says so and checks first.
- Each tool call checks its turn after retry or budget waits and before each HighLevel API request.
  Stop prevents later requests. A request already sent can still complete.
- Access tokens last a day; refresh tokens a year and rotate on every use. The rotated pair is stored before the retry.
  A refresh or a sign-out lands only on the token pair it started from. A call whose tokens were replaced meanwhile
  retries with the newer tokens of the same location, or stops when another location was connected.
- Results: at most 50 per page, pages 1 to 1,000; text fields are cut at 4,000 characters; responses over 4 MB are refused.
- Custom field definitions are cached for 10 minutes per location.

## Not in v1

Sending messages (SMS, email, WhatsApp), campaigns, workflows, payments, booking or changing appointments, deleting
records, webhooks from HighLevel (contact changed → bot), agency-level (Company) tokens, bulk installs, several
locations at once (one connection per installation).

## Tests

- `server/highlevel/client.test.ts`: request shapes, trimming, Version header, refresh-once with rotation persisted,
  refreshes and late 401s that race a reconnect or another refresh,
  429 backoff, 5xx retry without replaying a create, the budget, plain errors, the store's encryption and the no-messaging guard; a missing scope
  is not a sign-out (token and OAuth) while a dead token still is; the token check's 401/403/404 sentences and redaction.
- `server/highlevel/rpc.test.ts`: per-bot scoping (read-only refusal text, grants, tools/list filtering), the write
  record and the host's activity row.
- `server/highlevel/cancellation.test.ts`: Stop during 429, 5xx and budget waits, before dispatch, and concurrent call isolation.
- `server/highlevel/sign-in.test.ts`: the relay contract, the sign-in flow, a replaced flow's late claim, the token path
  and the owner routes.
- `server/highlevel.e2e.test.ts`: a real server, fake relay and fake HighLevel, Connect → tools → refresh →
  revocation → Disconnect → Private Integration token, and Stop during a 429 wait without a later write.
