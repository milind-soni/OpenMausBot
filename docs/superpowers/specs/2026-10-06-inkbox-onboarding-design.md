# In-app Inkbox setup

> Historical design stage. Later conversation, approval and release decisions are documented in [the current Inkbox release guide](../../verification/inkbox-release.md). The user has now tested iMessage and authorized one PR.

User correction: the earlier environment-file, terminal tunnel and manual webhook setup is unacceptable for normal users. The app must own that work. Continue the already authorized feature branch; original code only, no PR until local testing.

## User flow
Settings → iMessage. Paste an Inkbox API key, choose a local bot, enter your own international phone number, then Connect. Explain that an admin key creates a separate Mausbot identity; identity-scoped keys reuse their identity only when setup will not rotate another connection's signing key. No paid phone provisioning. Show a QR/text link to the provider's connect command and ask the person to send hello. Show transport readiness separately from an observed inbound message. Disconnect pauses delivery without deleting provider resources; reconnect needs no key re-entry.

## Backend
Provision with fixed Inkbox HTTPS APIs and no redirects. For an admin key, create a unique identity with iMessage enabled, mint an identity-scoped runtime key, and discard the admin key. For a scoped key, discover only that identity, validate its existing tunnel, and refuse to rotate an existing signing key silently. Own the webhook subscription and signing secret. Persist setup stages to encrypted desktop credentials so retries resume known resources. Never automatically retry ambiguous mutating requests. Show a bounded safe error and allow explicit retry of recoverable known stages.

Use @inkbox/sdk's documented Node tunnel connection with an in-process handler. Only POST /inkbox is forwarded to the fixed local webhook receiver; all other paths/upgrades are refused. Bound bodies and timeouts; do not expose the app API. Manage reconnect and shutdown within the app. A provider failure must not advertise connected. Keep the existing signed receiver, exact owner phone binding, Ask tasks, narrow contact permissions and duplicate protections.

## Secrets and access
Packaged local desktop setup only initially; remote pages and service tokens cannot provision. Use the existing OS-encrypted credentials store, keyed by workspace data directory; unavailable secure storage fails closed. Private parent/child messaging loads and saves settings. Never return keys in status, logs or renderer snapshots; never put them in child agent environments. Server route handlers live in server/routes. Setup operations are serialized. Disconnect prevents stale setup or tunnel completions from re-enabling delivery.

## Verification
Synthetic provider and tunnel fixtures only; no live account resources or sends. RED/GREEN coverage for provisioning scopes, secret redaction, storage failure, restart/resume, signing-key conflict, invalid provider URLs, disconnect races, narrow tunnel forwarding, admin route denial, setup UI states and encrypted desktop persistence. Retain existing contact/owner acceptance tests. Build and smoke packaged backend, then rebuild OMB2 when safe for the user's running test app. Live iMessage remains unverified until the user connects their account.

Sources: https://inkbox.ai/docs/capabilities/tunnels , https://inkbox.ai/docs/api/identities/manage , https://inkbox.ai/docs/api-keys , https://inkbox.ai/docs/api/webhooks/subscriptions , https://inkbox.ai/docs/api/imessage/router .
