# Self-host the full stack with rootless Podman

Run the OpenMausBot server, Caddy, and per-bot Linux desktops with one Podman
engine. Docker Engine, Docker Desktop, and Docker Compose are not required;
`podman-compose` provides the Compose commands. The existing
[`deploy/docker-compose.yml`](../docker-compose.yml) remains an independent option.

```text
Browser -> loopback Caddy :8080 -> OpenMausBot :8799
                                    |
                             rootless Podman socket
                                    |
                         per-bot desktop containers
                         (private network + workspace)
```

The server and Caddy use the Linux host network so the server can reach each
desktop's dynamically allocated loopback port. On Windows, that host is the
Podman WSL2 machine. Data stays on its Linux filesystem, not a Windows bind mount.

## Windows x64 / WSL2

Install WSL2 and Podman (`winget install --exact --id RedHat.Podman`), then reopen
PowerShell. Podman Desktop is optional. Clone the repository on a Windows drive
that WSL can access through `/mnt/c`, `/mnt/d`, etc. From the repository root:

```powershell
.\deploy\podman\maus.ps1 setup
# Edit deploy/podman/.env. Set ENGINES to the npm CLI packages you want to use.
.\deploy\podman\maus.ps1 up -d --build
.\deploy\podman\maus.ps1 ps
```

Setup creates/starts a WSL2 machine named `openmausbot` (4 CPUs, 10 GiB RAM,
60 GiB requested disk), installs `podman-compose` inside it if missing, enables
the user socket, and generates `.env`. WSL resource limits still apply.
It preserves an existing `.env`. Use `OMB_PODMAN_MACHINE` to select a different
machine. The wrapper refuses a stopped machine for normal Compose commands;
after a reboot, use `podman machine start openmausbot` before `up -d`.

Compose runs **inside** the machine, so the socket and bind paths have the same
meaning for the server and the engine. `OMB_PODMAN_ENV_FILE` selects an alternate
environment file (relative to `deploy/podman`), useful for an isolated fixture.

## Linux x64 / systemd

Install rootless Podman, `podman-compose`, and configure the user's subuid/subgid
ranges using your distribution's instructions. Run as a regular user:

```sh
cd deploy/podman
sh setup.sh
# Edit .env; for example ENGINES=@anthropic-ai/claude-code @openai/codex
PODMAN_COMPOSE_PROVIDER=podman-compose podman compose --env-file .env -f compose.yaml up -d --build
```

This recipe targets Podman 5.8.3 / podman-compose 1.6.0 and Linux x86_64. The
remote client is checksum-pinned; the renderer and server both build from your
checkout. Engine installation is opt-in through `ENGINES`; pin package versions
there when reproducibility is required. The live acceptance environment is a
Windows WSL2 machine. Native Linux, SELinux-enforcing systems, ARM64, macOS, and non-systemd
hosts need separate validation; the Containerfile explicitly rejects non-x86_64.
SELinux-enforcing systems need an appropriate socket/bind policy, not blanket label
disabling. Reboot persistence on Linux additionally needs the user's linger and
Podman restart service configured according to the host's administration policy.

## Engines and desktops

Open <http://localhost:8080>. Sign the selected engines in inside the container,
for example `maus.ps1 exec omb claude`. Their logins persist under `OMB_DATA_ROOT`.
For the Linux commands, substitute the `podman compose --env-file .env -f
compose.yaml` prefix for `maus.ps1`.

In **App Settings -> Local VM**, prepare the managed image, select **Per bot**,
and set the maximum number of desktops. Give each bot **Local VM** as its computer,
then create its desktop. The first image preparation needs a large download.
Each desktop has the existing 4 GiB / 2 CPU limits; allow capacity for the server
and build as well as all concurrent desktops. See the
[Local VM guide](../../apps/docs/content/docs/computers/local-vm.mdx).

The server's `maus` user (1001) and each desktop's `cua` user (1000) map to the same
rootless host user through separate `keep-id` namespaces. The server mounts the
data root at the **same absolute path** on both sides so desktop workspace paths
resolve on the engine host. Do not replace that mount with an unrelated named
volume or add `:U`: recursive ownership changes can make the workspace unwritable
by the desktop user. Old workspaces already affected by ownership changes need
an explicit, backed-up ownership repair; this recipe does not recursively chown
existing data.

## Access and trust boundary

Caddy listens on loopback only. To use Tailscale Serve, route the tailnet HTTPS
endpoint to `http://127.0.0.1:8080`, set `OMB_PUBLIC_URL` to that HTTPS URL and
`OMB_HTTPS_HOST` to its hostname, then recreate the services with `up -d`.
Mint a pairing code with `maus.ps1 exec omb node dist-server/openmausbot.js pair`.
The proxy forwards the client address and scheme so the server's pairing checks
remain in force. Do not publish the server, webhook listener, or Podman socket
directly. For public-domain HTTPS, use the existing Docker deployment or design
and verify an authenticated edge for this recipe.

The app's socket grants control of **all containers owned by that rootless user**.
Use a dedicated machine/user. This is not complete isolation of each agent CLI:
CLIs execute in the shared app container. Desktop containers receive only their
own workspace, never the socket. The web Computer preview and bot actions go
through the server. Direct "Open desktop" URLs use host-local dynamic noVNC ports;
manual noVNC access from another device needs a separate authenticated relay.

## Updates, backup, and coexistence

- Update the checkout and run `up -d --build`; there is no published Podman app
  image/update channel in this recipe.
- Data, chats, credentials, and desktop workspaces live under `OMB_DATA_ROOT`.
  Stop the app and its desktops before archiving that Linux directory. Do not
  copy a live SQLite database. Preserve ownership and the absolute path on restore.
- Compose `down` stops the app and Caddy, **not** the dynamically created bot
  desktops. Remove/stop those through the app before taking the stack down.
- Docker deployments keep their existing commands, volumes, and files. This
  recipe does not migrate them. For side-by-side operation, use separate data
  roots and different app/webhook/proxy ports; never share a live data directory.
- For acceptance checks, follow the [isolated verification recipe](../../docs/verification/podman-self-hosting.md).
