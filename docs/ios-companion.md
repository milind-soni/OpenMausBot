# iOS companion architecture

The iOS app is a thin, native client for the OpenMausBot instance running on
your Mac. The Mac remains the only machine that persists agent processes,
credentials, SQLite data, transcripts, and computers. The iPhone trusts a Mac
by scanning the QR code shown in desktop **Settings → Remote access**; it does not need
an OpenMausBot account of its own.

## Use My Cloud on your phone

With MausBot Cloud, pair the phone with your Cloud instead of your computer, and
it keeps working while the computer is off.

1. In the desktop app, open the menu under your name and choose **Get the
   phone app**: the App Store for iPhone, or the APK for Android. Scan its code
   with the phone's camera.
2. In the same menu, choose **Connect your phone · to your Cloud (always on)**.
   (**Settings → MausBot Cloud → Use My Cloud on your phone** does the same.) The
   app opens your Cloud in its window, at the Cloud's phone pairing.
3. Choose **Create pairing code** and scan the QR code with the phone app.

On your computer, **Connect your phone** offers your Cloud first and this
computer second, once your plan is paid and your Cloud is Ready. Until the Cloud
is Ready it offers only *to this computer*, with a note that the Cloud will show
there. With the Cloud open in the app window, the entry reads *to your Cloud*
and pairs with it directly. On another server it pairs with that server, and it
is shown only to a session allowed to make pairing codes there.

## Current status

The first version includes:

- QR-first pairing from desktop **Settings → Remote access**, with the computer name
  confirmed on the iPhone before it connects.
- Hosted HTTPS for the default QR after the desktop owner enables it, with
  dedicated Tailscale and trusted-local QR routes only after an explicit
  choice.
- Nearby computers, a manual address, and a six-digit code under **Other ways
  to connect** when the QR path is unavailable.
- Secure per-device trust, device listing, and revocation.
- Multiple saved computers with a one-tap switcher. Each pairing has its own
  Keychain credential, and only the selected computer is connected at a time.
- Bot and room lists, paged transcripts, sending, interruption, and unread
  state.
- Approvals and questions, including narrow “always allow” grants.
- Resumable SSE, streamed reply text, reconnect hydration, and an opt-in live
  Boat computer view. The loopback-only VPS SSH viewer remains desktop-only.
- On-demand stills of a bot's Local VM, idle or working, for a phone the
  computer owner has allowed computer access.
- Markdown rendering and Keychain storage for the phone's pairing trust.
- Secure completion of supported credential-request cards using iOS Password
  AutoFill and QR-pinned HPKE encryption. Apple Passwords/iCloud Keychain is
  sufficient; 1Password, Bitwarden, and other AutoFill providers are optional.

Alerts work while the app is open or for the short period it remains connected
after moving to the background. Once iOS suspends or closes the app, the event
stream is gone; the harness can then wake the phone through Apple Push
Notification service, by way of a relay in the hosted control plane (see
[Closed-app alerts](#closed-app-alerts-apns) below). Voice and App Store
release automation are not part of this version. The optional hosted transport
connects to the user's own computer; it is not a cloud transcript store.

The Mac must be running OpenMausBot and must not be asleep. Desktop
**Settings → Remote access** offers an off-by-default **Keep this computer awake**
switch that prevents system sleep while device access is on; the display may
still turn off. A sleeping or powered-off computer cannot receive phone
requests or run its local routines, including through the optional hosted
transport.

## Markdown

Bot and room replies are rendered. Messages the person typed stay literal.

Rendered blocks are paragraphs, headings, lists, task lists, quotes, thematic
rules, fenced code, and top-level tables indented by at most three spaces. A
table inside a list item, a blockquote, or a fence stays text or code, as
does a row indented by four spaces or a tab. Inline emphasis, code,
strikethrough, and links use Foundation attributed text. A table scrolls
horizontally inside the bubble. A task item shows a checkbox, and an ordered
task keeps its number beside that checkbox.

The in-app spoken form reads each table row and each task's words. It skips a
delimiter-only paragraph and the checkbox token. Closed-app voice is not part
of this version.

## Runtime architecture

```text
 iPhone (pairing trust in Keychain; credential plaintext only while editing)
       │                         │
       │ trusted LAN/Tailscale   │ optional hosted HTTPS
       ▼                         ▼
 sidecar :8810          Cloudflare Tunnel (outbound connector)
                                 │
                                 ▼
                        guardian gateway 127.0.0.1:8812
                                 │ exact per-launch socket/pipe
                                 └──────────────┐
                                                ▼
 companion sidecar (pairing auth, default-deny allowlist,
 response/SSE scrubbing, authenticated endpoint refresh;
 credential ciphertext only)
            │ loopback only
            ▼
 OpenMausBot harness :8799
   HTTP API + event stream
   agent processes and approvals
            │ private Electron utility-process channel
            ▼
 OS-encrypted desktop credential store
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
| Hosted gateway | `127.0.0.1:8812` | Guardian-owned route to one exact sidecar generation |

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

The QR code is still the primary path on the same Wi-Fi. If it is unavailable,
the user can open **Other ways to connect** and choose a nearby computer or
enter the address shown in desktop Settings → Remote access. Nearby discovery does not
run until the user opens that fallback.

Nearby discovery uses Bonjour and direct LAN traffic. Use it only on a network
you trust.

Choosing a nearby computer or manually entering a LAN address is therefore an
explicit fallback. Once the app is using a hosted or Tailscale route,
automatic reconnection stays within those protected transports. Moving back to
direct LAN requires choosing that computer or address again.

### Tailscale

Tailscale is an optional route away from home and on Wi-Fi networks that
isolate clients. In desktop **Settings → Remote access**, the primary card remains
**Secure HTTPS pairing — Recommended**. The separate **Tailscale pairing**
card is only for people who already use Tailscale. Install or open Tailscale
on both devices, sign in to the same tailnet, leave MagicDNS enabled, and
choose **Turn on device access & check** followed by **Pair over Tailscale**.
That first action explicitly starts Remote access so the phone has a listener
to reach. OpenMausBot then places the computer's MagicDNS name in that
dedicated QR; it never silently replaces the default hosted HTTPS route.
Manual entry remains available as a fallback.

The URL is still `http`, but the path is encrypted and authenticated by
WireGuard inside the tailnet. Use the MagicDNS name rather than the
`100.64.0.0/10` address: App Transport Security exceptions are domain-based,
and `ios/project.yml` narrowly allows insecure HTTP for `ts.net` subdomains.

Tailscale is optional. The direct path does not use an OpenMausBot-operated
relay or create a cloud copy of local transcript data.

### Optional hosted HTTPS

In desktop **Settings → Remote access**, **Use your phone anywhere** accepts a
passwordless email code and provisions one HTTPS address for that computer.
This desktop sign-in is only for hosted HTTPS. The iPhone never signs in; it
trusts the computer through the same pairing QR. Nearby, manual, and Tailscale
connections continue to work without an account.

The desktop runs an outbound connector to Cloudflare, so no inbound router
configuration or Tailscale installation is required. The hosted address is
included in a pairing invitation only after it is ready. The default setup
waits for that HTTPS address instead of silently substituting Tailscale;
Tailscale pairing remains an explicit choice in its own optional card.

The address is held only while something needs it. The desktop creates it
when you sign in, choose Retry, or start pairing (a few seconds under the
"Creating secure remote access" spinner), keeps it while any phone or desktop
is paired, and gives it back one to four hours after Remote access shows
nothing paired and no pairing open. The next pairing gets the same address
back. If no HTTPS address is free, the panel says when to try again, and
Wi-Fi or Tailscale pairing still works.

Cloudflare terminates and proxies the encrypted connection to the connector.
The OpenMausBot control plane stores account and installation metadata plus
opaque tunnel/DNS identifiers in D1, but not bots, transcripts, approvals,
screen frames, pairing tokens, or connector tokens. See `docs/ios-privacy.md`
for data and deletion details.

The connector does not point at the reusable LAN port. Electron launches one
private sidecar socket (or Windows pipe) and a guardian that owns both the
fixed loopback gateway and `cloudflared`. If Electron or that sidecar exits,
the guardian first makes forwarding unavailable, confirms the connector is
dead, and only then releases the gateway. Another process that later binds a
local port cannot inherit the public route.

## Closed-app alerts (APNs)

When a bot needs the person (an approval, a question, a sign-in, a mention,
an incident, a turn that could not start, and the harness's other
notifications), the harness emits a `notify` frame. A phone whose app holds
the event stream shows it itself. For a phone whose app is suspended or
closed, the harness asks the push relay in the hosted control plane to wake
it. Proposal and decision: issue #2769.

```text
 harness ──(installation credential, HTTPS)──▶ control plane push relay ──(project APNs key)──▶ APNs ──▶ iPhone
    ▲                                                                                                    │
    └──────────────── the app opens and fetches the content over its usual connection ◀─────────────────┘
```

**Why a relay.** Apple accepts pushes for an App Store or TestFlight build
only when they are signed with the key of the team that publishes the app.
That key cannot ship inside every harness, and a harness may run on a VPS or
in a container rather than on the Mac. So the project's relay holds the key,
and each harness proves who it is with the installation credential it already
holds for the hosted transport (`omb_install_…`, from the desktop's hosted
sign-in, `openmausbot serve --tunnel`, or a fleet's
`OMB_INSTALLATION_CREDENTIAL`). The harness needs only outbound HTTPS. A
harness without that credential sends nothing; closed-app alerts are then
simply unavailable.

**Content-free.** A push carries the alert's kind, a title made from the
bot's and room's names, and opaque ids. Never the message text, a reply, a
command, a file path, or a secret. The title is the harness's own banner
wording, except that a sign-in request leaves out the website and a spend
notice its amounts. The app fetches everything else from the harness after
the tap.

**When the harness sends.** Only when the bot's own notification switch
produced an alert at all; when `features.phonePush` is on for the workspace
(the default; `PUT /api/config {"features":{"phonePush":false}}` turns it off);
when this phone has not opted out; when the phone may see that bot or room
(the same rule as its event stream); and when the phone holds **no** live
event stream. While the app is connected it shows the frame itself, so it is
never alerted twice. The harness also coalesces repeats of one kind in one
conversation for 10 seconds and caps each phone at 30 pushes per 10 minutes.

### What the iOS app implements

1. **Get a token.** After notification permission is granted, call
   `registerForRemoteNotifications()` and hex-encode the device token in
   lowercase. Entitlement `aps-environment`; the optional Time Sensitive
   Notifications capability lets approvals and questions break through Focus.
2. **Register it with each saved computer**, on the connection that computer
   already uses (the companion bearer token or the paired session; the
   harness keys the registration by that identity, never by anything in the
   body):

   ```http
   PUT /api/push/device
   {"token":"<lowercase hex>","environment":"production","pairing":"<tag>"}
   ```

   - `environment`: `"sandbox"` for development-signed builds,
     `"production"` for TestFlight and the App Store.
   - `pairing`: 8–64 characters of `[A-Za-z0-9_-]`, generated once per saved
     computer and kept with its Keychain pairing. Every push echoes it, so a
     tap opens the computer that sent it.
   - `enabled`: optional per-phone opt-out. `false` keeps the registration
     and sends nothing. Send it only when the person changes the setting:
     a registration without it keeps the phone's previous choice (on for a
     new phone), so the refresh sent on every launch never undoes an opt-out.

   It is idempotent; send it on every launch and whenever iOS issues a new
   token. The answer is `{"push":"on"|"off"|"no-account","device":{…},"relay":"registered"|"pending"|"off"}`.
   `no-account` means that computer has no hosted sign-in, so it cannot wake
   the phone; the app may say so in its notification settings.
3. **Read or remove it.** `GET /api/push/device` returns the same `push` and
   `device`. `DELETE /api/push/device` removes this phone's registration
   here and at the relay; call it when the person removes the computer from
   the phone. Revoking the phone on the computer removes it too.
4. **Handle the push.** The payload, built by the relay:

   ```json
   {
     "aps": {
       "alert": { "title": "Scout in Launch needs approval" },
       "sound": "default",
       "thread-id": "<threadId>",
       "interruption-level": "time-sensitive"
     },
     "omb": {
       "v": 1,
       "kind": "approval",
       "botId": "<botId>",
       "botName": "Scout",
       "threadId": "<threadId>",
       "roomId": "<roomId>",
       "roomName": "Launch",
       "pairing": "<tag>"
     }
   }
   ```

   `interruption-level` is `time-sensitive` for `approval`, `question`,
   `sign-in` and `mention`, and `active` otherwise. `roomId`, `roomName` and
   `pairing` are present only when known. Treat an unknown `kind` (a newer
   harness) as a plain alert, and an unknown `omb.v` as "open the app".
   Repeats for the same kind and conversation share an APNs collapse id, so a
   newer one replaces the older on the lock screen.
5. **Route the tap.** Select the saved computer whose `pairing` matches;
   only a push without `pairing` uses the current computer. If `pairing` is
   present but matches no saved computer (it was removed from the phone),
   open the app without navigating. Otherwise connect as usual and open
   `threadId`: in the room `roomId` when present, otherwise the bot `botId`'s
   conversation. Fetch the content through the existing API; the push has
   none to show.
6. **Foreground race.** If a push arrives while the app has just reconnected
   and is showing the same alert from the event stream,
   `userNotificationCenter(_:willPresent:)` may suppress it.

The wire contract between harness and relay (version 1) is
`shared/phone-push.ts`; the relay and the secrets it needs are described in
`cloudflare/control-plane/README.md`. Registrations live in
`push-devices.json` in the data directory (owner-only), keyed
`companion:<device id>` or `session:<session id>`. The relay stores only the
token, its environment and the installation it belongs to.

Known gaps: a phone unpaired through the companion sidecar while the harness
was not running keeps its registration until APNs reports the token dead or
the app deletes it, because the sidecar's unpairing notice is best effort.
The harness judges "app is open" by an open event stream; a stream held open
by a network middlebox after iOS suspended the app delays pushes until it
drops.

## Pairing and device security

1. On the Mac, open **Settings → Remote access** and choose **Pair a phone**. The app
   starts device access as part of setup.
2. On the iPhone, choose **Connect my computer** and scan the QR.
3. Confirm the computer name and the displayed transport — **HTTPS connection**,
   **Tailscale connection**, or **Trusted local connection**. The phone stores
   its trust securely in Keychain; no iPhone account is required. A camera QR
   also pins that computer's public credential-encryption key. Manual and old
   pairings can still chat, but must scan a fresh QR before entering a key on
   the phone.
4. If scanning is unavailable, open **Other ways to connect** for a nearby
   computer, manual address, or six-digit code.
5. Revoking the phone on the Mac removes its access and lets it pair again.

To add another Mac, open **Settings → Computers → Connect another computer**
on the iPhone and scan that Mac's QR. The existing computer stays usable if
the new pairing fails or is cancelled. Switching computers replaces the live
event stream and in-memory chat state, but keeps every saved pairing; removing
one computer deletes only that computer's Keychain credential from the phone.
An app upgrade migrates the previous single saved pairing automatically.

The Mac must remain awake with OpenMausBot running for chats, approvals, and
routines to work, including through hosted HTTPS or Tailscale.

After pairing, the phone periodically reads the authenticated, sidecar-owned
`GET /api/companion/endpoints` snapshot. This lets an existing phone learn a
new hosted address—or its withdrawal—without another pairing ceremony. The
route never reaches the harness and returns only the computer name plus a
bounded list of connection origins.

An OpenMausBot account is not required for nearby, manual, or Tailscale
connections. Only the desktop owner signs in when enabling the optional hosted
HTTPS route; the iPhone always uses the same QR trust flow.

### Secure credential entry

This is Password AutoFill, not a password-vault integration. A native
`SecureField` marked as a password lets the user explicitly choose Apple
Passwords or any enabled third-party AutoFill provider. OpenMausMobile does
not enumerate a vault, receive a provider token, or save the entered value in
its own Keychain.

The packaged desktop creates one stable P-256 recipient key pair and keeps the
private JWK inside its operating-system-encrypted credential document. Only the
65-byte uncompressed public point is added to a camera QR. The phone validates
and pins that point with the connection; manual and older pairings remain fully
usable for chat but cannot submit a credential until they scan a fresh QR.

Credential submission is enabled only while the phone is using hosted HTTPS or
a Tailscale route. Local and Bonjour chat pairing still work as before, but
their cleartext HTTP transport would expose the reusable device token to anyone
who could observe that Wi-Fi network, so the app directs the user to finish the
credential request on the computer instead.

Each submission uses RFC 9180 base-mode HPKE with P-256/HKDF-SHA256/AES-GCM-256
and authenticates this exact newline-separated context:

```text
openmausbot-phone-credential-v1
<key id>
<authenticated companion device id>
<bot id>
<thread id>
<message id>
<credential target>
<one-time request key>
```

The companion replaces any caller-supplied device header with the identity of
the bearer token it authenticated. The harness accepts only an allowlisted
target on the exact pending card, opens the ciphertext through its private
Electron channel, and waits for the encrypted desktop store and live config to
commit before it marks the card complete. Replays are idempotent; moving a
ciphertext to another device, bot, task, card, target, or computer fails
authentication. The native field is cleared immediately after local
encryption. If the response is interrupted, the app retains only that exact
ciphertext in memory and reuses it for Retry, so HPKE randomness cannot turn a
network retry into a second credential write. Nothing is persisted on the
phone. Development servers deliberately have no recipient key and fail closed
instead of advertising an unusable secure-entry route.

The device-facing socket rejects browser `Origin` headers before reading a
token. Its route policy in `companion/src/routes.ts` is default-deny: a new
harness route remains unreachable until it is deliberately added.

Allowed in the first release:

- Read the fleet, rooms, instances, configuration status, and transcripts.
- Fetch settled screen images and opt into live screen frames.
- Request a fresh interactive cloud-desktop viewer only when the computer
  owner has enabled that capability for this specific paired phone.
- With the same capability, fetch a still of a bot's Local VM
  (`POST /api/bots/:id/local-computer/screenshot`). The app always passes the
  conversation's `threadId`, so the harness answers 409 for a conversation
  that is not on the Local VM. This reads a picture; it cannot start, stop,
  remove the VM. Like the desktop panel's preview, each capture
  counts as use of the VM, so an open computer view keeps it from being
  reclaimed as idle; leaving the view or backgrounding the app stops that.
- With the same capability, drive the Local VM: take the bot's computer under
  a device control lease (`POST /api/bots/:id/computer/control`), then
  `POST /api/bots/:id/local-computer/join?controlLeaseId=…`. The harness answers
  that only for a loopback caller, only for a conversation on the Local VM,
  and only to the lease that holds the computer. The sidecar rewrites the
  loopback noVNC address into its device-scoped relay path, then asks the
  harness every few seconds whether that lease still holds
  (`action: "check"`, read-only) and closes the relay when it does not. The
  phone speaks RFB over the relay. Hand back closes the viewer and releases
  the lease, and so does backgrounding the app.
- A phone paired with the server directly (`openmausbot serve` behind
  Tailscale Serve or a tunnel, no sidecar) drives the Local VM the same way,
  but the join answers it with the server's own authenticated desktop proxy
  (`/api/desktop-viewer/local/<target>/websockify`), bound to its control
  lease, and the VNC password; never the loopback address. The proxy re-checks
  the lease and the session every few seconds and closes the socket when
  either lapses; hand back closes it at once. Computer access is the pairing's
  scope: Full access (`openmausbot pair`) may, chat-only (`--client`) is
  answered 403 and the app shows computer access as off.
- Phone control requires per-bot Local VMs. Shared and pool modes are refused
  on both connection paths until a viewer can reserve its desktop against
  other bots; a control hold on one bot alone cannot do that. Stills remain
  available in every mode.
- Send messages, interrupt bots, answer approvals/questions, and mark chats
  read.
- Register, read or remove this phone's own APNs token for closed-app alerts
  (`/api/push/device`). The sidecar's device id names the phone; the body
  cannot name another one.
- Create a basic bot.
- Submit a supported pending credential card as an RFC 9180 HPKE envelope
  bound to the authenticated device, bot, task, message, request, and target.
  Only the paired packaged desktop's embedded server and Electron private
  process channel receive the private key or plaintext; the sidecar, hosted
  relay, chat transcript, and SQLite store see ciphertext or status only.

The write surface uses purpose-built `read` and `always-allow` endpoints. The
general bot and room `PATCH` endpoints are not reachable through the sidecar.
An always-allow request succeeds only when its server-issued key is still on a
pending approval for that bot, so possession of a device token is not enough
to invent a broad execution grant.

Intentionally refused:

- Reading credentials, arbitrary credential targets, and general provider
  configuration. The only credential write is the exact pending-card envelope
  above, and it feeds the existing desktop OS-encrypted save path.
- Pairing, device revocation, or companion lifecycle control.
- Local VM lifecycle, webhooks, connectors, routines, team import/export, and
  internal peer-agent routes.
- Cloud computer provisioning, sleep, shell execution, and screenshot APIs.
  The phone receives only the fresh `join` viewer URL, never the provider key.
- New harness routes that have not been reviewed for device access.

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
visible. Backgrounding keeps the stream for only the short grace period iOS
allows, then closes it; foregrounding reconnects from the saved cursor. A hello
cursor is committed only after a cold hydration succeeds; replayed streams
advance it one folded frame at a time, so a disconnect during recovery cannot
skip the remaining gap.

## Source layout

```text
companion/
  src/routes.ts       device-facing allowlist
  src/devices.ts      pairing and token registry
  src/proxy.ts        HTTP/SSE forwarding and scrubbing
  src/origin.ts       private per-launch hosted origin listener
  src/control.ts      loopback-only control plane
  src/mdns.ts         Bonjour advertisement
```

## Verification contract

The merge gate for this feature is:

```sh
pnpm typecheck
pnpm test
pnpm build:companion
pnpm check:electron
```

The simulator validates compilation, launch, layout, manual address parsing,
and failure states. Bonjour, Local Network permission, Tailscale routing,
Keychain behavior across a reboot, and approval delivery still require a real
iPhone pass.

## Follow-on releases

Keep the foundational merge separate from capabilities that widen security or
distribution scope:

1. **Foundation:** sidecar, desktop controls, Swift core/app, pairing, chat,
   approvals, reconnect, simulator and contract CI.
2. **Desktop conversation parity:** task create/switch/rename/delete, SQLite
   search with exact-message landing, transcript export/share, reactions, and
   edit/version controls. Archived or hidden chat management remains desktop-only.
3. **Notifications:** native permission, live/replayed alerts, time-sensitive
   approvals, badges, and a brief background grace period are in the app.
   Closed-app delivery goes through the hosted relay with the project's APNs
   key ([Closed-app alerts](#closed-app-alerts-apns)); the harness side is in
   this repository, the app side registers its token and routes the tap.
4. **Distribution:** signing, bundle ownership, privacy declarations,
   TestFlight, and App Store review material. Swift tests and an unsigned
   simulator build already run in the repository CI.
5. **Optional expansion:** voice/call mode or Local VM/host-computer
   interaction. Each requires its own threat-model review.
