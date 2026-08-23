# iOS companion architecture

The iOS app is a thin, native client for the OpenMausBot instance running on
your Mac. The Mac remains the only machine that owns agent processes,
credentials, SQLite data, transcripts, and computers. The phone discovers or
is told how to reach the Mac, pairs once, and then uses the same HTTP and SSE
contract as the desktop client through a restricted sidecar.

## Current status

The first version includes:

- Bonjour discovery on the same LAN and manual address entry.
- Remote access through a Tailscale MagicDNS name.
- QR-first pairing with a short-lived, single-use credential and a six-digit
  manual fallback, plus per-device tokens, device listing, and revocation.
- Bot and room lists, paged transcripts, sending, interruption, and unread
  state.
- Native agent profiles opened from the chat identity: name, role,
  description, agent notifications, authenticated custom avatars, avatar
  generation through the computer's configured provider, and per-agent voice.
- Tasks & Routines with native date/time/day controls, lifecycle actions, and
  run receipts. Each routine run creates a fresh task; no cron string reaches
  the phone.
- Account-aware connected apps: aliases, add-another OAuth, refresh, and
  account-specific disconnect for multiple Slack/Google accounts.
- Approvals and questions, including narrow “always allow” grants.
- Resumable SSE, streamed reply text, reconnect hydration, and an opt-in live
  computer view.
- Native notification alerts and exact `botId + threadId` routing when a user
  taps one, including detached tasks reached after replay.
- Markdown rendering and Keychain storage for the device token.

The live companion connection remains foreground-oriented. Native alerts are
delivered from live or cursor-replayed frames, but closed-app APNs delivery and
a hosted relay are not part of this version. Voice selection and preview are
included; a live call mode is not.

## Runtime architecture

```text
 iPhone
   SwiftUI UI + CompanionCore
   bearer token in Keychain
            │
            │ HTTP + resumable SSE
            │ LAN or Tailscale
            ▼
 companion sidecar :8810
   pairing authentication
   default-deny route allowlist
   response and SSE scrubbing
            │
            │ loopback only
            ▼
 OpenMausBot harness :8799
   HTTP API + event stream
   agent processes and approvals
            │
            ▼
 SQLite message store + local configuration
```

There are three deliberately separate trust surfaces:

| Surface | Bind | Purpose |
|---|---|---|
| Harness | `127.0.0.1:8799` | Existing app API; remains loopback-only |
| Companion | `0.0.0.0:8810` | Paired native devices; authenticated and allowlisted |
| Companion control | `127.0.0.1:8811` | Start pairing, cancel pairing, list devices, revoke |

The desktop app owns the sidecar lifecycle through
`electron/companion.mjs`. The renderer only receives narrow IPC operations; it
does not fetch the control port directly.

## SQLite compatibility

SQLite does not move onto the phone. It is an implementation detail behind the
harness API:

- `server/message-db.ts` and `server/store.ts` persist and page transcripts.
- The phone asks for `GET /api/bots?messages=50` and
  `GET /api/threads/:threadId/messages?before=…&limit=50`.
- SQLite ordering and cursors are therefore tested at the server boundary,
  while the Swift package tests decoding and prepend/deduplication using
  responses captured through the real sidecar.
- A storage migration may change the bytes on disk without changing the app.
  If an API payload changes, regenerate the fixtures with
  `node scripts/capture-companion-fixtures.mjs` and review the diff.

The sidecar keeps its device registry in `~/.openmausbot/devices.json`. That is
security state owned by the network boundary, not transcript data, so it does
not belong in the message database.

## Connectivity

### Same Wi-Fi

The sidecar advertises `_openmausbot._tcp` over Bonjour. The app browses with
`NWBrowser`, resolves the chosen service, and connects directly. If multicast
is unavailable, the desktop shows the LAN address for manual entry.

LAN traffic is plain HTTP. Use it only on a network you trust. Device tokens
are bearer credentials, so someone able to observe that LAN traffic could copy
one until the device is revoked.

### Tailscale

Tailscale is the recommended route away from home and on Wi-Fi networks that
isolate clients. Both devices join the same tailnet and the phone uses the
Mac’s MagicDNS name, such as `macbook.example.ts.net:8810`.

The URL is still `http`, but the path is encrypted and authenticated by
WireGuard inside the tailnet. Use the MagicDNS name rather than the
`100.64.0.0/10` address: App Transport Security exceptions are domain-based,
and `ios/project.yml` narrowly allows insecure HTTP for `ts.net` subdomains.
Bonjour does not cross the tailnet, so remote pairing uses manual address
entry.

Tailscale is optional. There is no OpenMausBot-operated relay or cloud copy of
the local data in this design.

## Pairing and device security

1. The user enables Companion in desktop Settings and starts pairing.
2. The desktop opens a two-minute pairing window. Its QR contains the reachable
   address and a high-entropy, single-use credential; the visible six-digit code
   remains available for manual entry and older app builds.
3. The phone scans and validates the invitation, shows the computer and address,
   and asks the user to confirm before it connects. Scanning never auto-pairs.
4. The phone sends the one-time credential and a device name to `POST /api/pair`.
   Redeeming either the QR credential or manual code closes the entire window,
   so neither can be replayed.
5. The sidecar returns a separate random device token once and stores only its
   SHA-256 digest.
6. The phone stores the device token in Keychain and sends it as a bearer token.
   It never persists the QR credential or manual code.
7. Revoking the device on the Mac invalidates future requests and sends the
   phone back to pairing.

This mirrors the direct-pairing security shape used by T3 Code: a high-entropy
bootstrap credential, explicit confirmation of the scanned target, and a
one-time exchange for a securely stored long-lived credential. An OpenMausBot
account is not required because the phone connects directly to the user's Mac;
authentication would only become necessary for a future hosted relay.

The device-facing socket rejects browser `Origin` headers before reading a
token. Its route policy in `companion/src/routes.ts` is default-deny: a new
harness route remains unreachable until it is deliberately added.

Allowed in the first release:

- Read the fleet, rooms, instances, configuration status, and transcripts.
- Fetch settled screen images and opt into live screen frames.
- Request a fresh interactive cloud-desktop viewer only when the computer
  owner has enabled that capability for this specific paired phone.
- Send messages, interrupt bots, answer approvals/questions, and mark chats
  read.
- Create a basic bot.
- Edit only the paired-safe profile fields: identity text, agent notification
  preference, avatar URL/shape, voice id, and spoken-reply preference.
- Upload/fetch app-owned raster avatars (10 MB maximum) and ask the computer to
  generate one using its already-configured shared image-provider key.
- List voice labels, select a per-agent voice, and receive synthesized preview
  audio from the computer's shared ElevenLabs configuration.
- List/create/edit/pause/resume/run/delete routines and read their run receipts.
- List connected-app account ids/aliases/status, start external OAuth with an
  explicit alias for additional accounts, and disconnect one exact account.

The write surface uses purpose-built `read`, `always-allow`, and
`PATCH /api/bots/:id/profile` endpoints. The profile route rejects every field
outside its safe allowlist. General bot and room `PATCH` endpoints are not
reachable through the sidecar.
An always-allow request succeeds only when its server-issued key is still on a
pending approval for that bot, so possession of a device token is not enough
to invent a broad execution grant.

Intentionally refused:

- API keys and provider configuration.
- Pairing, device revocation, or companion lifecycle control.
- Local VM lifecycle, webhook creation/rotation/signing secrets, team
  import/export, and internal peer-agent routes.
- Bulk or implicit connected-app removal. The phone can remove only an exact
  opaque account id already proven to belong to the requested toolkit/user.
- Routine-run cancellation/receipt mutation and arbitrary cron/RRULE input;
  the native feature uses the existing once/selected-days schedule contract.
- Cloud computer provisioning, sleep, shell execution, and screenshot APIs.
  The phone receives only the fresh `join` viewer URL, never the provider key.
- New harness routes that have not been reviewed for phone access.

## Stream and state model

`CompanionCore` contains the wire models, client, raw-byte SSE parser, and pure
state fold. The SwiftUI target owns lifecycle and presentation only.

On connection, the server sends a `hello` frame containing a cursor and whether
the requested gap was replayed. The client:

1. resumes from its last `<streamId>:<seq>` cursor;
2. folds replayed and live frames when the gap is available;
3. hydrates the newest page of each visible conversation when it is not; and
4. paginates older transcript pages on demand.

Unknown message and frame kinds degrade safely instead of failing an entire
response, and one malformed fleet record does not hide every healthy chat.
Screen frames are off by default and enabled only while a computer view is
visible. Backgrounding deliberately closes the stream; foregrounding
reconnects from the saved cursor. A hello cursor is committed only after a
cold hydration succeeds; replayed streams advance it one folded frame at a
time, so a disconnect during recovery cannot skip the remaining gap.

## Source layout

```text
companion/
  src/routes.ts       device-facing allowlist
  src/devices.ts      pairing and token registry
  src/proxy.ts        HTTP/SSE forwarding and scrubbing
  src/control.ts      loopback-only control plane
  src/mdns.ts         Bonjour advertisement

ios/
  Sources/CompanionCore/   models, HTTP, SSE, state fold
  Tests/CompanionCoreTests/ captured-contract and core tests
  App/                     SwiftUI, lifecycle, discovery, Keychain
  project.yml              generated Xcode project specification
```

## Verification contract

The merge gate for this feature is:

```sh
pnpm typecheck
pnpm test
pnpm build:companion
pnpm check:electron

cd ios
swift test
xcodegen generate
xcodebuild -project OpenMausCompanion.xcodeproj \
  -scheme OpenMausCompanion \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

The simulator validates compilation, launch, layout, manual address parsing,
profile/routine/connector screen construction, and failure states. The focused
contract suites also pin old/new avatar decoding, notification target parsing,
and every newly allowed sidecar method/path. Bonjour, Local Network permission,
Tailscale routing, Keychain behavior across a reboot, avatar upload/generation,
OAuth return, audio playback, exact-task notification taps, and approval
delivery still require a real-iPhone pass.

## Follow-on releases

Keep the foundational merge separate from capabilities that widen security or
distribution scope:

1. **Foundation:** sidecar, desktop controls, Swift core/app, pairing, chat,
   approvals, reconnect, simulator and contract CI.
2. **Desktop conversation parity:** task create/switch/rename/delete, SQLite
   search with exact-message landing, transcript export/share, reactions, and
   edit/version controls. Archived or hidden chat management remains desktop-only.
3. **Profiles and workspace parity:** paired-safe identity/avatar/voice,
   Tasks & Routines, multi-account connector aliases, and exact-task
   notification taps are in the app. The iPhone's compact custom-avatar roster
   is the native equivalent of desktop's collapsible avatar rail; a literal
   desktop sidebar and iPad split view are outside this release. Lock-screen
   Live Activities retain the deterministic mascot because the widget extension
   is deliberately not given the paired-device token or private avatar bytes.
4. **Notifications:** native permission, live/replayed alerts, time-sensitive
   approvals, badges, exact-task routing, and background reconciliation are in
   the app. Closed-app delivery still requires project-owned APNs credentials
   and a hosted relay; Tailscale cannot wake a terminated iOS process.
5. **Distribution:** signing, bundle ownership, privacy declarations,
   TestFlight, and App Store review material. Swift tests and an unsigned
   simulator build already run in the repository CI.
6. **Optional expansion:** live call mode, webhook administration, Local VM or
   host-computer interaction, iPad split view, or a hosted relay. Each requires
   its own threat-model and platform review.
