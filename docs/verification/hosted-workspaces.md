# Hosted workspace sign-in and revocation

This repository ships the workspace-side protocol adapter, not a hosted
administration console. The adapter is optional, belongs to the licensed
`enterprise/` layer, and does not add dependencies to the desktop or ordinary
self-hosted server. An independently deployed identity service owns its own
accounts, invitations and provider gateway.

## Configuration and protocol

An operator configures the workspace with an HTTPS `OMB_ADMIN_URL` origin,
its `OMB_ADMIN_WORKSPACE` slug, its exact HTTPS `OMB_PUBLIC_URL`, and an
active `admin` entitlement. Partial or invalid hosted configuration denies
remote access; it never enables legacy email or QR sign-in as a fallback.
Credential-free, unproxied loopback owner access remains available for recovery.
The `identity.example.test` URLs below illustrate external identity-service
endpoints; requests use the configured `OMB_ADMIN_URL`, not the tenant origin.

1. The workspace's `/api/auth/hosted/start` creates bounded, expiring state
   and a secure host-only handoff cookie. It redirects to the identity
   service's `/connect` with workspace, state and a SHA-256 PKCE challenge.
2. The service returns a one-use code to `/api/auth/hosted/callback`.
   State and cookie must match. The workspace consumes local state before
   awaiting `POST https://identity.example.test/api/handoff/consume` with
   workspace, code, verifier and `contractVersion: 1`.
3. A successful response contains `contractVersion: 1`, email, role (`admin`
   or `member`) and a high-entropy workspace-bound grant. The adapter issues a normal scoped
   workspace session. By default the local email allow-list also narrows
   its access.
4. Every authenticated remote request checks the grant at
   `POST https://identity.example.test/api/handoff/check`.
   Membership removal or loss of an issued scope
   revokes the session. Promotion does not widen an existing credential.
   An unavailable service denies access and closes streams without treating
   an outage as permanent membership removal.

The wire contract is defined in `server/hosted-contract.ts`, independently of
application release numbers. Both consume and check use `contractVersion: 1`
in requests and successful replies. The **legacy-v1** transition supports
omitted versions only as the existing v1 payload, so either side can be
upgraded first. Explicit unsupported versions (including strings, null and
future versions) are not legacy: the identity service rejects them with `409`
and code `HOSTED_CONTRACT_MISMATCH` before spending a one-use code. The runtime
fails closed with an actionable, generic `503`, closes active streams, and
preserves established sessions for recovery after compatible deployment.
It never retries without the version or copies remote error details.

This compatibility window is release-bounded, not clock-dependent:
unversioned support ends at the next breaking protocol version, v2. That
rollout must first inventory and upgrade legacy peers; it must not silently
reinterpret omitted versions as v2. Additive v1 fields do not require a bump;
incompatible changes to identity, grant or revocation semantics do. Metadata
advertises `contractVersion: 1`, `supportedContractVersions: [1]` and
`legacyPolicy: "legacy-v1"`; supported versions are an explicit list, not an
assumption that arbitrary older or newer versions work.

An operator may explicitly set `OMB_ADMIN_MEMBERSHIP=portal` when the identity
service is the sole membership authority. This requires the complete valid
hosted configuration above. Only sessions internally marked after a successful
portal grant exchange may skip the local allow-list; ordinary email sessions,
pairing credentials and a `portal:` user ID alone never gain that exemption.
All remote grant checks and stream revocation still apply. Unset the mode (or
set it to `local`) to restore local narrowing, including for saved sessions.
Other mode values fail closed. This opt-in avoids rewriting tenant allow-lists
or restarting a tenant for every accepted invitation.

The public `GET /api/health/hosted` capability probe returns `200` only when
complete hosted configuration, explicit portal membership, the loaded access
hook, and a currently valid `admin` entitlement are all present; otherwise it
returns a generic `503`. Its successful response
includes `{ok:true,service:"openmausbot",membershipAuthority:"portal",workspace:"<slug>"}`
plus the contract metadata above and the `X-OMB-Hosted-Contract-Version: 1`
response header, emitted by the running runtime for an authenticated deployment
probe to relay. A wrapper must not manufacture this version for an older runtime.
It exposes no credentials or sessions
and does not cache readiness. License expiry withdraws readiness without a
restart. This is a runtime capability signal, not a portal reachability check.
The existing `/api/health` remains an ordinary reachability probe and must not
be used to infer hosted authentication support.

Backchannel requests go only to the configured HTTPS origin, omit browser
cookies, reject redirects, and have a five-second deadline. A ten-second
revalidation cadence closes quiet event/browser streams after access ends;
the combined bound is fifteen seconds. Invalid or revoked credentials may
not fall back to the local owner merely by using a loopback address.

The public fleet supports this configuration plus workspace-scoped managed
Anthropic/OpenRouter credentials. Never seed a hosted workspace with a
provider gateway's master key. These runtime seams do not require a particular
console repository, orchestration platform, or cloud provider.

Hosted sign-in starts have a bounded per-source allocation limit. A full
handoff table returns 429 without evicting existing sign-ins or preventing
their callbacks from completing. Email/account sessions survive a successful
graceful shutdown. An unclean shutdown or failed session persistence requires
account sign-in again; paired-device sessions are preserved. A durable boot
marker prevents old, revoked account tokens from reappearing after a failed
write and restart. Local allow-list membership is read once per revalidation
pass, not once per session on each streamed event.

## Isolated verification

Read [the verification entry point](README.md) first. Run only disposable
fixtures; do not point these tests at an existing app, workspace or identity
service.

```sh
pnpm typecheck
pnpm lint
pnpm exec vitest run server/hosted-access.test.ts enterprise/server/workspace-access.test.ts server/email-signin.test.ts server/sessions.test.ts server/request-auth.test.ts server/enterprise.test.ts server/browser-live.test.ts server/fleet.test.ts server/fleet-cli.test.ts server/fleet-agent.test.ts server/fleet-cli-filesystem.test.ts src/components/WorkspacesSection.test.ts
pnpm test:packaged-server
```

The full-server fixture launches an owned server with a disposable home and
an injected fake HTTPS backchannel. It verifies hosted navigation, disabled
legacy credentials, local recovery access, sign-in, outage, demotion,
reauthentication and quiet event-stream closure. The bridge tests use real
HTTP, cookies and sessions to check PKCE mismatch, expiry, replay, host
binding and live permission checks. Fleet fixtures use disposable sockets,
recording executors and bounded child processes for hostile file cases.
The capability probe is also exercised against missing or invalid hosted
settings, local membership, absent hooks, invalid licenses, missing admin
entitlement, valid portal mode, and entitlement expiry in the running process.
The contract fixtures cover explicit v1 and legacy-v1 peers, malformed/future
versions, no downgrade retry, safe mismatch errors, and idle-stream closure
with session recovery after compatibility is restored. The real server emits
version metadata only when hosted readiness succeeds.

These checks do not deploy a console, send real mail, issue TLS certificates,
call a paid provider or prove Linux tenant isolation. Real root transitions,
service/fence ordering, proxy boundaries, reboot recovery and backup restore
still require a separately authorized disposable Linux deployment using the
[fleet recipe](fleet.md).

## Observed local result — 2026-09-13 (Asia/Kolkata; September 12 UTC)

The commands above passed after extracting the runtime changes onto public
main `c610e6cd`: 240 targeted tests, typecheck, lint, all twelve packaged proxy
paths and the packaged MCP round trip. The production UI build also passed.
The full-server fixture additionally proved explicit portal membership with
an empty local allow-list, including outage, demotion and quiet-stream
revocation, plus live hosted-readiness attestation and entitlement expiry.
All identities, sessions, fleet actions and backchannels were
disposable or synthetic; no production deployment was exercised.
