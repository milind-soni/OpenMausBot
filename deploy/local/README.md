# Local Docker Compose

From the repository root, run `docker compose up -d --build`, then open
http://localhost:8080. Docker with Linux containers is required.
Compose supplies defaults; no `.env` file is required.
The application container uses Docker's init process to reap orphaned agent
subprocesses.

To customize, copy `.env.example` to `.env` in the repository root.
The `.env` file is ignored by Git. Shell environment variables take precedence.
`OMB_HTTP_PORT` changes the host port and the default public URL.
Internal service ports remain fixed inside the shared network namespace.
`ENGINES` selects space-separated npm packages; an empty value skips installation.
The image also carries Grok Build, pinned by `GROK_VERSION` in
`deploy/local/Dockerfile`; Grok and Codex sign in from the app's engine setup
with a one-time code, no terminal needed.

For Tailscale Serve, set `OMB_PUBLIC_URL` to your HTTPS URL and
`OMB_HTTPS_HOST` to its hostname without scheme or path. Configure Tailscale
Serve on the host to forward to the chosen localhost HTTP port.
Keep the default `OMB_BIND_ADDRESS=127.0.0.1`. Caddy refuses to start when
`OMB_HTTPS_HOST` is set with any other bind address, so direct remote HTTP
clients cannot claim HTTPS semantics by supplying that hostname.
The hostname mapping preserves HTTPS
semantics for that host while localhost access continues to use HTTP.
Private tailnet webhook URLs are only reachable by callers on that tailnet.
Without `OMB_HTTPS_HOST`, the bind address can be changed for HTTP access.
Only use HTTPS hostname mapping with a trusted local TLS-terminating proxy.

Sign in and pair:

```sh
docker compose exec omb codex login --device-auth
docker compose exec omb openmausbot pair
```

With the defaults, `pair` prints a sign-in link for a browser on the Docker
host. For the desktop app or a phone on the same network, publish the port
there and name the address they use (only on a machine behind your router):

```sh
OMB_BIND_ADDRESS=0.0.0.0 OMB_PUBLIC_URL=http://192.168.1.20:8080 docker compose up -d
docker compose exec omb openmausbot pair    # Link http://192.168.1.20:8080/pair#code=…
```

Paste that link into MausBot under **＋ → Connect to a server**; the app
accepts plain http on a private network address. The other install methods
are in [Self-hosting](../../docs/self-hosting.md#golden-paths).

The image runs MausBot's hardened profile: bots work in a sandbox, away from
the server's settings and keys. Docker's defaults do not let a container build
one, so on a Linux host prepare it once and add the box's settings:

```sh
sudo sh deploy/box/prepare-host.sh
docker compose -f compose.yaml -f deploy/box/compose.box.yaml up -d
```

Without that the server starts as before and says, in its log and once in
Settings, that its bots are not sandboxed. A server more than one person
signs in to needs the sandbox to start. Docker Desktop on macOS and Windows
cannot be prepared this way. See
[The hardened profile](../../docs/self-hosting.md#the-hardened-profile).

On Windows, `./maus.ps1` forwards arguments to Compose using the repository
directory. It respects Docker's selected context and `DOCKER_CONTEXT`.

Data and engine credentials persist in the named data volume. For an existing
volume, set `OMB_DATA_VOLUME` to its name and `OMB_DATA_EXTERNAL=true`.
Fresh installs create their volume automatically.

Update with `docker compose build --pull` followed by `docker compose up -d`.
Stop with `docker compose stop`. `docker compose down -v` deletes managed volumes.
