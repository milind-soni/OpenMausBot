# Podman full-stack acceptance

Use a dedicated rootless Podman user/machine, a new Compose project, a fresh
Linux data directory, and unused ports. Never mount the live app's data or
substitute its URL. The app container has engine-wide management access even
though its data is separate. Keep raw logs and screenshots out of public commits.

## Build and standard control fixture

Run `pnpm typecheck` and `pnpm test`. Follow [Launch](README.md#launch) and
[Chat turns](chat-turns.md) to prove a fake-engine turn settles through the
shared control surface. Stop that fixture with Ctrl-C.

Build the candidate Podman image from the same checkout. On Windows, enter the
selected machine with `podman machine ssh MACHINE`, then run the Linux commands
below. `repo` must be the candidate checkout's absolute Linux path, for example
`/mnt/c/Projects/OpenMausBot`:

```sh
cd "$repo"
podman build -f deploy/podman/Containerfile -t localhost/openmausbot-podman:verify .
fixture=$(mktemp -d /tmp/omb-podman-verify-XXXXXXXX)
mkdir -m 700 "$fixture/.openmausbot"
cp server/testing/fake-claude-cli.ts "$fixture/fake-claude-cli.ts"
# Windows checkouts may have CRLF; the fake is executed via its shebang on Linux.
sed -i 's/\r$//' "$fixture/fake-claude-cli.ts"
chmod 700 "$fixture/fake-claude-cli.ts"
cat > "$fixture/.openmausbot/config.json" <<EOF
{"profile":{"name":"Podman verification"},"instances":{"claude":{"driver":"claudeAgent","displayName":"Podman verification","config":{"cli":"$fixture/fake-claude-cli.ts"}}},"localVm":{"mode":"per-bot","maxInstances":2}}
EOF
cd deploy/podman
umask 077
cat > .env.fixture <<EOF
COMPOSE_PROJECT_NAME=omb-podman-verify
OMB_IMAGE_TAG=verify
OMB_DATA_ROOT=$fixture
PODMAN_SOCKET=/run/user/$(id -u)/podman/podman.sock
OMB_PORT=28799
OMB_WEBHOOK_PORT=28800
OMB_HTTP_PORT=28880
OMB_PUBLIC_URL=http://localhost:28880
OMB_HTTPS_HOST=https-disabled.invalid
ENGINES=
EOF
PODMAN_COMPOSE_PROVIDER=podman-compose podman compose --env-file .env.fixture -f compose.yaml up -d --no-build
```

Check those three ports are unused before starting. Use a different project
name and ports if another fixture exists; do not reuse its data. Enable the
rootless user's `podman.socket` before launch. No production credentials or real
model are required. The fake engine does not prove model-driven GUI interaction.

## Drive and observe

Use the candidate checkout's `control-omb.ts` on the host. The explicit fixture
URL in this example is `http://127.0.0.1:28799` (WSL forwards the machine's loopback
listener on Windows). Confirm `GET /api/config` has the fixture profile before
issuing mutations. If it does not, stop: the URL is not your fixture.

1. `GET /api/local-computer` must report `runtime: podman` and `daemonUp: true`.
   If `image` is false, `POST /api/local-computer/pull` prepares the official
   managed desktop image. This may take several minutes on a fresh machine.
2. Use `control-omb.ts new-bot --name "Fixture A" --url URL` and repeat for B.
   Record each returned `bot.id`.
3. For each ID, `PATCH /api/bots/ID` with `{"computer":"vm"}`, then
   `POST /api/bots/ID/local-computer/run` with `{}`. JSON requests must send
   `Content-Type: application/json`.
4. `GET /api/bots/ID/local-computer` must eventually report `ready: true`,
   `network: loopback`, `security: hardened`, and `persistence: durable`.
   Record its `container_name` and `workspace_path`.
5. `POST /api/bots/ID/local-computer/screenshot` must return a valid image.
   Decode and visually inspect both images. Open the fixture web UI through
   `http://localhost:28880` and confirm the renderer is served. An unpaired
   request to that proxy's `/api/bots` must be refused, rather than treated as
   the loopback owner. Pair explicitly for browser interaction.
6. In each **fixture** desktop, run `podman exec --user cua CONTAINER touch
   /home/cua/workspace/probe-A` (B uses `probe-B`). Verify the other desktop
   cannot see that file. The app container must be able to read its contents
   at the recorded workspace path. `stat -c %u WORKSPACE_PATH` on the host must
   still equal the rootless user's UID.
7. Remove A with `POST /api/bots/ID/local-computer/remove`, recreate it with
   `run`, and verify the file still exists and `cua` can create another file.
8. Follow the mapped `send`, `wait`, and `messages` commands in
   [Chat turns](chat-turns.md) against this Compose fixture. Require `settled`
   and `hello from fake claude` in the transcript.

Record the candidate commit, Podman/provider versions, image ID, action results,
workspace ownership before/after, screenshots, and bounded chat output. Repeat
against an unmodified base to establish the workspace-writing regression; do
not change or repair a user's existing workspace as part of that comparison.

## Cleanup

Remove only the recorded fixture bot desktops through their API while the app
is running. Then run `podman compose --env-file .env.fixture -f compose.yaml
down -v` with the same provider and project. Compose does not own the bot
desktops. Retain the printed temporary fixture directory and local evidence
until reviewed, then remove only that exact directory and `.env.fixture`.
