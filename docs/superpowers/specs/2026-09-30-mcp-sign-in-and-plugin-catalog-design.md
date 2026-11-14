# MCP sign-in and plugin catalog — design

Date: 2026-09-30 · Status: awaiting review · Scope: desktop (macOS, Windows)

## Why

Adding Higgsfield (`https://mcp.higgsfield.ai/mcp`) failed two ways:

1. **As a URL server** the app got `HTTP 401` and told the person to "check the
   address and headers". Higgsfield has no API key; it wants an OAuth sign-in,
   and OpenMausBot's URL servers only support static headers.
2. **Through `npx mcp-remote`** the Test button reported "The server did not
   answer in time." mcp-remote had opened a browser sign-in; the probe kills
   every server after 8 s (`server/mcp-probe.ts`, `DEFAULT_TIMEOUT_MS`), long
   before a person finishes signing in. Once signed in from a terminal, the same
   command lists 108 tools in 3.3 s.

Root cause: the app has no OAuth support for remote MCP servers. More hosted
servers (Higgsfield, Notion, Linear, Figma, Vercel, Sentry…) require it, and
people who don't use Composio have no one-click way to connect them.

## Goals

- **A. Sign-in for URL servers.** A URL server that asks for OAuth can be signed
  into from the desktop app; tokens are stored, refreshed, and handed to every
  engine as an ordinary `Authorization` header.
- **B. Plugin catalog.** A Plugins tab, independent of Composio, with a curated
  featured list plus search over the official MCP Registry. Connect = add +
  sign in + test + enable.

## Non-goals

- Signing in from the iOS/Android apps. Phones show state and use connected
  plugins; they say "Sign in on your computer". (A hosted return page + deep
  link can add this later without changing the stored data.)
- Signing in when the desktop is attached to a remote workspace (Box/VPS). The
  loopback callback only works where the server runs; the UI says so.
- Local (stdio) registry packages. Catalog and search show URL servers only.
- Changing the Composio Connected apps tab.

## A. Sign-in for URL servers

### Detection

`RemoteMcpClient` (`server/mcp-http.ts`) surfaces a `401` as an auth-required
failure carrying the `WWW-Authenticate` header. A new module resolves the
authorization server the MCP way:

1. `resource_metadata` from `WWW-Authenticate`, else
   `/.well-known/oauth-protected-resource` on the server origin → its
   `authorization_servers[0]`; fall back to the MCP server origin.
2. Authorization-server metadata from `/.well-known/oauth-authorization-server`,
   then `/.well-known/openid-configuration`.
3. Require `authorization_endpoint`, `token_endpoint`, and PKCE `S256`.

A server that answers 401 and yields this metadata is **Needs sign-in**. The
probe returns `{ ok: false, auth: "required" }` instead of the misleading
"check the address and headers", and does not wait out the timeout.

### Sign-in flow (new `server/mcp-oauth.ts`)

- **Client identity:** Dynamic Client Registration (RFC 7591) when
  `registration_endpoint` exists, as a public client
  (`token_endpoint_auth_method: none`), `client_name: "OpenMausBot"`, one
  loopback redirect URI. The registration is cached per authorization server.
  Without DCR, the catalog entry may carry a pre-registered `clientId`; a
  pasted URL without either shows "This server needs an app registration
  OpenMausBot doesn't have yet."
- **Loopback callback:** the server listens on `127.0.0.1` on a port derived
  from the server URL (stable across attempts, so one registration is reused;
  falls back to an ephemeral port and re-registers if taken). Path
  `/mcp-oauth/callback`. The listener lives only for the pending sign-in and
  closes after success, failure, cancel, or 5 minutes.
- **Authorization request:** PKCE S256, random `state`, `resource` = the MCP
  URL (RFC 8707), `scope` from protected-resource metadata when given.
- **Start:** `POST /api/mcp/servers/:name/sign-in` returns the authorization
  URL; the renderer opens it through the existing external-browser path
  (`shell.openExternal`). The server never opens a browser itself.
- **Finish:** the callback checks `state`, exchanges the code, stores tokens,
  answers the browser with a small "You can close this tab" page, and emits a
  server event so the MCP panel updates without polling. Errors
  (`access_denied`, bad state, exchange failure) render a short message in the
  tab and on the server card.
- **Where it runs:** sign-in starts only when this server process runs on the
  same machine as the requesting desktop (loopback origin). Otherwise the
  endpoint returns
  `409 remote-workspace` and the UI shows "Sign in from the computer running
  this workspace."

### Token storage

A new `mcp-oauth.json` in the data directory, written atomically with mode
`0600` like `config.json`, keyed by server name and bound to its URL:
`{ url, clientId, accessToken, refreshToken?, expiresAt?, scope?, authServer }`.
Tokens never leave the server: not in `GET /api/mcp/servers`, not in logs
(add them to redaction), not to phones. The list API gains
`auth: "none" | "signed-in" | "needs-sign-in"`.

Changing a server's URL, removing it, or **Sign out** deletes its tokens
(Sign out also calls the revocation endpoint when advertised, best-effort).

### Handing tokens to engines

`engineMcpServers(bot)` (`server/index.ts`) is the single point where a turn
gets its servers. It adds `Authorization: Bearer <access token>` to signed-in
servers (a user-set `Authorization` header is replaced for OAuth servers), and
**leaves out** servers that need sign-in, so a turn never mounts a server that
will 401. Before each turn and each Test, `refreshDue(names)` refreshes
tokens expiring within 2 minutes (single-flight per server). A refresh that
fails with `invalid_grant` marks the server Needs sign-in and posts one
notice; network failures keep the current token and retry next turn.

Claude, Codex and ACP drivers already receive headers correctly, so no driver
changes are expected; the plan verifies each.

### UI (MCP servers panel)

- Status chip: **Signed in** / **Needs sign-in**.
- Buttons: **Sign in** (and **Cancel** while pending), **Sign out**.
- Test on a Needs-sign-in server offers Sign in instead of an error.

## B. Plugin catalog

### Placement

Plugins dialog tabs: **Connected apps** (Composio, unchanged) · **Plugins**
(new) · **MCP servers** (existing, for custom entries). Plugins works with no
Composio key.

### Featured list

`shared/plugin-catalog.json`, shipped with the app, validated by a zod schema
and a test. Entry: `id, name, description, icon, url, transport, auth
("oauth" | "api-key" | "none"), clientId?, apiKeyHeader?, docsUrl`.
Seed candidates (each verified to sign in end to end before inclusion):
Higgsfield, Notion, Linear, Figma, Vercel, Sentry, Stripe, Atlassian, Asana,
Canva. Icons are bundled files, not hot-linked.

### Registry search

`GET /api/plugins/search?q=` on the server proxies
`https://registry.modelcontextprotocol.io/v0/servers?search=`, keeps entries
with a `streamable-http` or `sse` remote, keeps only `isLatest`, de-duplicates
by name, caps at 30, times out at 5 s, caches 10 minutes. Results show
**Community · not reviewed** and the remote's domain (the registry returns a
third-party `higgsfield.app` server for "higgsfield" — the domain must be
visible). Connect on a search result requires ticking "I trust this server".
Registry failure only disables search.

### Connect

1. Create the URL server entry (existing `POST /api/mcp/servers`; name from
   the catalog id, suffixed on collision). It stays off.
2. `auth: oauth` → sign-in (A). `api-key` → a small dialog; the key becomes a
   write-only header. `none` → skip.
3. Test; on success enable it. The card shows **Connected · N tools**, with
   Turn off and Sign out / Remove.

Cards read state from the MCP server list (matched by URL), so a server added
by hand on the MCP servers page also shows as connected. Per-bot access uses
the existing per-bot MCP selection — nothing new.

### Phones

Phone apps list connected plugins read-only and show "Sign in on your
computer" for Needs sign-in. Small label change on iOS and Android.

## Error handling summary

| Situation | Result |
| --- | --- |
| 401 with OAuth metadata | Needs sign-in; excluded from turns |
| 401 without metadata | "The server answered HTTP 401. Check the address and headers." (today's text) |
| No DCR and no catalog clientId | Explained on the card; no flow starts |
| Browser closed / 5 min pass | Pending sign-in cancelled, listener closed |
| Refresh `invalid_grant` | Needs sign-in + one notice |
| Refresh network error | Keep token, retry next turn |
| Remote workspace | 409 + "sign in from the computer running this workspace" |
| Registry down | Search disabled, featured list unaffected |

## Testing

- **Unit (vitest):** metadata discovery (header hint, well-known fallbacks,
  missing S256); DCR request shape; PKCE/state; callback state mismatch;
  token store 0600 + URL binding + deletion on URL change; refresh
  single-flight and `invalid_grant`; `engineMcpServers` header injection and
  exclusion; registry filter/dedupe/cap; catalog schema.
- **Integration:** a fake OAuth + MCP server in-process — register, sign in via
  the callback, Test lists tools, turn config carries the bearer, expiry →
  refresh → still works, revoke → Needs sign-in.
- **Probe:** a 401 OAuth server returns `auth: "required"` quickly, not a
  timeout.
- **Manual (OMB2 side-by-side build):** Higgsfield from the catalog end to end
  on macOS, then a Claude bot and a Codex bot generating an image; Notion as a
  second provider; Windows smoke on a Windows build.

## Build order

1. A: discovery + probe `auth: required` (fixes the misleading message).
2. A: sign-in flow, token store, refresh, `engineMcpServers` injection, panel UI.
3. B: catalog file + Plugins tab + Connect.
4. B: registry search.
5. Phone labels.

Each step is shippable on its own; 1–2 can be one PR, 3–4 a second, 5 a third.
