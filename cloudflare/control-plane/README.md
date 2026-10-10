# OpenMausBot control plane

This directory is an isolated Cloudflare Worker for cloud account identity,
installation ownership, and per-installation managed companion endpoints. It
does **not** store or move local bots, chats, desktop SQLite state, prompts, or
tool output.

## What is included

- Better Auth 1.7.1 with email OTP, signed bearer sessions, hashed OTP storage,
  and D1-backed IP plus recipient rate limits.
- A Cloudflare Email Sending binding that produces both HTML and plain-text OTP
  messages. Authentication responses remain generic even when delivery fails;
  email addresses, OTPs, secrets, and provider errors are never logged.
- Owner-scoped desktop installations and independently revocable
  `omb_install_…` credentials. Account bearer tokens are never accepted as
  installation credentials, or vice versa.
- Exact-origin CORS, bounded JSON bodies, redacted errors, and `no-store` on
  every response.
- One remotely managed Cloudflare Tunnel per installation. Its opaque public
  hostname routes to the Electron-owned gateway at `http://127.0.0.1:8812`
  (never the reusable LAN listener on `8810`) and is followed by a mandatory
  `http_status:404` catch-all. A proxied CNAME points to
  `<tunnel-id>.cfargotunnel.com`.
- D1-backed generation/lease claims, recovery by stable opaque tunnel name, and
  retryable partial cleanup. Cloudflare API credentials and raw connector
  tokens are never written to D1 or logs.
- Endpoints in one or more Cloudflare accounts (see **Several Cloudflare
  accounts**). A new endpoint goes to the account with the most room; every
  endpoint stays in the account it was created in for its whole life.

The D1 schema is pinned in `migrations/`. `0001_better_auth_1_7_1.sql` was
generated from the exact Better Auth configuration. `0002_installations.sql`
contains only cloud ownership and credential metadata. `0003` adds a
recipient-scoped OTP limiter whose keys are HMACs rather than email addresses,
plus an authenticated installation-creation limiter. `0004` adds managed
endpoint resource IDs, lifecycle state, generation leases, redacted error
codes, and installation-scoped action limits. `0005` adds the cleanup-attempt
counter used for scheduled retry backoff. `0006` adds the idle-reclaim marker
and a one-row capacity snapshot (counts and timestamps only), and gives rows
an operator had already moved to `deleting` for active installations the same
reconnect guard as automatic reclaims. `0007` ties every endpoint row to the
Cloudflare account that holds it (`provider_account`, an account ID whose
default is the account every earlier row lives in, so rows written before it,
or by a Worker deployed before it, keep their account) and moves capacity
state to one row per account (`managed_endpoint_account_capacity`, seeded from
the `0006` row, which stays but is no longer written). Endpoint rows
deliberately do not cascade away with a hard installation deletion: losing the
tunnel and DNS IDs would make operator cleanup impossible.

## API surface

| Method | Path | Authentication |
| --- | --- | --- |
| `GET` | `/healthz` | none |
| any | `/api/auth/*` | Better Auth |
| `GET` | `/v1/me` | account bearer |
| `GET`, `POST` | `/v1/installations` | account bearer |
| `POST` | `/v1/installations/:id/credentials/rotate` | owning account bearer |
| `DELETE` | `/v1/installations/:id` | owning account bearer |
| `GET` | `/v1/installations/self` | installation credential |
| `GET`, `POST`, `DELETE` | `/v1/installations/self/endpoint` | installation credential |

Installation registration requires a stable `clientInstanceId`, a display
`name`, and a `platform` of `darwin`, `windows`, or `linux`; `appVersion` is
optional. A client ID is unique among one account's active installations. After
revocation, that account may register the stable ID again. Other accounts may
independently use the same client ID. An account may have at most 100 active
installations, matching the complete management-list limit. Creation is also
limited to 100 attempts per account per hour.

Raw installation credentials contain a random lookup ID plus 32 random bytes.
Only a SHA-256 digest is stored, and the raw value is returned only when an
installation is created or its credential is rotated. Credentials expire after
90 days even if they are not revoked; the response includes their expiry so a
signed-in desktop can rotate ahead of time. `/v1/installations/self` rejects
expired credentials and records both credential use and installation
`lastSeenAt`. Rotations are serialized with a one-minute cooldown, so concurrent
requests cannot both return credentials while one invalidates the other.

### Managed endpoint contract

All three endpoint methods require `Authorization: Bearer <omb_install_…>`.
Account bearer tokens are rejected.

- `GET` returns `{ "endpoint": null }` before allocation or after deletion.
  Otherwise it returns the HTTPS URL, hostname, lifecycle status, generation,
  timestamps, and a redacted `lastErrorCode`. It never returns a connector
  token.
- `POST` has no required body. An app may send `{ "appVersion": "0.1.104" }`
  (`application/json`, printable, at most 64 characters): the release it runs,
  which is recorded on the installation and decides which accounts may hold a
  new endpoint (see **Several Cloudflare accounts**). No body behaves exactly
  as before; any other member, or a malformed body, is `400 invalid_request`,
  and a body that is not JSON is `415 unsupported_media_type`. It
  idempotently reserves or reconciles the endpoint, adopts a tunnel/DNS record
  created by an interrupted earlier run, and returns
  `{ endpoint, connectorToken }`. The raw token is obtained only
  after tunnel configuration and DNS are ready. The caller must place it
  directly in the operating system's secure credential store; it is not
  recoverable from GET or D1. After an idle reclaim the same call allocates a
  new tunnel behind the **same hostname**, so a paired phone keeps its
  address; it may also take back an endpoint whose reclaim is still pending.
  The desktop app (Remote access on) and `openmausbot serve --tunnel` ask
  `GET` every 15 minutes, even while their connector reports ready, and make
  this call when the endpoint is gone or in `error`; a `401` from `GET` (the
  90-day installation credential expired) sends them through account
  recovery, or to a "sign-in expired" prompt.
- When Cloudflare's tunnel quota (`1045`) or the zone's DNS record quota
  (`81045`) refuses an allocation, `POST` returns
  `503 endpoint_capacity` with `Retry-After: 600`. A full account can also
  answer tunnel creation with `429`: the control plane then reads the
  account's tunnel count (or, when that read fails, its last scan if under 30
  minutes old, less the tunnels scheduled cleanup has deleted since) and, at
  or over the account's tunnel limit, treats the `429` as the quota
  (`cf_tunnel_quota`). For the next ten minutes (or until scheduled
  cleanup frees one of its resources) further allocations in that account
  that would need a new tunnel are answered the same way without calling
  Cloudflare, protecting the shared API budget. An endpoint that never
  handed out an address moves to another configured account with room
  instead, in the same request (see **Several Cloudflare accounts**). Any
  other `429` from Cloudflare's API
  rate limit (`cf_rate_limited`) returns `503 endpoint_rate_limited` with
  Cloudflare's `Retry-After` clamped to 30–300 seconds (60 when Cloudflare
  sent none) and closes nothing. Every other provider failure remains
  `502 endpoint_unavailable`; with several accounts, one where Cloudflare
  refused the account's token also closes that account (see **A refused
  token**).
- `DELETE` removes DNS first and then the tunnel. It returns `204` when done or
  when already deleted. A partial Cloudflare failure returns
  `503 endpoint_cleanup_pending` and retains only the IDs needed for a retry.
  A concurrent mutation returns `409 endpoint_busy` with `Retry-After: 2`.

Hostnames have exactly one opaque label in front of the suffix of the account
that holds the endpoint: `c-<32-lowercase-hex>.<COMPANION_HOST_SUFFIX>` in the
primary account. Set the suffix to a zone name covered by the zone's edge
certificate (normally the zone apex) so the endpoint does not depend on
deep-subdomain TLS coverage. Tunnel names are stable opaque identifiers and
contain no account email, display name, or client-supplied ID.

Endpoint provisioning is limited to 20 attempts per installation per hour;
deletion is limited to 30. A 60-second D1 lease and monotonically increasing
generation serialize concurrent requests. The owner renews and fences that
lease before every provider call, so an expired request cannot roll back a
resource adopted by its successor. Cloudflare calls have a five-second
per-request timeout, reject redirects, bound response bodies, and validate the
response shape before persisting an ID. Ambiguous create/update responses are
reconciled by the stable tunnel name and exact DNS identity. Before any
destructive cleanup, both stored IDs and provider-side names/targets are
revalidated; a renamed or repurposed resource is retained for an operator
instead of being guessed at. A newly created partial resource is rolled back;
an adopted resource is never deleted by a failed reconciliation.

Revoking an installation first revokes its local installation credentials, then
schedules best-effort endpoint cleanup. Cloud cleanup failure cannot restore or
delay credential revocation. Repeating the owner-scoped installation DELETE is
safe and retries retained cleanup state. A five-minute cron also processes at
most `OMB_CLEANUP_SWEEP_LIMIT` (code default 20, which `wrangler.jsonc` ships;
it needs Workers Paid, whose per-invocation subrequest and D1 limits the
default relies on) expired-lease rows per run when
they are already deleting, belong to a revoked installation, or outlive a
hard-deleted installation. Each row is cleaned in its own account, and rows
no configured account acts on (see **Several Cloudflare accounts**) are
skipped. Rows run five at a time (the Workers limit is six connections
awaiting headers), and a run stops
starting new rows in an account as soon as that account's API answers `429`.
At ten provider calls per row the default is about
200 calls per run: a sixth of the API token's 1,200 requests per five minutes,
and far below the Workers Paid limit of 10,000 subrequests per invocation. On
Workers Free (50 subrequests per invocation) set the limit to 4. Failed
scheduled cleanups back off from five minutes through 15 minutes, one hour,
six hours, and then 24 hours. Once a deletion has been pending for 24 hours,
each eligible sweep emits a distinct aggregate operator-attention log without
installation or account identifiers. This bounded sweep prevents a transient
provider failure from orphaning resources forever without creating an
unbounded scheduled invocation.

### Tunnel capacity and idle reclaim

Cloudflare limits an account to 1,000 tunnels by default and a zone to a fixed
number of DNS records. Each run of the same cron also performs one bounded
capacity step per configured account, in configuration order, before cleanup.
A failure in one account is logged and never stops the others:

1. It reads one page of 100 undeleted tunnels for the whole account (the
   account's page cursor walks and wraps across runs) and the zone's DNS
   record count. The tunnel page's total is the account-wide usage.
2. It reclaims idle tunnels by moving their endpoint rows to `deleting` with
   `reclaim_requested_at`, at most 20 per run across all accounts. It never
   deletes anything itself; cleanup does, through the same ownership-verified
   path as an owner's DELETE. A tunnel is idle only when Cloudflare reports it
   - `inactive` (never ran), with no activation time, created at least seven
     days ago; or
   - `down` with its last connection ended at least
     `OMB_TUNNEL_OFFLINE_RECLAIM_DAYS` (default 21, minimum 7) days ago and no
     later activation.

   `healthy` and `degraded` tunnels, any reported connection, an unknown
   status, and any unparseable timestamp are never idle. The D1 side must also
   be quiet for the same period: the installation is active (not revoked) and
   has not called the control plane, the endpoint row belongs to this account
   and has not been reconciled or updated, the stored tunnel ID still names
   the listed tunnel, and no request holds the row's lease. Those guards live
   in the marking SQL itself, so a check-in that races the scan wins. Tunnels
   with no endpoint row in that account are only counted (`unmatched`), never
   touched.
3. Before each destructive call of a reclaim, cleanup re-reads the tunnel
   from Cloudflare. If it has reconnected, or the installation checked in after
   the mark, the reclaim is cancelled and the row returns to `ready` (or to a
   retryable `error` when its DNS record was already removed). An owner's
   DELETE or revocation clears the reclaim marker and always deletes.
4. It writes the account's capacity snapshot (counts, timestamps, pending
   reclaims, and dormant endpoints: those of active installations whose tunnel
   is gone) and logs one `managed endpoint tunnel scan` summary with the
   account's `hostSuffix`. Until the next scan, scheduled cleanup lowers the
   snapshot's tunnel and DNS record counts by what it deletes, so a slot it
   freed is not counted as used. When usage reaches 90% of the account's
   tunnel or DNS record limit it emits `console.error` with
   `"alert": "managed_endpoint_capacity"`, the `hostSuffix`, resource, used,
   limit, and percentage. Create a Workers Logs alert on that field. With more
   than one account, a run whose pool status (below) is `high` or `full` also
   emits `"alert": "managed_endpoint_pool_capacity"`: once an account fills it
   reports `full` for good, so page on the pool alert instead.

`OMB_TUNNEL_RECLAIM` is `observe` unless set to `on` (an unset or invalid value
observes): it logs `idle`/`eligible` counts without marking anything. Deploy in
`observe`, check one full scan cycle of real counts, then set it to `on`.

`OMB_TUNNEL_LIMIT` and `OMB_DNS_RECORD_LIMIT` (default 1000 each) are the
primary account's tunnel quota and its zone's DNS record quota; extra accounts
carry their own. The limits drive the alerts and `/healthz`, rank accounts for
new endpoints, and decide whether a tunnel-creation `429` is the quota. They
never refuse an allocation on their own: only Cloudflare does. Keep them equal
to Cloudflare's real quotas and raise them when Cloudflare raises a quota (a
limit below the real quota turns a genuine rate limit at that count into a
ten-minute capacity gate for that account).

`GET /healthz` keeps `ok` and `service` unchanged (desktops gate hosted sign-in
on them; a full quota must not hide sign-in or recovery) and adds a
`capacity` object with no identifiers or secrets. With one account it is that
account's snapshot:

```json
{
  "status": "ok | high | full | unknown",
  "checkedAt": 1790000000000,
  "tunnels": { "used": 950, "limit": 1000 },
  "dnsRecords": { "used": 960, "limit": 1000 },
  "providerRejectedAt": null,
  "reclaim": { "mode": "on", "pending": 12 }
}
```

`status` is `full` while a recent quota rejection (with several accounts,
also a refused token) is gating allocations, `unknown` when the snapshot is
more than 30 minutes old. With more than one account the same fields describe
the pool a new installation sees (the accounts that take new endpoints), and
`accounts` lists every account by its host suffix (never by account or zone
ID):

```json
{
  "status": "ok",
  "checkedAt": 1790000000000,
  "tunnels": { "used": 1010, "limit": 2000 },
  "dnsRecords": { "used": 412, "limit": 1200 },
  "providerRejectedAt": null,
  "reclaim": { "mode": "on", "pending": 12 },
  "accounts": [
    {
      "hostSuffix": "openmausbot.com",
      "newEndpoints": true,
      "status": "full",
      "checkedAt": 1790000060000,
      "tunnels": { "used": 1000, "limit": 1000 },
      "dnsRecords": { "used": 400, "limit": 1000 },
      "providerRejectedAt": 1790000030000,
      "reclaimPending": 12
    },
    {
      "hostSuffix": "mausbot.si",
      "newEndpoints": true,
      "status": "ok",
      "checkedAt": 1790000000000,
      "tunnels": { "used": 10, "limit": 1000 },
      "dnsRecords": { "used": 12, "limit": 200 },
      "providerRejectedAt": null,
      "reclaimPending": 0
    }
  ]
}
```

The pool is every account whose `newEndpoints` is not `false`; the primary
always counts. Its `status` is the best known status among them (`ok`, then
`high`, then `full`; an account refusing allocations counts as `full`).
`used` is their sum, or `null` when any of their snapshots is unknown or
stale; `limit` and `reclaim.pending` are sums; `checkedAt` is the oldest
scan; and `providerRejectedAt` is set only while every one of them is
refusing. The pool assumes the newest release, so an account's
`minAppVersion` does not take it out: installations on older releases are
refused there by design (see **Why `minAppVersion`**), and the pool alert does
not page for them. Monitors that read the top-level numbers should read
`accounts` once a second account is configured. Each Cloudflare data center
reuses one read of the snapshots for up to two minutes, so `capacity` can
trail D1 by that long; allocation gating always reads D1.

### Several Cloudflare accounts

The account configured by `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`,
`COMPANION_HOST_SUFFIX`, the `CLOUDFLARE_API_TOKEN` secret, `OMB_TUNNEL_LIMIT`,
and `OMB_DNS_RECORD_LIMIT` is the primary. Without `CLOUDFLARE_ENDPOINT_ACCOUNTS`
it is the only account, and endpoints behave exactly as described above.

`CLOUDFLARE_ENDPOINT_ACCOUNTS` adds up to three more accounts. It is a JSON
array, set either as a `wrangler.jsonc` JSON var (see the commented example
there) or as a secret holding the same JSON
(`wrangler secret put CLOUDFLARE_ENDPOINT_ACCOUNTS`) to keep the IDs out of the
repository:

```json
[
  {
    "accountId": "<32-hex Cloudflare account ID>",
    "zoneId": "<32-hex zone ID of mausbot.si in that account>",
    "companionHostSuffix": "mausbot.si",
    "apiTokenSecret": "CLOUDFLARE_API_TOKEN_MAUSBOT_SI",
    "tunnelLimit": 1000,
    "dnsRecordLimit": 200,
    "minAppVersion": "0.1.104"
  }
]
```

| Field | Meaning |
| --- | --- |
| `accountId` | The account that holds the tunnels. |
| `zoneId` | The zone of `companionHostSuffix` in that account; it holds the proxied CNAMEs. |
| `companionHostSuffix` | The zone apex. Hostnames are `c-<32 hex>.<suffix>`: Universal SSL covers first-level names only. |
| `apiTokenSecret` | The name of the Worker secret holding this account's API token: `CLOUDFLARE_API_TOKEN` (one token for both accounts) or `CLOUDFLARE_API_TOKEN_<NAME>` in uppercase letters, digits, and underscores. Any other name is refused, so a typo can never send another secret to Cloudflare. |
| `tunnelLimit` | The account's tunnel quota. Default 1000. |
| `dnsRecordLimit` | The zone's DNS record quota. Default 1000. |
| `minAppVersion` | Optional `x.y.z`. Only installations that report at least this release get a new endpoint in this account. |
| `newEndpoints` | Optional, default `true`. `false` closes the account to new endpoints and keeps the ones it holds working. |

Account IDs, zone IDs, and suffixes must each be unique across all accounts,
including the primary. An invalid entry never takes the Worker down: it is
ignored, and every cron run logs `"alert": "managed_endpoint_account_config"`
with redacted issue codes such as `entry_1_token` or `entry_2_duplicate`
(never values) until it is fixed. A bad primary configuration still fails as
before.

**An endpoint never changes account.** Every endpoint row records the ID of
its account (`provider_account`). Renewal, re-provisioning after an idle
reclaim (same hostname, new tunnel), owner DELETE, revocation cleanup, the
sweep, and the idle scan all act in that account, with that account's token,
and nowhere else. An endpoint whose account is not configured, or whose
hostname is not exactly one opaque label under that account's suffix, is
never acted on: `POST` answers `502 endpoint_unavailable` without calling
Cloudflare, `DELETE` and revocation keep the row with `503
endpoint_cleanup_pending`, the idle scan never matches its tunnel, the sweep
skips it, and each cron run logs their number with
`"alert": "managed_endpoint_account_unconfigured"`. So:

- Never edit an entry's `accountId`, `zoneId`, or `companionHostSuffix` once it
  holds endpoints. To use another domain or account, add a new entry.
- Removing an entry strands its endpoints until the same entry is added back.
  To stop new endpoints going to an account while keeping its existing ones,
  set its `"newEndpoints": false`: its endpoints keep renewing,
  re-provisioning after a reclaim, and cleaning up there, no new endpoint and
  no moving row is given to it, and it leaves the pool that `/healthz` and
  the pool alert describe.
- Do not roll the Worker back to a version from before migration `0007` once
  an extra account holds endpoints. An older Worker ignores
  `provider_account`: it would create tunnels for those rows in the primary
  account, and its cleanup would mark them deleted after a `404` there,
  leaving their real tunnel and DNS record behind.

**Choosing an account.** Only a new endpoint row chooses. It goes to the
eligible account with the most room, `min(tunnelLimit − tunnels,
dnsRecordLimit − DNS records) − dormant endpoints`, from that account's last
scan (an unknown DNS count is left out; an unknown tunnel count ranks last;
ties go to configuration order). The dormant endpoints are a slot set aside
for each address already handed out whose owner may come back. An account is
eligible when it takes new endpoints, its last scan is under 30 minutes old
(so a new account takes nothing before its first cron run), Cloudflare has
not refused it a resource, or its token, in the last ten minutes, and the
installation's version is at least its `minAppVersion`. Room only ranks:
when no account is eligible the primary is used, exactly as with one account.

A row that never handed out an address (no tunnel, no DNS record, never
ready) may move, at most once per request, to the best other eligible account
under a new hostname: before calling Cloudflare when its account is refusing
new tunnels, or right after its account refuses the tunnel. Its old account is
checked first; a tunnel or record that an interrupted earlier request left
there is adopted instead. Each move logs `managed endpoint relocated` with
both host suffixes. A row that was ever ready never moves: a reclaimed
endpoint waits for a slot in its own account and keeps its hostname, so a
paired phone keeps working.

**A refused token.** A read-only check cannot show that an account's token
may create tunnels and DNS records; the first new endpoint there does. With
several accounts, Cloudflare answering a request in an endpoint's account
with `401` or `403` (its token is invalid or revoked, or lacks Tunnel or DNS
Edit) closes that account to new endpoints for ten minutes, as a quota
refusal does: a row that never handed out an address moves to another
eligible account (in the same request when tunnel creation was refused,
otherwise on its next request), and the account's other endpoints that need a
new tunnel are answered `502 endpoint_unavailable` without calling
Cloudflare. Every such refusal, with one account too, logs
`"alert": "managed_endpoint_account_refused"` with the account's `hostSuffix`
and `errorCode`; only an operator can fix the token.

**Why `minAppVersion`.** Desktop releases up to 0.1.103 accept only
`openmausbot.com` names for **Remote computer → Desktop companion** pairing
(phones, pairing links, and Tailscale have no domain rule). The desktop app
accepts `mausbot.si` from the release that ships this change, and from the
same release it reports its version with every endpoint request; older apps
are judged by the version they registered with. Set `minAppVersion` to that
release so a computer on an older release keeps an address every desktop can
pair with. Leaving it out brings relief sooner, because computers on older
releases get an address in the new account at once; desktop-companion
pairing from an older desktop to those computers then fails (phones and
Tailscale still work).

**Adding an account.**

1. Ship an app release whose desktop-companion allow-list
   (`electron/desktop-companion-client.mjs`) includes the new domain.
2. Apply migration `0007` to the production database before deploying a
   Worker built from this code (an older Worker keeps working against it),
   and deploy with only the primary account first. `/healthz` is unchanged;
   a full account now answers `endpoint_capacity` instead of
   `endpoint_rate_limited`.
3. Add the domain to the other account as a zone and wait until it is active
   and its Universal SSL certificate is issued (check that CAA records allow
   Cloudflare's certificate authorities; the scan does not check TLS). Read
   the zone's real record quota with
   `GET zones/<zone id>/dns_records/usage` (`record_quota`): Free zones added
   since September 2024 allow 200 records, older Free zones 1,000, Pro and
   Business 3,500. Note the account's current tunnel count.
4. Create an API token limited to that account and that zone, with Account →
   Cloudflare Tunnel → Edit and Zone → DNS → Edit. Before relying on it, you
   can prove it may write: with the token, create a tunnel
   (`POST accounts/<account id>/cfd_tunnel` with
   `{"name": "omb-token-check", "config_src": "cloudflare"}`) and a TXT record
   in the zone, then delete both.
5. `wrangler secret put CLOUDFLARE_API_TOKEN_MAUSBOT_SI` (or the name you
   chose). Never put a token in `vars`, `.dev.vars.example`, logs, or CI output.
6. Set `CLOUDFLARE_ENDPOINT_ACCOUNTS` with `dnsRecordLimit` equal to the
   zone's real quota and `minAppVersion` as above. Add the token's secret name
   (and `CLOUDFLARE_ENDPOINT_ACCOUNTS`, when it is a secret) to
   `secrets.required` in `wrangler.jsonc`, then deploy. A deploy explicitly
   keeps only the secrets listed there, and refuses to run while one of them
   is missing, so a listed token can never be dropped or forgotten.
7. After the next cron run, `/healthz` lists the new suffix in
   `capacity.accounts` with a fresh `checkedAt` and both `tunnels.used` and
   `dnsRecords.used` filled in (a `null` DNS count means the token cannot read
   the zone: fix that before new endpoints fail there); new endpoints go there
   from then on. Watch for `managed endpoint relocated`,
   `managed endpoint DNS record count failed`,
   `managed_endpoint_account_config`, and `managed_endpoint_account_refused`
   in Workers Logs.
8. Page on `managed_endpoint_pool_capacity` instead of
   `managed_endpoint_capacity`, and on `managed_endpoint_account_refused`,
   `managed_endpoint_account_config`, and
   `managed_endpoint_account_unconfigured`.

Each account adds two Cloudflare reads to every cron run (a tunnel page and a
DNS count), and each move two lookups in the old account. Tokens created by
the same Cloudflare user share its 1,200 requests per five minutes. On
Workers Free, four accounts with `OMB_CLEANUP_SWEEP_LIMIT` 4 use the whole
50-subrequest budget, hence at most three extra accounts.

## Local checks

Install from the repository root, then run:

```sh
pnpm control-plane:check
pnpm control-plane:test
pnpm control-plane:dry-run
```

For local manual development, copy `.dev.vars.example` to `.dev.vars`, replace
`BETTER_AUTH_SECRET` with at least 32 cryptographically random bytes, provide a
non-production scoped `CLOUDFLARE_API_TOKEN`, apply the migrations locally, and
start Wrangler:

```sh
pnpm --filter @openmausbot/control-plane exec wrangler d1 migrations apply DB --local --config wrangler.jsonc
pnpm --filter @openmausbot/control-plane exec wrangler dev --config wrangler.jsonc
```

Do not commit `.dev.vars`. Because `wrangler.jsonc` declares
`secrets.required`, `wrangler dev` reads from `.dev.vars` only the names it
declares, so a second account cannot be configured there; the test suite
covers several accounts, and `.dev.vars.example` says how to try one by hand.

## Troubleshooting managed HTTPS setup

`endpoint_capacity` means Cloudflare refused a new tunnel or DNS record in
the endpoint's account: `cf_api_1045` (the tunnel quota), `cf_tunnel_quota`
(tunnel creation answered `429` while the account's tunnel count was at or
over its `tunnelLimit`, which is how Cloudflare refuses a full account), or
`cf_api_81045` (the zone's DNS record quota). See **Tunnel capacity and idle
reclaim**, **Several Cloudflare accounts**, and the `capacity` object in
`/healthz`. `endpoint_rate_limited` means Cloudflare's API rate limit (shared
by every request this Worker makes) pushed back; it clears on its own within
minutes. `endpoint_unavailable` is every other failure, including
`endpoint_account_unavailable` in the logs: the endpoint's account is not
configured, or its configuration entry was ignored (look for
`managed_endpoint_account_config`), and a token Cloudflare refused (look for
`managed_endpoint_account_refused`). All three come from authenticated
endpoint provisioning, before
the desktop starts its connector or a phone connects. A successful `/healthz`
response only validates Worker configuration; it does **not** check provider
capacity, API permissions, DNS writes, or tunnel creation. A reachable LAN
companion on port `8810` also does not prove managed HTTPS is ready.

1. Search Worker logs for the user's **Reference** UUID and
   `managed endpoint reconcile failed`. The structured `errorCode` is safe to
   inspect; never log API tokens, connector tokens, or raw provider responses.
   Historical log queries require Workers Observability access; a live tail
   cannot recover an older request. Do not claim an exact request was traced
   from aggregate database counts alone.
2. Check the scope of failures without exporting account or installation data:

   ```sh
   pnpm --filter @openmausbot/control-plane exec wrangler d1 execute DB --remote --command "SELECT provider_account, status, last_error_code, COUNT(*) AS endpoints FROM installation_endpoints GROUP BY provider_account, status, last_error_code"
   ```

3. Check **account-wide** undeleted tunnel usage in the endpoint's Cloudflare
   account, not just ready D1 rows. Cloudflare's [documented default limit is 1,000 tunnels per
   account](https://developers.cloudflare.com/cloudflare-one/account-limits/#cloudflare-tunnel).
   Pending allocations and tunnels belonging to other services also consume
   capacity. At the limit, request a capacity increase from Cloudflare or add
   an account (see **Several Cloudflare accounts**). A new desktop release
   cannot raise the provider's quota. Do not infer the meaning
   of an API error code from similarly numbered Cloudflare edge error pages.
   `GET /healthz` reports the last scanned usage.
4. Review already-requested deletion and revoked-installation cleanup. Do not
   delete a healthy installation's tunnel by hand, or infer abandonment from a
   disconnected connector: a sleeping laptop is normal. Idle reclaim already
   uses week-scale thresholds and re-checks the connection before deleting;
   search logs for `managed endpoint tunnel scan` and
   `managed endpoint cleanup sweep`.
5. After the service-side problem is resolved, the user can choose **Retry
   secure access** without signing out or reinstalling. The desktop retains
   the installation credential even when endpoint provisioning fails, avoiding
   unnecessary credential rotations and their one-minute cooldown. Endpoint
   retries remain limited to 20 per installation per hour.

While provisioning is unavailable, use **Advanced & troubleshooting → Pair on
this Wi-Fi** on a trusted reachable LAN, or the separate **Tailscale pairing**
option. These do not depend on managed endpoint provisioning. Do not change
phone VPN settings to diagnose a failure that happens before phone pairing.

The isolated HTTP recovery fixture exercises healthy service discovery,
failed endpoint setup, repeated retry, app restoration, and eventual recovery:

```sh
node --test electron/companion-provisioning.node-test.mjs
```

Run it from the repository root. It uses synthetic credentials and a loopback
server, never a real account, cloud tunnel, or the user's desktop data. It
verifies client recovery, not live Cloudflare availability or iPhone pairing.

## Production blockers

The checked-in Wrangler file is intentionally non-deployable production
scaffolding. No remote resource was created or changed while preparing it.
Before a production deployment, an operator must:

1. Choose and route an HTTPS hostname, then replace `BETTER_AUTH_URL`. The
   Worker has `workers_dev` disabled and no production route in this PR.
2. Generate a strong production `BETTER_AUTH_SECRET` and add it with Wrangler's
   interactive secret command. Add `CLOUDFLARE_API_TOKEN` the same way. The
   checked-in `secrets.required` names validate local configuration and generate
   binding types; they do not contain or upload values.
3. Create the D1 database, replace the all-zero `database_id`, review the pinned
   migrations, and apply them to that database.
4. Complete Cloudflare Email Sending domain onboarding, replace the placeholder
   sender in both `EMAIL_FROM` and `allowed_sender_addresses`, and grant the
   deployment identity access to the binding. The Cloudflare session used while
   preparing this code could not list Email Sending (`2036 Unauthorized`), so no
   domain or binding activation was attempted.
5. Create a least-privilege Cloudflare API token scoped to the selected account
   and zone. It needs a Cloudflare Tunnel/`cloudflared` connector **Write**
   permission plus DNS **Read** and **Write** for that zone. Set
   `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, and add the token through
   `wrangler secret put CLOUDFLARE_API_TOKEN`. Never put the token in `vars`,
   `.dev.vars.example`, logs, or CI output.
6. Set `COMPANION_HOST_SUFFIX` to the certificate-covered DNS suffix where
   opaque `c-*` records may be created. The configured zone must contain that
   suffix. This change does not create the zone, certificate, or any remote
   tunnel/DNS resources during build or tests. Further accounts are optional
   and added later (see **Several Cloudflare accounts**).
7. Replace `ALLOWED_ORIGINS` with a comma-separated allow-list of exact HTTPS
   application origins. Wildcards are deliberately unsupported.
8. Deploy the Worker and verify that `GET <BETTER_AUTH_URL>/healthz` returns
   `"ok": true` and `"service": "openmausbot-control-plane"` over HTTPS
   before shipping the desktop build. Electron probes this endpoint and
   keeps new hosted onboarding hidden until it is healthy; an already signed-in
   user remains visible so cleanup and recovery are not stranded.

The control-plane API token is never handed to a desktop. A desktop receives
only its tunnel connector token, which can run that one remotely managed tunnel.
The public companion service still enforces its own pairing and application
authentication; the tunnel is transport, not user authentication. This control
plane does not collect marketing consent.
