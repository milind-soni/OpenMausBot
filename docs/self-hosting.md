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

## Many client workspaces on one server

`openmausbot fleet` runs one workspace per client on a single Linux server,
each as its own OS user, its own `openmausbot@<name>` service on its own
loopback ports, its own data folder, brand, sign-in list and provider key,
reached at `<name>.<your domain>` through the system Caddy. Bots of one
workspace cannot read another's files or reach its API: the data lives in a
private home, the unit runs with a private `/tmp`, no new privileges and a
read-only system, and an nftables rule keeps each workspace's ports to its
own user, Caddy and root.

Once, as root, with the package installed permanently and a wildcard DNS
record (`*.example.com`) pointing at the server:

```sh
openmausbot fleet init --domain example.com
```

That writes the template unit, the fence and its unit, the workspace folders,
and adds `import /etc/caddy/omb.d/*.caddy` to `/etc/caddy/Caddyfile`. Then per
client:

```sh
openmausbot fleet create acme --admin owner@acme.test --member @acme.test \
  --brand /root/acme-brand.json --anthropic-key-file /root/acme-anthropic.key \
  --cap 50 --memory 1G
openmausbot fleet users acme add bob@acme.test --chat-only
openmausbot fleet list
openmausbot fleet suspend acme      # 503 page, service stopped; resume undoes it
openmausbot fleet upgrade           # new release, then every running workspace restarted in turn
openmausbot fleet delete acme --yes # add --keep-data to keep the home folder
```

Give `init` `--operator USER` (the Unix user your own workspace runs as; the
user behind `sudo` by default) and it also installs the **fleet agent**: a
root service on a Unix socket only that user may open. Your workspace then
shows **Settings → Workspaces** (with the enterprise `admin` feature): create
a workspace, add or remove who may sign in, suspend, resume, delete, upgrade
all, and see each one's spend this month. Every action goes through the
agent's audit log at `/var/log/openmausbot/fleet.jsonl`.

`https://acme.example.com` is up when `create` returns; the first admin signs
in with an emailed code. `OMB_LICENSE_KEY` in the environment (or
`--license-key`) is carried into every workspace so a partner's white-label
key covers them all. Not root? Every command prints the exact steps to run as
root instead, and `--dry-run` always prints.

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

From the **desktop app**, use the workspace dropdown above Search → **Connect
hosted workspace…**, or **Settings → Connected workspaces**. Enter the server's
HTTPS address or full pairing link, with an optional name. Custom domains and
Cloudflare tunnel addresses work; Tailscale is not required. Generate a fresh
link for each device: `npx openmausbot pair --label "My desktop"` creates an
owner link without the phone wizard; add `--client` for chat-only access.
A code already used by your phone cannot also pair your desktop.

Confirm the server address in the app's connection dialog, then finish pairing
on the server page. The app stays signed in across restarts. The workspace
dropdown switches between **This computer** and saved hosted workspaces, without
moving bots or chats. The **Server** menu and **Add Server from Copied Pairing
Link…** remain available there too (on Windows and Linux press Alt to show
the menu bar). The separate **Desktop companion** option in Settings is for
the six-digit code from another desktop app, not a self-hosted server's
12-character code. Older hosted UIs may not show the dropdown; use the native
Server menu to switch back until the server is updated.

After pairing, **Share this computer?** offers **Choose access** or **Not now**.
Nothing is shared automatically. In **Settings → Connected workspaces → Computer
access**, choose read-only folders and optionally allow edits. Unrestricted
terminal and screen/app control are separate opt-ins, confirmed in a native
dialog. They can access information outside the selected folders. Share only
with a workspace you trust; its bots and AI providers may receive shared content.
Folder transfers are limited to 256 KiB per file and do not follow links or
delete files. Local screen control also needs OS permissions and a supported
desktop driver. Microphone access is not included.

Sharing works while this desktop is awake and running, including when viewing
another workspace. **Stop sharing** revokes access; closing the app stops the
connector. An action already sent to a local app may still finish. **Forget**
also stops sharing and signs this desktop out, without deleting the server's
bots or conversations. If sign-out cannot reach the server, the app warns you;
revoke its session there when reachable again, or if the device is gone.

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

### Inviting people

**Settings → People** lists who may sign in, their role, when they were last
seen, and what each person spent this month. **Invite** adds an address (or
`@company.com` for everyone there) and shows a link like
`https://your.host/pair?email=name%40company.com`: it opens the sign-in page
with the address filled in, and the one-time code still goes to that address.
Roles change with one click; removing someone stops new sign-ins.

On the Workspaces screen, creating a client workspace shows the same kind of
link for that workspace's admin, so a client gets one address, one workspace
and one link.

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

Both native apps pair this way. `openmausbot pair --phone android` prints the
app-scheme QR that Android's scanner needs, and the iOS app accepts either
that QR or the web link. Pass `--phone` whenever nothing is watching the
terminal, such as `docker compose exec omb node dist-server/openmausbot.js
pair --phone android --public-url https://your-domain`, since a scripted run
never reaches the question the interactive command asks. Nothing extra to install, and the phone becomes a
session like any other.

Older way, still supported, and only useful on a LAN or a tailnet: run the
companion sidecar next to the harness and pair by its own QR. It advertises
on your private networks (Tailscale-aware) and issues its own per-device
credentials, which are **not** `openmausbot sessions` and are revoked from
its own page on `127.0.0.1:8811`. It also serves phones over cleartext HTTP
on port 8810, so do not expose it from a public server. It ships only in a
git checkout: neither the npm package nor the Docker image contains it.

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

## A bot that also runs outside the server

Some engines have their own long-running front door — a Hermes Agent Telegram
gateway, a Slack bot, an OpenClaw session. That process is the same bot with
the same workspace and memory, but the server did not spawn it, so it holds
none of the turn-scoped capabilities the peer-comms tools need and cannot ask
or delegate to its teammates.

Give it a standing one with `external-runtimes.json` in the data directory,
mapping the bot's id to a secret of at least 32 characters:

```sh
umask 077
TOKEN=$(openssl rand -hex 32)
printf '{ "%s": "%s" }\n' "$BOT_ID" "$TOKEN" > ~/.openmausbot/external-runtimes.json
```

The file must be mode `600`; a file other users can read is ignored with a
warning. It is read on demand, so adding or rotating a token needs no restart.
The runtime then runs the bundled MCP bridge with that token:

```sh
OMB_HARNESS_URL=http://127.0.0.1:8799 OMB_BOT_ID=$BOT_ID OMB_COMMS_TOKEN=$TOKEN \
  node --experimental-strip-types server/drivers/agents-proxy.ts
```

Scope is deliberately narrow: the token is an *agents* capability for that
bot's main thread only, and the server accepts just four calls with it — list
peers, ask, delegate, and read the status of its own delegations. Opening
threads, creating bots or rooms, skills, memory and every other internal route
answer 403. Delegations
it sends are picked up immediately, because there is no turn on this server
whose end they could wait for. Everything else the server offers still needs
the owner's session or a per-turn capability.

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
