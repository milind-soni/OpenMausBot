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

Desktop-only for now (needs the Mac/Linux app):

- the built-in browser panel, the skill recorder, dictation/voice,
  controlling the host desktop

## Docker (recommended)

One tenant = one container for the server plus Caddy for HTTPS and login.
Requirements: Docker with Compose, a DNS name pointing at the machine, and
ports 80/443 open.

```sh
git clone https://github.com/milind-soni/OpenMausBot && cd OpenMausBot/deploy
cp .env.example .env
# set DOMAIN, BASIC_AUTH_USER and BASIC_AUTH_HASH (the file says how;
# the hash's `$` signs must be doubled, Compose interpolates them)
docker compose pull omb && docker compose up -d
```

That uses the image CI publishes on every `main` push
(`ghcr.io/milind-soni/openmausbot`, tagged `latest`, `sha-…` and `v…`).
To build from your checkout instead: `docker compose up -d --build`.

Then sign the engine CLIs in **inside the container** — their logins live
on the `data` volume, so they survive restarts and image upgrades:

```sh
docker compose exec omb claude     # each CLI you listed in ENGINES
```

Open `https://<DOMAIN>` and log in with the basic-auth user. Webhook URLs
(`https://<DOMAIN>/hooks/wh_…`) work without the login — every hook
carries its own secret — and that is the base the app prints on new hooks,
because the stack sets `OMB_WEBHOOK_PUBLIC_URL`.

What the stack does, so you can adapt it:

- [`Dockerfile`](../Dockerfile) builds the UI and the self-contained
  server bundle, and runs them as an unprivileged user with `HOME=/data`.
  `--build-arg ENGINES="…"` (or `ENGINES=` in `.env`) bakes engine CLIs
  into the image.
- [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) runs Caddy
  **in the server's network namespace**, so Caddy reaches the server on
  `127.0.0.1` and the server never binds anything public. The loopback
  invariant above holds unchanged.
- [`deploy/Caddyfile`](../deploy/Caddyfile) carries the two header rules
  from "Putting a proxy in front" below. Swap `basic_auth` for
  `forward_auth` to an identity provider (Authentik, oauth2-proxy) when you
  outgrow a shared password — nothing in the server needs to change.

Upgrade with `docker compose pull omb && docker compose up -d` (or
`git pull && docker compose up -d --build`). State (chats, routines,
engine logins) is on the `data` volume; back that up.

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

Open an SSH tunnel and use the web UI in any browser:

```sh
ssh -L 8799:localhost:8799 you@your-server
# then open http://localhost:8799
```

The server serves the full app UI itself — no desktop install needed on the
client. The tunnel keeps the loopback trust model intact: to the server,
you look local, because through the tunnel you are.

Note: a plain `tailscale serve` or reverse proxy is refused — the server
checks that requests look like loopback on purpose. A proxy can satisfy
that check; see "Putting a proxy in front" below. Only do it behind a login.

## Putting a proxy in front

The server has two request gates, both aimed at browsers:

1. **Host** must be loopback (`localhost`, `127.x.x.x`, `::1`). The proxy
   must rewrite `Host` to `127.0.0.1:8799` on the way in.
2. **Origin**, when present, must be a loopback origin. Browsers send the
   proxy's origin (`https://your.domain`), so the proxy must map exactly
   that one origin onto `http://127.0.0.1:8799` — and leave every other
   Origin untouched, so cross-site requests are still refused.

Plus two non-security rules: the UI streams events over SSE, so the proxy
must not buffer responses (`flush_interval -1` in Caddy,
`proxy_buffering off` in nginx); and the webhook receiver (port 8800,
paths `/hooks/...`) only knows its loopback address, so set
`OMB_WEBHOOK_PUBLIC_URL=https://your.domain` to make the app print hook
URLs senders can reach. [`deploy/Caddyfile`](../deploy/Caddyfile) is the
reference implementation. The proxy itself must add the login — the
server has none — so never point it at the internet without one.

## Using it from your phone

The iOS companion pairs with a running server. Start the companion process
next to the harness and pair by QR:

```sh
node --experimental-strip-types companion/src/index.ts
```

It advertises on your private networks (Tailscale-aware) and issues
per-device credentials on pairing — see the pairing screen in the iOS app.

## Updating

```sh
docker compose -f deploy/docker-compose.yml pull omb && docker compose -f deploy/docker-compose.yml up -d   # Docker
git pull && pnpm install && sudo systemctl restart openmausbot          # from source
```

Routines and queued work survive restarts; in-flight turns do not, so
update between runs.
