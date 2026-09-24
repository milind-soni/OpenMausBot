# Self-hosting the OpenMausBot server

Run the harness server on an always-on Linux box (a VPS, a home server, a
Mac mini in a closet) and pair browsers, the desktop app, or phones with it.
The npm CLI supports a managed public tunnel, Tailscale, or your own proxy.

> **Security first:** by default a self-hosted server trusts loopback as its
> owner — any process that can reach `127.0.0.1:8799` has full control,
> including the shell your bots can use. **Never expose that port directly
> and never bind it to a public interface.** Reach it through an SSH tunnel, a
> private network you trust, or an authenticated remote path below. Requests
> through the managed tunnel or a correctly configured proxy require a paired
> session. If several people use one server, read
> [Loopback trust](#loopback-trust-owner-or-service) below.

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

(With `OMB_LOOPBACK_TRUST=service`, below, a tunnel is loopback without a
session: the page asks you to sign in or pair first, because it no longer
makes you the owner.)

### Loopback trust: owner or service

Every bot's shell runs on the server as the same user, so every bot is a
loopback caller too. On a server one person uses that is fine: the bots are
theirs. On a workspace several people share it is not: a member could ask a
bot to `curl` the local API and change settings, keys, MCP servers or
webhooks as the owner. The server therefore decides at start-up how far a
loopback request **without a session** is trusted, and logs it:

```
local requests: owner trust (self-hosted default)
local requests: service trust (hosted workspace); without a session, loopback may use only health, the Slack worker's guarded routes and bot capability routes
```

| Trust | Default for | A session-less loopback request may |
|---|---|---|
| `owner` | a self-hosted server, the desktop app | do everything, as today |
| `service` | a hosted workspace: any of `OMB_ADMIN_URL`, `OMB_ADMIN_WORKSPACE` or `OMB_ADMIN_MEMBERSHIP` set (shared-workspace Full access only works there, so it is covered too) | read health, who-am-I, the bot list, a thread's messages and a bot's picture; open a thread; send through the guarded route; watch and stop its exact request; withdraw a queued line; **decline** a card; use the bots' own capability routes (`/api/internal/*`, which check their own per-turn token) |

Under `service`, everything else from loopback needs a real session and
answers 403: settings and keys (`/api/config`), instances, MCP servers,
webhooks, sessions and pairing, people and sign-in lists, usage, budgets,
the decision log, fleet, workspace backups, creating or loosening bots, and
approving or answering any card. The Slack worker (the only session-less
local caller a hosted workspace has) needs nothing more and keeps working
unchanged. Sessions — a portal sign-in, an email sign-in or a pairing — work
exactly as before, with their own scopes.

Set `OMB_LOOPBACK_TRUST=service` on a self-hosted server people share (with
an email sign-in list, say), or `OMB_LOOPBACK_TRUST=owner` to opt a hosted
workspace back into the old behaviour (the log then warns). Any other value
means `service`. The desktop app ignores the setting: its local changes
already need the app's own per-launch capability.

With `service` on a self-hosted server:

- `openmausbot serve` still prints the first pairing code. It hands the
  server it starts a one-off secret over the server's stdin (never its
  environment, which every engine inherits), and that secret opens the
  pairing route for that CLI alone. Pass `--no-pair` to skip the code; if
  the server refuses one anyway, `serve` says why and keeps running.
- `openmausbot pair` and `openmausbot sessions`, run later from another
  terminal, are refused like any other admin change and say so. Pair from
  Settings → Remote access while signed in as an admin, or let people sign
  in with their email (`openmausbot access add you@example.com`, which edits
  the sign-in list on disk).
- A browser on an SSH tunnel gets the sign-in page instead of the app.
- The MCP server script works with `OPENMAUSBOT_TOKEN` set to a paired session.

**What `service` does not close yet.** Any bot's shell can still do
everything the Slack worker does, and on a shared workspace that is a real
gap: it can post into any bot's thread through the guarded route, including
an existing Full-access thread (`expectedApprovalMode: "full"`), and while
shared Full access is on it can open new Full-access threads. Either way the
work runs with Full access and no card, so a member who can talk to a bot
can get Full access through it. It can also stop a request and decline a
card. It cannot approve a card, change settings, keys, people or sessions,
or loosen a bot's permissions. The planned fix is a relay token that only
the Slack worker holds, so these routes stop answering session-less loopback
at all; until then, turn shared Full access on only where every member may
have Full access. Files the server's user owns (`config.json`, the engine's
environment) are also still readable from a bot's shell; that needs a
second user for engines, a separate change.

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

On a hosted workspace whose members your organisation's Admin manages
(`OMB_ADMIN_MEMBERSHIP=portal`), this list decides nothing, so Settings →
People shows, read-only, who has signed in and what they spent, with a
**Manage people in Admin** link to that workspace in Admin → People. Remote
access there lists signed-in devices and offers no pairing codes, since a
hosted workspace refuses them.

### Who may answer a card

Approval cards are the provider's own (see the approval modes); OpenMausBot
adds none. On a workspace several people share — portal membership, or an
email sign-in list that names members — it narrows only whose answer counts,
and only when the card can be traced to a person:

- a card for a request a member sent, or in a thread a member opened, is
  theirs to answer (admins and the owner may answer any card);
- a thread a bot opened while working on someone's request (a delegated or
  coordinated job) is traced back to that person, so the cards of work done
  for them are theirs too;
- a card that names nobody — sent by the owner on this machine, by a
  routine or webhook, from Slack (until Slack passes the asker through), or
  in a thread from before this existed — may be answered by any member, as
  before;
- a session-less local caller under `service` trust may only decline.

On a workspace with one person, anyone who can chat may answer, as before.
Each answered card records who answered it (`card.answeredBy`), and so does
its row in the decision log. Who a thread was opened for is kept in a
server-private file (`<data dir>/thread-starters.json`), never sent to clients.

### Who can see a bot

On a workspace several people share, an admin can limit who sees a bot:
**Bot settings → Who can see it** (in the browser, for admins), or when
creating it — **New bot** offers the same choice, and `POST /api/bots` and
`POST /api/teams/import?visibility=…` take it — so a bot for a sensitive job
is never shown to everyone first. Over the API it is `visibility`:

- `"everyone"` — every signed-in person, the default and today's behaviour;
- `"admins"` — admin sessions only;
- `{ "people": ["ada@company.com", "@hr.company.com"] }` — the listed
  addresses and `@domain` entries, plus admins.

It is access control, not an approval step, and it applies at once. For a
member who may not see a bot, the server answers the bot, its threads and
their messages, images, exports, reactions, cards, sends, routines, runs and
attachments exactly as it answers an id that does not exist (404), and leaves
the bot out of the bot list, search results, routines, webhooks, the team map
and the live event stream. Every bot a member is sent, by any route, comes
without its audience list or the ids of teammates they cannot see. When an
admin changes a bot's audience, every member's open app reconnects and
reloads exactly what that person may now see (a member who was away and
resumes from an older point gets the same fresh load); admins' apps are left
alone.

- **Rooms.** A room is one shared transcript, so its bots must be visible
  to the same people: creating a room, adding a bot to one, or scheduling a
  call between bots that other people see differently is refused with a
  plain sentence (for admins too). If an admin later restricts a bot that
  is already in a room, the change is allowed and the room narrows to the
  people who can see all its bots. A room also keeps the narrowest audience
  it has ever had (its floor): taking the restricted bot out, deleting it,
  or widening it again never shows the transcript to more people. A member
  sees a room only if they can see every bot in it and the floor admits
  them. Such a room stays out of the recall, recent-work brief and daily
  memory log of any bot more people can see, and that bot cannot write
  notes from it into its memory — so a bot everyone sees cannot repeat, in
  a chat with anyone, what a restricted bot said there. To widen a room, an
  admin says so explicitly: **Bot settings → Who can see it** lists the
  rooms visible to fewer people than the bot, each with **Show … to everyone
  its bots allow** (`PATCH /api/groups/:id` with `{"resetAudience": true}`),
  which resets the floor to what the room's current bots allow and is
  recorded in the admin activity log.
- **Teams.** A team (sidebar section) is listed to a member only when it
  holds a bot or room they can see.
- **Bots working together.** A bot reaches a teammate (asks, delegations,
  its roster and `list_bots`, @mentions, a Chief's team) only when exactly
  the same people can see both: otherwise one bot's thread could carry the
  other's answers to people who cannot see it. Bots nobody restricted all
  share "everyone", so nothing changes until an admin restricts one. A bot a
  Chief creates (directly, or in a reviewed team setup) gets exactly the
  Chief's audience.
- **Who sees everything.** Admin sessions, the owner on this machine, and a
  session-less local service (the Slack worker under `service` trust) see
  every bot. A pairing-code device with no email sees only bots everyone
  can see. Members never receive a bot's audience list.
- **Files.** An attachment is refused only when everything that uses it —
  a message in a thread, a bot's picture — is hidden from that member. A
  file nothing uses yet (someone's own upload) is served; its name is random.
- **Not covered.** Words already quoted into a conversation a member can
  see (an earlier delegation, a message copied by hand, or something a bot
  wrote into its own memory files with its file tools while it shared a room
  with a restricted bot) stay there. A bot's
  shell can still read files on the server, as it always could. Slack is
  decided in your organisation's Admin: whoever may message a bot's Slack
  app reaches that bot there.

The desktop app has no member sessions and does not show this setting;
nothing there changes.

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

### The decision log

Every approval decision — a rule that let a tool call through, a card that
was shown, and a person's answer, with who gave it (the session's email or
device label, `loopback` for the owner, `worker` for a session-less local
service) — is appended to `<data dir>/decisions/YYYY-MM.ndjson` (0600,
credentials redacted). Month files are kept for at least 180 days; set
`decisions.retentionDays` in `config.json` (or through `PUT /api/config`),
or `OMB_DECISION_RETENTION_DAYS`, to keep them longer or shorter (1–3650
days; the environment wins). A month is deleted only once all of it is older
than the window. An older server's `decisions.ndjson` and `.1` are still read
and age out the same way. Admins can read it back:

```sh
curl -H "Authorization: Bearer $TOKEN" "https://maus.example.com/api/decisions?limit=200"
curl -H "Authorization: Bearer $TOKEN" -o decisions.csv \
  "https://maus.example.com/api/decisions.csv?from=2026-09-01&to=2026-09-30"
```

The CSV has one line per decision (time, decision, source, bot, tool,
summary, rule, unattended, answered by, thread, request); cells that would
start a spreadsheet formula are prefixed with `'`.

### Admin activity

On a workspace several people share — a hosted workspace, an email sign-in
list that names more than one person or a whole `@domain`, or a device paired
(or a pairing code open) with chat-only access, whether before or after the
change — every admin change is recorded beside the decision
log, in `<data dir>/admin-activity/YYYY-MM.ndjson` (0600), and kept for the
same window (`decisions.retentionDays` / `OMB_DECISION_RETENTION_DAYS`; a
quiet server prunes on a timer, and pending rows are written out at
shutdown): settings
(which keys changed), sign-in lists and people, pairing codes and revoked
sessions, webhooks, MCP servers, engines and keys, bots created, deleted or
given different permissions, spend limits and prices, and who can see a bot.
Each row names who acted — the session's email or device label, `This
computer` for the owner, `Command line` for `openmausbot` commands such as
`openmausbot access add` — and the values before and after. Values are
redacted: anything under a key that names a credential, every value in a
headers or environment map, the value after a flag such as `--api-key` or
`-k`, URL parameters such as `?key=`, a token before a URL's host
(`https://TOKEN@host`), and key-like URL path parts (`/s/<key>/sse`) are
written as `[hidden]`, so a key change
shows that the key changed and never the key. Each row covers only what that
request named or saved, so two admins changing things at the same moment are
each credited with their own change. The desktop app, and a server one person
uses, keep no such log.

**Settings → Activity** (admins, in the browser) shows these rows together
with the cards people answered, filtered by who, what and when, and exports
them as CSV. The same over the API:

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://maus.example.com/api/admin-activity?from=2026-09-01&to=2026-09-30&what=visibility"
curl -H "Authorization: Bearer $TOKEN" -o activity.csv \
  "https://maus.example.com/api/admin-activity.csv?who=ada@company.com"
```

`what` is `all` (admin changes and answered cards, the default), `approvals`,
`decisions` (every decision, automatic ones too), or one of `config`,
`people`, `session`, `webhook`, `mcp`, `engine`, `bot`, `budget`,
`visibility`; `who` matches part of a name or email; without `from` the list
starts 30 days ago. Nothing here is sent to your organisation's cloud Admin,
which keeps its own activity log.

## Spend limits and sell prices (enterprise)

With the `budgets` entitlement, **Settings → Usage → Monthly spend limit**
caps the workspace: once the month's cost reaches it, no bot starts a turn,
whether a person wrote, a routine fired, a peer asked or a webhook arrived,
until an admin raises it. A warning shows at a configurable percentage, and
admins get one in-app notification the first time each month crosses the
warning and one when it reaches the limit (a new month or a new limit starts
over).

The figure is every cost in the usage ledger. Claude reports its own cost
(real on your keys, an equivalent on personal subscriptions). Codex, the
OpenAI-compatible/OpenRouter engine, Grok, MiniMax and the ACP engines report
tokens but no price, so the server books an **estimate** from a built-in list
of vendor list prices (`server/model-prices.ts`, each entry with its source
and the date it was read) and marks the row `costSource: "estimated"`. A model
that is not in the list is unpriced and not counted; Usage says how many
turns that was. Estimates use each vendor's standard short-context rate, so
long prompts, cache writes and priority tiers cost more than estimated.

With the `billing` entitlement, **Sell prices** takes your own price per
million tokens by model id, `driver/model`, or `default`, and History and the
CSV export gain a **billable** column next to the provider's cost. For an
engine that reports no cost, a price you set for that exact model also
replaces the list price in its estimate; `default` is used only for models
the list does not know. Both are plain settings in `config.json` (`budgets`,
`billing`) and through `PUT /api/config`.

## A bot that also runs outside the server

Some engines have their own long-running front door — a Hermes Agent Telegram
gateway, a Slack bot, an OpenClaw session. That process is the same bot with
the same workspace and memory, but the server did not spawn it, so it holds
none of the turn-scoped capabilities the peer-comms tools need and cannot ask
or delegate to its teammates.

Give it a standing one with `external-runtimes.json` in the data directory,
mapping the bot's id to a secret of at least 32 characters and one existing
thread owned by that bot. Use the bot and task `threadId` from the local
`GET /api/bots` response; selecting a different thread in the sidebar will
not change this binding. This connects peer communications, not the external
engine's filesystem or login configuration.

For a **new** file (add entries to the existing JSON instead if already set up):

```sh
umask 077
BOT_ID=your-bot-id
THREAD_ID=your-existing-thread-id
TOKEN=$(openssl rand -hex 32)
printf '{ "%s": {"token":"%s","threadId":"%s"} }\n' "$BOT_ID" "$TOKEN" "$THREAD_ID" > ~/.openmausbot/external-runtimes.json
chmod 600 ~/.openmausbot/external-runtimes.json
```

Keep the file private (`600` on Unix; restrict its Windows file permissions).
A Unix file other users can access is ignored with a warning. It is read on
demand, so adding, removing or rotating a token needs no restart, including
requests waiting on a body, approval or status poll. Use a different secret
for each bot. Deleting or archiving the bound thread disables its token; it
never silently moves to another conversation. A bare token without `threadId`
is rejected, including on bots that currently have just one thread.

The runtime runs the bundled MCP bridge from the source checkout with the same
bot, thread and token (replace the port with your server's actual address):

```sh
OMB_HARNESS_URL=http://127.0.0.1:8799 OMB_BOT_ID=$BOT_ID OMB_THREAD_ID=$THREAD_ID \
  OMB_COMMS_TOKEN=$TOKEN OMB_EXTERNAL_RUNTIME=1 \
  node --experimental-strip-types server/drivers/agents-proxy.ts
```

Scope is deliberately narrow: the token is an *agents* capability for that
bot's pinned thread only, and the server accepts just four routes with it — list
peers, ask, delegate, and read the status of its own delegations. Opening
threads, creating bots or rooms, skills, memory and every other internal route
answer 403. External mode advertises only `list_bots`, `ask_bot`, `delegate_bot`,
`check_delegation` and `wait_delegation`. It can check a delegation from the
same long-running process without inventing a turn end. The server still
enforces peer access and approval settings. An idle source starts dispatch
immediately; a busy teammate is queued until available. Regular in-app turns
keep their existing dispatch timing.

The credentials stay on this server and are excluded from workspace backups;
restoring a backup preserves destination registrations. Never put this token
in chat or source control. Everything else the server offers still needs the
owner's session or a per-turn capability.

Verification: [external runtime fixture](verification/external-runtime.md).

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
