# Self-hosting the OpenMausBot server

Run the harness server on an always-on Linux box (a VPS, a home server, a
Mac mini in a closet) and pair browsers, the desktop app, or phones with it.
The npm CLI supports a managed public tunnel, Tailscale, or your own proxy.

> **Security first:** the server deliberately trusts only loopback — any
> process that can reach `127.0.0.1:8799` has full control, including the
> shell your bots can use. **Never expose that port directly and never bind
> it to a public interface.** Reach it through an SSH tunnel, a private
> network you trust, or an authenticated remote path below. Requests through
> the managed tunnel or a correctly configured proxy require a paired session.

Step by step, for a server you do not have yet: [Deploy OpenMausBot on a
VPS](deploy-vps.md) walks through the three ways in (public address, own
domain, Tailscale), signing engines in, pairing, keeping it running,
updating and backups. This page is the reference behind it.

## What works headless (and what doesn't)

Runs fully on a server:

- every engine CLI (Claude, Codex, Grok, custom ACP engines — install and
  log them in **on the server**)
- chats, rooms, bot-to-bot coordination, routines (they keep running with
  every laptop on the planet closed — this is the point)
- connected apps / custom MCP servers, webhooks, Company Brain
- computer use on **cloud or container computers** (the bot's computer runs
  server-side anyway)
- text-to-speech (with a key), the web UI (the server serves it itself)

- a browser for bots, once the engine is installed on the server
  (`npx openmausbot browser install`, or nothing to do in the Docker image,
  which ships it): each bot gets its own isolated, persistent session.
  Watching it live from the app is the next step (docs/plans/browser-engine.md).

Desktop-only for now (needs the Mac/Linux app):

- dictation/voice, controlling the host desktop

## Quickest: one command with Node

On any machine with Node 24 or newer (a VPS, a Mac mini, a Raspberry Pi):

```sh
npx openmausbot start
```

First launch asks you to choose AI access, connect an account or API key,
and choose the default model for new bots. Existing sign-ins can be reused;
Codex also offers device-code login for SSH. API-key connections currently
support chat, not agent tools or computer use. The [setup guide](cli-onboarding.md)
explains the choices, key storage, and how to run setup again safely.

It then starts the server and keeps your data in `~/.openmausbot`. If you
choose phone access, it prints a pairing link and QR code only after checking
the HTTPS connection. Choosing **Skip for now** keeps the workspace local-only
and creates no pairing invitation. Use `npx openmausbot setup` to configure without starting, or
`npx openmausbot serve` to start non-interactively with your existing config
(for services and scripts).

The npm package does not include engine CLIs (`claude`, `codex`, …); setup
can offer to install and sign in supported engines on this machine.
Run setup, engine authentication, and the server as the same unprivileged
operating-system user. Engine credentials live in that user's CLI-specific
directories, not all under `.openmausbot`.

For a Linux service, the [VPS guide](deploy-vps.md#before-you-start) shows the
account setup, engine installation, and browser dependency installation.
After installing browser libraries as administrator, also run
`npx openmausbot browser install` as the service user so that user's browser
is present. Three ways to make the server reachable from elsewhere:

- **On your Tailscale network, no domain needed:**
  `npx openmausbot serve --tailscale`. Tailscale terminates HTTPS with its
  own certificate and the link uses this machine's MagicDNS name, so only
  devices on your tailnet can reach it. Needs Tailscale signed in and HTTPS
  certificates enabled for the tailnet (admin console → DNS).
- **A public address, no domain, no proxy, no open port:**

  ```sh
  npx openmausbot login          # once: an emailed code signs this machine in
  npx openmausbot serve --tunnel
  ```

  `login` reserves an address like `https://c-….openmausbot.com` for this
  machine; `serve --tunnel` connects it through a Cloudflare tunnel (the same
  one the desktop app uses for its companion) and prints the pairing link at
  that address. The first run downloads `cloudflared` (pinned version and
  digest) into the data dir. Only traffic through the tunnel reaches the
  server, and it still has to pair: the tunnel lands on a separate listener
  the server treats as "through a proxy", never as the owner. `npx openmausbot
  logout` releases the address. The account credentials live in
  `~/.openmausbot/tunnel-account.json` (mode 0600).
  Starting it from a fleet or a container, where nobody can type an emailed
  code? Set `OMB_INSTALLATION_CREDENTIAL` to the installation credential the
  fleet issued and skip `login`: the address and connector token are fetched
  at every start and nothing is written to disk. A rejected credential stops
  the start with a clear message rather than serving locally.
- **Your own domain, still one command:**

  ```sh
  npx openmausbot serve --domain maus.example.com
  ```

  Point the domain's A record at this machine and open ports 80 and 443.
  The server downloads a pinned Caddy once into its data dir, writes the
  same Caddyfile the Docker stack uses, runs it as a child, and Caddy gets
  and renews the certificate from Let's Encrypt. On Linux, binding ports 80
  and 443 as a normal user needs one privilege grant; when Caddy reports the
  refusal, `serve` prints the exact `setcap` command to run once.
- **Behind your own proxy or domain:** `npx openmausbot serve --public-url
  https://maus.example.com`, with the proxy rules from "Putting a proxy in
  front".

Later: `npx openmausbot pair --label "Kitchen iPad"` for another device
(`--client` for one that may chat but not change settings), and
`npx openmausbot sessions` to see or revoke them. `openmausbot serve` is a
plain foreground process. For unattended use, follow the
[systemd example](deploy-vps.md#keep-it-running), which installs a chosen
release and runs its binary directly. Restarting that service does not
implicitly download a new release.

## Connect ChatGPT from the browser

An owner-paired browser can connect an installed Codex CLI without opening a
terminal: **Settings → Engines → Codex → Connect ChatGPT**. OMB starts
`codex login --device-auth` on the server and shows a one-time code. Choose
**Open ChatGPT sign-in**, enter the code on OpenAI's page, and complete sign-in
with your own account. OMB checks for completion and refreshes the model list.
You can cancel or request a fresh code after it expires.

The server still needs Codex installed and runs it as the same operating-system
user as OMB. Your password never goes through OMB; Codex stores its credentials
on the server. Treat server access and backups as sensitive. Device-code login
may need enabling in ChatGPT security settings or by your workspace admin; see
[OpenAI's headless authentication guide](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).
Subscription limits still apply. This browser flow is currently for Codex;
other providers retain their existing sign-in methods.

Once connected, Settings shows the account email when Codex can report it.
To switch accounts, open **Manage account and sign-in** under that line
and choose **Sign out of ChatGPT**: OMB runs `codex logout` on the server as
the same user and confirms with `codex login status`. New ChatGPT tasks need
a connected account. Stop running Codex tasks before switching: sign-out does
not cancel work already in progress. API-key logins are not removed by this
ChatGPT-specific action. A sign-in another browser is still completing is never
pulled away; finish or cancel it first.

## Connect a custom domain in Settings

For a self-hosted server, open **Settings → Remote access → Connect your
domain** from an owner-paired browser. This is an address-setting and verification
flow, not a DNS or hosting service. Enter the domain to see a compact DNS record
with copy buttons for **Type**, **Name / Host**, and **Value / IP**. The full
hostname is shown; providers that already append the DNS zone need only the
relative name (or `@` at the zone root). Server/proxy instructions are under
**Advanced server setup**.

The IP comes from this server's network interfaces, never the browser, tunnel
hostname or an IP-echo service. Only a single unambiguous public IPv4 is shown.
For containers/NAT or hosts with multiple public addresses, an administrator can
set `OMB_PUBLIC_IPV4` to the public IPv4 of the HTTPS proxy and restart OMB.
This is a display hint, not proof of reachability; verification still checks
HTTPS and the workspace identity. If the IP is missing or invalid, the UI asks
for administrator help instead of inventing a DNS value.

To configure the connection:

1. Point your chosen name's DNS **A** record at the server's public IPv4 address.
   Add **AAAA** only when IPv6 routes to the same server.
2. Configure HTTPS with a reverse proxy such as Caddy. The Settings example uses
   your actual app and webhook ports; the [supplied Caddyfile](../deploy/Caddyfile)
   is the reference. Keep OMB listening on loopback, forward the original Host
   and proxy headers, and keep event streams unbuffered. Caddy needs incoming
   ports 80/443 for its usual certificate setup. For containers, follow the
   Docker recipe below so Caddy can reach the loopback listener.
3. Enter `bots.yourcompany.com` (or its bare `https://` origin) and choose
   **Connect domain**. OMB checks HTTPS and the workspace identity at that
   domain before saving it. An incorrect domain leaves the existing address
   unchanged.

The saved custom address takes precedence over the server's configured public
address for **new server pairing links**. Removing it restores that fallback
address, if any; neither action changes DNS, the proxy, bots, conversations, or
existing sessions. A different browser origin needs its own pairing, so keep
your original tab open until the new one works. The setting does not change
`OMB_WEBHOOK_PUBLIC_URL`, existing webhook URLs, or the desktop companion's
managed connection. This feature is for self-hosted servers, not the desktop
app's managed phone endpoint.

## Docker (with HTTPS on your own domain)

For a single rootless Podman engine running the server, Caddy, and per-bot
desktops, see the optional [Podman full-stack recipe](../deploy/podman/README.md)
for Windows/WSL2 and Linux x64. It is separate from the Docker deployment below.

For local Docker Desktop or private Tailscale access without a public domain,
use the [local Compose setup](../deploy/local/README.md). It defaults to
`http://localhost:8080` and supports optional `.env` overrides.

One tenant = one container for the server plus Caddy for HTTPS.
Requirements: Docker with Compose, a DNS name pointing at the machine, and
ports 80/443 open.

```sh
git clone https://github.com/milind-soni/OpenMausBot && cd OpenMausBot/deploy
cp .env.example .env            # set DOMAIN
docker compose pull omb && docker compose up -d
```

That uses the image CI publishes on every `main` push
(`ghcr.io/milind-soni/openmausbot`, tagged `latest`, `sha-…` and `v…`).
To build from your checkout instead: `docker compose up -d --build`.

Then sign the engine CLIs in **inside the container** (their logins live on
the `data` volume, so they survive restarts and image upgrades) and mint a
pairing code for your first device:

```sh
docker compose exec omb claude                       # each CLI you listed in ENGINES
docker compose exec omb node dist-server/openmausbot.js pair # prints a code, a link and a QR
```

Open the link (`https://<DOMAIN>/pair#code=…`) in a browser and it is
paired; see "Using it from your computer" for what a session is. Webhook
URLs (`https://<DOMAIN>/hooks/wh_…`) work without a session, and that is the
base the app prints on new hooks because the stack sets
`OMB_WEBHOOK_PUBLIC_URL`.

What the stack does, so you can adapt it:

- [`Dockerfile`](../Dockerfile) builds the UI and the self-contained
  server bundle, and runs them as an unprivileged user with `HOME=/data`.
  `--build-arg ENGINES="…"` (or `ENGINES=` in `.env`) bakes engine CLIs
  into the image.
- [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) runs Caddy
  **in the server's network namespace**, so Caddy reaches the server on
  `127.0.0.1` and the server never binds anything public.
- [`deploy/Caddyfile`](../deploy/Caddyfile) terminates TLS and forwards
  the real `Host` plus `X-Forwarded-For`/`X-Forwarded-Proto`; the server's
  own pairing is the login. A shared-password `basic_auth` block is there,
  commented out, if you want a second wall in front of pairing.

Upgrade with `docker compose pull omb && docker compose up -d` (or
`git pull && docker compose up -d --build`). State (chats, routines,
engine logins, paired sessions) is on the `data` volume; back that up.

## From source

Requirements: Node 24+, pnpm, and at least one agent CLI installed and
signed in on the server.

```sh
git clone https://github.com/milind-soni/OpenMausBot && cd OpenMausBot
pnpm install

# choose where data lives and start the server
OMB_DATA_DIR="$HOME/.openmausbot" OMB_PORT=8799 \
  node --experimental-strip-types server/index.ts
```

For something durable, let the CLI write the service for you:

```sh
npx openmausbot service install --domain maus.example.com   # or --tunnel, --tailscale, or nothing
```

It renders a systemd unit (Linux) or a launchd agent (macOS) that runs the
same `openmausbot serve …` with your options, restarts it if it stops, and,
for `--domain`, grants the unit the capability to bind ports 80 and 443
without root. The file is written next to your data and the two commands
that install and start it are printed (they need `sudo` on Linux).
`openmausbot service uninstall` prints the reverse. Install the package
permanently first (`npm install -g openmausbot`): a service must not point
at an `npx` cache that npm may prune.

Engine CLIs read their logins from the service user's home: sign them in
from Settings → Engines (below), or as that user in a terminal, before you
rely on routines running unattended.

## Installing the engines without a terminal

Engines whose installer is an npm package (Claude Code, Codex, OpenCode,
MiniMax, pi) can be installed and updated from **Settings → Engines** when
npm is on the server's PATH. OMB runs `npm install -g` as its own user into
`<data dir>/tools/npm`, so nothing needs sudo and nothing touches a global
prefix; that folder goes ahead of everything else on the engines' PATH, so
the copy OMB installed is the one bots run. The package name comes from the
engine's own install descriptor, never from the browser. Engines installed
by a `curl | bash` script still need the command on the server.

## Provider keys, billed per token

**Settings → Connections → Model providers** takes the keys a whole workspace
runs on, for people who would rather pay per token than have every user sign
in. Keys are write-only: the page shows connected-or-not and a **Test** button
that makes one read-only request to the provider from the server.

- **Anthropic API key**: while one is saved, every Claude bot runs on it and
  Claude Code reports the real cost per turn to the usage ledger. Nobody has
  to sign in, and Settings → Engines shows "workspace API key" instead of a
  person. Remove the key to go back to personal logins. The server's own
  `ANTHROPIC_API_KEY` environment variable is deliberately ignored; use the
  page, `config.json`, or `OMB_ANTHROPIC_API_KEY`.
- **OpenAI-compatible API key and base URL**: OpenRouter by default, or Groq,
  Together, a gateway, or `https://api.openai.com/v1` for OpenAI itself. This
  powers the OpenAI-compatible engine. Codex has no key path by design and
  always uses a personal ChatGPT login.
- **xAI API key**: the Grok API engine and xAI image generation.

## Signing the engines in without a terminal

On a hosted server, the engine CLIs sign in from Settings → Engines:

- **Codex**: "Connect ChatGPT" shows a one-time code to enter on OpenAI's
  device page. Once connected, Settings names the account and offers
  **Sign out of ChatGPT** so a different person can connect their own.
- **Claude Code**: "Sign in to Claude" opens Anthropic's own sign-in page in
  your browser; after you sign in it shows a code, which you paste back into
  Settings. The server hands that code to the unmodified `claude` CLI once and
  never stores it; the login lands where Claude Code keeps it for the account
  that runs your bots. This is the sign-in Anthropic permits for a hosted,
  unmodified Claude Code with your own subscription; the bots then share that
  subscription's usage limits. Once signed in, **Manage account and sign-in →
  Sign out of Claude** runs `claude auth logout` for that account's
  configuration directory, confirmed with `claude auth status`, so a different
  person can sign in with their own subscription. Stop running Claude tasks
  before switching accounts: signing out does not cancel them.

## Using it from your computer

Pair once, then use the server from any browser on any machine that can
reach it. On the server:

```sh
npx openmausbot pair                         # npm install
pnpm omb pair                                # from a checkout
docker compose exec omb node dist-server/openmausbot.js pair   # Docker
```

It prints a 12-character code (single use, five minutes) and, when the
server knows its public address (`OMB_PUBLIC_URL`, set by the Docker stack),
a link like `https://maus.example.com/pair#code=XXXX-XXXX-XXXX`. Open the
link, or open `/pair` on the address you use and type the code. The browser
gets a session cookie (30 days, renewed on use up to 180 days from pairing, revocable) and the app loads. Sessions are
listed and revoked at `GET`/`DELETE /api/auth/sessions` for now; a Settings
screen follows.

From the **desktop app**, open **Settings → Remote access → Connect to another
computer**, choose **Self-hosted server**, and paste the full HTTPS pairing
link from your server. Custom domains and Cloudflare tunnel addresses work
here; Tailscale is not required. Generate a fresh link for each device (use
`npx openmausbot pair --client` for chat-only access). A code already used by
your phone cannot also pair your desktop.

Confirm the server address in the app's connection dialog, then finish pairing
on the server page. The app stays signed in across restarts. The **Server** menu
switches between Local and saved servers; **Add Server from Copied Pairing
Link…** remains available there too (on Windows and Linux press Alt to show
the menu bar). The separate **Desktop companion** option in Settings is for
the six-digit code from another desktop app, not a self-hosted server's
12-character code. While a remote server is
shown, this computer's screen, microphone, files and local control are not
offered to it. "Forget" signs the app out of that server; revoke the
session on the server too if the device is gone.

What this changes about the trust model: the server still binds loopback
and still trusts loopback as the owner. A **paired session** is the second
way in: a bearer token or the cookie, same-origin only, with a scope (`admin`
by default, `--client` for a device that may chat but not change settings or
pair others). Five bad codes from one address lock that address out for ten
minutes. Over plain HTTP (a LAN address without TLS) the cookie is not
marked `Secure` and travels in clear: use the Docker stack, Tailscale, or
another TLS front for anything beyond a trusted private network.

Native clients (CLI, scripts) send the token as `Authorization: Bearer …`
and take a 5-minute ticket from `POST /api/auth/stream-ticket` for the
event stream, because `EventSource` cannot set headers:
`GET /api/events?ticket=…`.

`GET /.well-known/openmausbot/environment` is public and tells a client what
it is talking to: a stable `environmentId`, the label, the version and
capabilities. Saved connections check the id so a reused address that now
points at a different server is refused loudly.

An SSH tunnel still works, and is the right answer when the server has no
address of its own:

```sh
ssh -L 8799:localhost:8799 you@your-server
# then open http://localhost:8799 — loopback, so no pairing needed
```

## Sign in with your email

A pairing code is fine for the owner's own devices. For a workspace other
people use every day, let them sign in with an emailed code instead: set an
allow-list, and `/pair` on your server offers "Sign in with your email" first.

```sh
OMB_SIGNIN_EMAILS="her@yourcompany.com, @yourcompany.com"   # full access
OMB_SIGNIN_MEMBER_EMAILS="freelancer@example.com"          # chat and approvals only
```

Signed in as an admin? Settings → Remote access → **Who can sign in with an
email** edits the same list in the browser, no command line needed. With the
npm package, the same thing from the command line, with the server running
or not, no restart needed:

```sh
npx openmausbot access add her@yourcompany.com
npx openmausbot access add freelancer@example.com --chat-only
npx openmausbot access list
```

An entry is an address or `@domain` (everyone at that domain). Admins get
the same access as a pairing code from `openmausbot serve`; members get the
chat-only scope, the same as `openmausbot pair --client`. The same lists live
in `config.json` under `signIn.admins` and `signIn.members` and can be changed
through the settings API without a restart; the environment variables win
when set, which is how a container or a service unit is bootstrapped.

The code itself comes from `accounts.openmausbot.com`, the OpenMausBot
account service, so your server needs no email credentials. Your server asks
it to send the code, checks the answer, and then issues its own session
cookie: the browser only ever talks to your server, and who is welcome is
decided only by your allow-list. Wrong codes count against the same lockout
as pairing codes. Sessions from a sign-in show the email in
`openmausbot sessions` and can be revoked the same way.

## Putting a proxy in front

Any reverse proxy works, given three things:

1. **Forward the real `Host`** and set `X-Forwarded-Proto`. Any request that
   carries forwarded headers is treated as remote and needs a session, so a
   proxy that rewrites `Host` to `127.0.0.1`, or forwards a stranger's
   `Host: localhost`, gains nothing. The proxy's scheme decides whether the
   session cookie is `Secure` and is part of the same-origin check.
2. **Set `X-Forwarded-For` yourself** (Caddy and nginx do by default) and
   drop any the client sent: the pairing lockout counts failures per first
   forwarded address.
3. **Do not buffer** the event stream (`flush_interval -1` in Caddy,
   `proxy_buffering off` in nginx); the UI streams events over SSE.

Plus one convenience: set `OMB_PUBLIC_URL=https://your.domain` so pairing
links, and `OMB_WEBHOOK_PUBLIC_URL=https://your.domain` so hook URLs, are
printed with the public address. [`deploy/Caddyfile`](../deploy/Caddyfile)
is the reference implementation.

## Using it from your phone

Signed in on a hosted server as an admin (with a pairing code or your
email)? Settings → Remote access → **Pair a phone or another computer**
creates a one-time code with a QR right in the browser, and lists every
paired device with a sign-out button. Nobody needs the command line.

The iOS app pairs with a server the same way a laptop does: scan the QR
code that `openmausbot serve` (or `openmausbot pair`) prints, paste the
whole `https://host/pair#code=…` link into the address field on the pairing
screen, or type the address and then the code. The phone gets a session of
its own, listed and revocable with `openmausbot sessions`. What it may do is
the code's scope: a code from `openmausbot pair` carries `admin` and the app
shows everything; a code from `openmausbot pair --client` (also what the
guided phone setup mints) can chat, approve and read, and the app hides
creating bots and sections, changing models, generating avatars, connecting
apps and cloud desktops — those stay with the owner. A server reinstalled at
the same address has a new identity; the app then asks to pair again rather
than present the old session to it.

Older way, still supported: run the companion sidecar next to the harness
and pair by its own QR. It advertises on your private networks
(Tailscale-aware) and issues per-device credentials on pairing.

```sh
node --experimental-strip-types companion/src/index.ts
```

## Usage and costs

Every settled turn is appended to `<data dir>/usage/YYYY-MM.jsonl`: which
bot, which model and engine, tokens in and out, the cost the engine reported
(real on a metered key, an equivalent on a subscription, absent when the
engine reports none), and who asked: the email a person signed in with, the
device label otherwise, a routine, another bot, or this computer. No message
text is stored. **Settings → Usage → History** shows a period grouped by bot,
model, person, day or engine, and **Export CSV** downloads one line per turn.
Owners can read the same over the API:

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://maus.example.com/api/usage?from=2026-09-01&to=2026-09-30&groupBy=user"
curl -H "Authorization: Bearer $TOKEN" -o usage.csv \
  "https://maus.example.com/api/usage.csv?from=2026-09-01&to=2026-09-30"
```

Dates are inclusive, UTC, at most a year apart; without them you get the
current month to date.

## Spend limits and sell prices (enterprise)

With the `budgets` entitlement, **Settings → Usage → Monthly spend limit**
caps the workspace: once the month's reported cost reaches it, no bot starts
a turn, whether a person wrote, a routine fired, a peer asked or a webhook
arrived, until an admin raises it. The figure is what engines report to the
ledger: real on your keys, an equivalent on personal subscriptions. A warning
shows at a configurable percentage.

With the `billing` entitlement, **Sell prices** takes your own price per
million tokens by model id, `driver/model`, or `default`, and History and the
CSV export gain a **billable** column next to the provider's cost. Both are
plain settings in `config.json` (`budgets`, `billing`) and through
`PUT /api/config`.

## Updating

For the npm service, [install the chosen new version](deploy-vps.md#update)
as the service user while the server is stopped, then start it again.
For a foreground invocation, `npx --yes openmausbot@X.Y.Z serve --tunnel`
selects a particular published release; replace `X.Y.Z` with that version.

```sh
docker compose -f deploy/docker-compose.yml pull omb && docker compose -f deploy/docker-compose.yml up -d   # Docker
git pull && pnpm install && sudo systemctl restart openmausbot          # from source
```

Routines and queued work survive restarts; in-flight turns do not, so
update between runs.

Stop the server before a filesystem backup so SQLite is copied consistently.
Back up the entire app data directory and, separately, the service user's
engine credentials, browser state, and external workspaces. For Docker, the
whole `/data` volume includes the CLI homes. See the
[backup and restore instructions](deploy-vps.md#back-up) for the exact scope
and stop/start commands.
