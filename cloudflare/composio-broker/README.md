# OpenMausBot connected-apps broker

This Worker keeps the shared Composio project key out of desktop builds. Each
installation receives a random bearer token stored only as a SHA-256 hash in
D1. The Worker gives that installation its own Composio user/session, proxies
MCP traffic, and returns short-lived Connect Links to the local app.

The desktop never receives the project key. Authorization links are returned
only on demand and are never persisted in chat messages.

Deployment for this repository:

1. `pnpm broker:types`
2. `pnpm exec wrangler d1 migrations apply openmausbot-composio --remote --config cloudflare/composio-broker/wrangler.jsonc`
3. For an existing Worker, run `pnpm exec wrangler secret put COMPOSIO_API_KEY --config cloudflare/composio-broker/wrangler.jsonc`, then `pnpm broker:deploy`.
4. For the very first deploy, put `COMPOSIO_API_KEY=...` in the ignored `.dev.vars.production` file and run `pnpm exec wrangler deploy --config cloudflare/composio-broker/wrangler.jsonc --secrets-file .dev.vars.production`. Delete the file immediately afterward.

Forks should create their own D1 database and rate-limit namespaces, replace
the IDs in `wrangler.jsonc`, deploy under their own Worker name, and set
`OMB_COMPOSIO_BROKER_URL` in their packaged build. Running only the local
server with a Composio project key remains the no-Cloudflare self-host path.

Set `REGISTRATION_MODE` to `closed` to stop issuing new installation tokens
without affecting existing users.

## App events (Composio triggers)

The broker also receives Composio trigger events for every installation and
queues them until the installation's OMB server collects them. A desktop
needs no public URL: Composio posts to the broker, the server long-polls it.

```
Composio --signed POST--> /v1/composio/webhook --> D1 queue per installation <-- GET /v1/events (25 s long-poll)
```

### Routes

| Route | Auth | Does |
| --- | --- | --- |
| `POST /v1/composio/webhook` | Composio signature (`COMPOSIO_WEBHOOK_SECRET`) | Verifies the Standard Webhooks signature (300 s tolerance), routes `metadata.trigger_id` through `trigger_bindings`, requires `metadata.user_id` to be that installation's Composio user, and queues the event. A bad, missing or stale signature gets 401; an event no installation can take gets 200 and is only counted. |
| `GET /v1/trigger-types[?toolkits=a,b]` | installation token | Event types of the given toolkits (at most 10), or of the installation's active connected accounts. Types that need their own webhook endpoint are left out. Cached per isolate for an hour. |
| `GET /v1/trigger-types/:slug` | installation token | One event type with its config and payload schemas. |
| `POST /v1/triggers` `{slug, connectedAccountId, config}` | installation token | Checks that the account is this installation's, then `POST /trigger_instances/{slug}/upsert` and saves the binding. An identical config returns the same `triggerId`, so local triggers can share one. |
| `PATCH /v1/triggers/:triggerId` `{enabled}` | installation token | Enables or disables the instance at Composio (only disabled once no other binding wants it). A config change is a new `POST` plus a `DELETE` of the old instance. |
| `DELETE /v1/triggers/:triggerId` | installation token | Removes the binding, its queued events and drop counts, and the Composio instance once nothing else binds it. Also deletes an unbound instance of this installation's Composio user. |
| `GET /v1/triggers` | installation token | Bindings beside Composio's view (`remote.state`: `enabled`, `disabled` or `missing`), `unbound` instances, drop counts per trigger, limits and today's usage: everything the server's reconciliation needs. |
| `GET /v1/events?after=<seq>&wait=<0-25>&limit=<1-50>` + header `x-omb-poller` | installation token | Acks every event at or below `after`, then returns the next events in arrival order, holding up to `wait` seconds. One poller at a time per installation: another `x-omb-poller` gets 409 until the 90 s lease runs out. |
| `POST /v1/events/test` `{triggerId, data}` | installation token | Queues a synthetic event (`type: "omb.test"`) through the same queue and limits. |
| `PUT /v1/installation/cloud` `{grant}` | installation token | Marks the installation as a paid Cloud's from an Admin-signed grant. |
| `POST /v1/installation/share` `{for}` | installation token | A one-time code (10 minutes, only its hash kept) that lets the installation `for` act as this installation's Composio user. An installation acting as a MausBot account's user (a bound phone, or a Cloud that adopted it) shares only with a paid Cloud's installation: any other gets 403 `cloud_only`. |
| `POST /v1/installation/adopt` `{code}` | installation token | Redeems a code minted for this installation: from then on it acts as that Composio user (`shared_user_id`). Refused with 409 `has_connections` while it has active connected accounts of its own, which stay reachable. An installation bound to a MausBot account gets 409 `account_bound` before the code is read, so the code stays valid; once the code is looked up it is spent, whatever the answer. A code that shares a deleted MausBot account's user gets 404. |
| `PUT /v1/installation/account` `{grant}` | installation token | Binds a phone's installation to a MausBot account from an Admin-signed grant. See "Phones signed in to a MausBot account". |
| `DELETE /v1/installation` | installation token | The installation ends itself (a phone signing out): 200 `{ended: true}`, and its token is refused from then on. A repeat answers the same, and it works after the account grant ran out. The account's sign-ins and other phones are untouched. |
| `POST /v1/accounts/revoke` `{accountId}` | Admin signature (`CLOUD_GRANT_SECRET`) | Stops a deleted MausBot account everywhere and deletes its sign-ins. See "Phones signed in to a MausBot account". |
| `GET /v1/stats/app-events?days=<1-90>` | `Bearer STATS_TOKEN` | Fleet totals per day (queued, delivered, duplicates, drops, expired, unrouted) and current counts. Counts only, never event contents or installation ids. |
| cron `23 * * * *` | | Expires events not collected within 7 days, disables at Composio the triggers of installations that have not polled for 14 days (re-enabled on their next poll), keeps daily counts for 90 days, and finishes deleting revoked accounts' sign-ins. At most 40 + 8 Composio requests a run, within the free plan's 50 subrequests. |

### One person's desktop and Cloud

Composio ties every connected account to one user, and a tool router Session
uses only its own user's accounts, so a person's desktop and their own Cloud
share connected apps by acting as one Composio user. The desktop app mints a
code for the Cloud's installation id, which the Cloud reports to the app over
its owner session (the Admin verified that Cloud as the person's); the Cloud's
server redeems it. A code works only for the installation it names, once,
within 10 minutes. Sessions, the connected inventory, triggers and the event
routing all follow the installation's acting user; an instance one sharing
installation binds is never listed as unbound to the other. `GET /v1/me` adds
`user`, a digest of the acting user, equal on two installations exactly when
they reach the same apps.

Deploy order: apply `0004_shared_users.sql` first (additive), then the code.
Every query reads `installations.*`, so the new code also runs on a database
without it: `GET /v1/me` then carries no `user`, so no desktop tries to share,
and sharing answers 503 until it is applied.

### Limits

| | Desktop | Paid Cloud |
| --- | --- | --- |
| Events queued per UTC day | 500 | 2,000 |
| Waiting in the queue | 1,000 events or 20 MB | same |
| Event `data` stored | 64 KB, then a truncation marker with a preview | same |
| Kept when not collected | 7 days | same |

A phone bound to a MausBot account gets the Desktop limits.

An event over a limit is answered 200 to Composio, not queued, and counted on
its trigger (`event_drops`, shown by `GET /v1/triggers`) and in the daily
counts. Status events (`composio.trigger.disabled`,
`composio.connected_account.expired`) skip the limits and carry ids only.

### Paid Clouds

Registration is open, so a Cloud proves its plan with a grant the Cloud Admin
signs. The grant is `v1.<machine id>.<signature>`, where the signature is
`base64url(HMAC-SHA256(CLOUD_GRANT_SECRET, "omb-connected-apps-cloud:v1\n" + machineId))`:

```js
import { createHmac } from "node:crypto";
const grant = `v1.${machineId}.${createHmac("sha256", CLOUD_GRANT_SECRET).update(`omb-connected-apps-cloud:v1\n${machineId}`).digest("base64url")}`;
```

The Admin sets it as the machine's `OMB_CLOUD_CONNECTED_APPS_GRANT` secret
for paid plans only. The Cloud's server presents it after registering
(`server/cloud-connected-apps.ts`). One machine id holds the Cloud limit on one
installation at a time: presenting the grant again moves it.

### Phones signed in to a MausBot account

A phone signed in to a MausBot account reaches that account's connected apps:
every installation bound to the account acts as the Composio user
`omb_acct_<account id>`, so all the account's phones see the same apps. The
Cloud Admin mints a grant for the account's phone, never for a desktop, and the
phone presents it with `PUT /v1/installation/account {grant}`. The grant is
`v1.acct.<account id>.<installation id>.<exp, unix seconds>.<signature>`:

```js
import { createHmac } from "node:crypto";
const message = `omb-connected-apps-account:v1\n${accountId}\n${installationId}\n${exp}`;
const grant = `v1.acct.${accountId}.${installationId}.${exp}.${createHmac("sha256", CLOUD_GRANT_SECRET).update(message).digest("base64url")}`;
```

| Answer | When |
| --- | --- |
| 200 `{accountUntil, appLimit, user}` | Bound until `exp`. |
| 403 `invalid_grant` | A bad signature or body, a grant for another installation, or an `exp` in the past or more than 24 h + 300 s ahead. |
| 403 `account_revoked` | The account was deleted, even if the grant was minted before. |
| 409 `account_mismatch` | The installation is bound to another account; nothing changes. |
| 503 `unsupported` | No `CLOUD_GRANT_SECRET`, or no migration 0006. |

- **24-hour lease.** The Admin mints grants for 24 hours. Once `exp` passes,
  every route but `GET /v1/me`, `PUT /v1/installation/account` and
  `DELETE /v1/installation` answers 401 `grant_expired` until the phone
  presents a fresh grant. Every bind clears the
  stored Session, so the next call creates a fresh one; an MCP client holding
  the old `mcp-session-id` gets one 404 and initializes again.
- **Three apps.** A free account connects up to 3 apps across all its phones.
  `POST /v1/connectors/:slug/authorize` counts the account's active apps plus
  the apps it opened a sign-in link for in the last 15 minutes
  (`account_links`), so links opened at once can't pass the allowance. A new
  app past that is 402 `{error, code: "app_limit", limit: 3, apps}`, where
  `apps` includes the pending ones. Another sign-in to an app the account has
  or has just opened stays allowed. When Composio can't list the account's
  apps, the answer is 502 `provider_error` and no link is minted.
- **300 tool calls a day.** Each `tools/call` message in a `/v1/mcp` body
  (every one in a batch) counts against the account's UTC day, across its
  phones. Past the cap the answer is 429 `daily_limit` and nothing is
  forwarded. A bound phone's MCP body that isn't JSON is 400
  `invalid_request`, since Composio could read it as an uncounted call. The
  var `ACCOUNT_DAILY_TOOL_CALLS` changes the cap (default 300). Desktops and
  Clouds are never counted.
- **Fixed callback.** A bound phone's hosted sign-in always returns to
  `openmausbot://connected-apps/done`, whatever callback the caller sends; a
  desktop's link has none. Composio adds `status` and `connected_account_id`,
  which are no proof: the phone confirms with its own status call.
- **No connection management.** A bound phone's Sessions are created with
  `manage_connections: {enable: false}`, so a bot can't connect apps through
  Composio's own tool, past the allowance.
- **The person's Cloud.** A bound phone, and a Cloud that adopted the
  account's user, share the account's apps only with an installation that
  presented a paid Cloud grant (403 `cloud_only` otherwise), which brings its
  own allowance. A bound installation never adopts another user (409
  `account_bound`).

#### Revoking a deleted account

When the Admin deletes a MausBot account, it calls:

```
POST /v1/accounts/revoke
content-type: application/json
x-omb-revoke-timestamp: <unix seconds>
x-omb-revoke-signature: v1=<base64url(HMAC-SHA256(CLOUD_GRANT_SECRET, "omb-connected-apps-revoke:v1\n" + timestamp + "\n" + accountId))>

{"accountId":"<account id>"}
```

The broker answers 202 `{revoked: true, installations: <installations
disabled now>}`, 401 `unauthorized` for a missing or bad signature, a timestamp
more than 300 s off or a bad body, and 503 `unsupported` without
`CLOUD_GRANT_SECRET`. A replay within the 300 s repeats the same revoke, which
changes nothing more.

In one transaction it records the account in `revoked_accounts`, deletes the
queued events, trigger bindings, drop counts and share codes of every
installation acting as the account's user, and disables those installations:
the bound phones, and any installation that adopted the account's user through
a share code. Their next call gets 401, and a grant minted before the deletion
gets 403 `account_revoked`. The bind and the adopt are each one conditional
`UPDATE` that checks `revoked_accounts`, so a bind or an adopt of the
account's user racing the revoke either lands first and is disabled by it, or
lands after and is refused (403 `account_revoked`, or 404 for the adopt).

After answering, and then on every hourly run, the broker deletes the
account's sign-ins at Composio (`DELETE /connected_accounts/{id}?revoke_on_delete=true`),
4 accounts and 8 requests a run, until a listing comes back empty
(`cleared_at`). It deletes only listed items whose `user_id` is the
account's user: should Composio ever ignore the `user_ids` filter, another
person's sign-ins are skipped, the account stays uncleared, and each run
logs `{message: "revoked account cleanup skipped another user's sign-ins",
skipped}` with a count and no ids. Each run takes the accounts it tried longest ago first
(`attempted_at`), so an account that keeps failing goes to the back. A Composio outage never holds up the revoke itself: a
failure is logged as `{message: "revoked account cleanup failed", accountId,
status}` and retried on the next run.

### Waking a sleeping Cloud

A Cloud on a plan that sleeps when idle collects its events only while it is
awake. When an event is queued (not dropped, not a duplicate) for an
installation that has a `cloud_machine_id` and is not polling (its poll lease
is unset or has run out), the broker asks the Cloud Admin to start that
machine, at most once a minute per installation (`wake_requested_at`):

```
POST <CLOUD_ADMIN_URL>/api/cloud/machines/wake
content-type: application/json
x-omb-wake-timestamp: <unix seconds>
x-omb-wake-signature: v1=<base64url(HMAC-SHA256(CLOUD_GRANT_SECRET, "omb-cloud-wake:v1\n" + timestamp + "\n" + machineId))>

{"machineId":"<machine id>"}
```

The Admin accepts a timestamp within 300 s, each signature once, and answers
`202 {waking}`. The request runs after Composio has been answered
(`ctx.waitUntil`); a refusal or failure is logged without the key and never
fails the event. It is off unless both `CLOUD_GRANT_SECRET` and
`CLOUD_ADMIN_URL` (an `https://` origin) are set, so a deploy without them
changes nothing.

### One-time owner setup, in this order

1. Apply the migration before deploying the code (the old code ignores the
   new tables and columns):
   `pnpm exec wrangler d1 migrations apply openmausbot-composio --remote --config cloudflare/composio-broker/wrangler.jsonc`
2. Deploy as usual (`wrangler versions upload --preview-alias <name>`, check,
   then `wrangler versions deploy`). Until step 4 the webhook route answers
   503 and no client calls the new routes.
3. Create the project's webhook subscription. Composio allows one per
   project; check that there is none, then create it and copy the returned
   `secret`:

   ```sh
   curl -sS https://backend.composio.dev/api/v3.1/webhook_subscriptions -H "x-api-key: $COMPOSIO_API_KEY"
   curl -sS -X POST https://backend.composio.dev/api/v3.1/webhook_subscriptions \
     -H "x-api-key: $COMPOSIO_API_KEY" -H "content-type: application/json" \
     -d '{"webhook_url":"https://openmausbot-composio.milindsoni201.workers.dev/v1/composio/webhook","enabled_events":["composio.trigger.message","composio.trigger.disabled","composio.connected_account.expired"],"version":"V3"}'
   ```

   If Composio refuses `composio.trigger.disabled`, leave it out: the server's
   reconciliation still sees a disabled trigger through `GET /v1/triggers`.
4. `pnpm exec wrangler secret put COMPOSIO_WEBHOOK_SECRET --config cloudflare/composio-broker/wrangler.jsonc`
   with that secret.
5. Optional, each with `wrangler secret put` and a fresh random value
   (`openssl rand -base64 32`): `CLOUD_GRANT_SECRET` (shared with the Cloud
   Admin, which mints the grants) and `STATS_TOKEN` (given to Admin for the
   fleet counter). Without them, `PUT /v1/installation/cloud` answers 503 and
   the stats route 404.
6. Waking sleeping Clouds (at launch of a plan that sleeps): apply migration
   `0003_cloud_wake.sql` (step 1) before deploying the code that uses it, then
   set `CLOUD_ADMIN_URL` to the Cloud Admin's origin
   (`https://cloud.openmausbot.com`). Either add it to `vars` in
   `wrangler.jsonc` in a PR, or `wrangler secret put CLOUD_ADMIN_URL`: a
   deploy replaces variables set in the dashboard, but keeps secrets. Without
   it (or without `CLOUD_GRANT_SECRET`) the broker never asks the Admin to wake
   anything.
7. Idle sweep progress: apply migration `0005_trigger_sweep_progress.sql`
   (step 1) before the code that uses it reaches `main`, because CI deploys
   every push to `main`. Without it, the hourly sweep of idle installations
   fails after it has expired old events.
8. Phones signed in to a MausBot account: apply
   `0006_account_installations.sql` and `0007_account_limits.sql` (step 1)
   before merging, because CI deploys every push to `main`. Without 0006,
   unbound installations keep working, and binding and revoking answer 503;
   without 0007, a bound phone's tool calls and sign-ins answer 503. Deploy
   the binding and the allowance together, never the binding alone: a phone
   bound without the allowance would get Sessions with connection management
   on. Without `CLOUD_GRANT_SECRET` (step 5), both
   `PUT /v1/installation/account` and `POST /v1/accounts/revoke` answer 503
   `unsupported`. Optionally set the var `ACCOUNT_DAILY_TOOL_CALLS` (default
   300) in `wrangler.jsonc`. To check that this code is live (an unsigned
   `POST /v1/accounts/revoke` can't tell: an older broker answers it 401
   too), run `pnpm exec wrangler deployments list --config cloudflare/composio-broker/wrangler.jsonc`,
   or register a throwaway installation and send `PUT /v1/installation/account`
   with `{}` and its token: 403 `invalid_grant` is this code, 503 is this
   code without `CLOUD_GRANT_SECRET` or 0006, and 404 is older code; then end
   it with `DELETE /v1/installation`. Rolling back past this code removes the
   phone limits (bound phones keep their account's user with no lease,
   allowance, daily cap or connection-management lock) and every revoke
   answers 401, so the Admin refuses deletions of accounts that had grants:
   unset `OMB_COMPOSIO_BROKER_URL` on the Admin first.
