# Connect apps through an OpenConnector runtime

OpenMausBot's connector layer is pluggable: behind `server/composio.ts` a `ConnectorProvider`
seam serves the same callers, grants, scopes and approval cards from either backend. Composio
remains the default. This page covers the optional OpenConnector backend: a local or self-hosted
[oomol-lab/open-connector](https://github.com/oomol-lab/open-connector) runtime that serves
provider actions over its `/v1` HTTP API.

## Security premises

- **The runtime owns the credentials.** Connection credentials (OAuth tokens, API keys) are
  stored on the OpenConnector runtime, encrypted at rest under its own
  `OOMOL_CONNECT_ENCRYPTION_KEY`. Keep that key on the runtime host, backed up with it, and out
  of the repository.
- **The admin token is root for the runtime.** `OOMOL_CONNECT_ADMIN_TOKEN` can read and manage
  every connection and OAuth client configuration on that runtime. Treat it like a root
  password: inject it through `OMB_OPENCONNECTOR_ADMIN_TOKEN` or a reference
  (`OMB_OPENCONNECTOR_ADMIN_TOKEN_REF=env:VAR` / `file:/path` to an owner-only file). Never
  commit it, print it, or let it into a backup.
- **OpenMausBot keeps only references and labels.** On this host the provider stores the
  runtime URL, the admin-token reference, per-connection aliases and labels, and each app's
  OAuth client record with the client secret sealed (AES-256-GCM) under a `0600`
  `connector-key` file. `connector-key` is excluded from workspace backups, so a sealed copy in
  a backup cannot be opened elsewhere.

## Configuration

Environment variables win over `config.json`, matching every other credential in this repo:

```bash
OMB_CONNECTOR_PROVIDER=openconnector
OMB_OPENCONNECTOR_URL=https://connector.example.test     # or http://127.0.0.1:3000
OMB_OPENCONNECTOR_ADMIN_TOKEN=...                        # or:
OMB_OPENCONNECTOR_ADMIN_TOKEN_REF=env:MY_TOKEN_VAR
# OMB_OPENCONNECTOR_ADMIN_TOKEN_REF=file:/home/me/.secrets/openconnector-admin
```

The persistent equivalent lives in `config.json` under `"connectors"`. The URL must not carry
credentials, a query, or a fragment, and plain HTTP is accepted on loopback hosts only — point
HTTPS at anything else.

## Connecting an app (per-app OAuth)

Each app gets its own OAuth client on the runtime; OpenMausBot never shares one client across
apps.

1. Read the runtime's redirect target and store the app's client, with an operator script
   (there is no product UI for this yet):

   ```bash
   read -rs OPENCONNECTOR_OAUTH_CLIENT_SECRET
   export OPENCONNECTOR_OAUTH_CLIENT_SECRET
   node scripts/openconnector-oauth.ts configure github \
     --client-id <id> --scope repo --scope read:user
   node scripts/openconnector-oauth.ts status github
   ```

   The non-echoing `read -s` prompt keeps the secret out of argv and shell history; clear the
   exported variable when the shell exits. The script prints the `expectedRedirectUri`; register
   exactly that value as the OAuth app's callback. The client secret travels only to the runtime;
   the local copy is sealed.
2. Connect from the product as usual (Connected apps → Connect). The provider asks the runtime
   to start an authorization request, returns the browser link, and records a pending local
   account.
3. Finish the authorization in the browser. The provider polls the runtime in the background
   (at most every two seconds, honoring `Retry-After`) and folds the terminal state back into
   the local record — `connected`, or a terminal failure such as `expired`, on its own. A
   polling failure marks the record `error` with the reason; it never changes what the Connect
   action already returned.

Disconnect (Connected apps → Disconnect) drops the runtime connection and the local records
for that app; disconnecting one account sends the runtime the connection's alias.

## How tools look to bots

OpenConnector action ids map onto the repo's existing connector-tool shape, so
`connectorTools` grants, `connectorScopes` (read/write) and the approval cards work unchanged:

| OpenConnector action | Toolkit slug | Connector tool | Scope rule |
|---|---|---|---|
| `github.get_current_user` | `github` | `GITHUB_GET_CURRENT_USER` | read (`GET`) |
| `gmail.send_email` | `gmail` | `GMAIL_SEND_EMAIL` | write (`SEND`) |
| `google_calendar.create_event` | `google_calendar` | `GOOGLE_CALENDAR_CREATE_EVENT` | write (`CREATE`) |
| `notion.search_pages` | `notion` | `NOTION_SEARCH_PAGES` | read (`SEARCH`) |

The mapping is total or null: an action id that cannot produce a
`CONNECTOR_TOOL_NAME_PATTERN`-compliant name never becomes a tool. Services with underscores
(`google_calendar`, `bland_ai`) keep their full slug; tool calls resolve against the exact runtime
action catalog rather than guessing a service prefix. When a service has several local accounts,
pass `_meta.openconnectorAccountAlias`; otherwise the call is rejected instead of silently using
the default account.

## Triggers: not supported in this phase

The Composio path can subscribe to app events and push them to OpenMausBot routines; the
OpenConnector provider does not. OpenConnector exposes trigger *execution* endpoints, but
OpenMausBot's trigger host is built around the managed broker's push channel, and wiring
OpenConnector triggers would be a new integration, not a provider swap. The provider therefore
does not advertise triggers, and the Composio trigger path is untouched.

## Limitations

- **SaaS sources are out of scope.** Use a local or self-hosted runtime. URL validation does not
  verify where the runtime is hosted.
- **No in-product settings UI yet.** Provider selection and per-app OAuth configuration use env
  vars, `config.json`, and the `openconnector-oauth` script; the Composio settings screens keep
  working untouched.
- **Tool listing is not cached.** Every tools/list walks `GET /v1/actions`; add caching only
  with the same per-backend identity discipline the Composio provider uses.
- **The MCP bridge translation is stateless.** It answers `initialize`, `tools/list`, and
  `tools/call` from the REST API per call and holds no MCP session (accepted and ignored);
  every other JSON-RPC method gets a method-not-found error.
- **Named-account deletion depends on the runtime.** Disconnecting one account selects it with
  the runtime's connection selector; verify against your runtime version.
- A re-sent `authorize` for the same connection request id polls once, not in duplicate loops.
