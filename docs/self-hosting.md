# Self-hosting the MausBot server

To keep MausBot and its agents on your current computer and use a VPS only as a
bot’s remote desktop, see [Bring Your Own VPS](byo-vps.md) and the
[published setup guide](https://docs.openmausbot.com/docs/computers/byo-vps).

Run the server on a machine you control (a VPS, a home server, a Mac mini in a
closet). Then connect the desktop app, browsers and phones to it. Every path
below ends the same way: the server prints **one link**, and you paste it into
MausBot under **＋ → Connect to a server**.

> **Security first:** the server listens on `127.0.0.1:8799`, and a program on
> that machine counts as its owner. Never forward that port yourself. Let one
> of the ways in below reach it: `--public-url`, `--domain`, `--tunnel`,
> `--tailscale` or `--lan`. Every device that comes in through one of them has
> to pair. If several people share one server, read
> [Loopback trust](#loopback-trust-owner-or-service).

For server feature switches, defaults and configuration-file instructions, see
[Feature switches](feature-flags.md).

## Pick a way in

| You have | Run | Link it prints |
|---|---|---|
| HTTPS in front already (cloudflared, Caddy, nginx) | `npx openmausbot serve --public-url https://maus.example.com` | `https://maus.example.com/pair#code=…` |
| A domain name, and ports 80 and 443 open | `npx openmausbot serve --domain maus.example.com` | `https://maus.example.com/pair#code=…` |
| Tailscale on the server and your devices | `npx openmausbot serve --tailscale` | `https://<machine>.<tailnet>.ts.net/pair#code=…` |
| Only this network (home or office) | `npx openmausbot serve --lan` | `http://192.168.1.20:8799/pair#code=…` |
| Nothing at all | `npx openmausbot account login`, then `npx openmausbot serve --tunnel` | `https://c-….openmausbot.com/pair#code=…` |
| Only the phone app, from anywhere (a machine with no tunnel address, for now) | `npx openmausbot login --relay`, then `npx openmausbot serve --relay` | a QR for the MausBot app ([MausBot Relay](phone-relay-server.md)) |

`--lan` can be added to any of the others. Plain `http://` is only for a
private network: the desktop app accepts it on LAN addresses, Tailscale
addresses and `*.local` names, and shows "Private network, not encrypted". It
refuses plain http on the open internet.

## Golden paths

### With Node (npx or a global install)

On any machine with Node 24 or newer:

```sh
npx openmausbot setup                                        # once: AI access and a default model
npx openmausbot serve --public-url https://maus.example.com  # or --domain, --tailscale, --lan, --tunnel
```

In a terminal, `serve` checks the address and prints one pairing block:

```
MausBot 0.1.147 · server "hetzner-1"
data: /home/maus/.openmausbot
Reach    https://maus.example.com   ✓ answers as this server (11:04)

Pairing code   7KQ2-M9XD-H4TP   works once, until 11:14 · everything
Link           https://maus.example.com/pair#code=7KQ2-M9XD-H4TP

  Desktop app   ＋ → Connect to a server, paste the link
  Phone         scan with your camera or the MausBot app

  ▄▄▄▄▄▄▄ ▄ ▄▄ ▄▄▄▄▄▄▄   (QR of the link)
For a phone (chat and approvals only)   npx openmausbot pair --phone
New code later   npx openmausbot pair
Stop with Ctrl+C
```

Each way in has its own Reach line:

- `--lan`: `http://192.168.1.20:8799   this network only, not encrypted`
- `--tailscale`: `… · your tailnet`
- `--tunnel`: `… · MausBot web address`

Paste the link into MausBot: **＋ → Connect to a server**. The sheet names the
server it found ("✓ hetzner-1 · MausBot 0.1.147 · HTTPS"), and **Connect to
hetzner-1** finishes. You can also type the address (`maus.example.com`,
`192.168.1.20:8799`) and the pairing code in their own fields.

`serve` with no way in mints no code. It lists the ways in instead. Every
command the CLI prints starts the way you started it (`npx openmausbot`,
`openmausbot`, `pnpm omb`, or `docker compose exec omb openmausbot`), so you
can paste it as is.

### Already have cloudflared, Caddy or nginx in front

Point your tunnel or proxy at `http://127.0.0.1:8799` (webhooks:
`http://127.0.0.1:8800`). Keep the original `Host`, set `X-Forwarded-Proto`,
and don't buffer the event stream ([details](#putting-a-proxy-in-front)).
Then:

```sh
npx openmausbot serve --public-url https://maus.example.com
```

Setting `OMB_PUBLIC_URL=https://maus.example.com` in the environment works the
same way. If the Reach line says
`✗ https://maus.example.com doesn't reach this server`, the tunnel points
somewhere else. Fix that, then run `npx openmausbot account status` to check again.

### Docker on your computer or home network

From a checkout of the repository:

```sh
docker compose up -d --build                  # http://localhost:8080 on this machine
docker compose exec omb openmausbot pair      # a code, and a sign-in link for this machine's browser
```

To pair from other devices on the same network, publish the port there and
name the address they use:

```sh
OMB_BIND_ADDRESS=0.0.0.0 OMB_PUBLIC_URL=http://192.168.1.20:8080 docker compose up -d
docker compose exec omb openmausbot pair      # Link http://192.168.1.20:8080/pair#code=…
```

Do this only on a machine behind your router. A machine with a public address
would answer the whole internet over plain http. More options are in
[the local Compose setup](../deploy/local/README.md).

### Docker with your own domain

On a fresh Ubuntu 22.04 or 24.04 server (x86-64), one command checks the
server, installs MausBot under `/opt/openmausbot` and ends with HTTPS on your
domain:

```sh
curl -fsSL https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/deploy/install.sh | sudo sh -s -- --domain maus.example.com
cd /opt/openmausbot && sudo docker compose exec omb openmausbot pair   # Link https://<DOMAIN>/pair#code=…
```

Add `--check` to only check the server. Running it again repairs;
`sudo /opt/openmausbot/update.sh` updates, with a copy of the data first;
`--uninstall` stops the server and keeps your data. The checks, the files it
writes and what it contacts are in
[Deploy on a VPS](deploy-vps.md#quick-start-one-command-on-your-own-domain).

By hand, on any system with Docker:

```sh
git clone https://github.com/milind-soni/OpenMausBot && cd OpenMausBot/deploy
cp .env.example .env                          # set DOMAIN (and ENGINES)
docker compose pull omb && docker compose up -d
docker compose exec omb openmausbot pair      # Link https://<DOMAIN>/pair#code=…
```

Caddy gets the certificate. See [Docker (with HTTPS on your own domain)](#docker-with-https-on-your-own-domain).

### Keep it running (a service)

```sh
npx openmausbot service install --public-url https://maus.example.com   # the same way-in options as serve
```

This writes a systemd unit (Linux) or a launchd agent (macOS) with the same
options, and prints the `sudo` lines that install it. Run from npx, it first
installs a copy of this exact version beside your data, because npm prunes
its npx cache. The service log never shows a code. Get one with:

```sh
npx openmausbot pair
```

### Podman (rootless, as a service)

> **Warning: this install isolates less than the Docker install.** The
> server shares the machine's network (Podman's host network), so:
>
> - Any port a bot or a tool opens on `0.0.0.0` is open on every interface
>   of the machine, including a VPS's public IP, whatever `--local` says.
>   Bots run unboxed, beside the data folder that holds the engines' logins.
> - Bots can reach every loopback service on the machine: databases, other
>   apps' admin ports.
> - Every local account and process on the machine counts as the owner on
>   the server's port, and can attach to Chrome's debugging port.
>
> Use it on a machine only you sign in to, and put a host firewall in front
> (`ufw`, `firewalld`) that lets in only what you mean to serve.

It needs Linux and Podman 4.9 or newer. One command run as your own user,
without `sudo`, installs the published server image as your user's systemd
service:

```sh
curl -fsSL https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/deploy/podman/install.sh | sh
podman exec -it openmausbot openmausbot pair      # a code, and a sign-in link for this machine's browser
```

It writes a Quadlet unit, `~/.config/containers/systemd/openmausbot.container`,
that runs the image pinned by its digest. systemd starts it again when it
fails or stops answering its health check. It starts at boot once your user
may run services without being logged in. The installer checks this and
prints the one line to run as an administrator; it never runs `sudo` itself:

```sh
sudo loginctl enable-linger "$USER"
```

The server uses the host's network, as `npx openmausbot serve` does. It
listens on `127.0.0.1:8799` only, and a program on this machine counts as its
owner ([Loopback trust](#loopback-trust-owner-or-service)). Nothing is
forwarded into a container. `--local` and `--lan` decide only which
addresses the server's own port answers; they do not limit other ports (see
the warning above). Options, given after `sh -s --`:

| Option | Does |
|---|---|
| `--lan` | The server's port also answers other devices on this network, over plain http, and only from private addresses. Each device pairs. |
| `--local` | Back to this machine only (the default). |
| `--port N` | Another port, when 8799 is taken (webhooks use the next one). |
| `--public-url URL` | The HTTPS address a tunnel or proxy in front of it serves, for pairing links. |
| `--dir PATH` | Another folder for the data and settings (not a Docker install's folder). |
| `--uninstall` | Stops and removes the service. Keeps the data. |

Running the command again repairs the install and keeps the version, the
folder, the data and your settings. It restarts the server only when
something changed. Without `--dir` it keeps the folder the service already
uses; a `--dir` that names another folder is refused. It also refuses while
`update.sh` is running, or after an update that did not finish: run
`update.sh` first.

| | Where |
|---|---|
| Data (chats, settings, engine logins) | `~/.local/share/openmausbot/data`, owned by your user on the host |
| The server's settings | `~/.local/share/openmausbot/server.env`. Apply a change with `systemctl --user restart openmausbot` |
| Log | `journalctl --user -u openmausbot -f` |
| Status | `systemctl --user status openmausbot` |

**Update.** `~/.local/share/openmausbot/update.sh` updates to the stable
version (`--version X.Y.Z` for another, `--check` to only look). It is
`deploy/update.sh`, as for Docker installs: it downloads the image by digest,
stops the service, copies the data into a Podman volume and checks the copy,
points the unit at the new image and restarts the service. Then it waits until
the server answers and can still start bots. If it cannot, the old image and
the copy of the data go back. `update.sh --rollback` goes back after an update
that worked. Run it as your user, without `sudo`. The app's **Update server**
button does not run it on this install yet: run `update.sh` yourself.
When a rollback cannot find the old version by its digest, it names the
copy it kept on this machine, `openmausbot-before-update:local`, in the
unit and in `.env`. Running the installer again never downloads that name:
it pins the copy by the digest it came with, or, when it has none, keeps
it as it is and says so, until the next `update.sh`.

**Uninstall.** Run the same command with `--uninstall`. The data stays.
Some of its files can belong to the container's other user ids, so remove
it through Podman: `podman unshare rm -rf ~/.local/share/openmausbot`. The
copy of the data the last update kept is a Podman volume:
`podman volume ls --filter label=com.mausbot.role=update-backup`.

**What rootless does not do.**

- The bots' sandbox (bubblewrap) is off. The published server image does
  not include bubblewrap, so bots run in the server's container, beside its
  data, as with the Docker image. Use this install on a machine only you
  sign in to. Bubblewrap itself can run in a rootless container, with the
  repository's seccomp profile (`connector/profiles/seccomp-omb-home.json`)
  and `/proc` left uncovered (`--security-opt unmask=/proc/*`). There the
  box's self-check passes 31 of 32 checks; the kernel keyring stays
  reachable. This install sets neither.
- Chrome runs with `--no-sandbox` inside the container, as in every
  container install, and the container is the boundary. It needs no other
  flag: the built-in browser starts and loads pages.
- No HTTPS of its own: put Caddy, a tunnel or Tailscale in front and pass
  `--public-url`.
- Per-bot Linux desktops (**Local VM**) need the Podman socket, which this
  install does not mount. [deploy/podman](../deploy/podman/README.md) runs
  the full stack with them.

Tested on Ubuntu 24.04 (x86-64, Podman 4.9.3), with
`kernel.apparmor_restrict_unprivileged_userns=1`, and nowhere else yet.
Other distributions with Podman 4.9 or newer (RHEL 9.4, or Podman 5 on
Debian 13 and Fedora), SELinux hosts and ARM64 have not been tried.

## Troubleshooting

| You see | It means | Do this |
|---|---|---|
| "That's a pairing code. Also enter the server's address, like http://192.168.1.20:8799." | A code went into the address field. | Type the server's address in the first field; the code moves to its own field. |
| "http://… is on the open internet and isn't encrypted…" | A plain http link to a public address. | Use its https address, or put HTTPS in front: `--public-url` behind cloudflared or Caddy, `--domain`, or `--tailscale`. |
| "This points at this computer (127.0.0.1), not at the server." | A link to `127.0.0.1` or `localhost`, which is the computer you're on. | Use the address other devices reach the server at: run `openmausbot pair` on the server, or choose a way in. |
| "Can't reach 192.168.1.20:8799. Check the server is running and reachable from this computer." | Nothing answers there. | Start it with a way in (`serve --lan` for this network), and check a firewall allows the port. |
| "maus.example.com doesn't exist yet." / "…certificate isn't valid yet." | DNS or the certificate isn't ready. | Wait for the DNS record, or give a new server a minute. |
| "That address answers, but it isn't a MausBot server." | Something else answers there, often a proxy pointing at the wrong port. | Point it at `http://127.0.0.1:8799`. |
| "That's a sign-in code from an email…" / "That code is for the phone app…" / "That's a script key…" | The wrong kind of code. | On the server, run `openmausbot pair` for a 12-character pairing code. |
| "Too many wrong codes. Try again at 11:19." | Five wrong codes in five minutes from one address. | Wait until then, or make a new code. |
| `Reach    ✗ https://… doesn't reach this server (connection refused).` | Your tunnel or proxy doesn't reach port 8799. | Point it at `http://127.0.0.1:8799`, then run `openmausbot account status`. |
| `Reach    ✗ https://… answers as a different server.` | The address leads to another MausBot server. | Point the tunnel at this machine's port. |
| `Reach    … https://… doesn't answer yet` (`--domain`) | DNS isn't pointing here yet, or ports 80 and 443 are closed. | Fix the A record and open the ports; the certificate follows. |
| `--lan: this machine has no private network address…` | A VPS with only a public address. | Use `--public-url`, `--domain` or `--tailscale`. |
| `tailscale: HTTPS certificates are off for this tailnet, so this server listens on http://…` | Tailscale can't serve HTTPS yet, so the server listens on its own tailnet address. It works, and only your tailnet reaches it. | For an `https://` address, turn on HTTPS certificates at https://login.tailscale.com/admin/dns, then run `serve --tailscale` again. |
| `No MausBot server is running here. Start it: … serve` | `pair` found no server on this port. | Start it, or pass the server's `--port` and `--data-dir`. |
| `Get a pairing code: openmausbot pair` and no code | The server runs as a service or under `docker compose logs`, where codes stay out of logs. | Run that command in a terminal. |
| "This shared server takes no pairing commands from this machine." | The server runs with `OMB_LOOPBACK_TRUST=service`. | Let people sign in with their email (`openmausbot access add you@example.com`), or pair from a signed-in admin's Settings. |

## Reference

The rest of this page explains each part in detail.

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
  It reaches the public internet and the dev servers a bot starts itself,
  not this server's network or other services unless `browserEngine.egress.allow`
  lists them ([what a bot's browser can reach](browser-packaging.md#what-a-bots-browser-can-reach)).

Desktop-only for now (needs the Mac/Linux app):

- dictation/voice, controlling the host desktop

## Ways in, in detail

`npx openmausbot start` (or plain `npx openmausbot`) is the guided start. It
asks for AI access, an account or API key, and the default model, then opens
the workspace in this machine's browser. `setup` only configures, and `serve`
starts without questions from the saved configuration and the flags you give
it (for services and scripts). The [setup guide](cli-onboarding.md) explains
the choices. The npm package does not include engine CLIs (`claude`,
`codex`, …); setup can install and sign in the supported ones. Run setup,
engine sign-ins and the server as the same unprivileged user: engine
credentials live in that user's home, not all under `.openmausbot`. For a
Linux service, the [VPS guide](deploy-vps.md#before-you-start) covers the
account, engines and browser libraries. After installing browser libraries
as administrator, run `npx openmausbot browser install` as the service user
too.

- **`--public-url URL`**: you already have HTTPS in front. The address must
  be https, or http on a private network. After start, `serve` fetches
  `URL/.well-known/openmausbot/environment` and prints whether it answers
  with this server's own id. The pairing link uses that address either way.
- **`--domain NAME`**: point the domain's A record at this machine and open
  ports 80 and 443. The server downloads a pinned Caddy once into its data
  dir, writes the same Caddyfile the Docker stack uses, runs it as a child,
  and Caddy gets and renews the certificate from Let's Encrypt. On Linux,
  binding ports 80 and 443 as a normal user needs one privilege grant. When
  Caddy reports the refusal, `serve` prints the exact `setcap` command to run
  once.
- **`--tailscale`**: needs Tailscale signed in. With HTTPS certificates off
  for the tailnet (admin console → DNS), or `tailscale serve` not allowed for
  this user, the server listens on this machine's own tailnet addresses at
  `http://<name>:<port>` and answers only tailnet peers that use that exact
  name. Otherwise `serve` checks that
  no other MausBot server already answers on this machine's name. Then it
  runs `tailscale serve --https=443 http://127.0.0.1:8799` in the foreground,
  so the share ends when `serve` stops. A marker file in the data dir lets the
  next start turn off a share that a crashed run left behind. It never
  touches a share you made yourself. Only devices on your tailnet can reach
  it.
- **`--lan`**: listens on every IPv4 address and drops any connection whose
  local or remote end isn't private (loopback, 10/8, 172.16/12, 192.168/16,
  100.64/10, link-local). The link uses this network's address, read again
  for every code, so a new Wi-Fi network needs no restart. Docker bridges, VM
  networks and VPN tunnels are skipped. A machine with no private address
  says so and stays on loopback. Plain http travels in clear, so use it only
  on a network you trust.
- **`--tunnel`**: `npx openmausbot account login` reserves an address like
  `https://c-….openmausbot.com` for this machine (an emailed code signs it
  in). `serve --tunnel` connects it through a Cloudflare tunnel, the same one
  the desktop app uses for its companion. The first run downloads
  `cloudflared` (pinned version and digest) into the data dir. Only traffic
  through the tunnel reaches the server, and it still has to pair: the tunnel
  lands on a separate listener that the server treats as "through a proxy",
  never as the owner. That listener gzips JSON replies of 1 KB or more when
  the client accepts gzip; the loopback port never compresses.
  `npx openmausbot account logout` releases the address. The account credentials
  live in `~/.openmausbot/tunnel-account.json` (mode 0600). Started from a
  fleet or a container, where nobody can type an emailed code? Set
  `OMB_INSTALLATION_CREDENTIAL` to the installation credential the fleet
  issued and skip `login`. The address and connector token are fetched at
  every start, and nothing is written to disk. A rejected credential stops
  the start with a clear message rather than serving locally.

Later: `npx openmausbot pair --label "Kitchen iPad"` for another device
(`--phone` for one that may chat but not change settings), and
`npx openmausbot devices` to see or sign them out. `openmausbot serve` is a
plain foreground process. For unattended use, run `service install` (above)
or follow the [systemd example](deploy-vps.md#keep-it-running). Restarting a
service never downloads a new release on its own.

## Connect ChatGPT from the browser

A browser paired with Full access can connect an installed Codex CLI without opening a
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
domain** from a browser paired with Full access. This is an address-setting and verification
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

On Ubuntu, the [installer](deploy-vps.md#quick-start-one-command-on-your-own-domain)
sets this up with one command, keeping the data in `/opt/openmausbot/data`.
The rest of this section is the same setup by hand.

One tenant = one container for the server plus Caddy for HTTPS.
Requirements: Docker with Compose, a DNS name pointing at the machine, and
ports 80/443 open.

```sh
git clone https://github.com/milind-soni/OpenMausBot && cd OpenMausBot/deploy
cp .env.example .env            # set DOMAIN
docker compose pull omb && docker compose up -d
```

That starts the image CI publishes on every `main` push
(`ghcr.io/milind-soni/openmausbot:latest`; each release is also tagged `v…`,
and the one our own Clouds have run for 48 hours is `stable`). Move to the
stable version right away with `./update.sh`, which pins it by digest in
`.env`. To build from your checkout instead: `docker compose up -d --build`. The
build needs about 6 GB of memory: on a smaller server, add swap first or use
the published image.

Then sign the engine CLIs in **inside the container** (their logins live on
the `data` volume, so they survive restarts and image upgrades) and mint a
pairing code for your first device:

```sh
docker compose exec omb claude                       # each CLI you listed in ENGINES
docker compose exec omb openmausbot pair             # prints a code, a link and a QR
```

Paste the link (`https://<DOMAIN>/pair#code=…`) into MausBot under **＋ →
Connect to a server**, or open it in a browser, and it is paired; see "Using it from your computer" for what a session is. Webhook
URLs (`https://<DOMAIN>/hooks/wh_…`) work without a session, and that is the
base the app prints on new hooks because the stack sets
`OMB_WEBHOOK_PUBLIC_URL`.

What the stack does, so you can adapt it:

- [`Dockerfile`](../Dockerfile) builds the UI and the self-contained
  server bundle, and runs them as an unprivileged user with `HOME=/data`.
  `--build-arg ENGINES="…"` (or `ENGINES=` in `.env`) bakes engine CLIs
  into the image.
- [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) runs Caddy
  in its own container. It reaches the server over two Unix sockets in a
  shared in-memory volume (`OMB_TUNNEL_SOCKET`, `OMB_WEBHOOK_SOCKET`), so the
  server never binds anything but loopback, and a request that comes through
  Caddy is a remote one, as one through any proxy is. Caddy used to share the
  server's network instead; then a server container restarted on its own (a
  crash, `docker compose restart`, `stop omb`) came back in a new network and
  left Caddy refusing HTTPS in the old one while both showed healthy.
- [`deploy/Caddyfile`](../deploy/Caddyfile) terminates TLS and forwards
  the real `Host` plus `X-Forwarded-For`/`X-Forwarded-Proto`; the server's
  own pairing is the login. It adds no password: a Caddy password would
  refuse clients that send their own `Authorization` header. For a second
  wall, use a tailnet or a firewall.

Update with `git pull && ./update.sh`: it copies the data aside, starts the
stable version, and puts the old version and the data back if the new one
does not come up healthy ([what it does, step by step](deploy-vps.md#update)).
A build from source updates with `git pull && docker compose up -d --build`.
State (chats, routines, engine logins, paired sessions) is on the `data`
volume; back that up.

The published image installs the current Chrome for Testing whenever a new
Stable ships. A build from source keeps the Chrome (and any `ENGINES`) it
installed first, because those layers sit beneath the app and stay cached
across code changes. To pick up the current ones, rebuild with a new tag:

```sh
docker compose build --build-arg CHROME_CACHE_TAG=$(date +%F) omb && docker compose up -d
```

## Running on a container platform (Railway, Render, Kubernetes, Cloud Run)

These platforms run the image's own command, with no `--init`, and usually
with a 64 MB `/dev/shm` and a limit on how many processes the container may
hold. The server image (`ghcr.io/milind-soni/openmausbot`) is built for that:

- **It brings its own init.** tini is the image's entrypoint and collects
  the processes that bots' engines, browsers and shell commands leave behind.
  Without one they stay in the process table as zombies until the container's
  limit is reached, and then nothing new can start: bots fail with
  `spawn EAGAIN`. Keep the image's entrypoint when you set a start command.
  If your platform replaces it, the server says so in one line at start and
  starts itself again under the image's tini, which then stays process 1; an
  init of the platform's own on top (`docker run --init`, Compose's
  `init: true`) does no harm. A command you give the container runs as
  written, so start it with `openmausbot …` or `node …`
  (`docker run --rm ghcr.io/milind-soni/openmausbot openmausbot --version`):
  a bare `--version` or `dist-server/openmausbot.js`, which older images
  passed on to Node, no longer starts.
- **Chrome does not need a larger `/dev/shm`.** Where `/dev/shm` is under
  512 MB the bots' browser keeps its shared memory in `/tmp`, so there is
  nothing to set. `/tmp` is slower, and where it is itself in memory (Cloud
  Run) it counts against the container's memory limit; a 512 MB `/dev/shm`,
  where your platform lets you set one, avoids both.
- **Mount a volume at `/data`.** Engine sign-ins and all of OpenMausBot's
  state live there.
- **Give the platform a way in.** The server listens on `127.0.0.1` inside
  the container, which a proxy outside the container cannot reach. Any one
  of these works:
  - `OMB_LAN=1`: the server listens on every IPv4 address, on `OMB_PORT`
    (8799 unless you set it; point the platform there). It still drops any
    connection whose either end is not a private address (10/8, 172.16/12,
    192.168/16, 100.64/10, link-local), so it answers a proxy that reaches
    the container over a private network, such as an ingress controller
    inside a Kubernetes cluster, and refuses one that arrives from a public
    address: check which your platform's does. Every request through it is
    a remote one and has to pair.
  - A proxy next to the server (a sidecar in the same Kubernetes pod or
    Cloud Run service): share an in-memory volume between the two, set
    `OMB_TUNNEL_SOCKET` to a socket in it, and point the proxy at that
    socket, as [the Compose setup](#docker-with-https-on-your-own-domain)'s
    Caddy does. A sidecar can reach `127.0.0.1:8799` too, but then it must
    add `X-Forwarded-For` to every request (Caddy does): a loopback request
    with no forwarding header and a loopback `Host` is taken to be the
    server's owner.
  - A tunnel that dials out, so nothing has to reach the container:
    `openmausbot serve --tunnel` as the start command ([`--tunnel`](#ways-in-in-detail)).

**How many processes and how much memory.** A container's process limit
(`pids.max`; Docker's `--pids-limit`, Kubernetes' `podPidsLimit`) counts
threads, not only processes, and every bot that is working holds an engine
and the small helper programs that give it its tools:

| What | Processes | Counted against the limit | Memory |
| --- | --- | --- | --- |
| The server itself | 3 | about 20 | about 1 GB |
| Each bot that is working | 6 or more | about 45, more while it runs commands | about 700 MB |
| Each open browser | about 13 | about 165 | about 400 MB |

An engine stays loaded for ten minutes after its bot's last turn, so count
the bots that work within the same ten minutes, not only in the same second.
Leave room for the commands bots run: budget about 80 per working bot.

| Bots working at once | Process limit to ask for | Memory |
| --- | --- | --- |
| 5 | 1,024 | 6 GB |
| 10 | 2,048 | 10 GB |
| 20 | 4,096 | 18 GB |
| 34 | 4,096 | 28 GB |

The limit column includes two open browsers. A server opens more when its
limits leave room for them (at most 40% of the process limit and of the memory
go to browsers; `OMB_BROWSER_MAX_RUNNING` sets the number instead), and each
new browser also waits for room for its processes, as a turn does. If
your platform's limit is fixed and lower than the row you need, the server
still works: fewer bots run at the same moment and the others wait.

**Turns wait for room instead of failing.** In a container that was given a
memory limit or a process limit, the server holds a turn back while its
engine would not fit, and starts it by itself when there is room:

- It reads the container's own limits (cgroup `memory.max` and `pids.max`,
  v1 or v2) and what is used now, never the host machine's totals.
- Before it makes a turn wait it closes an engine no turn is using. An idle
  engine otherwise stays loaded for ten minutes for the conversation in
  front of you and thirty seconds for work nobody is watching (a teammate's
  task, a routine), and no more stay idle than fit beside the ones working.
- A waiting turn says so in its chat ("Waiting for room on this server…"),
  and again every ten minutes. A routine's run waits the same way; a routine
  is never switched off for it.
- A bot's browser opens only where its processes fit under the process
  limit. Each open browser is counted at its full size for as long as it
  runs, so one that a bot opens halfway through its turn is never missed.
  With no room, the browser call waits up to 20 seconds, then tells the bot
  that the server is close to its limit and to try again later.
- If the system refuses to start a bot's engine anyway (`spawn EAGAIN`,
  `EMFILE`, `ENOMEM`), or the kernel stops an engine for memory, that is the
  server's shortage, not the AI's failure: nothing is sent to a backup AI
  and no Chief is asked about it. The chat shows one line, the turn starts
  again by itself once, half a minute later, behind the same wait, and only
  if that fails too are you told. A failure that names its own cause (a usage
  limit, a sign-in) is always shown as it is.
- A new engine that says nothing for 90 seconds is stopped the same way only
  while the server is short of room (its process limit nearly full, a start
  refused since the engine began, or memory short) and only once the
  engine and everything it started have stopped using the CPU. A slow first
  start, such as an engine that `npx` is still installing, is left to finish
  or to time out on its own.

`OMB_TURNS_MAX_RUNNING` sets how many turns run at once on the whole server:

| Value | What it does |
| --- | --- |
| unset | In a container with a memory or process limit: a number worked out from those limits (below). Anywhere else: no limit, as before. |
| `auto` | The worked-out number on any self-hosted server, with or without a container limit. |
| a number | That many turns at once. The live checks on memory and processes still apply. |
| `off` or `0` | No waiting at all. |

The worked-out number is the smaller of two: the memory limit less a tenth
(at least 320 MB), divided by 700 MB for an engine; and the process limit
less a tenth (at least 32) and 40 for the server, divided by 60. A 4 GB
container runs 5 turns at once, an 8 GB one 10; a process limit of 512 allows
7, 1,024 allows 14, 4,096 allows 60. The desktop app never uses this setting,
and a MausBot Cloud keeps its own rules.

On Kubernetes a pod's process limit (`podPidsLimit`) is set above the
container, where the server cannot read it. The server then learns it from
the first refused start and holds turns below that count for the next half
hour; set `OMB_TURNS_MAX_RUNNING` to a number to avoid that first refusal.

**Reading how close the server is.** At start the server logs one line with
what it found, for example `processes: process 1 is an init; limits:
processes and threads 512, memory 4096 MB, ulimit -u unlimited, /dev/shm 64
MB`. It logs one more line the first time it passes 80% of its process limit,
one the first time it passes 80% of its memory limit, and one the first time
more than 20 exited processes are waiting to be collected (which means the
container has no init). `GET
/api/diagnostics/performance` and the performance part of a problem report
carry a "Process room" block: what process 1 is, the limits, how many
processes, threads, zombies and open files there are now and at their most
since start (engines by kind, browser, tool servers, commands, other; sampled
each minute, and the kernel's own exact high-water marks where cgroup v2
keeps them), how
many turns run and wait and the longest wait, and counts since start of
turns that waited, starts the system refused by error code, engines that
never came up, and processes that had to be force-stopped or outlived their
turn. It holds numbers and fixed words only: no command line, path, bot name
or message.

**Per bot.** The same report carries each bot's share, taken from the same
process list (no extra work per bot): its processes, threads, resident memory
(now and at its most since start) and CPU time, counting its engine, what the
engine started (including what outlived its turn in the engine's process group
or session) and its own browser. An engine or browser several bots share (a
shared engine process, a browser profile used by more than one bot) is counted
once as "shared", never against any one bot. The report shows the ten bots
using the most memory; `GET /api/diagnostics/bots` (admin only) lists every
bot. Bot ids and numbers only.

**Idle engines close sooner when room runs short.** A conversation's engine
stays loaded after its turn (10 minutes by default, `OMB_SESSION_IDLE_MS`;
30 seconds for work nobody is watching), a bot's browser stays open for its
idle time, and a process several bots share is recycled a minute after its
last session (`OMB_ACP_SHARED_RECYCLE_MS`; this one stays fixed). Where turns
wait for room, a conversation's engine time and a browser's idle time shrink
as memory or the process limit fills, down to a tenth (never below their
floor), and engines already kept are looked at again every few seconds.
Before a new turn or browser waits for room, the engine idle longest is
closed.

**One bot's memory.** Where turns wait for room, the server watches how
much memory each bot uses against twice its fair share (the memory over
the turns that may run at once), at least 1,900 MB and at most 80% of it,
for each engine the bot runs (a bot with several conversations open may use
that much for each). By default it only writes down a bot that stays over
(for 30 seconds, or sooner while memory is short): the bot's id, the memory
it used and how it was measured, the limit, its engines and the room left
go to the server log and the health report. Nothing is stopped. To have the
server act, set `OMB_BOT_MEMORY_MAX_MB` to a number of MB (any Linux host,
the desktop app included); `auto` is the default (watch only) and `off` turns
the watching off. Even then it acts only while the server is short of
memory, only on the bot using the most, and in steps: first what the bot
left running and its idle engines; then, measured again and still over, its
largest busy engine. The browser of a stopped engine's conversation is
closed once that turn lets it go. A turn whose engine is stopped ends with a
line saying the bot used more memory than this computer allows for one bot.
Engines and browsers several bots share, and a process other conversations
may join, are never stopped this way; on a Team Cloud only the stopped
conversation's own browser is closed, never the same bot's browsers for
other members. The
server watches by reading its process list; it logs at start whether the
host also offers a systemd scope or a delegated cgroup, which are not used
yet.

**Bots' cloud computers do not count.** A bot's cloud computer runs at the
provider that hosts it, not in this container, so its desktop and browser
use none of the container's processes or memory. Only the built-in browser
described above runs here.

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
npx openmausbot service install --domain maus.example.com   # or --public-url, --tunnel, --tailscale, --lan
```

It renders a systemd unit (Linux) or a launchd agent (macOS) that runs the
same `openmausbot serve …` with your options, restarts it if it stops, and,
for `--domain`, grants the unit the capability to bind ports 80 and 443
without root. The file is written next to your data and the two commands
that install and start it are printed (they need `sudo` on Linux).
`openmausbot service uninstall` prints the reverse. Run from `npx`, it
first installs a copy of the same version into `<data dir>/app/<version>`,
because npm may prune its npx cache. The unit points at that copy. Not being
a terminal, the service writes no pairing code into its log: run
`npx openmausbot pair` when you need one.

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

A saved key goes only to its own engine and only to the workspace's endpoint:
an engine instance in `config.json` with its own base URL or its own key (a
router or proxy) never receives it.

**OpenCode is the exception to "the server's own environment is ignored".**
Like `opencode` in a terminal, it reads provider keys from its environment
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`,
`KIMI_API_KEY`, `MOONSHOT_API_KEY`, `MINIMAX_API_KEY`) and offers those
providers' models, billed to that key. It does so only where the server's
environment is one person's own: never on MausBot Cloud, a hosted team
workspace, an organisation-managed desktop, or a server whose sign-in list
lets other people in (users, more than one admin, or a whole domain).
Providers added with `opencode auth login` work everywhere.

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
shows **Settings → Installations** (with the enterprise `admin` feature): create
an installation, add or remove who may sign in, suspend, resume, delete, upgrade
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
docker compose exec omb openmausbot pair     # Docker
```

It prints a 12-character pairing code (it works once, for 10 minutes, or up
to a day with `--ttl 24h`) and the link with the code in it, built from the
address the server is reached at (`--public-url`, `--domain`, `--tunnel`,
`--tailscale`, `--lan`, or `OMB_PUBLIC_URL`). Open the link, or open `/pair`
on that address and type the code. The browser gets a session cookie (30
days, renewed on use up to 180 days from pairing, revocable) and the app
loads. `npx openmausbot devices` lists the paired devices and
`devices revoke ID` signs one out.

From the **desktop app**, choose **＋ → Connect to a server** and paste the
link. You can also type the address (`maus.example.com`,
`192.168.1.20:8799`, a `*.ts.net` name) and the pairing code in its own
field. The sheet looks the address up and names what it found, for example
"✓ hetzner-1 · MausBot 0.1.147 · HTTPS". A bare address tries https first,
then plain http when the address is private. Plain http works only on a
private network (LAN addresses, Tailscale's 100.64/10 and `*.ts.net`,
`*.local`); a public http address is refused with what to do instead.
Generate a fresh code for each device: `npx openmausbot pair --label "My
desktop"` gives full access, and `--phone` gives chat and approvals only. A
code already used by your phone cannot also pair your desktop.

**Connect to hetzner-1** opens the server's own page with the code, and the
app stays signed in across restarts. The rail at the window's left edge
switches between this computer and each server, without moving bots or
chats. A link copied elsewhere also works from the **Server** menu's **Add
Server from Copied Pairing Link…** (on Windows and Linux, press Alt to show
the menu bar).

**Let your server use this computer.** When the desktop pairs with a code for
everything (the server's owner), it asks once: **Let <server> use this
computer?** with **Allow** or **Not now**. Allow lets the server's bots see and
use the apps on this computer's screen, and run the MCP servers you keep for
it, while the app is open. Folders and the terminal are added in **Settings →
Servers**, where each server of yours has a **Share this computer** switch and
**Choose what it can use**; the switch turns it off at once, and the menu bar's
OpenMausBot item pauses it with your Clouds. The server needs nothing turned on:
it takes a computer from its owner's pairings only, and a phone code or another
person's pairing is never asked. Set `features.sharedComputers` to `false` in the
server's config to turn this off, or to `true` to let every paired session lend
its computer. Nothing is shared without that Allow, unless you make the server
your bots' home (below). In **Settings → Servers → Computer
access**, choose read-only folders and optionally allow edits. Unrestricted
terminal and screen/app control are separate opt-ins, confirmed in a native
dialog. They can access information outside the selected folders. Share only
with a workspace you trust; its bots and AI providers may receive shared content.
A folder read takes a file of up to 2 MiB and a write at most 256 KiB;
transfers do not follow links or delete files. Local screen control also needs OS permissions and a supported
desktop driver. Microphone access is not included.

**Make the server your bots' home.** Bots work together only within one
place: bots on this computer can't reach bots on the server. To bring them
together, right-click the server's circle at the window's left edge and choose
**Make <server> my home**. The app moves this computer's bots, chats, memory,
skills, logins, apps and keys, and routines there the way it moves them to My
Cloud: everything is copied while you keep working, then at a quiet moment this
computer stops for good, the rest goes, both sides are checked, and the server
switches on what was on here, so no routine ever runs twice. The account area
says how it goes, and after a day of failing it says the move needs you, with
Try again. Afterwards the server is what the window opens, and this computer
works for it by itself as it does for My Cloud: no access dialog, only the
menu bar's item with Pause.

Until then, a bot that asks for a teammate living in your other place says where
that teammate lives and how to bring them together, instead of only that it
can't reach it: the app tells each place of yours the names of the bots your
other places have, and nothing more.

This is offered only for a server that is yours alone: you paired with it as an
admin, and its sign-in list names no members and no other admin (Settings →
People). A server other people sign in to keeps the explicit **Share this
computer?** flow above, and its bots stay where they are. Both sides need this
release: an older server says to update it first.

To move by hand instead, export a backup from this computer in **Settings →
Import & export → Export backup**, then import it on the server in **Settings → Import & export
→ Import backup**. API keys, engine sign-ins and paired devices stay where they
are on both sides; routines arrive paused. An older desktop app's **Copy this
computer here** is answered with "Update OpenMausBot to bring your bots here by
itself."

Only conversations you start yourself on that server can use what you share;
other people's bots, routines and webhooks there cannot. Keys and sign-in
stores (`~/.ssh`, cloud CLIs, browser profiles, keychains) and `.git`
internals stay out of reach of any shared folder, and the desktop keeps a log
of every request under **Computer access**.

Sharing works while this desktop is awake and running, including when viewing
another workspace. **Stop sharing** revokes access; closing the app stops the
connector. An action already sent to a local app may still finish. **Forget**
also stops sharing and signs this desktop out, without deleting the server's
bots or conversations. If sign-out cannot reach the server, the app warns you;
revoke its session there when reachable again, or if the device is gone.

What this changes about the trust model: the server still binds loopback
and still trusts programs on loopback as the owner, though never a browser
(below). A **paired session** is the second way in: a bearer token or the cookie, same-origin only, with a scope (`admin`
by default, `--phone` for a device that may chat but not change settings or
pair others). Five wrong codes in five minutes from one address lock that
address out for five minutes ("Too many wrong codes. Try again at 11:19.").
Behind a proxy that names no client, every visitor looks like this machine,
so those wrong codes never lock anyone out: after five of them the open
codes stop working and a new one has to be made. Over plain HTTP (`--lan`,
or a LAN address without TLS) the cookie is not marked `Secure` and travels
in clear: use HTTPS (`--public-url` behind your proxy, `--domain`,
`--tailscale`) for anything beyond a trusted private network.

A loopback request counts as the owner only when it really comes from this
machine. A client on the LAN that writes `Host: 127.0.0.1` is still a
stranger.

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
# then run `openmausbot pair` on the server and open the "Browser on this machine" link it prints
```

The browser signs in once through the tunnel, like any browser on the server
itself.

### A browser signs in

A browser never gets loopback trust, on any server: a request that carries
the `Sec-Fetch-Site` or `Sec-Fetch-Dest` header (every browser sends them to a
loopback address, and a page cannot remove them), or a WebSocket handshake
with an `Origin`, needs a session: a web page is not the person who owns the
server, even when it runs on the same machine. Programs are unaffected: the
CLI, scripts, `curl` and the companion send neither header.

So the first time you open the web UI in a browser on the server's own
machine, it shows the sign-in page. With no way in, `openmausbot pair` prints
a link for it:

```
  Browser on this machine     http://127.0.0.1:8799/pair#code=XXXX-XXXX-XXXX
```

Open it and choose **Connect** (or type the code on the sign-in page); the browser
keeps its session cookie from then on. `openmausbot` (the guided start) prints
the same link when it opens the browser. The desktop app is unaffected:
its window adds the app's own per-launch owner header to every request and
WebSocket it sends to its server, and no other Electron session may reach the
server at all.

For development, `pnpm dev:server` sets `OMB_DEV_TRUST_LOCAL_BROWSER=1`, so a
browser on Vite's dev page (`pnpm dev`) is the owner as before. The server
honours it only when it runs from source with owner trust, logs a warning, and
ignores it in a build, the desktop app, a hosted workspace and MausBot Cloud.
Run `OMB_DEV_TRUST_LOCAL_BROWSER=0 pnpm dev:server` to try the sign-in.

### Loopback trust: owner or service

Every bot's shell runs on the server as the same user, so every bot is a
loopback caller too. On a server one person uses that is fine: the bots are
theirs. On a workspace several people share it is not: a user could ask a
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
already need the app's own per-launch capability. MausBot Cloud ignores
it too and is always `service` (docs/cloud-pro.md).

With `service` on a self-hosted server:

- `openmausbot serve` in a terminal still prints the first pairing code. It
  hands the server it starts a one-off secret over the server's stdin (never
  its environment, which every engine inherits), and that secret opens the
  pairing route for that CLI alone. Pass `--no-pair` to skip the code; if
  the server refuses one anyway, `serve` says why and keeps running. Not in
  a terminal (a service), it prints no code and points at email sign-in.
- `openmausbot pair` and `openmausbot devices`, run later from another
  terminal, are refused like any other admin change and say so. Pair from
  the server's Settings while signed in as an admin, or let people sign
  in with their email (`openmausbot access add you@example.com`, which edits
  the sign-in list on disk).
- A browser on an SSH tunnel gets the sign-in page instead of the app.
- The MCP server script works with `OPENMAUSBOT_TOKEN` set to a paired session.

**What `service` does not close yet.** Any bot's shell can still do
everything the Slack worker does, and on a shared workspace that is a real
gap: it can post into any bot's thread through the guarded route, including
an existing Full-access thread (`expectedApprovalMode: "full"`), and while
shared Full access is on it can open new Full-access threads. Either way the
work runs with Full access and no card, so a user who can talk to a bot
can get Full access through it. It can also stop a request and decline a
card. It cannot approve a card, change settings, keys, people or sessions,
or loosen a bot's permissions. The planned fix is a relay token that only
the Slack worker holds, so these routes stop answering session-less loopback
at all; until then, turn shared Full access on only where every user may
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
the same access as a pairing code from `openmausbot serve`; users get the
chat-only scope, the same as `openmausbot pair --phone`. The same lists live
in `config.json` under `signIn.admins` and `signIn.members` and can be changed
through the settings API without a restart. An environment variable that
names someone wins over its list, which is how a container or a service unit
is bootstrapped; while it does, Settings refuses to change that list and says
which variable to change instead. One that is empty, as `.env.example` and the
Compose files leave them, leaves the list to Settings.

The code itself comes from `accounts.openmausbot.com`, the OpenMausBot
account service, so your server needs no email credentials. Your server asks
it to send the code, checks the answer, and then issues its own session
cookie: the browser only ever talks to your server, and who is welcome is
decided only by your allow-list. Wrong codes count against a lockout of
their own: ten in a minute from one address pause sign-in there for a minute. Sessions from a sign-in show the email in
`openmausbot devices` and can be revoked the same way.

To send the codes through your own mail server instead, so nobody signs in
through the account service and no MausBot account is made, give the server
an SMTP address:

```sh
OMB_SIGNIN_SMTP_URL="smtps://signin%40yourcompany.com:PASSWORD@smtp.yourcompany.com:465"
OMB_SIGNIN_SMTP_FROM="OpenMausBot <signin@yourcompany.com>"   # else the user name, if it is an address
```

`smtps://` uses TLS from the start (port 465); `smtp://` upgrades with
STARTTLS (port 587) and refuses a server that cannot, unless the mail server
is on this machine (`smtp://localhost:25`). Write the user name and password
URL-encoded (`@` is `%40`). Your server then makes each code itself: 8 digits,
single use, ten minutes and five tries, kept only as a hash in memory (a
restart ends the open ones), and at most one every 30 seconds per address.
The allow-list, the lockout and the sessions work as above. Keep the URL in
the service's environment file, never on a command line.

### Inviting people

**Settings → People** lists who may sign in, their role, when they were last
seen, and what each person spent this month. **Invite** adds an address (or
`@company.com` for everyone there) and shows a link like
`https://your.host/pair?email=name%40company.com`: it opens the sign-in page
with the address filled in, and the one-time code still goes to that address.
Roles change with one click; removing someone stops new sign-ins.

On a hosted workspace whose members your organization's Admin manages
(`OMB_ADMIN_MEMBERSHIP=portal`), this list decides nothing, so Settings →
People shows, read-only, who has signed in and what they spent, with a
**Manage people in Admin** link to that workspace in Admin → People. Remote
access there lists signed-in devices and offers no pairing codes, since a
hosted workspace refuses them.

### Who may answer a card

Approval cards are the provider's own (see the approval modes); OpenMausBot
adds none. On a workspace several people share — portal membership, or an
email sign-in list that names users — it narrows only whose answer counts,
and only when the card can be traced to a person:

- a card for a request a user sent, or in a thread a user opened, is
  theirs to answer (admins and the owner may answer any card);
- a thread a bot opened while working on someone's request (a job it handed
  a teammate with `coordinate_bots`) is traced back to that person, so the cards of work done
  for them are theirs too;
- a card that names nobody — sent by the owner on this machine, by a
  routine or webhook, from Slack (until Slack passes the asker through), or
  in a thread from before this existed — may be answered by any user, as
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
user who may not see a bot, the server answers the bot, its threads and
their messages, images, exports, reactions, cards, sends, routines, runs and
attachments exactly as it answers an id that does not exist (404), and leaves
the bot out of the bot list, search results, routines, webhooks, the team map
and the live event stream. Every bot a user is sent, by any route, comes
without its audience list or the ids of teammates they cannot see. When an
admin changes a bot's audience, every user's open app reconnects and
reloads exactly what that person may now see (a user who was away and
resumes from an older point gets the same fresh load); admins' apps are left
alone.

- **Rooms.** A room is one shared transcript, so its bots must be visible
  to the same people: creating a room, adding a bot to one, or scheduling a
  call between bots that other people see differently is refused with a
  plain sentence (for admins too). If an admin later restricts a bot that
  is already in a room, the change is allowed and the room narrows to the
  people who can see all its bots. A room also keeps the narrowest audience
  it has ever had (its floor): taking the restricted bot out, deleting it,
  or widening it again never shows the transcript to more people. A user
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
- **Departments.** A department (sidebar section) is listed to a user only when it
  holds a bot or room they can see.
- **Bots working together.** A bot reaches any teammate, in any department
  (`coordinate_bots`, its roster and `list_bots`, @mentions, a Chief's team),
  but only when exactly the same people can see both: otherwise one bot's
  thread could carry the other's answers to people who cannot see it. Bots nobody restricted all
  share "everyone", so nothing changes until an admin restricts one. A bot a
  Chief creates (directly, or in a reviewed team setup) gets exactly the
  Chief's audience, and a copy of the Chief's connected apps.
- **Who sees everything.** Admin sessions, the owner on this machine, and a
  session-less local service (the Slack worker under `service` trust) see
  every bot. A pairing-code device with no email sees only bots everyone
  can see. Users never receive a bot's audience list.
- **Files.** An attachment is refused only when everything that uses it —
  a message in a thread, a bot's picture — is hidden from that user. A
  file nothing uses yet (someone's own upload) is served; its name is random.
- **Not covered.** Words already quoted into a conversation a user can
  see (an earlier hand-off, a message copied by hand, or something a bot
  wrote into its own memory files with its file tools while it shared a room
  with a restricted bot) stay there. A bot's
  shell can still read files on the server, as it always could. Slack is
  decided in your organization's Admin: whoever may message a bot's Slack
  app reaches that bot there.

The desktop app has no chat-only user sessions and does not show this setting;
nothing there changes.

On the Workspaces screen, creating a client workspace shows the same kind of
link for that workspace's admin, so a client gets one address, one workspace
and one link.

## Announcements from the project

When someone opens the app, the server downloads the project's public announcements file from GitHub
(`raw.githubusercontent.com`, at most once an hour, a plain GET with nothing of yours in it) and its pages may show one of
its cards in the corner: product news, a tip, or a sponsor's offer, each once per person
([docs/announcements.md](announcements.md)). Set `OMB_DISABLE_ANNOUNCEMENTS=1` in the server's environment to never
download it and never show those cards.

## Attachment storage

Files people attach, and pictures a bot shows inline, live in the
`attachments` folder of the data directory. Nothing there is deleted, since
old messages still point at it, so the server stops taking new files once the
folder holds 512 MB. A team fills that sooner: set
`OMB_ATTACHMENTS_MAX_BYTES` in the server's environment and restart, for
example `OMB_ATTACHMENTS_MAX_BYTES=4294967296` for 4 GB.

One file can be up to 100 MB, whether a person sends it or a bot attaches it;
that setting does not change it. It matches Cloudflare's upload ceiling, so a
tunnel carries it too. A video or audio file over 25 MB does not play inside
the chat, but it still downloads, and so does a file a bot links to, up to
500 MB.

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

Then start with `serve --public-url https://your.domain` (or set
`OMB_PUBLIC_URL=https://your.domain`) so pairing links, and
`OMB_WEBHOOK_PUBLIC_URL=https://your.domain` so hook URLs, are printed with
the public address. `serve` checks the address answers as this server and
says so on its Reach line. [`deploy/Caddyfile`](../deploy/Caddyfile)
is the reference implementation.

## Opening a desktop from another device

In a paired admin browser, as in the desktop app, **Take control** turns the
Computer panel's picture into the live desktop for Local VMs and your own VPS,
through the same address as OpenMausBot; **Full screen** fills the window with
the same session. Shared, per-bot and pool Local VMs connect through their
managed container's loopback port. VPS desktops connect
through an SSH tunnel opened by the server. Neither needs an additional public
port or viewer origin setting. Keep Local VM VNC ports bound to loopback and
VPS VNC ports private.

Your app reverse proxy must support WebSocket upgrades, preserve `Host`, and
set `X-Forwarded-Proto` to the browser-facing scheme. This also applies when
using Tailscale Serve. Viewer requests require an admin session. Logging out
or revoking that session closes open viewers. Client-only pairing does not
grant desktop control.

An open Local VM viewer keeps that VM's idle timer active. Remote VPS viewers
share a tunnel; it closes 30 seconds after the last viewer leaves, allowing
reconnects during that interval. **Hand control back**, closing the panel or
leaving the page gives the computer back to the bot.

Use **Keyboard** to send text from a phone and **Clipboard** to exchange text
with the desktop; clipboard edits sync automatically. The desktop fits the
window, with fullscreen available when the browser supports it. Hosted Cloud
keeps its provider-issued viewer in its own window or tab.

These controls are in the web app. The native phone apps have their own
computer viewers; use a paired browser for interactive Local VM or VPS access.
For the proxy boundary and offline regression checks, see the
[viewer verification recipe](verification/desktop-viewer.md).

## Using it from your phone

Signed in on a hosted server as an admin (with a pairing code or your
email)? Settings → Remote access → **Pair a phone or another computer**
creates a one-time code with a QR right in the browser, and lists every
paired device with a sign-out button. Nobody needs the command line.

The iOS app pairs with a server the same way a laptop does: scan the QR
code that `openmausbot serve` (or `openmausbot pair`) prints, paste the
whole `https://host/pair#code=…` link into the address field on the pairing
screen, or type the address and then the code. The phone gets a session of
its own, listed and revocable with `openmausbot devices`. What it may do is
the code's scope: a code from `openmausbot pair` carries `admin` and the app
shows everything; a code from `openmausbot pair --phone` (also what the
guided phone setup mints) can chat, approve and read, and the app hides
creating bots and sections, changing models, generating avatars, connecting
apps and cloud desktops — those stay with the owner. A server reinstalled at
the same address has a new identity; the app then asks to pair again rather
than present the old session to it.

Both native apps pair this way. `openmausbot pair --phone android` prints the
app-scheme QR that Android's scanner needs, and the iOS app accepts either
that QR or the web link, for example `docker compose exec omb openmausbot
pair --phone android --public-url https://your-domain`. `pair` never asks
questions, so it works the same from a script. Nothing extra to install, and
the phone becomes a session like any other.

Older way, still supported, and only useful on a LAN or a tailnet: run the
companion sidecar next to the harness and pair by its own QR. It advertises
on your private networks (Tailscale-aware) and issues its own per-device
credentials, which are **not** `openmausbot devices` and are revoked from
its own page at the `127.0.0.1:8811/#token=…` link it prints. It also serves phones over cleartext HTTP
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

### Usage caps

By default nothing limits what the bots use. The owner can cap a day's and a
month's usage, for the whole server and for each bot, in estimated dollars
and in tokens, under **Settings → Usage → Usage caps**, in `config.json`, or
for the server's own caps in the environment
(`OMB_USAGE_CAP_DAILY_USD`, `OMB_USAGE_CAP_MONTHLY_USD`,
`OMB_USAGE_CAP_DAILY_TOKENS`, `OMB_USAGE_CAP_MONTHLY_TOKENS`,
`OMB_USAGE_CAP_STOPS`). A reached cap stops new unattended work (routines,
webhooks, app events, Bot API calls, hand-offs nobody is waiting on) until
the day or month rolls over, and cuts nothing off mid-turn.
[Usage caps](usage-caps.md) has every setting and what a person sees.

### When an engine runs out

When a turn ends on a usage limit (a subscription's 5-hour or weekly limit,
one model's own weekly window, a model's extra usage credits), the bot carries
on by itself with a backup the person chose until that limit resets, and the
person hears it once for that stretch of the limit, as a notification: "Codex
reached its limit until 14:00, so Kai is using Claude meanwhile." With no
chosen backup that can carry on, the bot waits for the reset and the
notification says so ("…no backup you chose can take over"); no other AI is
picked for it. Nobody is asked.

- **Which AI.** For one model's own limit, the same AI's default model first;
  then the backups chosen for the bot or in Automatic recovery, in that order.
  Only an AI that can run a turn now (installed, signed in,
  allowed by your organisation, not limited itself) with the tools and the
  working folder the current one has, and one the conversation's approval level
  can move to without asking (Auto-accept edits stays on an AI that has it).
  Never another sign-in to the same subscription, which would rotate accounts
  around the provider's limit; a pay-per-use API key on the same AI is fine.
- **What moves.** The person's message that met the limit is sent again on that
  AI, in that conversation alone; the bot's own model and its other
  conversations stay where they are. While the limit lasts, every new turn and
  conversation of every bot that uses the limited AI (a person's, a routine's,
  a webhook's) goes straight to that AI without asking the limited one first,
  and a routine run the limit stopped starts again on it.
- **How long.** The limited AI is held until the reset it named, or for an hour
  when it named none or named one already past; the next turn after that hour
  checks it again. One model's own limit holds that model alone, and for at
  most six hours before it is tried again. The holds are saved
  (`limit-holds.json`, `limit-takeover-holds.json`), so a restart, an update or
  a sleep the Cloud was stopped for keeps them. A conversation that moved goes
  back once its AI's limit has reset, with one line saying so.

An engine that posts the provider's raw error as its whole reply instead of
failing the turn (omp's ACP mode sends `429 {"type":"error",…} retry-after-ms=…`
that way) has that turn count as failed, not as a reply, and the person reads
it in plain words. It is a usage limit when its words say so, or when it is a
429 whose wait runs past two minutes, and is then held until that wait ends;
a shorter wait is a rate limit to try again after. A reply that only quotes
such an error among other words stays a reply.

This is on by default. Start the server with `OMB_QUOTA_SWITCH=0` to switch it
off: then only the backups Automatic recovery names take over, and the
notification says the bot waits. Any other value, or none, leaves it on. It
has no setting in `config.json` yet.

### When an engine is signed out

When a turn stops because its AI is signed out (its sign-in expired or was
revoked), the person hears it once, in that conversation and as a
notification: "Claude is signed out on the Cloud. Sign in again in Settings →
AI to keep using it.", with a Sign in button that opens those settings. Each
later refused turn still shows that it failed, with no second notice; its
Chief gets one incident, not one a turn. An account out of credit, which some
engines stop the same way, is no sign-out.

The backups a turn its AI never started would get carry on meanwhile (the
bot's own backup AIs, or else the app-wide backup while Automatic recovery is
on), by the same rules as a usage limit (another sign-in to the same AI is fine
here, since nothing is rotated around a limit): the person's message is sent
again there, every new turn and conversation starts there, and a conversation
that moved goes back once the AI is signed in again in the app, or a turn on it
works. No AI is picked for a sign-out by itself, so with no such backup nothing
moves. A new turn tries the signed-out AI again an hour after its last refusal,
unless its status still says signed out.

### Which engine a new bot uses

A saved default model (Settings, `openmausbot setup`, or the New Bot
defaults) always wins. Without one, new bots get the first engine that can
run, in this order: a Claude account, a ChatGPT plan, Gemini, Grok, then the
rest in the order of `instances`; OpenCode running only Zen's free no-login
models comes last.

The server picks at once at start, then sends the person's own engines one
tiny test message each in the background ("Reply with the single word OK",
90 seconds at most), best first, stopping at the first that answers. One
miss alone doesn't move the default: that engine is tried again two minutes
later. Two misses in a row move the default to the best engine that
answered; the engine is tried again ten minutes later, then once an hour.
An engine that already answered (for example one the welcome checked) can
take the default after a single miss. An organization's models and the
trial credit are never tested this way. Results are kept for a day per
engine and sign-in in `<data dir>/providers/ai-checks.json`, so a restart
doesn't send them again. On a later start, where the engines are read one at
a time, nothing is tested or moved until that read ends: never on the status
the last run recorded.

The first bot the app made follows the default until someone writes to it
or picks a model for it or one of its conversations: it moves only after a
test result, only to an engine that answered, and only away from one whose
latest test missed or that is signed out or turned off, or up to a better
one. A status read that timed out moves nothing. No other bot ever moves. To stop the
background test messages, start the server with `OMB_AI_CHECKS=0`.

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

### The safety floor

Full access answers every permission request for a bot, and a saved command
answers one. The safety floor is a short never-list that neither can answer:
a recursive delete of the filesystem root, of the home directory or of a
top-level system directory (`rm -rf /`, `rm -rf ~`, `rm -rf /etc`);
formatting or overwriting a disk (`mkfs` on a device, `diskutil eraseDisk`,
`dd of=/dev/sda`, a redirection into a disk device); and a fork bomb. Making
a filesystem in an image file or on a loop device is not on it.

It is off unless you switch it on: set `safetyFloor.enabled` to `true` in
`config.json` (or through `PUT /api/config`), or start the server with
`OMB_SAFETY_FLOOR=1`, which turns it on whatever the file says.
`GET /api/config` reports whether it is in force as `safetyFloor.enabled`.

**It is not applied on a Windows server yet.** There the setting is accepted
and does nothing: no command is checked, denied or held, and every approval
behaves as it does with the setting off. The server says so once at startup
(`[safety-floor] … not applied on a Windows server yet`), and
`GET /api/config` reports `safetyFloor.enabled: false`. Telling cmd,
PowerShell and Git Bash apart needs to know which shell a request is for,
which the server does not know yet.

With it on, on macOS or Linux, a command on the list that a grant was about
to allow is denied instead. The bot is told why, the conversation shows
`Blocked by the safety floor: …`, and the decision log gets an `auto-denied`
row with source `safety-floor`. A card you answer yourself is not overridden:
at "Ask for approval" the request still reaches you, and your Allow stands.

A command the floor cannot read is not approved automatically either: one
with a quote or heredoc that never closes, or longer than 32 KB. The request
comes to you as a card instead, and the server log says so once, without the
command. An API-key bot at Full access has no card to show, so there the call
is refused.

It reads a command as a POSIX shell line. cmd commands (`rd /s /q`,
`format C:`) are not evaluated: a Mac or Linux machine does not run them, so
a server there that drives a Windows machine gets no protection for what
runs on it. PowerShell is the exception, because PowerShell 7 runs on macOS
and Linux: what follows `pwsh -c` or `powershell -Command` is read too, both
as a POSIX line and as PowerShell, so `pwsh -c 'rm -rf /'` and
`pwsh -c 'Remove-Item -Recurse -Force $HOME'` are blocked.

It holds wherever the engine asks the server, and only there. API-key models
(the chat runtime) are covered in full, at Full access and under "Always
allow this session". So is any shell request Claude Code, Codex, Muse Code or
an ACP agent sends, whether a saved command, a kept session allow or Full
access would have answered it: the engine's command line travels with the
request, so it is read even when its working directory is not known. An
engine running its own no-ask mode never sends a request, so the floor does
not see the command: at Full access that is Claude Code
(`bypassPermissions`), Codex (approvals off) and the ACP agents started in
their own yolo mode. Treat it as a net under saved commands and API-key bots,
not as a sandbox.

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
starts 30 days ago. Nothing here is sent to your organization's cloud Admin,
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
none of the turn-scoped capabilities the peer-comms tools need and cannot hand
work to its teammates.

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
bot's pinned thread only, and the server accepts just three kinds of route
with it — list peers (`GET /api/internal/agents`), hand work on
(`POST /api/internal/coordinate-bots`) and read how it went
(`GET /api/internal/assignment-status`). Opening threads, creating bots or
rooms, skills, memory and every other internal route answer 403. The bridge
offers the one tool surface every turn gets (docs/runtime-contract.md §9):
`coordinate_bots` (work; a question with `consult: true`; a one-way notice
with `reply: "none"`) and the read-only `assignment_status`. Every call from
the standing capability is its own root on the job
runtime with `reply: poll`: it completes without a turn once the teammates'
work settles, and the runtime reads the results with `assignment_status`,
long-polling `wait_ms` (at most 240 s) on the root's `rootId` or a receipt's
`requestId` from the same long-running process, without inventing a turn end.
A settled hand-off never wakes the bot's own engine on that thread. The
server still enforces peer access and approval settings. A free teammate
starts at once; a busy one is queued on the runtime until a slot frees
(docs/runtime-contract.md §2). Regular in-app turns keep their existing
dispatch timing.

The credentials stay on this server and are excluded from workspace backups;
restoring a backup preserves destination registrations. Never put this token
in chat or source control. Everything else the server offers still needs the
owner's session or a per-turn capability.

Verification: [external runtime fixture](verification/external-runtime.md).

## A bot stuck on a failing command

Every server shows a chat notice when a bot repeats the same tool call 5, 10
and 20 times in one turn. That notice only tells you. The loop guard, which is
off by default, also tells the bot:

- Set `loopGuard.enabled` to `true` in `config.json` (or through
  `PUT /api/config`), or start the server with `OMB_LOOP_GUARD=1`. When the
  same whole shell command fails the same way five times in a row
  (`loopGuard.steerAt`, 2-1000), the server puts one short note into the
  running turn saying so. A command that succeeds, or that fails differently,
  ends the count, so a turn that re-runs its tests after each edit or polls a
  build is left alone.
- Stopping the turn is a separate choice. Set `loopGuard.stopAt` (2-1000), or
  `OMB_LOOP_GUARD_STOP_AT`, and the turn is stopped at that many identical
  failures in a row, with a line in the chat that names the command and offers
  Retry. Leave it unset and the guard never stops a turn. A wait that fails
  until something is ready (`curl -f` against a server that is still starting)
  counts as a failing command, which is why the stop is not on by default.

A turn nobody is watching (a routine's, a webhook's) has the guard on and is
stopped at 20 identical failures in a row, whatever is set here: see "Keeping
unattended bots from spending on failures".

The note needs an engine that accepts a message in the middle of a turn
(Claude Code, Codex, Pi, Muse Code). ACP agents cannot take one, so they get
only the stop, and only if you set it. The note and the stop do not cover bots
on API models or turns in a room yet.

Bots on API models (xAI, Mistral, Groq, Greenference, ModelGo, Cerebras, Meta, MiniMax or an
OpenAI-compatible endpoint) end a turn as failed when a tool call failed and
the bot then answered. With the loop guard on, set `loopGuard.correctiveRounds`
(0-5, default 0) and such a bot is sent back to re-run the failed call up to
that many times first; the turn counts as done only if the tools it runs after
that succeed. A tool call that was denied is never sent back.

## A turn that goes silent

The server stops a turn that has sent it nothing for 20 minutes
(`OMB_TURN_STALL_MS`) and says why in the chat. Engines report a tool only
when it starts and when it ends, so while one of the turn's tools is still
running the turn may stay silent for up to `OMB_TOOL_STALL_MS` (default 2
hours). Any event from the turn starts the silence over, and time spent waiting
on a person or a computer never counts. Either way the turn stops with "no
activity for N minutes".

Both take whole milliseconds. `OMB_TURN_STALL_MS` is never below 60000 (one
minute) and `OMB_TOOL_STALL_MS` never below `OMB_TURN_STALL_MS`. A value that
is not a positive finite number (empty, `65m`, `0`, a negative number,
`Infinity`, `1e309`) leaves the default. Set them in the server's environment
and restart it; the restart stops every running turn.

A turn in a room also has a limit of its own, `rooms.turnTimeoutMinutes` in
`config.json` (default 5 minutes, 1-1440, which one conversation can replace).
It stops a member's turn that shows no progress for that long. While one of the
turn's tools runs, the turn may show nothing for up to 60 minutes (the longest
an MCP call can be set to take) or the room's limit if that is longer. These two
settings do not change it.

## Keeping unattended bots from spending on failures

Work that nobody is watching (a routine, an event, work one bot hands to
another) backs off when it keeps failing, and has an upper bound when it keeps
going. Nothing here turns a routine off or asks you anything. Each limit that
stops something leaves one line saying so, on the routine's run row or in the
thread. A failure that is this server's own (it could not start another
process, its disk is full, a tool server is down, an AI is signed out) is told
apart from the AI's errors, because starting the same work again cannot fix it.

### Routines and incidents

A routine stays on however often it fails.

A failed run starts once more by itself only when a second start can plausibly
pass: a rate limit, a provider that is overloaded or answered with a temporary
error, an engine that crashed or was stopped for memory (that start waits for
room). A tool server that is down, an AI that is signed out, a full disk or an
engine that could not be started fail the run at once. The second start sends
one short line saying to finish the run when the engine resumes a session that
holds the routine's instructions, or replays a conversation small enough to
still include them. Otherwise, and always on a backup AI, after a usage-limit
wait or for a routine that calls a /command, it sends the instructions again.

Past these limits, something is held back and says so in one line: on the
routine's run row, or in the Chief's "Problems to look at" chat.

| Setting | Default | What it bounds |
| --- | --- | --- |
| `OMB_ROUTINE_FAILURES_BEFORE_SPACING` | `3` | The runs of one routine that may fail in a row before its next scheduled runs are spaced out. A run that completes, a change to the routine, turning it on again, or a run that failed only because the bot's AI is signed out, out of credit or at its usage limit ends the streak and the spacing. The skipped runs share one row: "Skipped 12 scheduled runs because its last runs failed, so its next tries are spaced out". From `1`. |
| `OMB_ROUTINE_FAILURE_SPACING_MS` | `3600000` (1 hour) | How long after the failure that starts the spacing the next run waits. From `60000`. |
| `OMB_ROUTINE_FAILURE_SPACING_MAX_MS` | `14400000` (4 hours) | How long after each later failure the next run waits. Never below `OMB_ROUTINE_FAILURE_SPACING_MS`. |
| `OMB_CHIEF_INCIDENT_TURNS_PER_HOUR` | `6` | The turns a Chief of Staff is started for problems in an hour, across all the chats it hears about. Past that, the Chief is not started: you are notified of each such problem, and one line in its "Problems to look at" chat counts them, names the first five chats they came from and links the newest. From `1`. |
| `OMB_STARTUP_ROUTINE_GAP_MS` | `1800000` (30 minutes) | On a server not started by the desktop app, how soon after the start that last ran them routines set to "Also run when OpenMausBot starts" may run again. A start within that time leaves one row per routine: "Not run at 4 starts because OpenMausBot started again soon after the start that last ran it". `0` runs them at every start. |
| `OMB_ROUTINE_RESTART_STAGGER_MS` | `30000` (30 seconds) | The time between the runs a restart cut off as each starts again, so they do not all start at once. From `0`. |
| `OMB_BURST_PART_MAX_RESTARTS` | `2` | The times a burst's part, or its merge, starts again after a restart cut it off. Past that the part fails with "Not started again: OpenMausBot restarted while this part ran 3 times.", and the parts are posted as they came instead of merged. From `0`. |

A routine every minute (`* * * * *`) is still accepted and is spaced out the
same way. Identical failures are told to you and to the Chief once: two
failures that differ only in ids, paths, long numbers or times count as the
same, while different exit codes, HTTP statuses or models do not.
A Chief told of a failure that is this server's own is told not to retry it.

Any value that is not a whole number in range leaves the default. Set them in
the server's environment and restart it.

### Hand-offs and unattended turns

A turn with a person waiting in the chat keeps the limits described under
"A turn that goes silent".

A turn nobody is watching is one a routine, a webhook or an app event started,
or work a bot handed on from such a turn. Past any of these it is stopped, and
its thread (and a routine's run row) gets one line saying which:

| Setting | Default | What it bounds |
| --- | --- | --- |
| `OMB_UNATTENDED_TURN_MAX_MS` | `14400000` (4 hours) | The time one such turn may work. Time it waits on a person or a computer is not counted. From `60000`. |
| `OMB_UNATTENDED_TURN_MAX_REQUESTS` | `400` | The requests one such turn may make to its AI. A usage report that names its call counts that call once however often it repeats; reports without a name count one call per step between tool calls; the tool calls count instead when that is the larger number. |
| `OMB_UNATTENDED_TURN_MAX_DENIALS` | `5` | The permission requests of one such turn that may be denied or go unanswered (each unanswered one waits 15 minutes first). One a person denies is not counted. |
| `loopGuard.unattendedStopAt`, or `OMB_LOOP_GUARD_UNATTENDED_STOP_AT` | `20` | The times in a row one shell command may fail the same way. For such a turn the loop guard (see "A bot stuck on a failing command") is on whatever `loopGuard.enabled` says, with its note at `loopGuard.steerAt` and its stop here, or at `loopGuard.stopAt` if that is lower. `2`-`1000`. |
| `OMB_HANDOFF_MAX_FAILURES` | `5` | For work nobody is waiting on: work one request handed to other bots that may fail in a row, with none completing between. At that many the request is stopped with a line naming the last failure. |
| `OMB_HANDOFF_MAX_TURNS` | `300` | For work nobody is waiting on: the turns one request may hand out in all, across every bot it hands work to. Nothing renews it. Past it no more work is handed out, and the bot that asked still gets one turn to wrap up what came back. |

The three `OMB_UNATTENDED_TURN_*` settings and
`OMB_LOOP_GUARD_UNATTENDED_STOP_AT` also take `off`; `loopGuard.unattended:
false` in `config.json` does the same for the loop guard. Any other value that
is not a whole number in range leaves the default. Set them in the server's
environment and restart it.

For work nobody is waiting on, work that fails no longer renews a request's
hand-off limits (64 hand-offs, 96 turns and 48 wake-ups since any work last
completed): only work that completes does. A request a person made keeps the
earlier behaviour and none of the limits above end it on failures alone: the
bot that asked is resumed after each failure and decides. When handed-off work
failed for a reason in the server's own failure words (not anything the bot
said), the bot that asked is told: for this server (it could not start a
process, its disk is full), that sending it again anywhere fails the same way;
for one teammate's own setup (a tool server down, its AI signed out), which
teammate, and that another teammate may do it.

### Pausing every bot

A paused bot's routines skip quietly and leave a row saying so.

**Pause every bot** (any bot's menu in the sidebar, under More) pauses all of
them at once, the bots made later included. It is the same pause as
**Pause bot** ([Pausing a bot, a department or every bot](pausing-bots.md)): work in
progress stops as Stop does, and until **Resume every bot** each routine or
webhook run that comes due is let go with one line in its run log, "Every bot
is paused, so <bot> takes no new work. Resume every bot from any bot's menu in
the sidebar." A message to a bot is refused with the same line. Resuming leaves
a bot or department that was paused by itself paused.

From a terminal, to stop spending at once:

```sh
openmausbot bots pause --all      # openmausbot bots resume --all undoes it
openmausbot stop --all            # or only stop the work running now, pausing nothing
```

Both are admin requests, so they need you signed in (`openmausbot login`),
except on a server you started with `openmausbot serve` whose loopback trust is
`owner` (see "Loopback trust: owner or service"). With a token instead:

```sh
curl -X POST http://127.0.0.1:8799/api/paused -H "Authorization: Bearer $(cat ~/omb-admin.token)" \
  -H 'content-type: application/json' -d '{"kind":"all","paused":true}'
```

It has no setting: the pause is kept in `paused-bots.json` in the data
directory and lasts across restarts until it is resumed.

## Updating

Self-hosted servers follow the **stable** channel: a released version that our
own Clouds have run for 48 hours, named by the image tag `stable` and by
[`stable.json`](https://raw.githubusercontent.com/milind-soni/OpenMausBot/channels/stable.json).
`latest` follows `main` and is not for a server you rely on. The update check
(`GET /api/updates/check`, **Check for updates** in the app) compares the
server with the stable version; `OMB_UPDATE_CHANNEL=newest` makes it follow
every release instead.

A server installed with the [installer](deploy-vps.md#quick-start-one-command-on-your-own-domain)
updates with `sudo /opt/openmausbot/update.sh`, which the installer puts there.
Its admins can also press **Update server** in **Settings → Updates**, which runs
that same script on the server; a Docker checkout gets the button with
`sudo deploy/update-runner.sh --install`. Until the bots' sandbox is on for
self-hosted servers, a bot can ask for the same update, so the runner allows only
the standard forward update, once per stable release, and never removes your own
copy of the data. [How it works and
what it can and cannot do](deploy-vps.md#from-the-app-update-server).

```sh
cd deploy && git pull && ./update.sh                                    # Docker: copy the data, update, roll back on failure
git pull && pnpm install && sudo systemctl restart openmausbot          # from source
```

`deploy/update.sh` is the whole routine for a Docker Compose install: the
stable image by digest, a copy of `/data` first, a health check that includes
"an engine can still start a bot", and the old image and the copy put back
when the check fails. It is safe to interrupt and to run twice, carries on
when the terminal closes, never goes to an older version unless told to
(`--allow-older`; a server on `latest` moves to stable once the stable version
is newer than the one it reports), and asks before it puts back data from an
update an earlier run left unfinished.
[Every step, the rollback and the exit codes](deploy-vps.md#update).

For the [fixed-prefix Linux npm service](deploy-vps.md#paths-a-and-c-npm-with-the-service-above),
run `sudo ./deploy/update-npm.sh` from a trusted checkout on the server. The
[manual steps](deploy-vps.md#manual-update) cover custom units. For a foreground invocation,
`npx --yes openmausbot@X.Y.Z serve --tunnel` selects a particular published
release; replace `X.Y.Z` with that version.

The desktop and phone apps work with any server version that was the stable
one within the last 90 days. An older server keeps running, but the app says
it is behind, and newer features may not work until it is updated.

Routines and queued work survive restarts. A teammate turn in flight runs
again once at the next start, told to check what it already did, and the bot
that asked for it is told. A person's own turn and a running routine are not
run again: the conversation says it was interrupted. Update between runs
where you can.

Stop the server before a filesystem backup so SQLite is copied consistently.
Back up the entire app data directory and, separately, the service user's
engine credentials, browser state, and external workspaces. For Docker, the
whole `/data` volume includes the CLI homes. See the
[backup and restore instructions](deploy-vps.md#back-up) for the exact scope
and stop/start commands.

### The doctor: checking and repairing the data

The doctor checks a server's data folder and repairs what can be repaired
without losing anything. It runs by itself on the first start of each new
version, before the server reads its data. It writes one log line for each
thing it found, and adds a short `doctor` summary to `/api/health` (as seen by
the owner): the names of the checks it fixed and of those left for you, never a
path. When the new version fails its health check, `update.sh` runs that
version's doctor with `--fix`. If the doctor repairs something, the update
starts the new version once more; otherwise it rolls back as before.

You can run it yourself, as the server's user:

```sh
openmausbot doctor --data                 # check and report; changes nothing
openmausbot doctor --data --fix           # also apply the safe repairs (stop the server first)
openmausbot doctor --data --json          # the report as JSON
docker compose exec omb openmausbot doctor --data   # Docker
```

`--data-dir DIR` points it at another folder. It exits 0 when everything is
fine (after `--fix`, fine now) and 8 when a problem is left. `--fix` changes
nothing when it runs as a user other than the data folder's owner (Linux and
macOS).

| Check | Looks at | Repaired by `--fix` |
|---|---|---|
| Data format | `data-format.json` | Never. Data from a newer version stops every repair: install that version, or roll back. |
| Data folder lease | `openmausbot-server.lease` | A lease a dead process on this machine left is retired. A live server means nothing is changed. |
| Folders | the data folder, `events`, `native` | Missing folders are made. |
| Bots and rooms | `bots.json`, `groups.json` | A damaged file (not a whole list) is put back from the whole temp file of a save that was cut short. With no such copy, a copy of the damaged file is kept and you are told how to restore it. A file this user cannot read at all is reported as not checked and left alone. |
| Unfinished saves | `<file>.<pid>.<id>.tmp` at the top of the data folder | Moved into the backup. |
| Engine-run records | `engine-runs/` | Records with neither a server nor a process to stop are moved into the backup. |
| Messages database | `messages.db` | SQLite's `quick_check`. A write-ahead log over 64 MB is folded back into the database. A damaged database is reported, never rewritten. One that cannot be opened (permissions, another program's lock) is reported as not checked, not as damaged. |
| Private files | `config.json`, `sessions.json`, `bots.json`, `messages.db`, … | Made owner-only (0600). Not on Windows. |
| Settings file | `config.json` | Never: it tells you `openmausbot config restore latest` when dated copies exist. |

Before changing anything, a repair copies it into
`<data>/doctor-backups/<time>/`, with a `manifest.json` that lists what changed
(for a file mode, the old mode). When a new run copies something, earlier runs
go: any beyond the ten newest, and, oldest first, as many as it takes to bring
the earlier runs together under 2 GB. A run that kept a copy of `bots.json` or
`groups.json` stays for at least 30 days either way. The copies stay on that
computer and are not part of a workspace backup.

As a server starts, the doctor reads `messages.db` through and copies it before
a checkpoint only while it and its write-ahead log come to 256 MB or less, so an update never waits on a large database;
`openmausbot doctor --data` does both at any size.
