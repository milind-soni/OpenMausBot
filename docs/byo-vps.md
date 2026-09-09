# Bring Your Own VPS

OpenMausBot can turn a Linux server you already own into a bot's computer. The agent process stays on your
machine; Docker's own SSH transport reaches the daemon on the VPS, and each bot gets one managed, hardened
Cua container there — a Linux desktop it can see and control. SSH is the only credential involved and the
only surface exposed: OpenMausBot never opens a public port on the VPS, never stores your SSH key or
passphrase, and never runs an agent remotely.

## What works

- A per-bot Linux desktop in a managed container on your VPS, driven through the official Cua tools.
- Live screen preview in the Computer panel and in transcripts, same as a Box.
- Explicit **Cloud** with the **Self-hosted VPS** backend provisions or starts the container. **Auto** reuses
  a ready container by default; an off-by-default **Start VPS automatically** switch lets that bot prepare
  or wake its managed container when needed.
- Interactive **Take control** locally or from a paired desktop client. The host binds noVNC only to a random
  `127.0.0.1` port, closes the tunnel with the viewer, and never publishes VNC on the VPS. A paired client
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
App Settings → Connections, nothing else. The alias block is load-bearing, not a convenience: every bot
action becomes a `docker exec` over SSH, and without multiplexing each one pays a full SSH handshake; without
keepalives and a connect timeout, a VPS that drops off the network hangs the bot's turn instead of failing it.
Set the block up like this:

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
  (`~/.openmausbot/config.json`); keys, passphrases, and agent state stay with SSH. The alias is also kept
  off paired phones — the companion reports configured-or-not, never the name.
- The container itself runs hardened: capabilities dropped, private network/IPC/cgroup namespaces, no host
  mounts, and memory/CPU/pid limits. A container missing any of that — including one someone created under
  the managed name — is refused, not repaired.

## Container lifecycle

Each bot owns one container on the VPS, named `openmausbot-vps-<bot>-<hash>` — stable across restarts and
independent of the bot's display name.

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
running and verified. If no local fallback exists, the turn now explains why the VPS was unavailable instead
of silently running without a computer. Enable **Start VPS automatically** per bot to let Auto prepare or wake
that bot's managed container; the switch is deliberately off by default.

## Troubleshooting

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
