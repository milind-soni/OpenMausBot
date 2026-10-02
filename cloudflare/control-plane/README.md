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
reconnect guard as automatic reclaims. Endpoint rows deliberately do not
cascade away with a hard installation deletion: losing the tunnel and DNS IDs
would make operator cleanup impossible.

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
- `POST` has no required body. It idempotently reserves or reconciles the
  endpoint, adopts a tunnel/DNS record created by an interrupted earlier run,
  and returns `{ endpoint, connectorToken }`. The raw token is obtained only
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
  `503 endpoint_capacity` with `Retry-After: 600`. For the next ten minutes
  (or until scheduled cleanup frees a resource) further allocations that
  would need a new tunnel are answered the same way without calling
  Cloudflare, protecting the shared API budget. Every other provider failure
  remains `502 endpoint_unavailable`.
- `DELETE` removes DNS first and then the tunnel. It returns `204` when done or
  when already deleted. A partial Cloudflare failure returns
  `503 endpoint_cleanup_pending` and retains only the IDs needed for a retry.
  A concurrent mutation returns `409 endpoint_busy` with `Retry-After: 2`.

Hostnames have exactly one opaque label in front of the configured suffix:
`c-<32-lowercase-hex>.<COMPANION_HOST_SUFFIX>`. Set the suffix to a zone name
covered by the zone's edge certificate (normally the zone apex) so the endpoint
does not depend on deep-subdomain TLS coverage. Tunnel names are stable opaque
identifiers and contain no account email, display name, or client-supplied ID.

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
most `OMB_CLEANUP_SWEEP_LIMIT` (code default 20; `wrangler.jsonc` ships 4 until
the account is confirmed on Workers Paid, whose per-invocation subrequest and D1
limits the default needs) expired-lease rows per run when
they are already deleting, belong to a revoked installation, or outlive a
hard-deleted installation. Rows run five at a time (the Workers limit is six
connections awaiting headers), and a run stops starting new rows as soon as
Cloudflare answers `429`. At ten provider calls per row the default is about
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
capacity step before cleanup:

1. It reads one page of 100 undeleted tunnels for the whole account (the page
   cursor walks and wraps across runs) and the zone's DNS record count. The
   tunnel page's total is the account-wide usage.
2. It reclaims idle tunnels by moving their endpoint rows to `deleting` with
   `reclaim_requested_at`, at most 20 per run. It never deletes anything
   itself; cleanup does, through the same ownership-verified path as an
   owner's DELETE. A tunnel is idle only when Cloudflare reports it
   - `inactive` (never ran), with no activation time, created at least seven
     days ago; or
   - `down` with its last connection ended at least
     `OMB_TUNNEL_OFFLINE_RECLAIM_DAYS` (default 21, minimum 7) days ago and no
     later activation.

   `healthy` and `degraded` tunnels, any reported connection, an unknown
   status, and any unparseable timestamp are never idle. The D1 side must also
   be quiet for the same period: the installation is active (not revoked) and
   has not called the control plane, the endpoint row has not been reconciled
   or updated, the stored tunnel ID still names the listed tunnel, and no
   request holds the row's lease. Those guards live in the marking SQL itself,
   so a check-in that races the scan wins. Tunnels with no endpoint row are
   only counted (`unmatched`), never touched.
3. Before each destructive call of a reclaim, cleanup re-reads the tunnel
   from Cloudflare. If it has reconnected, or the installation checked in after
   the mark, the reclaim is cancelled and the row returns to `ready` (or to a
   retryable `error` when its DNS record was already removed). An owner's
   DELETE or revocation clears the reclaim marker and always deletes.
4. It writes the capacity snapshot and logs one `managed endpoint tunnel scan`
   summary. When usage reaches 90% of `OMB_TUNNEL_LIMIT` (default 1000) or
   `OMB_DNS_RECORD_LIMIT` (default 1000) it emits
   `console.error` with `"alert": "managed_endpoint_capacity"`, the resource,
   used, limit, and percentage. Create a Workers Logs alert on that field.

`OMB_TUNNEL_RECLAIM` is `observe` unless set to `on` (an unset or invalid value
observes): it logs `idle`/`eligible` counts without marking anything. Deploy in
`observe`, check one full scan cycle of real counts, then set it to `on`. The two limits only drive the alert and `/healthz`; raise
them when Cloudflare raises the account or zone quota.

`GET /healthz` keeps `ok` and `service` unchanged (desktops gate hosted sign-in
on them; a full quota must not hide sign-in or recovery) and adds a
`capacity` object with no identifiers or secrets:

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

`status` is `full` while a recent quota rejection is gating allocations,
`unknown` when the snapshot is more than 30 minutes old.

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

Do not commit `.dev.vars`.

## Troubleshooting managed HTTPS setup

`endpoint_capacity` means Cloudflare refused a new tunnel (`cf_api_1045`) or
DNS record (`cf_api_81045`): see **Tunnel capacity and idle reclaim** and the
`capacity` object in `/healthz`. `endpoint_unavailable` is every other
failure. Both come from authenticated endpoint provisioning, before
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
   pnpm --filter @openmausbot/control-plane exec wrangler d1 execute DB --remote --command "SELECT status, last_error_code, COUNT(*) AS endpoints FROM installation_endpoints GROUP BY status, last_error_code"
   ```

3. Check **account-wide** undeleted tunnel usage in Cloudflare, not just ready
   D1 rows. Cloudflare's [documented default limit is 1,000 tunnels per
   account](https://developers.cloudflare.com/cloudflare-one/account-limits/#cloudflare-tunnel).
   Pending allocations and tunnels belonging to other services also consume
   capacity. At the limit, request a capacity increase from Cloudflare. A new
   desktop release cannot raise the provider's quota. Do not infer the meaning
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
   tunnel/DNS resources during build or tests.
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
