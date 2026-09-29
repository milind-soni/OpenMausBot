# OMB Cloud Pro: the home machine

Cloud Pro gives one person an always-on OpenMausBot server of their own. Each
customer gets one Fly app with one `home` machine that is always on, a volume
at `/data`, and TLS at `https://<app>.fly.dev`. The desktop app, the phone and
the web are windows onto it. Local use of the app is unchanged and free.

Cloud Pro includes no AI usage. The person signs in on their machine with their
own Claude or ChatGPT subscription, or an API key, through the same sign-in
flows as any OpenMausBot server. Nothing on a Cloud home is routed to a
platform model gateway.

This page is the OpenMausBot half of a contract with three parties:

- **the home machine**: this repository's `deploy/fly/` image;
- **the Admin** (openmaus-cloud, `docs/consumer-cloud.md` there): provisions
  the app, holds the machine's signing secret, and answers the desktop's Cloud
  session;
- **the desktop app**: signs in to Cloud, lists the machine under Servers,
  and offers **Connect to my Cloud**.

Contract version: `1` (`cloudContractVersion` on the wire).

## What the person sees

1. They subscribe on the Cloud site. The Admin creates the Fly app and machine.
2. They open the desktop app, go to **Settings → OMB Cloud** and sign in (the
   existing device sign-in). A **Your Cloud** card says **Setting up** until
   the machine is up.
3. When it is ready, the machine appears under **Servers** as **My Cloud**, and
   the card offers **Connect to my Cloud**. One click opens the machine in the
   app window, signed in. There is no second confirmation.
4. The first thing the Cloud shows is its engine sign-in
   (`src/components/CloudEngineSignIn.tsx`), with three choices:
   - **Sign in to Claude**: the existing paste-code flow (open Anthropic's
     page, paste the code back);
   - **Sign in to ChatGPT (Codex)**: the existing device-code flow;
   - **Use an API key**: the existing model-provider keys in **Settings →
     Connections** (Anthropic, or an OpenAI-compatible key such as OpenRouter).

   It says plainly that the account's plan limits apply to bots running 24/7,
   and that a Claude Max plan or an API key is recommended for heavy use.
5. Until one of those engines can run, every bot on the Cloud, including the
   default one, shows this sign-in rather than a chat that fails its first
   turn. Once one can run, the chat takes its place. Sign-ins stay on the
   machine's volume (`~/.claude`, `~/.codex`, the server's own config).

The Cloud's `GET /api/auth/session` answers `"cloudHome": true` for a paired
session; that is how the web UI knows to open the engine sign-in instead of
the welcome flow, which describes the person's own computer (it can still be
replayed from Settings). A paired session without admin scope (a phone paired
as a client) is not shown the sign-in, since it cannot sign engines in.

The card shows one of: **Setting up**, **Ready**, **Stopped**, **Payment
problem**, **Could not be set up yet**. Only Ready can be connected to.
Signed out of Cloud, the app makes no Cloud request and nothing on this page
runs.

### Open in the app: `openmausbot://cloud`

The Cloud page (`https://cloud.openmausbot.com/cloud`) can offer **Open in the
app** as a link to exactly `openmausbot://cloud`. The app accepts that string
and nothing else: no path, query, fragment or trailing slash, and it ignores
any other form. Like `openmausbot://organization`, it is an action, not a
router. It never carries an address, a pairing code or a credential; the app
decides everything from its own verified state (`electron/cloud-entry.mjs`).

1. The link starts the app, or brings it forward if it is already running
   (launch argument, a second instance, or macOS `open-url`, including one
   that arrives before the app is ready). If the window already shows
   **My Cloud**, coming forward is all it does.
2. Otherwise the window returns to this computer (a hosted server that was
   showing stays saved under **Servers**) and opens **Settings → OMB Cloud**.
   Before that view acts, the app gives a saved Cloud sign-in up to five
   seconds to finish restoring, so it is never mistaken for signed out.
3. Opened this way, the view acts on its own, with no confirmation:
   - signed out: it starts the existing device sign-in at once, which opens
     the browser approval page with the code filled in
     (`/cloud/desktop?code=…`);
   - signed in and the Cloud is **Ready**: it connects to **My Cloud**,
     exactly like **Connect to my Cloud**;
   - after that sign-in completes, or when the Cloud becomes **Ready** while
     the view is still open, it connects then;
   - anything else: the card shows the status and the person decides.

It starts at most one sign-in (only when signed out on arrival; a later
sign-out in that view starts nothing) and one automatic connection per link.
A failed connection shows the card's error; clicking the link again retries.
Closing Settings or choosing another section ends it. While it is open, the
first-run welcome waits, as it does for Organization settings. A normal visit
to **Settings → OMB Cloud** never signs in or connects by itself.

The link does nothing in development builds, and in companion client mode it
explains that the app must be disconnected from the other computer first.
The `openmausbot` scheme belongs to the installed app: on macOS through the
app bundle, on Linux through the `.deb`'s desktop entry, and on Windows (and
for an AppImage) once the installed app has started at least once, since it
registers itself at startup. Before that, or if the app is not installed, the
browser has nothing to open (it shows nothing or an error), so the Cloud page
should keep a download link next to the button.

## Let my Cloud use this Mac

The Cloud is home: bots and chats live there. The person's Mac is a computer
the Cloud can borrow while it is awake. Lending is off until the person turns
it on, and it exists only between their own desktop app and their own Cloud
home. Other users (desktop only, self-hosted, hosted team workspaces) keep
computer sharing exactly as before: off unless a maintainer sets
`features.sharedComputers` by hand.

### What the person sees

In **Settings → OMB Cloud**, the **Your Cloud** card has a **Let my Cloud use
this Mac** switch under **Connect to my Cloud** (it is part of connecting, not
a dialog). Turning it on shows what can be lent; each change applies at once,
with no confirmation. The switch and the chosen scopes are the consent.

- **Folders**: chosen with the folder picker. Read-only by default; **Can
  edit** lets bots create files and overwrite them, but only after reading the
  current version (the overwrite is checked against its hash). Nothing is ever
  deleted. At most 256 KiB per file, no symbolic or hard links. The home folder
  and anything above it cannot be chosen.
- **Apps and screen**: bots see the screen and use apps as the person, through
  this app's own computer control (the signed app holds Accessibility and
  Screen Recording; the Cloud never does). This is broad by nature, since it
  reaches anything those apps can, and the switch says so. It needs local
  computer control set up first.
- **No terminal.** The shell grant of maintainer sharing is never offered here.

The switch can be turned on before the first **Connect to my Cloud**; lending
starts once this Mac is signed in to the Cloud. Below the choices, **Activity
on this computer** lists every request the Cloud made, refused ones included.

While lending is on, a menu-bar item shows it (**In use** while the Cloud is
running something on this Mac) with **Stop lending**. Turning the switch off or
choosing **Stop lending** stops at once: the Cloud is told, a running action
is cancelled (the computer-control transport is closed and the screen lease
released), and nothing more runs. An action an app had already started may
still finish.

### How it is enforced

On the Mac (the authority; `electron/computer-sharing.mjs`,
`electron/shared-computer-access.mjs`):

- **Outbound only.** Electron main dials the Cloud's HTTPS address with this
  app's own session cookie and a per-grant 256-bit secret; there is no
  listening port. The Cloud can only answer the Mac's long poll.
- **Bound to the account and the machine.** The grant records the Cloud
  account id and the machine's origin from the verified Cloud session
  (`cloud-account.mjs`), and the Cloud home's environment id on first contact.
  Signing out of OMB Cloud, another account signing in, the Cloud moving to
  another machine, or another server answering at that address ends lending
  and switches it off (turning it back on is the person's choice). A Cloud
  sign-in that must be renewed pauses lending; a minute's re-verification or an
  unreachable Admin does not. The server must say it is a Cloud home
  (`cloudHome: true`) and this Mac's session there must be one of the owner's
  admin devices. Lending never reads the maintainer flag and it never goes to
  any other server.
- **Every operation is checked against the grant here**, whatever the server
  says: the folder must be lent, writes need **Can edit**, screen actions need
  apps and screen. Jobs are validated against the server's schema first.
- **What folders never reach**, read-only or not: this app's data and grants,
  keys and sign-in stores (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`,
  `~/.claude`, `~/.codex`, keychains, browser profiles and cookies…) and places
  that run code (`~/Library/LaunchAgents`, git and shell configuration,
  `~/.local/bin`), decided by filesystem identity rather than spelling. Writes
  inside any `.git` directory are refused.
- **Screen tools are an allow-list** of observation and input. The local
  driver's tools that work outside the screen (uploading a file by path,
  recording or replaying to a path, configuration, installing, DevTools,
  killing a process) are refused and hidden.
- **Activity log**: `lending-activity.jsonl` in the app's data folder, owner
  only, last 500 entries: time, action, folder and relative path or tool name,
  and whether it ran. Never contents, output or typed text.

On the Cloud home (`server/shared-computers.ts`, `server/index.ts`):

- Lending is on for every Cloud home, with no maintainer flag.
- Only the owner's admin sessions (the Admin's signed pairing gives the
  desktop one) can lend. A chat-only device the owner paired cannot.
- The server refuses operations outside the scopes the Mac registered before
  queuing them, never retries an operation with an unknown outcome, and never
  substitutes its own files for an offline Mac.
- A Cloud home is one person's server, so every turn on it acts for that
  person: a conversation, a routine or a webhook can use the lent Mac within
  its scopes. Anyone the owner pairs to their Cloud can direct its bots, and so
  reach what is lent; pair only your own devices. A bot whose **Computer**
  setting is off cannot use lent apps and screen.

### What the Cloud can see: `GET /api/shared-computers`

For the Cloud UI and the next step (placing a step on the Mac, "Waiting for
your Mac"). Client scope; on a Cloud home every session sees the person's lent
computers, elsewhere a session sees only its own person's. No secrets, no
local paths.

```json
{ "computers": [ {
  "id": "5b3e…", "name": "MacBook-Pro",
  "online": true, "busy": false, "lastSeenAt": 1790000000000,
  "scopes": { "folders": [ { "id": "9f1c…", "name": "Plans", "write": false } ], "terminal": false, "screen": true }
} ] }
```

`online` is false once the Mac has not polled for 40 seconds (asleep, app
closed, offline); the entry stays until lending is stopped, the Mac's session
ends, or 14 days pass. The list is in memory and empty after the Cloud
restarts, until the Mac registers again (within seconds of being online).
Server code can call `sharedComputers.status(principal)` directly. Bots use
the `list_shared_computers` and `shared_computer` tools.

## The image

`deploy/fly/Dockerfile` builds on the published server image
(`ghcr.io/milind-soni/openmausbot`) and adds:

- the engine CLIs from `ENGINES` (default Claude Code and Codex; the base
  image already carries agent-browser and its Chrome);
- Caddy, as the only listener the network can reach (`0.0.0.0:8080`);
- `server/cloud-home-start.ts` (bundled to `dist-server/cloud-home-start.js`)
  as the entry point.

```sh
docker build -t openmausbot .
docker build -f deploy/fly/Dockerfile --build-arg BASE_IMAGE=openmausbot -t omb-cloud-home .
```

At boot the launcher, running as root only for this step, hands the volume's
mount point to the `maus` user, drops privileges for good, binds the volume to
this machine (`/data/.omb-cloud-home.json`; another machine's volume, or an
unmarked volume with data on it, is refused), and runs two children: the
server on `127.0.0.1:8799` (webhooks on `127.0.0.1:8800`) and Caddy on
`:8080`. If either exits, both stop and Fly restarts the machine.

`HOME=/data`, so `~/.claude`, `~/.codex` and OpenMausBot's own data
(`/data/.openmausbot`) persist on the volume.

### Why the server stays on loopback

`server/request-auth.ts` treats an unproxied loopback request as the
machine's owner. The server therefore never binds a public interface. Caddy
(`deploy/fly/Caddyfile`) forwards every request with `X-Forwarded-Proto:
https` and `X-Forwarded-For`, so the server sees each one as remote: it needs
a paired session, whatever `Host` it claims. Caddy trusts `Fly-Client-IP`
only from Fly's private ranges; that address feeds the pairing lockout, never
authorization. Apart from `/api/health`, Caddy answers only for the machine's
own name (`OMB_PUBLIC_URL`) and refuses any other `Host`.

### Fly

The Admin creates the machine through the Machines API; `deploy/fly/fly.toml`
is the same shape for a manual deploy: `internal_port = 8080`, `force_https`,
no auto-stop, one machine always running, a volume `omb_home` at `/data`,
restart policy `always`, and an HTTP check on `GET /api/health` (it answers
`{"app":"openmausbot"}` with no session). Each customer's app lives in its
own Fly private network, so no machine can reach another's over 6PN.

## Boot contract

Set by openmaus-cloud's provisioner (`server/cloud-machines.ts`). Any of the
first four switches the server into Cloud home mode; then all of them are
required and the whole contract is validated. A partial or invalid contract
stops the server before it serves, with a message that names the variable and
never echoes a secret.

| Variable | Fly | Value |
| --- | --- | --- |
| `OMB_CLOUD_ROLE` | env | `home`. (`desktop` belongs to the Cloud desktop image and is refused here.) |
| `OMB_CLOUD_MACHINE_ID` | env | The Admin's machine id (a UUID). Binds the volume. |
| `OMB_CLOUD_ADMIN_URL` | secret | The Cloud origin, exact `https://`, e.g. `https://cloud.openmausbot.com`. |
| `OMB_CLOUD_BOOTSTRAP_SECRET` | secret | 43 base64url characters (256 bits): the key the Admin signs pairing requests with. |
| `OMB_PUBLIC_URL` | env | The machine's exact `https://` origin, `https://<app>.fly.dev`. |

- The machine must not also carry `OMB_ADMIN_URL`, `OMB_ADMIN_WORKSPACE` or
  `OMB_ADMIN_MEMBERSHIP`: a Cloud home is a personal server with pairing codes
  on, not a hosted team workspace with portal membership.
- `HOME=/data` and `OMB_DATA_DIR=/data/.openmausbot` are set by the image.
- The server keeps the secret in memory and removes it from its environment at
  startup; no engine or tool it starts ever inherits it.

### No model gateway

Cloud Pro includes no AI, so the contract has no model gateway. If a Cloud
home is ever given `OMB_HOSTED_MODEL_URL`, `OMB_HOSTED_MODEL_TOKEN` or
`OMB_HOSTED_MODELS` (an Admin from before this decision set all three), it
still boots, logs one warning naming the variables (never their values), and
ignores them:

- the launcher drops them from the server's environment, and the server drops
  them from its own at startup, so no engine or tool ever sees them;
- the portal workspace model policy (`server/hosted-models.ts`) stays off on a
  Cloud home whatever they hold, so no instance is routed to a gateway;
- no `included.*` or other read-only instance is served; the person's own
  engines are the only way to a model.

### Included Boat computers and voice

Pro includes Boat cloud computers and ElevenLabs voice with no key to paste.
When the Admin has both services configured, it also sets:

| Variable | Fly | Value |
| --- | --- | --- |
| `OMB_CLOUD_BOAT_URL` | env | `https://cloud.openmausbot.com/api/cloud/services/boat/api/box/v1`, the Admin's Boat relay. It keeps Boat's own `/api/box/v1` ending, so the Computer engine's model catalog (`<root>/api/provider-models`) resolves through the relay too. |
| `OMB_CLOUD_BOAT_TOKEN` | secret | This machine's Boat relay token (`box_omb_…`). It is not a Boat key and works only through the relay. |
| `OMB_CLOUD_VOICE_URL` | env | `https://cloud.openmausbot.com/api/cloud/services/voice/v1`, the Admin's voice relay. |
| `OMB_CLOUD_VOICE_TOKEN` | secret | This machine's voice relay token (`omb_voice_…`). |
| `OMB_TTS_DEFAULT_VOICE` | env | An ElevenLabs voice id, used until the person picks a voice or another speech provider in Settings. |

A service is included only when both its URL and its token are set
(`server/included-services.ts`). The real Boat and ElevenLabs keys stay on the
Admin, which checks the subscription, the monthly caps and which computers
belong to this machine on every request.

- **The person's own key always wins.** An included token is a fallback, used
  only while the person has no key of their own: none saved in Settings
  (`box.token`, `tts.key`) and no `BOX_TOKEN` or `OMB_TTS_KEY` in the
  environment. Adding a key switches to it at once; removing it falls back to
  the included service again (for Boat, once that key's cloud computers are
  deleted: removing a Boat key that still has computers is refused). The
  choice is made on every request.
- **Each credential goes to one place.** The relays know only the Admin's
  accounts, so an own key goes only to the provider (`OMB_BOX_API` or
  `OMB_ELEVENLABS_API` when set, for development and tests, else Boat's and
  ElevenLabs' own APIs) and an included token only to its relay.
- **An included token is never the person's key.** It is never written to
  `config.json`, never sent to a client (Settings sees `configured` and
  `included: true`, and says "Included with Cloud Pro"), and Settings never
  verifies, rotates or clears it. Boat's account-change rules still apply:
  adding an own Boat key while included cloud computers exist is refused until
  they are deleted, because the new account cannot reach them.
- **What holding the tokens does and does not do.** The server reads both
  tokens at startup, keeps them in memory and removes them from its
  environment, like the bootstrap secret, and they are on the credential list.
  So no process the server starts inherits them, including tools that copy
  its environment as it is (the browser, docker, ssh, MCP bridges). It does
  not make them unreadable: the launcher starts the server with them, so the
  server's `/proc/<pid>/environ` keeps its startup environment, and an engine
  running as the same user (a bot with a shell) can read a relay token there.
  That is accepted because a relay token is only this customer's own Cloud Pro
  allowance: it works only through the Admin, only on this machine's cloud
  computers and voice, and only up to the monthly caps. Whoever holds it can
  at worst use up this month's included hours or voice characters; it opens
  no other customer's data and none of the Admin's provider keys.
- A refusal from the relay (for example, the month's cloud computer hours are
  used up) is shown as the relay's own message. A resume that fails with a
  server error is retried on the next poll, as Boat asks.

## Pairing: the Admin's signed request

`POST https://<app>.fly.dev/api/cloud/pairing`

```http
POST /api/cloud/pairing
Content-Type: application/json
x-omb-cloud-timestamp: 1790000000
x-omb-cloud-nonce: <base64url, 16–128 characters>
x-omb-cloud-signature: v1=<base64url HMAC-SHA256(OMB_CLOUD_BOOTSTRAP_SECRET, canonical)>

{"label":"OpenMausBot app (Cloud)","ttlSeconds":300}
```

where `canonical` is

```text
v1\n<timestamp>\n<nonce>\nPOST\n/api/cloud/pairing\n<base64url SHA-256 of the raw body>
```

`200`:

```json
{ "code": "ABCD-EFGH-JKLM", "credential": "omb_pair_…", "expiresAt": 1790000300000 }
```

`code` and `credential` are two encodings of **one ordinary pairing window**
(`server/sessions.ts`): single use, admin and client scopes, redeemed at the
machine's existing `POST /api/auth/pair`.

| Status | Body | Meaning |
| --- | --- | --- |
| `401` | `{"error":"invalid_signature"}` | Wrong key, tampered request, or malformed headers. Counts toward the per-source pairing lockout. |
| `401` | `{"error":"stale_request"}` | Timestamp more than 300 s from the machine's clock. |
| `401` | `{"error":"replayed_request"}` | Nonce already used in the last 10 minutes. |
| `429` | `{"error":"rate_limited","retryAfterSeconds":n}` | Too many bad signatures from this source. |
| `400` | `invalid_body`, `invalid_label`, `invalid_ttl` | Not a JSON object; label not plain text of 80 characters or fewer; TTL not a positive integer. |
| `405`, `415` | | Not a POST; not JSON. |

Rules the machine enforces: the signature is checked first, in constant time;
the timestamp within ±300 s; each nonce refused for 10 minutes; `ttlSeconds`
defaults to 300 and is capped at 600; nothing about the request (headers, body
or code) is logged. Nonces live in memory, so a restart forgets them; a
captured request is still bounded by its five-minute timestamp window and TLS.

## What the desktop reads from the Admin

The desktop polls `GET /api/cloud/desktop/session` with its personal device
token (`Authorization: Bearer omc_…`). Contract version 1 adds:

```json
"cloud": { "state": "ready", "origin": "https://omb-u-1a2b3c4d5e6f.fly.dev", "pairingAvailable": true }
```

- `null` or absent when the account has no machine; the app then shows nothing new.
- `state` is `setting_up`, `ready`, `stopped`, `payment_problem` or `failed`.
  `origin` is required for `ready`. Any other state (including the retired
  `allowance_used`) is treated as no machine. Other fields, such as a retired
  `allowance`, are ignored.

**Connect to my Cloud** first asks the machine whether this app is already
signed in there (`GET <origin>/api/auth/session` with its cookie). If not, it
calls `POST /api/cloud/desktop/pairing` (same device token) and expects
`{"cloudContractVersion":1,"origin":…,"code":…,"expiresAt":…}` for the same
origin, with `expiresAt` at most ten minutes away. It then adds or selects the
**My Cloud** server entry and opens `<origin>/pair#code=<code>`, the same
pairing-link flow as Connect to a server. The code stays in main-process
memory for that one navigation: never on disk, never in a renderer. A
malformed session summary or grant is treated as none.

## Security summary

- The server never listens on the network; only Caddy does, and nothing it
  forwards is the loopback owner.
- Pairing windows are opened only for a request signed with the machine's
  secret, fresh and never replayed; each window is single use and short lived.
- The signing secret is removed from the server's environment at startup and
  is never passed to engines or to Caddy.
- There is no platform model gateway: stray `OMB_HOSTED_*` settings are
  ignored with one warning and never reach the server's environment or an
  engine. Every model call uses the person's own sign-in or key.
- A volume binds to one machine and is never adopted by another.
- Each customer's app lives in its own Fly private network.
- A lent Mac is reached only through its own outbound connection, within the
  scopes the person chose, which the Mac itself enforces (see "Let my Cloud use
  this Mac").

## Published image

Every push to `main` and every release tag publishes the home machine image as
`ghcr.io/milind-soni/openmausbot-cloud-home`, tagged `latest` (main only), `sha-<commit>` and the release tag.
It is built from `deploy/fly/Dockerfile` on top of the server image for the same commit, with Claude Code and
Codex installed. The Docker workflow's summary prints the digest. Set it in the Admin as
`OMB_CLOUD_HOME_IMAGE=ghcr.io/milind-soni/openmausbot-cloud-home@sha256:…`; changing it rolls the new image
out to existing machines one at a time, reverting automatically on a failed health check.
