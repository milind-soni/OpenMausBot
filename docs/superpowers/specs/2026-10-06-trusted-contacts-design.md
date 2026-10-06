# Trusted contacts and coordination

> Historical design stage. Later conversation, approval and release decisions are documented in [the current Inkbox release guide](../../verification/inkbox-release.md). The user has now tested iMessage and authorized one PR.

User intent: build the four recommended features with original Mausbot code, test locally, and prepare one branch for a later PR. No reference-repository code, dependencies or prompts are imported. No PR or deployment during this work.

## Product

Settings → Trusted contacts manages contacts, expiring grants, calendar availability, peer connections, and an approval inbox. A contact can request availability within an owner-selected date window and propose a meeting. Each proposal needs explicit approval of its exact subject and slot. Confirmations produce a downloadable calendar invitation; no external calendar write is claimed. The calendar source is owner-entered availability initially, with a Google Calendar free/busy adapter using the existing Composio relay. Both sources expose time intervals only.

Remote peers use a versioned, authenticated HTTP protocol on the existing webhook ingress. Each issued token names exactly one contact and one bot; only its digest is stored. The contact cannot invoke arbitrary tools, enumerate others, read transcripts, or approve its own request. Owners can configure an outbound peer endpoint and send structured scheduling requests. Replies stay attached to the originating request; delayed updates never reopen terminal work.

Messaging adapters use the same scheduling service. The local simulator accepts the same human-readable commands as live text delivery, persists replies, and supports restart-safe polling. An owner request to text the bot arbitrary tasks requires a separate, verified owner binding and is not implied by a contact token. The user selected iMessage/SMS via Inkbox. Signed one-to-one events bind the owner to an exact configured number and identity; every owner event creates a separate Ask conversation. Approvals and questions remain in the app. Live provider integration verifies signatures and identity and never infers identity from message text.

## Persistence and authority

State is versioned and atomically replaced with mode 0600. Save-before-publish prevents failed disk writes from granting permissions or acknowledging acceptance. Pending approvals survive restart. Revocation and expiry are rechecked immediately before answering and before approving. Requests are immutable; retries with the same request ID and different content fail. Interrupted external delivery is marked uncertain and is not replayed automatically.

Admin API requires existing admin authorization; contact transport never becomes an owner session. Hosted/cloud owners use their existing authorization. All external responses are built from a whitelist of fields. No model handles authorization or availability projection. Public ingress is bounded, token authenticated, limited per contact, and has no URL-fetch tools. Outbound peer URLs are configured by the owner, use HTTPS (loopback HTTP for local testing), disallow redirects, and receive only the peer's own secret.

## Validation

Unit tests cover expiry, revocation, narrow date scope, malformed inputs, duplicate delivery, immutable approvals, disk failure rollback, recovery, secret omission and private calendar field removal. HTTP tests exercise unauthorized access, cross-contact request access, and two-instance coordination. Launch a disposable harness through scripts/control-omb.ts and drive the real Settings UI. Never verify against the live app's data.
