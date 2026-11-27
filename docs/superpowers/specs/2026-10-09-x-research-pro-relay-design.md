# X Research for Cloud Plans (Included Relay)

## Summary

X research (`x_search`, `x_user_posts`, `x_post`, `x_profile`;
`2026-10-08-x-research-tools-design.md`) currently runs on a treg token the
person pastes. Change it to an included service of OpenMausBot Cloud plans:
our Admin holds the treg key and relays calls for paying accounts only, with a
monthly allowance per plan tier. Free users never get it. There is no
bring-your-own token.

Two repositories change:

- **openmaus-cloud** (Admin): the X relay, its per-tier allowance, tokens for
  Cloud homes and for signed-in desktops.
- **OpenMausBot** (app): the included credential replaces the person's token;
  the desktop fetches its token from its Cloud sign-in; the bot setting shows
  X research as a Cloud plan feature.

## Decisions (Omkar, 2026-10-09)

- Every paid tier gets X research: Personal, Pro and Max. Free gets nothing.
- Allowance per account per calendar month (UTC): Personal 1,500 calls,
  Pro 5,000, Max 15,000. Overridable per tier through `OMB_CLOUD_TIERS`.
- No bring-your-own treg token anywhere in the product.
- The relay is the real gate. The app's check is presentation only.

## Admin (openmaus-cloud)

### Relay

- `POST /api/cloud/services/x/call/<endpoint>` on the Cloud origin, next to
  Boat, voice and decider in `server/cloud-services.ts`. No session or CSRF;
  a relay token.
- `<endpoint>` must be one of the app's eight X endpoints:
  `anyapi.x.search.posts`, `treg.x.search.posts`, `anyapi.x.user.posts`,
  `treg.x.user.posts`, `anyapi.twitter.tweet`, `anyapi.x.post.comments`,
  `treg.x.post.comments`, `treg.x.user.profile`. Anything else is 404. The
  relay is never an open treg proxy.
- Request: a JSON object of at most 64 KiB.
- Forwarded to `https://treg.to/call/<endpoint>` with `X-Treg-Token: <key>`,
  `X-Treg-Route-Max-Cost: 0.05`, `X-Treg-Meta: customer=<userId>`,
  `redirect: "error"`, `accept-encoding: identity`, a 30 s timeout. Nothing the
  caller sent besides the JSON body reaches treg.
- Answers pass through as JSON (at most 4 MiB). Bodies are never logged.
- Errors (the app maps each):
  - 401 `invalid_api_key`: the token is unknown.
  - 402 `subscription_inactive`: no active paid plan.
  - 429 `quota_exceeded`: this month's calls are used up. The message names
    the plan, the allowance and the reset date.
  - 503 `service_unavailable`: no treg key configured, or treg refused our key,
    credit or plan (401, 402, 403). This also alerts the operator like the
    other relays (`KEY_REFUSED`).
  - 429 from treg itself becomes 503 `overloaded`; treg's 5xx stays 5xx (the
    app falls back to the routed endpoint); treg's 422 passes as 422.
- Allowance: one call reserved per request in one statement
  (`portal_cloud_x_usage(userId, month, calls)`), refused at the plan's
  `xCallsPerMonth`. Given back when the request provably never left, or treg
  refused it with a 4xx other than 429 (treg bills per answer). A timeout or a
  5xx stays counted.

### Tokens

- **Cloud homes**: like decider. `OMB_CLOUD_X_URL` (the relay base,
  `<origin>/api/cloud/services/x`) and the secret `OMB_CLOUD_X_TOKEN`
  (`omb_x_…`), minted by the provisioning job and the reconciler, honoured
  while `serviceAccess(machineId)` allows. Stored hashed in a new table
  `portal_cloud_relay_token(machineId, service, tokenHash, createdAt)`; the old
  token table's CHECK cannot take `x` and its rebuild is never repeated.
  Reads go through the view `portal_cloud_service_tokens` over both tables.
- **Desktops**: `POST /api/cloud/desktop/services/x` with the app's Cloud
  sign-in (`Bearer omc_…`). Paid, active accounts get `{ url, token }`
  (`omb_xd_…`); others get 402. One token per desktop sign-in: asking again
  replaces it. Stored hashed in `portal_cloud_desktop_service_token(deviceId,
  service, userId, tokenHash, createdAt)`. Honoured only while that sign-in is
  live (not revoked, not expired) and the account's entitlement is an active
  paid plan; its tier sets the allowance.
- Signing a desktop out deletes its relay tokens.

### Configuration

- `OMB_CLOUD_TREG_KEY`: our treg token. Without it the relay answers 503 and
  no home or desktop gets X wiring.
- `OMB_CLOUD_X_CALLS_PER_MONTH` (default 1,500): the allowance for a Cloud
  whose plan is unknown.
- Tier catalog: `xCallsPerMonth` per tier (defaults 1,500 / 5,000 / 15,000).
- The Cloud page's "Included" block gains `x: { calls, max }`.
- `deploy/admin.env.example`, `docs/consumer-cloud.md`.

## App (OpenMausBot)

### Removed

The person's token: config `treg`, `OMB_TREG_TOKEN`, desktop credential
`tregToken`, the API keys row and its Test route (`/api/x-research/test`),
their strings and tests. Old config files that still contain `treg` keep
loading.

### Included credential

- `server/included-services.ts`: `xCredential()` returns `{ token, api }`.
  - A Cloud home reads `OMB_CLOUD_X_URL` and `OMB_CLOUD_X_TOKEN` at boot, held
    in memory like the others (`CLOUD_HOME_SECRET_KEYS`,
    `cloud-home-start.ts` `SERVER_ENV_NAMES`, `WORKSPACE_CREDENTIAL_ENV`,
    diagnostics).
  - The desktop's main process sends
    `{ type: "openmausbot:included-x", access: { url, token } | null }` on the
    server's parent port; `null` clears it. Never written to disk.
- Desktop main (`electron/main.mjs`, `cloud-account.mjs`): when the Cloud
  account is connected with an active paid entitlement, it asks the Admin for
  the X token and sends it to the server. On sign-out, an inactive plan or
  re-sign-in required, it sends `null`. It sends again after the server
  restarts. A 402 from the Admin sends `null`.
- `OMB_CLOUD_X_URL` (with `OMB_CLOUD_X_TOKEN`) also serves development and the
  e2e fixture; the verification launcher lets it cross only as a
  `http://127.0.0.1:<port>` URL.

### Client and gate

- `server/x-research.ts` calls `<url>/call/<endpoint>` with
  `Authorization: Bearer <token>`. Endpoints, fallback, row mapping, links and
  the result cap are unchanged.
- New sentences:
  - 402: "X research comes with OpenMausBot Cloud plans, and this account's
    plan isn't active."
  - 429 `quota_exceeded`: the relay's own sentence (the plan, the allowance
    and the reset date).
  - 401: "Sign in to OpenMausBot Cloud again in Settings to use X research."
- Tools are shown only when `xCredential()` exists and `bot.xResearch` is on.
  The routes re-check both on every call.
- `configStatus` reports `xResearch: { included: boolean }` in place of
  `treg`.

### Access card

- Included: the switch, as today ("Included with your OpenMausBot Cloud plan").
- Not included, on the desktop app: locked. "X research is included with
  OpenMausBot Cloud plans." Signed out: the existing sign-in action. Signed
  in on Free: Get Pro.
- Elsewhere (a browser): the locked sentence only.
- A bot already switched on can still be switched off.

### Docs

`apps/docs/content/docs/connected-apps/index.mdx` and `docs/cloud-pro.md`
(env table).

## Not in scope

- Bring-your-own token, phone UI, usage display in the app (the Cloud page
  shows it), streaming monitoring.

## Testing

- Admin: the tier catalog default and override; the relay (allow-list, auth,
  402, quota and give-back, key refusal to 503, treg 429, header injection,
  that nothing else is forwarded, body caps, no body logging); home tokens
  (mint, env, plan, stale SQL, view); desktop tokens (paid only, replace,
  revoke on sign-out, refused after expiry or revocation, tier allowance);
  portal routing. A treg fake; no paid calls.
- App: the client against the relay (headers, path, error mapping); the
  included credential (home env, parent-port message, clearing); the gate;
  the Access card states; the e2e through a real agents proxy against a
  loopback relay stub; config and credential parity tests after the token
  removal.
