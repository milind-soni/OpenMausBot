# Deploy OpenMausBot on a VPS

From a blank Linux server to OpenMausBot running on it around the clock, reachable from your laptop, the desktop app and your phone, with your bots working while every laptop is closed. It assumes nothing beyond being able to open a terminal and paste commands. About twenty minutes, most of it waiting.

## Quick start: one command on your own domain

For a fresh Ubuntu 22.04 or 24.04 server (x86-64, at least 2 CPUs, 4 GB of memory and 20 GB of free disk) and a domain name whose A record already points at it:

```sh
curl -fsSL https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/deploy/install.sh | sudo sh -s -- --domain maus.example.com
```

The installer ([`deploy/install.sh`](https://github.com/milind-soni/OpenMausBot/blob/main/deploy/install.sh)) does path B below for you and ends with MausBot answering at `https://maus.example.com`.

**It checks the server first, and changes nothing while it checks.** Each check that fails prints one sentence saying what to fix, and nothing is installed until all pass:

| Check | Passes when |
|---|---|
| Operating system | Ubuntu 22.04 or 24.04 |
| Processor | x86-64, 2 cores or more |
| Memory | 4 GB or more (8 GB suggested) |
| Free disk | 20 GB or more, where the install and Docker keep their files |
| Docker | Docker 24 or newer with the Compose plugin, running, not rootless |
| Ports | 80 and 443 are free |
| DNS | the domain resolves to this server's public address |
| Outbound | HTTPS reaches the image registries (`ghcr.io`, `pkg-containers.githubusercontent.com`, Docker Hub), Let's Encrypt and `raw.githubusercontent.com` |
| User namespaces | switched on, for the bots' sandbox |
| Bots' sandbox | AppArmor is on with its tools, as it is on a stock Ubuntu |
| Clock | within five minutes of the internet's |
| Version | a MausBot release to install was found |

To run only the checks, add `--check`:

```sh
curl -fsSL https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/deploy/install.sh | sudo sh -s -- --check --domain maus.example.com
```

If Docker is missing, the installer asks before installing it with Docker's official script (`get.docker.com`); `--install-docker` says yes ahead of time. It installs nothing else on the server.

**Then it installs** everything under one folder, `/opt/openmausbot` (`--dir` picks another):

| Path | What |
|---|---|
| `compose.yaml`, `Caddyfile` | the same server-plus-Caddy setup as path B; written again on every run |
| `.env` | your settings: `DOMAIN`, the pinned version (`OMB_IMAGE`) and anything you add, such as [who may sign in with an email](self-hosting.md#sign-in-with-your-email). The installer keeps your lines |
| `data/` | everything MausBot stores: chats, bots, engine sign-ins, paired devices. Never touched once it exists |
| `caddy/` | the HTTPS certificates |
| `update.sh` | the update command, once this repository has it (see below) |
| `compose.box.yaml`, `box/` | the sandbox's settings and the files that prepare the server for it |

`update.sh` and the sandbox's files are this repository's own, taken from the tag of the version being installed so they match it, and from `main` only when that tag does not have them. The installer says which it used.

It runs the newest release, pinned by its version; once a `stable` channel is published it follows that instead. It never runs `latest`, which follows every commit. It then waits until the server reports healthy and `https://maus.example.com` answers with a valid certificate, and prints the address.

**The bots' sandbox.** A MausBot version with the hardened profile runs every bot in a sandbox, away from the server's settings, keys and other bots' files, and Docker's defaults do not let a container build one. For such a version the installer prepares the server (a seccomp profile in `/etc/mausbot` and an AppArmor profile in `/etc/apparmor.d`, the two the MausBot connector installs), starts the server with the four security settings in `compose.box.yaml` (no `--privileged`, no added capability), and then runs the server's own self-check, which among other things confirms that a bot cannot read `config.json`. If a check fails that means a bot could reach something it must not, or that bots would not work, the installer names it and does not report success; so does a self-check that gives no answer, or a check the installer has never heard of. Five checks that are about neither (the kernel keyring, the sandbox's host name, the CPU list, a hosting provider's address, and reaching the public internet) only print a note. For a version without the hardened profile it says the sandbox is not there yet; run the install command again after updating to one that has it. `--no-sandbox` skips all of this, for a server only you sign in to on a host without AppArmor.

**Sign in as the first admin** with a one-time link made on the server:

```sh
cd /opt/openmausbot && sudo docker compose exec omb openmausbot pair --label "First admin"
```

Open the link it prints, or paste it into the desktop app under **＋ → Connect to a server**. To sign in with an emailed code instead, run the installer with `--email you@example.com`.

- **Update:** `sudo /opt/openmausbot/update.sh`, which backs the data up, checks the new version's health and puts the old one back if it fails. The installer places it once this repository has it and prints the command when it finishes; until then, running the install command again moves to the newest release. `update.sh` pins the version by digest in `.env`, and a later run of the installer keeps that pin.
- **Repair:** run the install command again. It checks the server, rewrites its own files and leaves `.env` and `data/` alone.
- **Stop:** `--uninstall` stops the server and removes its containers. It deletes nothing: your data stays in `/opt/openmausbot/data`.
- **Every other command in this guide** that starts `docker compose` for path B works from `/opt/openmausbot`.
- **What the installer contacts:** the registries and Let's Encrypt from the table, GitHub's release list, this repository's files on `raw.githubusercontent.com`, and `cloudflare.com/cdn-cgi/trace` to learn the server's public address for the DNS check. It sends no telemetry.
- **Behind a load balancer or NAT** that forwards ports 80 and 443 to the server, set `OMB_INSTALL_SKIP_DNS=1` to skip the DNS check.

The installer also accepts the one-time code of a server connected to MausBot. That offering is not available yet.

Not on Ubuntu, or prefer to do it by hand? Use one of the three ways below.

## Three ways in, by hand

Three ways to make the server reachable are covered. Pick one; the rest of the guide is the same. The short version of every path, including `--lan` and your own cloudflared or proxy (`--public-url`), is at the top of [Self-hosting](self-hosting.md#pick-a-way-in); this guide adds the server setup around it.

| | You need | Who can reach it | Best for |
|---|---|---|---|
| **A. Public address, no domain** (`serve --tunnel`) | an OpenMausBot account (email code) | anyone with a pairing code, over HTTPS | the fastest path; a phone on cellular |
| **B. Your own domain** (Docker + Caddy) | a domain name, ports 80/443 | anyone with a pairing code, over HTTPS | a permanent address you own |
| **C. Your Tailscale network** (`serve --tailscale`) | Tailscale on the server and your devices | only your tailnet | the most private; nothing public at all |

Whichever you pick, the login is the same: you **pair** each device once with a short code and it stays signed in. A session lasts 30 days; using it with half that or less left renews it to a full 30, up to 180 days from pairing (`OMB_SESSION_TTL_DAYS` and `OMB_SESSION_MAX_DAYS` change both numbers). There is no password.

## Hetzner launch check (2026-09-07)

Path A was exercised on a blank Hetzner CX43 (x86-64, Ubuntu 24.04), using
Node 24.20.0 and Codex 0.153.4. The published 0.1.60 baseline was followed by
local candidate fixes from this change; these results do not certify the
unmodified published 0.1.60 package.

The paired web UI completed a real GPT-6-Astra chat, two automatically
scheduled routine runs, and a browser title/screenshot test. The browser
needed the Ubuntu sandbox setup below. A full reboot restored the service
and managed tunnel automatically; the existing paired device, bots, chats,
and paused schedule remained available. A new real chat turn also succeeded.

A stopped application-data backup restored with matching file hashes and
SQLite integrity. The restored copy was not started; provider reauthentication
and browser-login migration were not tested. Docker, Tailscale, ARM64, other
providers, and capacity limits were outside this run.

## What runs on a server, and what does not

Runs fully on the server: every engine CLI (Claude Code, Codex, Grok, custom ACP engines), chats, rooms, bot-to-bot coordination, routines, connected apps and custom MCP servers, webhooks, Company Brain, computer use on cloud or container computers, text-to-speech, and the web UI (the server serves it itself).

Needs the desktop app instead: dictation and controlling the server's own desktop. Bots browse on a server too, once the browser engine is installed (below).

## Before you start

1. **A server.** Any Linux VPS: Ubuntu 22.04 or 24.04, 2 CPUs and 4 GB of RAM is plenty. You need `sudo` or root. Hetzner, DigitalOcean, Lightsail, a Mac mini in a cupboard: all fine.
2. **Node 24 or newer** for paths A and C (`node --version`). On Ubuntu:

   ```sh
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs
   ```

   Path B uses Docker instead and needs no Node on the host.
3. **Your engine accounts.** Bots run on the same engine CLIs you use on your laptop, with your subscriptions. You sign them in on the server once, the same way.

Connect to the server for everything below:

```sh
ssh root@YOUR_SERVER_IP
```

For paths A and C, use the same unprivileged Linux account for setup and the
running service. The examples below use `maus` with home `/home/maus`. From an
administrator shell, create it if it does not already exist, then switch to it:

```sh
sudo useradd --create-home --shell /bin/bash maus
sudo -iu maus
```

The login shell also changes into `/home/maus`; run setup there, not from `/root`.
Run the `npx` commands and engine sign-ins below in this account. Keep a separate
administrator shell for system packages and systemd. If you already signed in as
root, sign in again as `maus`; those accounts have different homes and credentials.

## Path A: a public address with one command

No domain, no proxy, no open port. The server gets an address like `https://c-7f3a9c.openmausbot.com` through a Cloudflare tunnel; only traffic through the tunnel reaches it, and that traffic still has to pair.

```sh
npx openmausbot setup          # once: choose AI access, connect, and choose a model
npx openmausbot login          # once: an emailed code signs this machine in and reserves its address
npx openmausbot serve --tunnel # runs the server there and prints the pairing link with a QR code
```

`setup` connects an AI provider; it is separate from the OpenMausBot account.
Use Codex's device-code option over SSH, or enter a hidden API key for a
chat-only connection. More engines can be added later. See [CLI setup](cli-onboarding.md).

`login` asks for your email, sends an 8-digit code, and prints the address it reserved for this machine. `serve --tunnel` downloads `cloudflared` on the first run (a pinned version with a verified digest, into `~/.openmausbot`), starts the server, connects the tunnel, and after a few seconds prints `tunnel: live at https://…`. Leave it running; see "Keep it running" for a service.

The account credentials live in `~/.openmausbot/tunnel-account.json`, readable only by your user. `npx openmausbot logout` releases the address.

Skip to "Install and sign the engines in".

## Path B: your own domain, with Docker

One container for the server plus Caddy for HTTPS at `https://maus.example.com`.

The [installer](#quick-start-one-command-on-your-own-domain) does these steps for you on Ubuntu. Do them by hand on another system, to build your own image with `ENGINES`, or to see what it does.

1. **Point a name at the server.** In your DNS provider add an **A record** (name `maus`, value the server's public IP). After a few minutes `ping maus.example.com` should answer with that IP. Ports 80 and 443 must be open; most providers open them by default.
2. **Install Docker:**

   ```sh
   curl -fsSL https://get.docker.com | sh
   docker compose version   # prints a version; if "command not found", log out and back in
   ```

3. **Get the deploy files and set the name:**

   ```sh
   git clone https://github.com/milind-soni/OpenMausBot && cd OpenMausBot/deploy
   cp .env.example .env
   nano .env                # DOMAIN=maus.example.com ; ENGINES=@anthropic-ai/claude-code @openai/codex
   ```

   `ENGINES` lists the engine CLIs baked into your image, separated by spaces. Change it later and rebuild if you add one.

4. **Start it:**

   ```sh
   docker compose pull omb && docker compose up -d
   docker compose ps        # omb "healthy", caddy "running"
   ```

   Caddy requests the certificate on its own; give it a minute. Then `https://maus.example.com` shows a page asking for a pairing code. That is correct: nothing works until you pair.

In this path, every `npx openmausbot …` command below is run inside the container instead:

```sh
docker compose exec omb openmausbot pair --label "My MacBook"
```

## Path C: only your Tailscale network

From the administrator shell, install Tailscale on the server and sign in (`curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`). Enable HTTPS certificates for your tailnet once at https://login.tailscale.com/admin/dns (HTTPS Certificates), then run this from the `maus` shell:

```sh
npx openmausbot serve --tailscale
```

Tailscale terminates HTTPS with its own certificate and the pairing link uses the server's MagicDNS name (`https://maus.tail1234.ts.net`). `serve` runs `tailscale serve` in the foreground, so the share ends when it stops. Only devices on your tailnet can reach it, which is a very good property for a server that can run tools.

## Give the bots a browser (optional)

Bots can browse on a server. Docker (path B) ships the engine and Chrome in
the image. For paths A and C, install Linux system libraries once from the
administrator shell:

```sh
sudo -H npx --yes openmausbot browser install --with-deps
```

Then install the browser in the service account's home, from the `maus` shell:

```sh
npx --yes openmausbot browser install
```

The administrator's browser download is in a different home; it does not install
the service account's browser. Both commands must finish successfully.

On Ubuntu 24.04, AppArmor may also require [administrator sandbox setup](#ubuntu-2404-browser-sandbox).
The one-click installer downloads the browser; it does not grant these OS permissions.

Then turn the browser on under Settings → Computers, and per bot. Each bot
gets its own isolated session whose logins persist across restarts.

## Install and sign the engines in

The npm OpenMausBot package does not install model engine CLIs. For paths A and C,
install the engine you use in the service account, then sign it in. For example,
from the `maus` shell, for Claude:

```sh
npm install --global --prefix "$HOME/.local" @anthropic-ai/claude-code
export PATH="$HOME/.local/bin:$PATH"
claude
```

For Codex, use `@openai/codex` as the npm package and run `codex login --device-auth`
to sign in from a headless server. Complete the CLI's account flow in your browser. Repeat only for the
engines you use. For path B, run the installed CLI inside the container, for
example `docker compose exec omb claude`.

Engine logins belong to the service user's home (for example `~/.codex` and
`~/.claude`), separately from OpenMausBot's `~/.openmausbot`. Keep that home when
restarting or upgrading. The systemd example below includes `~/.local/bin` in PATH.

## Pair your first device

`serve` already printed a pairing block when it started in a terminal (a service prints none into its log). For another device later:

```sh
npx openmausbot pair --label "Kitchen iPad"
```

```
Pairing code   RR8Y-BLR6-H939   works once, until 10:59 · everything
Link           https://c-7f3a9c.openmausbot.com/pair#code=RR8Y-BLR6-H939

  Desktop app   ＋ → Connect to a server, paste the link
  Phone         scan with your camera or the MausBot app
```

- **A browser:** open the link. The code is filled in; press **Connect**. That browser is paired for 30 days, renewed on use as above.
- **The desktop app:** choose **＋ → Connect to a server** and paste the link, or type the address and the code. The rail at the window's left edge switches between your own machine and every server you added.
- **The phone:** scan the QR code from the iOS app's pairing screen, or paste the whole link into its address field. A code from `pair --phone` can chat, approve, and read; creating bots, changing models, and connecting apps stay with you in the server's UI.

Worth knowing: a code works **once**, for **10 minutes** (`--ttl 24h` keeps it open up to a day, for a device you set up later; it is still single use, and a server restart ends every open code); the link only works on that address (typing the code by hand: open `…/pair` and enter it); five wrong codes in five minutes from one address lock pairing there for five minutes; `--phone` mints a code for a device that may chat and approve but not change settings or pair others.

## Manage devices

Every paired device is a session:

```sh
npx openmausbot devices               # id, device, scope, last seen, expires
npx openmausbot devices revoke ID     # signs that device out and closes its stream at once
npx openmausbot status                # the address others use, and whether it answers as this server
```

## Keep it running

`npx openmausbot serve` is a plain foreground process. `npx openmausbot service install --tunnel` (or `--tailscale`) writes a unit like the one below for you, with a copy of the release it runs beside your data. To write it by hand for systemd (paths A and C),
install a chosen release first, from the `maus` shell. Replace `X.Y.Z` with the
published version you want to run:

```sh
npm install --global --prefix "$HOME/.local" openmausbot@X.Y.Z
```

Stop the foreground server with Ctrl-C before enabling the service. From the
administrator shell, save this as `/etc/systemd/system/openmausbot.service`:

```ini
# /etc/systemd/system/openmausbot.service
[Unit]
Description=OpenMausBot server
After=network-online.target

[Service]
User=maus
WorkingDirectory=/home/maus
Environment=HOME=/home/maus
Environment=PATH=/home/maus/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/maus/.local/bin/openmausbot serve --tunnel
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now openmausbot
journalctl -u openmausbot -f            # the server's log, including "tunnel: live at …"
```

Use `--tailscale` instead of `--tunnel` for path C. A service is not a terminal, so `serve` writes no pairing code into the journal; mint one with `npx openmausbot pair` when you need it. Docker (path B) restarts on its own (`restart: unless-stopped`).

Adjust the account, home, and PATH if yours differ; Node 24 must be available on
that PATH. The service runs the installed CLI directly, so a restart uses the
same release without an npm install prompt or an implicit upgrade.

## Update

- **Paths A and C with the service above:** choose the new published version,
  then run these commands from the administrator shell, replacing `X.Y.Z`:

  ```sh
  sudo systemctl stop openmausbot
  sudo -iu maus npm install --global --prefix /home/maus/.local openmausbot@X.Y.Z
  sudo systemctl start openmausbot
  ```

  Check that installation succeeded before starting. A service restart by itself
  does not update the installed package. For foreground `npx` usage, specify the
  desired release as `npx --yes openmausbot@X.Y.Z serve --tunnel`.
- **Installed with the installer:** run the install command again.
- **Path B:** `cd OpenMausBot/deploy && docker compose pull omb && docker compose up -d`.

Routines and queued work survive a restart. A teammate turn running at that moment runs again once at the next start, told to check what it already did, and the bot that asked for it is told. A person's own turn and a running routine are not run again: the conversation says it was interrupted. Update between runs where you can.

## Back up

Stop the server before copying its SQLite database: Ctrl-C for a foreground
process, or `sudo systemctl stop openmausbot` from the administrator shell for
the service above. Stop any engine processes and managed desktops still writing
files you intend to back up.

For paths A and C, this backs up application state (bots, chats, routines, tunnel
credentials, and paired sessions). Run it from the service account's shell:

```sh
umask 077
backup_dir=$(mktemp -d "$PWD/openmausbot-backup.XXXXXX")
tar czf "$backup_dir/openmausbot-data.tgz" -C "$HOME" .openmausbot
```

A full backup also needs your engine credential/configuration paths, such as
`~/.codex`, `~/.claude` and `~/.claude.json`, and browser session state under
`~/.agent-browser` if used. Include the paths that exist for your installed CLIs,
any configured home/data-directory overrides, and workspaces outside the app
directory. These are not included in the command above.

For path B, the whole `/data` volume includes the container's CLI homes. From
`OpenMausBot/deploy`, stop the app before archiving; `deploy_data` is the default
volume name, so use your actual volume name if you changed the Compose project:

```sh
docker compose stop omb
backup_dir=$(mktemp -d "$PWD/openmausbot-backup.XXXXXX")
docker run --rm -v deploy_data:/data:ro -v "$backup_dir":/b alpine sh -c 'umask 077; tar czf /b/openmausbot-data.tgz -C /data .'
```

With the installer, the data is a folder, not a volume. Archive it the same way:

```sh
cd /opt/openmausbot && sudo docker compose stop omb
backup_dir=$(mktemp -d "$PWD/openmausbot-backup.XXXXXX")
sudo tar czf "$backup_dir/openmausbot-data.tgz" -C /opt/openmausbot data
sudo docker compose start omb
```

Each command creates a fresh private folder in the current directory, so it
cannot overwrite an older archive with more permissive access. Keep the
archive inside that folder privately on another machine. Restore with the server stopped,
using the same paths and original ownership. After backup or restore, start the
service with `sudo systemctl start openmausbot`, or `docker compose start omb`.

## The rules the setup relies on

Read this before putting anything else in front of the server.

- The server only ever listens on loopback (`127.0.0.1:8799`). Never publish that port yourself. The tunnel, Caddy and Tailscale each reach it from the same machine.
- A request that arrives through a proxy or the tunnel is treated as remote and needs a session, whatever headers it carries. A proxy of your own (nginx, Traefik, Cloudflare Tunnel) must forward the real `Host` and add `X-Forwarded-For` and `X-Forwarded-Proto`, must not buffer the event stream, and must **not** rewrite `Host` to `127.0.0.1`.
- Pairing is the login. Want a second wall in front of it? Path B's `Caddyfile` has a commented `basic_auth` block for a shared password.
- The session cookie is marked `Secure`; do not serve this over plain HTTP on the public internet.
- The one thing a stranger can read is `/.well-known/openmausbot/environment` (the server's id, label, version, capabilities) and `/api/health` (only the app name). Everything else answers "pair this device".

## Troubleshooting

**`serve --tunnel` says "no account on this machine yet".** Run `npx openmausbot login` on this machine first; the credentials are per machine.

**The tunnel stays on "retrying".** The server is running and usable locally; the public hop is not verified yet. Wait a minute (Cloudflare needs a moment on a fresh address), then check `journalctl`/the terminal for the reason. If it never comes up, `npx openmausbot logout && npx openmausbot login` issues a fresh address.

**Path B: the page never loads or shows a certificate error.** Caddy could not get a certificate. Check that the name resolves to the server and that ports 80 and 443 are open; `docker compose logs caddy` shows the reason.

**"forbidden: pair this device to use the server remotely" / "this request came through a proxy".** Expected before pairing, and for tools that call the API without a session. Pair the device. Scripts send `Authorization: Bearer <token>` with the token from the pairing response instead of a cookie.

**Pairing code refused.** It expired (10 minutes, or its `--ttl`) or was used. Mint a new one. "Too many wrong codes. Try again at 11:19." means wait until then.

**More errors** (from the desktop's Connect to a server sheet and the CLI's Reach line) are in the [troubleshooting table](self-hosting.md#troubleshooting).

**A bot says the engine is not signed in.** Sign that engine in again on the server.

**What does the server think it is?** `https://<address>/.well-known/openmausbot/environment` is public and shows its id, label, version and capabilities; `npx openmausbot status` prints the same on the server.

**Something else.** `journalctl -u openmausbot --since -10m` (or `docker compose logs omb --tail 100`) shows the server's startup lines. Paste them with your question in the community channel.

### Ubuntu 24.04 browser sandbox

If Chrome reports `No usable sandbox!` and `sudo journalctl -k --since -10m`
shows an AppArmor `DENIED` for `userns`, the browser download is installed but
Ubuntu is blocking its sandbox. [Chromium documents this restriction](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).
Do not add `--no-sandbox` or disable `kernel.apparmor_restrict_unprivileged_userns` globally.

For paths A and C, an administrator can allow only a trusted, root-owned Chrome
copy. Find the service user's downloaded executable:

```sh
find /home/maus/.agent-browser/browsers -type f -name chrome -executable
```

Use its actual `chrome-VERSION` directory in every path below; `VERSION` is a
placeholder, not a fixed Chrome release. Copy the whole directory, including its
libraries, to a new location that the service user cannot modify:

```sh
sudo install -d -o root -g root -m 0755 /opt/openmausbot-browser
sudo cp -R /home/maus/.agent-browser/browsers/chrome-VERSION /opt/openmausbot-browser/
sudo chown -R root:root /opt/openmausbot-browser/chrome-VERSION
sudo chmod -R go-w /opt/openmausbot-browser/chrome-VERSION
```

Save this as the root-owned `/etc/apparmor.d/openmausbot-chrome`, replacing
`VERSION` with the same value. Keep the exact executable path: a wildcard under
the writable service home would also allow replacement executables.

```text
abi <abi/4.0>,
include <tunables/global>

profile openmausbot-chrome /opt/openmausbot-browser/chrome-VERSION/chrome flags=(unconfined) {
  userns,
}
```

Load the profile:

```sh
sudo apparmor_parser -r /etc/apparmor.d/openmausbot-chrome
```

Add the following line under `[Service]` in the systemd unit above, again using
the exact installed version, then run `sudo systemctl daemon-reload` and
`sudo systemctl restart openmausbot`:

```ini
Environment=AGENT_BROWSER_EXECUTABLE_PATH=/opt/openmausbot-browser/chrome-VERSION/chrome
```

For a foreground server, export `AGENT_BROWSER_EXECUTABLE_PATH` to that same
path in the `maus` shell before starting `serve`. After a Chrome update, copy the
new version and update both the AppArmor profile and service environment; the
root-owned copy is not updated by the browser installer. Keep
`kernel.apparmor_restrict_unprivileged_userns=1`.
