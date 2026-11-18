#!/bin/sh
# MausBot's server as your own user's service, with rootless Podman: no root, no Docker. One line, run as yourself:
#
#   curl -fsSL https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/deploy/podman/install.sh | sh
#   ... | sh -s -- --lan                 also answer other devices on this network (private addresses only)
#   ... | sh -s -- --uninstall           stops and removes the service; keeps your data
#
# It writes a Quadlet unit (~/.config/containers/systemd/openmausbot.container) that runs the published server image,
# pinned by its digest, as your user: systemd restarts it when it fails, and starts it at boot once your user may run
# services without being logged in (it prints the one `loginctl enable-linger` line for that; it never runs sudo).
# Your data stays in ~/.local/share/openmausbot/data. Running it again repairs the install and never touches your data.
# Updates, with a copy of the data first and a way back: ~/.local/share/openmausbot/update.sh
#
# WARNING: the server shares this machine's network, with less isolation than the Docker install (docs/self-hosting.md,
# Podman). A port a bot or tool opens on 0.0.0.0 is open on every address of the machine; bots reach every service on
# its loopback; every local account counts as the owner. Use it on a machine only you sign in to, behind a firewall.
#
# Nothing runs until the last line calls main, so a download that is cut off part-way runs nothing. It sends no
# telemetry. It contacts the image registry (ghcr.io), GitHub's release list and this repository's files.
set -eu

settings() {
  IMAGE_REPO=ghcr.io/milind-soni/openmausbot
  STABLE_URL=https://raw.githubusercontent.com/milind-soni/OpenMausBot/channels/stable.json
  RELEASES_URL=https://api.github.com/repos/milind-soni/OpenMausBot/releases/latest
  REPOSITORY_FILES=https://raw.githubusercontent.com/milind-soni/OpenMausBot
  PINNED='^ghcr\.io/milind-soni/openmausbot@sha256:[0-9a-f]{64}$'
  # One copy of this repository's files to use instead (https://… or file:///…), as deploy/install.sh takes it.
  SOURCE_ASKED="${OMB_INSTALL_SOURCE:-}"
  INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/openmausbot"
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
  NAME=openmausbot
  HEALTH_WAIT_S="${OMB_INSTALL_HEALTH_WAIT_S:-240}"
  MODE=install
  DIR_GIVEN=no
  LAN=""
  PORT=""
  PUBLIC_URL=""
  IMAGE=""
}

say() { printf '%s\n' "$*"; }
ok() { printf '  ok    %s\n' "$*"; }
note() { printf '  note  %s\n' "$*"; }
fail() {
  printf '\n%s\n' "$*" >&2
  exit 1
}

usage() {
  say "Usage: curl -fsSL $REPOSITORY_FILES/main/deploy/podman/install.sh | sh -s -- [options]"
  say ""
  say "  --lan              also answer other devices on this network (private addresses only, plain http)"
  say "  --local            answer this machine only again (the default)"
  say "  --port N           the server's port on this machine (default 8799; webhooks use the next one)"
  say "  --public-url URL   the HTTPS address a proxy or tunnel in front of it serves, for pairing links"
  say "  --dir PATH         where the data and settings live (default ~/.local/share/openmausbot)"
  say "  --uninstall        stop and remove the service; keeps the data"
}

parse() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --lan) LAN=1 ;;
      --local) LAN=0 ;;
      --uninstall) MODE=uninstall ;;
      --port | --public-url | --dir)
        [ $# -ge 2 ] || fail "$1 needs a value."
        case "$1" in
          --port) PORT=$2 ;;
          --public-url) PUBLIC_URL=$2 ;;
          --dir)
            INSTALL_DIR=$2
            DIR_GIVEN=yes
            ;;
        esac
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) fail "Unknown option $1. Run with --help for the options." ;;
    esac
    shift
  done
  case "$PORT" in
    "") ;;
    *[!0-9]*) fail "--port takes a number, like 8799." ;;
    *) if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65534 ]; then fail "--port takes a number from 1024 to 65534."; fi ;;
  esac
  case "$PUBLIC_URL" in
    "" | https://*) ;;
    *) fail "--public-url takes the https:// address people open, like https://maus.example.com." ;;
  esac
  case "$PUBLIC_URL" in *[!A-Za-z0-9:/._-]*) fail "--public-url takes a plain address, like https://maus.example.com." ;; esac
  UNIT="$UNIT_DIR/$NAME.container"
}

# The folder the service's unit already names, from an earlier run: its settings file, else its data volume.
installed_dir() {
  [ -f "$UNIT" ] || return 1
  from=$(sed -n 's|^EnvironmentFile=\(.*\)/server\.env$|\1|p' "$UNIT" | head -n 1)
  [ -n "$from" ] || from=$(sed -n 's|^Volume=\([^:]*\)/data:/data.*$|\1|p' "$UNIT" | head -n 1)
  [ -n "$from" ] || return 1
  printf '%s' "$from"
}

# One service per user, with one folder. A run without --dir keeps the folder the service already uses (it never moves
# the service onto an empty one); a --dir that names another is refused.
choose_dir() {
  INSTALL_DIR=$(printf '%s' "$INSTALL_DIR" | sed 's|//*$||')
  case "$INSTALL_DIR" in
    /?*) ;;
    *) fail "--dir takes an absolute path of a folder, like /srv/openmausbot." ;;
  esac
  existing=$(installed_dir || true)
  if [ -n "$existing" ] && [ "$existing" != "$INSTALL_DIR" ]; then
    if [ "$DIR_GIVEN" = yes ]; then
      fail "This user's MausBot service already uses $existing, and --dir names $INSTALL_DIR. Nothing was changed. Run this again with --dir $existing, or without --dir. To move it: --uninstall first, move the folder, then install with --dir and the new place."
    fi
    INSTALL_DIR=$existing
    note "The service already uses $INSTALL_DIR, so this run does too (--dir names it)."
  fi
  # Written into the unit, where these are plain text: letters, digits, dots, dashes, underscores, @ and slashes.
  case "$INSTALL_DIR" in *[!A-Za-z0-9/._@-]*) fail "The folder $INSTALL_DIR has characters this installer does not write into a service's unit. Name another with --dir PATH (letters, digits, dots, dashes, underscores, @ and slashes)." ;; esac
  DATA_DIR="$INSTALL_DIR/data"
}

# A folder of the Docker install (deploy/install.sh) or of a Compose checkout: its data and .env are not this service's.
refuse_docker_dir() {
  if [ -f "$INSTALL_DIR/compose.yaml" ] || [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    fail "$INSTALL_DIR holds a Docker install (compose.yaml or docker-compose.yml). Nothing was changed. The Podman service needs a folder of its own: name another with --dir PATH."
  fi
}

# deploy/update.sh at work in this folder: its lock (a folder holding its process id), or the journal of an update it has
# not finished. The installer then changes nothing: both rewrite .env and the unit's Image=.
update_busy() {
  pid=$(cat "$INSTALL_DIR/.update/lock/pid" 2>/dev/null || true)
  case "$pid" in
    "" | *[!0-9]*) ;;
    *) if kill -0 "$pid" 2>/dev/null; then fail "An update is running here (process $pid). Nothing was changed. Wait for $INSTALL_DIR/update.sh to finish, then run this again."; fi ;;
  esac
  if [ -f "$INSTALL_DIR/.update/journal" ]; then
    fail "An update here did not finish ($INSTALL_DIR/.update/journal). Nothing was changed. Run $INSTALL_DIR/update.sh first: it finishes or undoes that update. Then run this again."
  fi
}

# The user's own systemd: `systemctl --user` must reach it, which a login session or linger gives.
user_systemd() {
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
    XDG_RUNTIME_DIR="/run/user/$(id -u)"
    export XDG_RUNTIME_DIR
  fi
  systemctl --user show-environment >/dev/null 2>&1
}

quadlet_binary() {
  for candidate in ${OMB_INSTALL_QUADLET:-} /usr/libexec/podman/quadlet /usr/lib/podman/quadlet /usr/local/libexec/podman/quadlet; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

podman_version() { podman version --format '{{.Client.Version}}' 2>/dev/null || podman --version 2>/dev/null | sed 's/.* //'; }

# The unit's keys (UserNS=keep-id:uid=, ShmSize=, HealthOnFailure=) are tested with Podman 4.9, the oldest asked for.
check_host() {
  say "Checking this machine..."
  [ "$(uname -s)" = Linux ] || fail "This installs a systemd service, which needs Linux. On a Mac or Windows, use the desktop app or Docker."
  [ "$(id -u)" != 0 ] || fail "Run this as the user the server should run as, not as root (no sudo): it installs a service of your own."
  command -v podman >/dev/null 2>&1 || fail "Podman is not installed. Install it with your system's packages (sudo apt-get install -y podman, sudo dnf install -y podman), then run this again."
  version=$(podman_version)
  major=$(printf '%s' "$version" | cut -d. -f1)
  minor=$(printf '%s' "$version" | cut -d. -f2)
  case "$major.$minor" in
    *[!0-9.]* | .*) fail "Could not tell which Podman this is (podman version said: ${version:-nothing})." ;;
  esac
  if [ "$major" -lt 4 ] || { [ "$major" -eq 4 ] && [ "$minor" -lt 9 ]; }; then
    fail "This needs Podman 4.9 or newer, for its systemd units; this machine has $version. Ubuntu 24.04 has it (the one this has been tried on)."
  fi
  ok "Podman $version"
  [ "$(podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null || true)" = true ] ||
    fail "Podman does not run rootless for this user. Give the user subordinate ids (sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $(id -un)), then run this again."
  ok "rootless"
  QUADLET=$(quadlet_binary) || fail "Podman's systemd generator (quadlet) is missing. Install your distribution's full podman package, then run this again."
  user_systemd || fail "systemd for your user is not reachable (systemctl --user). Log in to this machine directly or over SSH, not with su or sudo, or run: sudo loginctl enable-linger $(id -un)  then run this again."
  ok "systemd for your user"
}

linger_on() { [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" = yes ]; }

fetch() { # url destination: 1 when it cannot be had
  tmp_fetch=$(mktemp "$2.XXXXXX")
  if curl -fsSL --max-time 60 "$1" -o "$tmp_fetch" 2>/dev/null && [ -s "$tmp_fetch" ]; then
    mv "$tmp_fetch" "$2"
    return 0
  fi
  rm -f "$tmp_fetch"
  return 1
}

write_file() { # path [mode], the content on standard input: replaced in one step
  tmp_file=$(mktemp "$1.XXXXXX")
  cat >"$tmp_file"
  chmod "${2:-644}" "$tmp_file"
  mv "$tmp_file" "$1"
}

env_value() { # file name
  sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -n 1
}

set_env() { # file name value: that one line, every other line as the person wrote it
  { if [ -f "$1" ]; then grep -v "^$2=" "$1" || true; fi; printf '%s=%s\n' "$2" "$3"; } | write_file "$1" 600
}

unset_env() { # file name
  if grep -q "^$2=" "$1" 2>/dev/null; then { grep -v "^$2=" "$1" || true; } | write_file "$1" 600; fi
}

# The image by digest: the one update.sh pinned, else the stable channel's, else the newest release's (only while no
# version is stable: the channel answers 404). As update.sh decides it, and never a tag that moves (`latest`).
choose_image() {
  asked="${OMB_INSTALL_IMAGE:-}"
  pinned=$(env_value "$INSTALL_DIR/.env" OMB_IMAGE)
  if [ -n "$asked" ]; then
    case "$asked" in *[!A-Za-z0-9/:._@-]*) fail "OMB_INSTALL_IMAGE is not an image name." ;; esac
    case "${asked##*/}" in
      *@sha256:*) ;;
      *:latest) fail "OMB_INSTALL_IMAGE names the latest tag, which follows every commit. Name a release, like $IMAGE_REPO:v0.1.151." ;;
      *:?*) ;;
      *) fail "OMB_INSTALL_IMAGE needs a release tag, like $IMAGE_REPO:v0.1.151." ;;
    esac
    IMAGE=$asked
    ok "version: $IMAGE, as asked"
  elif [ -n "$pinned" ]; then
    case "$pinned" in *[!A-Za-z0-9/:._@-]*) fail "OMB_IMAGE in $INSTALL_DIR/.env is not an image name." ;; esac
    IMAGE=$pinned
    case "$IMAGE" in
      *@sha256:*) ;;
      *)
        # update.sh's rollback can name the image that ran before by a name of this machine's own
        # (openmausbot-before-update:local), which no registry has: never pulled, pinned by the digest it came with.
        if podman image exists "$IMAGE" 2>/dev/null; then
          digest=$(podman image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$IMAGE" 2>/dev/null | grep -E "^${IMAGE_REPO}@sha256:[0-9a-f]{64}$" | head -n 1 || true)
          if [ -z "$digest" ]; then
            ok "version: the one already installed ($IMAGE, an image of this machine's own, not pinned by a digest); update.sh changes it"
            return 0
          fi
          IMAGE=$digest
        fi
        ;;
    esac
    ok "version: the one already installed ($IMAGE); update.sh changes it"
  else
    stable_image
  fi
  say "Downloading MausBot (the first time is about a gigabyte)..."
  podman pull -q "$IMAGE" >/dev/null || fail "MausBot could not be downloaded ($IMAGE; Podman's message is above). Check this machine's outbound HTTPS, then run this again."
  # A tag moves; the digest does not, so a restart never brings a different version than update.sh chose.
  case "$IMAGE" in
    *@sha256:*) ;;
    *)
      repo=${IMAGE%:*}
      digest=""
      for ref in $(podman image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$IMAGE" 2>/dev/null || true); do
        case "$ref" in "$repo"@sha256:* | */"$repo"@sha256:*)
          digest=$ref
          break
          ;;
        esac
      done
      [ -n "$digest" ] || fail "MausBot $IMAGE was downloaded, but Podman did not say its digest, so it cannot be pinned (a tag moves, a digest does not). Nothing was changed. Run this again, or name the image by its digest: OMB_INSTALL_IMAGE=$repo@sha256:..."
      IMAGE=$digest
      ;;
  esac
}

# The stable channel's image; the newest release only while the channel does not exist yet (404). Any other answer, or
# one that names no image pinned by digest, stops here, as deploy/update.sh does.
stable_image() {
  body=$(mktemp)
  code=$(curl -sS --max-time 20 -o "$body" -w '%{http_code}' "$STABLE_URL" 2>/dev/null || true)
  IMAGE=$(sed -n 's/.*"image": *"\([^"]*\)".*/\1/p' "$body" 2>/dev/null | head -n 1)
  rm -f "$body"
  case "$code" in
    200)
      printf '%s' "$IMAGE" | grep -Eq "$PINNED" || fail "The stable channel ($STABLE_URL) names no image this installer accepts. Nothing was changed. Run this again later, or name a version: OMB_INSTALL_IMAGE=$IMAGE_REPO:v0.1.151"
      ok "version: the stable channel"
      ;;
    404)
      release=$(curl -fsS --max-time 20 "$RELEASES_URL" 2>/dev/null | sed -n 's/.*"tag_name": *"\(v[0-9][0-9.]*\)".*/\1/p' | head -n 1)
      [ -n "$release" ] || fail "The newest MausBot release could not be read from api.github.com. Check this machine's outbound HTTPS, then run this again."
      IMAGE="$IMAGE_REPO:$release"
      ok "version: $release, the newest release (no version is stable yet)"
      ;;
    *) fail "The stable channel could not be read ($STABLE_URL answered ${code:-nothing}). Nothing was changed. Check this machine's outbound HTTPS, then run this again." ;;
  esac
}

# The image's own user and group (its `maus`): the container runs as them, mapped to this user by keep-id, so the data
# folder stays this user's own on the host. Never a recursive chown (`:U`).
image_user() {
  RUN_UID=$(podman run --rm --network none --entrypoint id "$IMAGE" -u 2>/dev/null || true)
  RUN_GID=$(podman run --rm --network none --entrypoint id "$IMAGE" -g 2>/dev/null || true)
  case "$RUN_UID:$RUN_GID" in
    *[!0-9:]* | : | :* | *:) fail "The MausBot image did not say which user it runs as. Run this again; if it still fails, send us this line." ;;
  esac
}

selinux_on() { command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; }

write_settings() {
  update_busy
  SETTINGS_BEFORE=$(cat "$INSTALL_DIR/server.env" 2>/dev/null || true)
  mkdir -p "$INSTALL_DIR" "$UNIT_DIR"
  chmod 700 "$INSTALL_DIR"
  [ -d "$DATA_DIR" ] || mkdir -m 700 "$DATA_DIR"
  if [ ! -f "$INSTALL_DIR/server.env" ]; then
    write_file "$INSTALL_DIR/server.env" 600 <<'ENV'
# The server's settings (docs/self-hosting.md). The Podman installer sets OMB_PORT, OMB_WEBHOOK_PORT, OMB_LAN and
# OMB_PUBLIC_URL when asked, and keeps every other line. Apply a change with: systemctl --user restart openmausbot
OMB_PORT=8799
OMB_WEBHOOK_PORT=8800
OMB_SERVER_NAME=mausbot-podman
OMB_CLI_PREFIX=podman exec -it openmausbot openmausbot
ENV
  fi
  if [ -n "$PORT" ]; then
    set_env "$INSTALL_DIR/server.env" OMB_PORT "$PORT"
    set_env "$INSTALL_DIR/server.env" OMB_WEBHOOK_PORT "$((PORT + 1))"
  fi
  case "$LAN" in
    1) set_env "$INSTALL_DIR/server.env" OMB_LAN 1 ;;
    0) unset_env "$INSTALL_DIR/server.env" OMB_LAN ;;
  esac
  if [ -n "$PUBLIC_URL" ]; then
    set_env "$INSTALL_DIR/server.env" OMB_PUBLIC_URL "$PUBLIC_URL"
    set_env "$INSTALL_DIR/server.env" OMB_WEBHOOK_PUBLIC_URL "$PUBLIC_URL"
  fi
  SERVER_PORT=$(env_value "$INSTALL_DIR/server.env" OMB_PORT)
  SERVER_PORT=${SERVER_PORT:-8799}
  # The install's own settings, which update.sh reads and pins: the image, nothing else.
  set_env "$INSTALL_DIR/.env" OMB_IMAGE "$IMAGE"
  # update.sh knows this install by this file: the unit it updates.
  printf '%s\n' "$UNIT" | write_file "$INSTALL_DIR/podman.unit" 600
}

# The install's folder as the app shows it in its update command: ~ for this user's home.
shown_dir() {
  # shellcheck disable=SC2088 # a ~ to show, never to expand
  case "$INSTALL_DIR" in
    "$HOME"/*) printf '~/%s' "${INSTALL_DIR#"$HOME"/}" ;;
    *) printf '%s' "$INSTALL_DIR" ;;
  esac
}

unit_text() {
  label=""
  if selinux_on; then label=":Z"; fi
  cat <<UNIT
# Written by MausBot's Podman installer (deploy/podman/install.sh), and written again each time it runs. The server's
# settings are in $INSTALL_DIR/server.env; update.sh changes Image= below.
[Unit]
Description=MausBot server (rootless Podman)
Documentation=https://github.com/milind-soni/OpenMausBot/blob/main/docs/self-hosting.md#podman-rootless-as-a-service

[Container]
ContainerName=$NAME
Image=$IMAGE
# The host's network, as a server started with npx has it: it listens on 127.0.0.1 (OMB_LAN=1: private addresses too),
# and every other device pairs. No port is forwarded into a container.
# WARNING: this isolates less than the Docker install. Any port a bot or a tool opens on 0.0.0.0 is open on every
# address of this machine, a VPS's public one too, whatever --local says; bots run unboxed beside the data folder that
# holds the engines' logins. Bots reach every service on this machine's loopback (databases, other programs' admin
# ports). Every local account and program counts as the owner on the server's port, and can attach to Chrome's
# debugging port. Use it on a machine only you sign in to, behind a host firewall.
Network=host
# The image's user is this user on the host, so the data folder stays yours.
UserNS=keep-id:uid=$RUN_UID,gid=$RUN_GID
Volume=$DATA_DIR:/data$label
EnvironmentFile=$INSTALL_DIR/server.env
# How the app knows this install, for the update command it shows: $(shown_dir)/update.sh
Environment=OMB_PODMAN_SERVICE=$(shown_dir)
# Chrome's shared memory, as the Docker install gives it. The image brings its own init (tini).
ShmSize=512m
# curl's own limit: Podman 4.9 does not end a check that hangs on a server that accepts and never answers. The port is
# read in the container when the check runs (server.env's OMB_PORT); systemd turns the doubled dollar into one.
HealthCmd=curl -sf --max-time 4 http://127.0.0.1:\$\${OMB_PORT:-8799}/api/health | grep -q openmausbot
HealthInterval=30s
HealthTimeout=5s
HealthRetries=3
HealthStartPeriod=120s
# A server that stops answering is stopped, and systemd starts it again.
HealthOnFailure=kill

[Service]
Restart=on-failure
RestartSec=5
# Room to download the image again if it was removed, and for a slow first start.
TimeoutStartSec=900
TimeoutStopSec=70

[Install]
WantedBy=default.target
UNIT
}

# The unit as it will be written, read by Podman's generator in a folder of its own first: a key this Podman does not
# know would otherwise leave only "unit not found", and the unit in use stays as it was.
check_unit() {
  check_dir=$(mktemp -d)
  unit_text >"$check_dir/$NAME.container"
  check=$(QUADLET_UNIT_DIRS="$check_dir" "$QUADLET" -dryrun -user 2>&1 || true)
  rm -rf "$check_dir"
  case "$check" in
    *"---$NAME.service---"*) ;;
    *) fail "Podman could not read the unit this would write, so nothing was changed: $(printf '%s' "$check" | grep -i "$NAME\|error" | head -n 3)" ;;
  esac
}

write_unit() {
  CHANGED=no
  # A changed unit, or changed settings (--lan, --port), take a restart; a run that changes nothing restarts nothing.
  if [ ! -f "$UNIT" ] || [ "$(unit_text)" != "$(cat "$UNIT")" ] || [ "$SETTINGS_BEFORE" != "$(cat "$INSTALL_DIR/server.env")" ]; then CHANGED=yes; fi
  unit_text | write_file "$UNIT"
  systemctl --user daemon-reload
}

# update.sh (deploy/update.sh) updates with a copy of the data and a way back. Its copy from the installed version's tag
# when that one knows a Podman install, else the newest.
place_update() {
  version=$(podman image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$IMAGE" 2>/dev/null |
    sed -n 's/^v\{0,1\}\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/v\1/p' | head -n 1 || true)
  for source in ${SOURCE_ASKED:-${version:+$REPOSITORY_FILES/$version} $REPOSITORY_FILES/main}; do
    if fetch "$source/deploy/update.sh" "$INSTALL_DIR/update.sh.new" && grep -q 'podman.unit' "$INSTALL_DIR/update.sh.new"; then
      chmod 755 "$INSTALL_DIR/update.sh.new"
      mv "$INSTALL_DIR/update.sh.new" "$INSTALL_DIR/update.sh"
      return 0
    fi
    rm -f "$INSTALL_DIR/update.sh.new"
  done
  note "update.sh could not be downloaded; run this again later to place it."
}

answers() { curl -sf --max-time 5 "http://127.0.0.1:$SERVER_PORT/api/health" 2>/dev/null | grep -q openmausbot; }

wait_healthy() {
  waited=0
  while [ "$waited" -lt "$HEALTH_WAIT_S" ]; do
    if answers; then return 0; fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

port_taken() { ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .; }

start_service() {
  update_busy
  if ! systemctl --user is-active --quiet "$NAME" && port_taken "$SERVER_PORT"; then
    fail "Something else on this machine already listens on port $SERVER_PORT (another MausBot server?). Stop it, or run this again with --port and a free port, like --port 8811."
  fi
  if [ "$CHANGED" = yes ] || ! systemctl --user is-active --quiet "$NAME"; then
    say "Starting MausBot..."
    systemctl --user restart "$NAME" ||
      fail "MausBot could not be started. Its log: journalctl --user -u $NAME -n 50"
  fi
  wait_healthy || fail "MausBot started but did not answer within $HEALTH_WAIT_S seconds. Its log: journalctl --user -u $NAME -n 50"
}

finish() {
  say ""
  say "MausBot is running as your user's service ($NAME), on http://127.0.0.1:$SERVER_PORT."
  if [ "$(env_value "$INSTALL_DIR/server.env" OMB_LAN)" = 1 ]; then say "Its port $SERVER_PORT also answers other devices on this network, from private addresses only, over plain http; each device pairs."; fi
  say ""
  say "  Pair a device   podman exec -it $NAME openmausbot pair"
  say "  Log             journalctl --user -u $NAME -f"
  say "  Update          $INSTALL_DIR/update.sh"
  say "  Data            $DATA_DIR"
  say ""
  say "Warning: it shares this machine's network, which isolates less than the Docker install."
  say "  - Any port a bot or a tool opens on 0.0.0.0 is open on every address of this machine, a public one too, whatever"
  say "    --local says. Bots run unboxed, beside the data folder that holds the engines' logins."
  say "  - Bots reach every service on this machine's loopback: databases, other programs' admin ports."
  say "  - Every account and program on this machine counts as the owner on port $SERVER_PORT, and can attach to Chrome's"
  say "    debugging port."
  say "Use it on a machine only you sign in to, behind a host firewall:"
  say "https://github.com/milind-soni/OpenMausBot/blob/main/docs/self-hosting.md#podman-rootless-as-a-service"
  say ""
  if linger_on; then
    say "It starts at boot, without anyone logged in."
  else
    say "It stops when you log out, and does not start at boot, until your user may run services on its own. Once, as an"
    say "administrator:"
    say ""
    say "  sudo loginctl enable-linger $(id -un)"
  fi
}

run_install() {
  refuse_docker_dir
  update_busy
  check_host
  choose_image
  image_user
  check_unit
  write_settings
  write_unit
  place_update
  start_service
  finish
}

run_uninstall() {
  update_busy
  user_systemd || fail "systemd for your user is not reachable (systemctl --user). Log in to this machine directly or over SSH, then run this again."
  systemctl --user stop "$NAME" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload 2>/dev/null || true
  rm -f "$INSTALL_DIR/podman.unit"
  say "MausBot's service is stopped and removed. Your data stays in $DATA_DIR."
  say "To remove the data too (some files belong to the container's other ids, so through Podman):"
  say "  podman unshare rm -rf $INSTALL_DIR"
  say "The copies of the data update.sh kept: podman volume ls --filter label=com.mausbot.role=update-backup"
  say "The downloaded images: podman image ls ghcr.io/milind-soni/openmausbot"
}

main() {
  settings
  parse "$@"
  choose_dir
  case "$MODE" in
    install) run_install ;;
    uninstall) run_uninstall ;;
  esac
}

main "$@"
