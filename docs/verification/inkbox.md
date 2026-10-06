# Inkbox iMessage and SMS adapter

For the expanded channel capabilities and current conversation behavior, see
[Inkbox communication release](inkbox-release.md).

The adapter accepts signed, one-to-one `imessage.received` and SMS
`text.received` events at `POST /inkbox`. It records an event before returning
202, then runs the host callback and submits one reply. A `sent` row means
Inkbox accepted the outbound HTTP request; it does not prove carrier delivery.

## Desktop setup (normal user flow)

Open **Settings → Account → Inkbox** in the packaged desktop app:

1. Paste an Inkbox API key, choose a bot, and enter your own international phone number.
2. Click **Connect**. Mausbot provisions its identity, saves credentials in the desktop's encrypted credential store, and opens the official Inkbox SDK connection automatically.
3. Scan the QR code on your phone and send the prepared `connect @…` message.
4. Send `Reply with hello`. Check for the reply on the phone and a fresh Ask task in Mausbot.

Keep Mausbot running and online. A working AI engine must be configured for the selected bot. No terminal tunnel, webhook dashboard setup, bot UUID lookup or environment file is needed. This wizard connects **iMessage**; it does not purchase an SMS number.

An admin key creates a separate app identity and is replaced with an identity-scoped key after setup. An identity key is accepted only when its identity has no existing signing key and its tunnel is unused. Existing signing keys are never rotated. Only the exact owner number entered in Settings receives the owner Ask path; other numbers need contact grants.

The app exposes only a signed `/inkbox` receiver through the official SDK tunnel. The main app API is not forwarded. Provider API paths and tunnel domains are fixed, redirects are refused, and provider metadata is validated before a credential can be used. The private desktop parent stores versioned setup state under a workspace-specific encrypted credential entry; remote clients and bot subprocesses cannot access that bridge.

**Ready to receive** means transport is up. **Connected** additionally requires a signed owner message in the saved inbox. Neither status alone guarantees a reply reached the phone. Disconnect drains the old channel, pauses automatically on restart, and keeps receipts; Reconnect uses the saved key. Completed setup steps resume after a read-only failure. An interrupted provider write with an unknown outcome is never automatically replayed.

Synthetic verification covers setup stages, signature admission, local owner-only routes, storage bridge, tunnel restrictions and disconnect/restart races. See [the rendered desktop UI fixture](inkbox-setup-ui.md). Real Inkbox provisioning and phone delivery still require the user's live test.

## Headless/manual configuration (optional)

The original environment adapter remains available for headless installations. These instructions are not required for desktop onboarding.

Set these environment variables in the server's launch environment:

| Variable | Purpose |
| --- | --- |
| `OMB_INKBOX_API_KEY` | An identity-scoped Inkbox API key |
| `OMB_INKBOX_SIGNING_SECRET` | That identity's plaintext signing key |
| `OMB_INKBOX_IDENTITY_ID` | The identity UUID |
| `OMB_INKBOX_OWNER_PHONE` | The owner's exact E.164 phone number |
| `OMB_INKBOX_BOT_ID` | The bot the host will use for owner Ask requests |
| `OMB_INKBOX_PHONE_NUMBER_ID` | Optional phone resource ID; required to accept SMS |

Missing or invalid required values disable admission. Configuration secrets
never appear in `status()`. Provision the identity, identity-scoped key,
signing key, phone number, and webhook subscription separately through Inkbox.
The adapter verifies an active identity-scoped key through the fixed
`GET https://inkbox.ai/api/v1/api-keys/self` endpoint before dispatching any
host callback. That verification is cached for the process lifetime; restart
after correcting rejected credentials. It does not provision accounts or
discover phone IDs. An inbox is bound to the configured identity, owner, bot,
and optional SMS phone resource. Reusing it with different bindings fails
closed; preserve the old inbox for inspection before configuring another one.

For a local server, forward an HTTPS tunnel or reverse proxy to its dedicated
webhook listener (normally `127.0.0.1:8800`; `OMB_WEBHOOK_PORT` overrides it).
Set `OMB_WEBHOOK_PUBLIC_URL` to that HTTPS origin and register
`https://YOUR-HOST/inkbox` with Inkbox. Expose only `/inkbox` and, if using peer
contacts, `/contacts/v1/requests` and its request-result paths. Do not point
this tunnel at the main application API. Setting the public URL advertises it;
it does not create a tunnel. The server must stay running to receive messages.

Transport secrets are captured on startup and removed from the environment
inherited by bot subprocesses. These inboxes, contact grants and peer credentials
are machine-local and excluded from workspace backup transfers. Normal filesystem
permissions protect message receipts at rest; receipts are not separately encrypted. Desktop setup credentials are encrypted separately by the operating system. SMS is not
end-to-end encrypted, and Inkbox can read the messages it delivers.

Subscribe only to `imessage.received` and `text.received`. Both channels use
the identity signing key. The three required headers are
`X-Inkbox-Request-ID`, `X-Inkbox-Timestamp`, and `X-Inkbox-Signature`.
The timestamp header contains Unix **seconds**, with a 300-second tolerance.
The signature is `sha256=<hex>` over
`request_id.timestamp.raw_body`, using HMAC-SHA256. The event's own timestamp
is ISO 8601. Signature validation precedes JSON parsing.

Owner messages use the exact configured phone binding. Other senders must
resolve through the local contact lookup; carrier contact names, IDs, memories,
and conversation context confer no permission and are discarded. The adapter
grants no tool privileges. The host keeps ordinary owner messages in one Ask task and maintains a durable conversation
binding for replies. Questions show the actual choices as numbered options;
reply with a number, an offered label, or your own text. Multiple questions are
collected one at a time, then delivered to the original task. Question correlation stays internal; no request code or ANSWER command is shown.

Ordinary action approvals show full details. Reply `yes` or `approve` to allow
that pending action once, or `no` or `deny` to reject it. No request code is
shown. The host rechecks the sender binding, task, card, turn and execution;
queued or duplicate replies cannot authorize a different action.

The linked owner can send `approve for me` to enable automatic ordinary tool
approvals for this messaging conversation. Mausbot confirms the change and
sends short action notices. `ask me first` turns it off. The preference is
saved across restart and shown in Inkbox settings; `NEW <request>` starts a
new conversation in Ask mode. It does not change the bot's other conversations
or answer clarification questions. Native account/proposal review still uses
its dedicated app screen.

Pending approvals expire after 15 minutes and questions after 24 hours.
`STATUS` shows the current request. A question can continue its original task
after its provider run has ended, but an expired action cannot be revived.

If a task takes longer than the initial wait, its next question or result is
sent automatically while the app stays connected. Follow-ups use the same
durable inbox and never automatically retry an unknown send. Disconnect pauses
observation. Restart restores saved observation and unanswered questions, never
an interrupted decision. `STATUS` inspects an uncertain answer without replaying
it. Native proposal review screens, secret/account connections, and requests too
large to display completely still require the app. An actionable approval is
never truncated. Other senders retain their existing contact permissions.

The shared conversation layer can support future authenticated email or other
adapters; this change implements the live integration through Inkbox only.

Group chats, Companion events, sponsored traffic, outbound lifecycle events,
ambiguous recipient/participant fields, and MMS are rejected. Inkbox's
documented inbound MMS shape cannot establish that a conversation is one to
one. Media-only messages are rejected. For iMessage, `is_group: false` must be
explicit. For SMS, matching sender/remote phone fields and `type: sms` are
required. Optional identity fields, when present, must match configuration.

The private atomic JSON inbox holds at most 1000 records and does not evict
delivery evidence. New events receive 503 when full; inspect and archive the
inbox through an explicit operator action while the channel is stopped.
A sender can admit at most 30 new events per rolling hour. Bodies are limited
to 128 KiB and text to 32,000 UTF-16 code units. Exact event-ID/body-digest
duplicates return 202 without another callback or send. A reused ID with a
different body returns 409.

`pending`, `processing`, and `sending` records become `uncertain` after restart
and are never automatically replayed. Network errors, HTTP 5xx/408 responses,
or persistence failures are also uncertain. A definitive HTTP rejection is
`failed`; a callback failure is visible as `failed`. The full reply is saved
before delivery, with one bounded outbound message (1600 characters for SMS,
18,995 for iMessage). Longer replies include a truncation notice and remain
complete in the inbox. Outbound requests use only fixed Inkbox HTTPS API paths,
the configured API key, an event-derived idempotency key, a 15-second timeout,
and rejected redirects. No automatic retry occurs, including after failure.

On a disk failure after the callback, the full reply remains visible in memory
but cannot be guaranteed durable until storage is repaired; admission stops.
Inspect the persisted inbox and current process status before stopping that
process. There is deliberately no automatic recovery that might repeat work
or duplicate a delivery. One process must own an inbox; cross-process file
locking is not provided.

## Isolated verification

Desktop onboarding checks (all providers and recipients are synthetic):

```sh
pnpm exec vitest run server/inkbox-setup.test.ts server/inkbox-setup-review.test.ts server/inkbox-setup.e2e.test.ts server/routes/inkbox-setup.test.ts server/inkbox-provider.test.ts server/inkbox-tunnel.test.ts server/inkbox-secrets.test.ts electron/inkbox-credentials.test.mjs
pnpm exec electron scripts/testing/inkbox-setup-ui-smoke.cjs
```

The setup E2E test uses real local HTTP routes, the real setup coordinator,
production tunnel request filtering, signed message admission and durable
receipts. Only the external provider and SDK connection are injected. It proves
one reply per event, rejection of invalid signatures, disconnected ingress,
restart-safe duplicate suppression, and secret-free snapshots and receipts.
It never connects to Inkbox or a real phone.

Run from the fixture checkout with Node 24:

```sh
pnpm exec vitest run server/inkbox-channel.test.ts
```

The test fixture launches actual loopback HTTP listeners and uses temporary
private inbox files. It injects only the external fetch boundary, so no real
Inkbox account or recipient is contacted. It covers signed HTTP admission,
durable owner/contact dispatch, exact outbound paths, duplicate suppression,
signature freshness, group and unknown-sender rejection, restart quarantine,
shutdown, contact revocation during processing, disk failures, bounded replies,
capacity/rate limits, and secret redaction.

Follow [the verification guide](README.md) for host integration checks. These
adapter tests do not prove external webhook reachability, Inkbox account
provisioning, phone-resource ownership, recipient opt-in, carrier delivery, or
the host's Ask/permission behavior.

The actual server owner path is covered by a separate hermetic fixture:

```sh
pnpm exec vitest run server/inkbox-owner.e2e.test.ts server/channel-answers.e2e.test.ts
```

It launches a temporary fake-engine server, stops it to seed a fixture bot
with Full Access defaults, then restarts only that owned server with synthetic
Inkbox credentials. A temporary import module intercepts the fixed Inkbox
key-inspection and send endpoints; all other HTTPS requests are refused.
Actual signed events enter the real webhook listener. The test verifies unselected Ask tasks and same-task follow-ups with `autoApprove: false` and empty `alwaysAllow`, the
fake engine's successful canonical final reply, exact duplicate suppression,
and API/signing-key absence from the fake CLI environment. It also holds a
genuine native permission request in older work: a new owner message `YES`
creates a fresh Ask task and leaves that older request unanswered. Evidence
is saved beside the fixture log with the suffix `.inkbox-owner.json`.

The channel-answer fixture drives signed HTTP messages through real native
questions and approvals with a held fake-engine turn. It checks numbered choices,
multiple selections, free text, plain-language allow/deny, stale targets, duplicate
messages, and continued work in the same task. External API requests remain
synthetic; no real message or email is sent. Focused safety checks are available
with:

```sh
pnpm exec vitest run shared/channel-replies.test.ts server/channel-conversation.test.ts server/channel-card-guard.test.ts server/inkbox-channel.test.ts
```

## Official API references

- [Webhook signature format](https://inkbox.ai/docs/api/phone/webhooks#verifying-webhook-signatures)
- [Signing keys](https://inkbox.ai/docs/signing-keys)
- [iMessage event payloads](https://inkbox.ai/docs/api/imessage/webhooks)
- [iMessage API base URL](https://inkbox.ai/docs/api/imessage)
- [iMessage send endpoint and limits](https://inkbox.ai/docs/api/imessage/messages)
- [Phone API base URL](https://inkbox.ai/docs/api/phone)
- [SMS payloads and send limits](https://inkbox.ai/docs/api/phone/texts)
- [Companion and sender-access metadata](https://inkbox.ai/docs/webhooks)
- [API key scope](https://inkbox.ai/docs/api-keys)
