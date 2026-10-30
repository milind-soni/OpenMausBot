# Bring Your Own VPS

OpenMausBot can turn a Linux server you already own into a bot's computer. The agent process stays on your
machine; Docker's own SSH transport reaches the daemon on the VPS, and each bot gets one managed, hardened
Cua container there — a Linux desktop it can see and control. SSH is the only credential involved and the
only surface exposed: OpenMausBot never opens a public port on the VPS, never stores your SSH key or
passphrase, and never runs an agent remotely.

## What works

- A per-bot Linux desktop in a managed container on your VPS, driven through the official Cua tools.
- Live screen preview in the Computer panel and in transcripts, same as a Boat.
- Explicit **Cloud** with the **Self-hosted VPS** backend provisions or starts the container. **Auto** reuses
  a ready container by default; an off-by-default **Start VPS automatically** switch lets that bot prepare
  or wake its managed container when needed. Scheduled and manually triggered routine runs always start it,
  and never fall back to this computer's own desktop when the VPS cannot be reached.
- Interactive **Take control** locally or from a paired desktop client: the Computer panel's picture becomes the
  live desktop. The host binds noVNC only to a random `127.0.0.1` port, closes the tunnel soon after you hand control
  back, and never publishes VNC on the VPS. A paired client
  receives a short-lived, device-scoped relay through managed HTTPS or Tailscale only after **Cloud desktop
  access** is enabled for that device on the host.

## Prerequisites

- **Locally:** a `docker` CLI, version 18.09 or newer (that is when `docker -H ssh://` shipped). The Docker
  daemon does not need to run locally — only the CLI is used.
- **On the VPS:** a running Docker daemon (`dockerd`) on x86_64 Linux.
- **The SSH user** must be in the `docker` group on the VPS, so `docker info` works without sudo.

Be clear-eyed about that last point: membership in the `docker` group is root-equivalent on that machine.
Anyone who can talk to the daemon can mount the host filesystem into a container. Using this feature means
trusting the VPS — and whoever else can reach its Docker daemon — completely. Give bots a dedicated server,
not one that also holds things you would not hand to the agent.

## The required SSH config alias

OpenMausBot connects only through a named alias in your `~/.ssh/config` — you type the alias into
Settings → API keys, nothing else. Every bot action becomes a `docker exec` over SSH, so the app
supplies connection sharing and fail-fast timeouts itself: it runs each VPS command through its own
`ssh_config` (under `~/.openmausbot/ssh/`) that includes your file first and fills in `ControlMaster`,
`ControlPersist`, keepalives and a connect timeout wherever your alias leaves them unset. Anything your
alias sets wins. Startup, previews, bot tools and their connection probes use the same settings.
For long data-directory paths, the app keeps its control socket in a private, user-owned directory
under `/tmp` to stay within OpenSSH's socket-path limit; the config stays in the app data directory.
Windows OpenSSH does not support connection sharing, so that platform keeps its normal SSH setup.
The block below is still the recommended shape, and it is what your own `ssh` uses outside the app:

```
Host my-vps
  HostName 203.0.113.7
  User deploy
  IdentityFile ~/.ssh/id_ed25519
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h-%p
  ControlPersist 60m
  ServerAliveInterval 15
  ServerAliveCountMax 3
  ConnectTimeout 10
```

- `ControlMaster`/`ControlPath`/`ControlPersist` — every action is a docker-over-SSH exec; multiplexing turns
  per-command connects into milliseconds over one persistent connection.
- `ServerAliveInterval`/`ServerAliveCountMax`/`ConnectTimeout` — a dropped VPS must fail fast (under a
  minute, and ten seconds to connect), not hang a turn waiting on a dead TCP session.

### One server per bot

The app-level alias (Settings → API keys) is the default server for every bot. A bot can also be pointed at
its own alias: Bot Settings → Access → **Server (SSH alias)** appears whenever the **Self-hosted VPS**
backend is chosen, and an empty field means "use the default". The bot's own server then wins for everything
that matters to that bot — provisioning, status checks, previews, screenshots, watched desktop sessions, its
computer tools, and deletion cleanup. The Settings inventory spans every server in play and tags each
computer with the alias that holds it.

A bot cannot be moved to another server while its computer still lives on the old one, and the default alias
cannot change while any computer it manages still exists: remove the computer first from Settings → Local VM →
Self-hosted VPS computers (or by hand: `docker -H ssh://old-server rm -f openmausbot-vps-<bot>-<hash>`). A server
that cannot be reached never traps a bot: moving the bot to another server, switching its computer, or deleting
it goes ahead, and the app says what may be left on that server and the command that removes it once the server
is back. (Changing the default alias still waits until its server can be listed.) Any alias from your
`~/.ssh/config`, host key already verified by hand, is all it takes. The field is in a saved bot's settings; a new
bot starts on the default server.

**Host key first, by hand.** Connect once manually before pointing OpenMausBot at the alias:

```sh
ssh my-vps true
```

That puts the host key in `known_hosts` on your terms. The app never auto-accepts a host key — an alias whose
host is unknown simply fails until you have done this once.

## Security

- **No public ports.** The managed container is created with no published ports, and OpenMausBot refuses to
  use a container that publishes any — the check runs before every attach, not just at creation. Live view
  reaches the container's private bridge address through SSH and is loopback-only on your computer.
- **Firewall the VPS to SSH only**, ideally from your IP. Nothing OpenMausBot does needs any other inbound
  port open, so anything else open is pure attack surface.
- **Nothing sensitive is stored.** The only thing OpenMausBot persists is the alias name itself
  (`~/.openmausbot/config.json`, plus a bot's own alias in `bots.json` when it has one); keys, passphrases,
  and agent state stay with SSH. Aliases are also kept out of the settings and bot records that paired phones
  and members of a shared workspace receive — they get configured-or-not, never the name. An SSH or Docker
  error that a bot reports in its conversation can still quote a server's name.
- The container itself runs hardened: capabilities dropped, private network/IPC/cgroup namespaces, no host
  mounts or devices, and no automatic removal. Ownership, pinned-image and isolation checks still apply
  when reusing a container; a container that fails them is refused, not repaired.

## Container lifecycle

Each bot owns one container on the VPS, named `openmausbot-vps-<bot>-<hash>` — stable across restarts and
independent of the bot's display name. It lives on the bot's server: the default alias, or the bot's own
when it has one.

New containers default to 4 GiB memory with no extra swap, 2 CPUs, 512 PIDs, 512 MiB shared memory and an
`unless-stopped` restart policy. These are creation defaults, not compatibility requirements. Existing
managed containers can keep customized resource and OOM settings, unlimited budgets, or other restart
policies, including the legacy `no` policy. OpenMausBot does not reset those settings or recreate a
container to enforce its defaults. Restart behavior follows the chosen Docker policy; for example,
`always` can wake a slept container after a Docker daemon restart.

- **Provision** (choosing **Cloud** for the bot, or the panel's button): builds the pinned Cua image on the
  VPS if needed, creates the container if missing, starts it if stopped, and waits until the desktop answers.
- **Start** only wakes an existing stopped container; it never creates one.
- **Sleep** stops the container. The VPS stops spending CPU on it; the filesystem stays put.
- **Remove** is yours, done by hand when a bot no longer needs the server:
  `docker -H ssh://my-vps rm -f <container>`. OpenMausBot never deletes a container on its own.

What survives what: sleep/start preserves the container's filesystem; removal — including the recreate that
follows a Cua image upgrade, since a container pinned to an old image is refused rather than reused — wipes
it. Treat the container filesystem as **disposable**: anything a bot must keep should leave the VPS (pushed,
uploaded, or pasted back into chat) before the container is removed.

A bot set to **Auto** is lifecycle-read-only by default. It attaches only when the container is already
running and verified. If no local fallback exists, the turn still runs, so work that needs no screen (a
teammate's write-up, a Chief's follow-up) is never stopped by a VPS it doesn't use, and the bot is told why the
VPS is unavailable and what to do about it, so it says so instead of claiming screen work. A scheduled run
fails and says why instead. Enable **Start VPS automatically** per bot to let Auto prepare or wake that bot's
managed container; the switch is deliberately off by default.

Each turn checks the container when it starts, because the computer tools connect into the running container
the moment the engine launches them. Turns that start together share one check instead of queueing one each.

## Several turns at once

Each bot has one container, but the container is not the bottleneck — the desktop inside it is. Any number of
the bot's threads (chats, tasks, routines) can run with the VPS mounted at the same time. The desktop goes to
the first thread that calls a computer tool (a screenshot, a click, a command through the Cua driver) and stays
with that turn until it ends; threads that never touch the computer tools are never held up. A thread that
reaches for the screen while another holds it shows

> Waiting for its turn on this computer — *position* in queue — *bot* is running *thread*. Starts automatically when the turns ahead of it finish.

and its computer call waits for the desktop, up to 45 seconds, and answers the moment it is free; a call that
runs out tells the model the desktop is still taken and to keep waiting with another call rather than end its
turn. A call that waited more than five seconds is not performed even then — an action started that late could
outlast the engine's limit for one tool call and run twice when the model retries — so the model calls again,
and that call acts at once: the desktop is its turn's by then. The chip settles as "Computer free — continuing"
when the desktop lands, or "Stopped waiting for the computer" if the turn ends first. A long wait parks the
turn at the ceiling (30 minutes by default), still naming the holder, and it resumes on its own when the
computer is free. A call made while a person has taken control waits for them the same way; once they hand it
back it is not performed (the screen may have moved), and the model takes a fresh screenshot. A hold older
than the same ceiling is not waited for: the bot stops and says it is waiting for control back. Container
lifecycle actions (create, start, stop) are still one at a time per container.

## Troubleshooting

Normal screen refreshes should not abort new turns with “the VPS is being prepared.”
Turn setup waits for a pending preview, and overlapping preparation requests share the same operation.
Stop and Delete remain exclusive; they do not race a pending capture or silently recreate its container.
If a Docker-over-SSH command times out, the app cleans up that command's Docker/SSH processes before
releasing it. Retry is explicit: potentially mutating commands are never automatically replayed.

Work up the same path the app takes, cheapest signal first:

1. **The alias works by hand:** `ssh my-vps true` returns silently. A password prompt means the key/agent is
   not set up; a host-key prompt means the first manual connect has not happened yet.
2. **Docker over SSH reaches the daemon:** `docker -H ssh://my-vps info` prints server details. A permission
   error means the SSH user is not in the `docker` group.
3. **Provision:** choose **Cloud** with the **Self-hosted VPS** backend in the bot's Computer panel. The
   first provision pulls and builds the Cua image on the VPS, which can take minutes; later ones are fast.
4. **Read the status states.** The panel surfaces exactly what the server found, in check order: alias not
   configured → daemon unreachable → image missing → container missing / stopped → container unmanaged or
   unsafe (ports, mounts, hardening) → desktop not ready. Each message names the step to fix.
