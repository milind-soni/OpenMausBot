# Self-hosting the OpenMausBot server

Run the harness server on an always-on Linux box (a VPS, a home server, a
Mac mini in a closet) and use it from other devices. This is the supported
path **today**; first-class remote access is coming — see
[`docs/plans/remote-workspace.md`](plans/remote-workspace.md).

> **Security first:** the server deliberately trusts only loopback — any
> process that can reach `127.0.0.1:8799` has full control, including the
> shell your bots can use. **Never expose that port directly and never bind
> it to a public interface.** Reach it through an SSH tunnel, a private
> network you trust, or the Docker stack below, which puts a login wall
> (Caddy) in front. Proper token-based remote auth is exactly what the
> Remote Workspace plan adds.

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

- the skill recorder, dictation/voice, controlling the host desktop

## Quickest: one command with Node

On any machine with Node 24 or newer (a VPS, a Mac mini, a Raspberry Pi):

```sh
npx openmausbot serve
```

It starts the server, keeps your data in `~/.openmausbot`, and prints a
pairing link with a QR code: scan it with the phone, or open it on the
laptop. Sign the engine CLIs in on the same machine as usual (`claude`,
`codex`, …). Two ways to make it reachable from elsewhere:

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
- **Behind your own proxy or domain:** `npx openmausbot serve --public-url
  https://maus.example.com`, with the proxy rules from "Putting a proxy in
  front".

Later: `npx openmausbot pair --label "Kitchen iPad"` for another device
(`--client` for one that may chat but not change settings), and
`npx openmausbot sessions` to see or revoke them. Run it under systemd or
pm2 to keep it up; `openmausbot serve` is a plain foreground process.

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

For something durable, run it under systemd:

```ini
# /etc/systemd/system/openmausbot.service
[Unit]
Description=OpenMausBot harness
After=network.target

[Service]
User=maus
WorkingDirectory=/home/maus/OpenMausBot
Environment=OMB_DATA_DIR=/home/maus/.openmausbot
Environment=OMB_PORT=8799
ExecStart=/usr/bin/node --experimental-strip-types server/index.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Engine CLIs read their logins from the service user's home — sign in as
that user (`sudo -u maus claude` etc.) before starting the service.

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
gets a session cookie (30 days, revocable) and the app loads. Sessions are
listed and revoked at `GET`/`DELETE /api/auth/sessions` for now; a Settings
screen follows.

From the **desktop app**, use the Server menu: "Add Server from Copied
Pairing Link…" reads the link you copied from the server, asks once, and
opens that server's own UI in the app; the app stays signed in to it across
restarts, and the menu switches between Local and any saved server (on
Windows and Linux press Alt to show the menu bar). While a remote server is
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

The iOS app pairs with a server the same way a laptop does: scan the QR
code that `openmausbot serve` (or `openmausbot pair`) prints, or paste the
whole `https://host/pair#code=…` link into the address field on the pairing
screen. The phone gets a session of its own, listed and revocable with
`openmausbot sessions`. It can chat, approve, and read; creating bots,
changing models, connecting apps and cloud computers stay with the owner in
the server's own UI, and the app hides those controls.

Older way, still supported: run the companion sidecar next to the harness
and pair by its own QR. It advertises on your private networks
(Tailscale-aware) and issues per-device credentials on pairing.

```sh
node --experimental-strip-types companion/src/index.ts
```

## Updating

```sh
docker compose -f deploy/docker-compose.yml pull omb && docker compose -f deploy/docker-compose.yml up -d   # Docker
git pull && pnpm install && sudo systemctl restart openmausbot          # from source
```

Routines and queued work survive restarts; in-flight turns do not, so
update between runs.
