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
# Nothing runs until the last line calls main, so a download that is cut off part-way runs nothing. It sends no
# telemetry. It contacts the image registry (ghcr.io), GitHub's release list and this repository's files.
set -eu

settings() {
  IMAGE_REPO=ghcr.io/milind-soni/openmausbot
  STABLE_URL=https://raw.githubusercontent.com/milind-soni/OpenMausBot/channels/stable.json
  RELEASES_URL=https://api.github.com/repos/milind-soni/OpenMausBot/releases/latest
  REPOSITORY_FILES=https://raw.githubusercontent.com/milind-soni/OpenMausBot
  # One copy of this repository's files to use instead (https://… or file:///…), as deploy/install.sh takes it.
  SOURCE_ASKED="${OMB_INSTALL_SOURCE:-}"
  INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/openmausbot"
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
  NAME=openmausbot
  HEALTH_WAIT_S="${OMB_INSTALL_HEALTH_WAIT_S:-240}"
  MODE=install
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
          --dir) INSTALL_DIR=$2 ;;
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
  case "$INSTALL_DIR" in
    /*) ;;
    *) fail "--dir takes an absolute path." ;;
  esac
  case "$INSTALL_DIR" in *[!A-Za-z0-9/._-]*) fail "--dir takes a path of letters, digits, dots, dashes and slashes." ;; esac
  DATA_DIR="$INSTALL_DIR/data"
  UNIT="$UNIT_DIR/$NAME.container"
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
  for candidate in /usr/libexec/podman/quadlet /usr/lib/podman/quadlet /usr/local/libexec/podman/quadlet; do
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
    fail "This needs Podman 4.9 or newer, for its systemd units; this machine has $version. Ubuntu 24.04, Debian 13, Fedora 40 and RHEL 9.4 or newer have it."
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

# The image by digest: the one update.sh pinned, else the stable channel's, else the newest release's.
choose_image() {
  asked="${OMB_INSTALL_IMAGE:-}"
  pinned=$(env_value "$INSTALL_DIR/.env" OMB_IMAGE)
  if [ -n "$asked" ]; then
    case "$asked" in *[!A-Za-z0-9/:._@-]*) fail "OMB_INSTALL_IMAGE is not an image name." ;; esac
    IMAGE=$asked
    ok "version: $IMAGE, as asked"
  elif [ -n "$pinned" ]; then
    IMAGE=$pinned
    ok "version: the one already installed ($IMAGE); update.sh changes it"
  else
    stable=$(curl -fsS --max-time 20 "$STABLE_URL" 2>/dev/null || true)
    IMAGE=$(printf '%s' "$stable" | sed -n 's/.*"image": *"\([^"]*\)".*/\1/p' | head -n 1)
    case "$IMAGE" in
      "$IMAGE_REPO"@sha256:*) ok "version: the stable channel" ;;
      *)
        release=$(curl -fsS --max-time 20 "$RELEASES_URL" 2>/dev/null | sed -n 's/.*"tag_name": *"\(v[0-9][0-9.]*\)".*/\1/p' | head -n 1)
        [ -n "$release" ] || fail "The newest MausBot release could not be read from api.github.com. Check this machine's outbound HTTPS, then run this again."
        IMAGE="$IMAGE_REPO:$release"
        ok "version: $release, the newest release"
        ;;
    esac
  fi
  say "Downloading MausBot (the first time is about a gigabyte)..."
  podman pull -q "$IMAGE" >/dev/null || fail "MausBot could not be downloaded ($IMAGE; Podman's message is above). Check this machine's outbound HTTPS, then run this again."
  # A tag moves; the digest does not, so a restart never brings a different version than update.sh chose.
  case "$IMAGE" in
    *@sha256:*) ;;
    "$IMAGE_REPO":*)
      digest=$(podman image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$IMAGE" 2>/dev/null | grep "^$IMAGE_REPO@sha256:" | head -n 1 || true)
      [ -z "$digest" ] || IMAGE=$digest
      ;;
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
# a program on this machine counts as its owner, and every other device pairs. No port is forwarded into a container.
Network=host
# The image's user is this user on the host, so the data folder stays yours.
UserNS=keep-id:uid=$RUN_UID,gid=$RUN_GID
Volume=$DATA_DIR:/data$label
EnvironmentFile=$INSTALL_DIR/server.env
# Chrome's shared memory, as the Docker install gives it. The image brings its own init (tini).
ShmSize=512m
# curl's own limit: Podman 4.9 does not end a check that hangs on a server that accepts and never answers.
HealthCmd=curl -sf --max-time 4 http://127.0.0.1:$SERVER_PORT/api/health | grep -q openmausbot
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

write_unit() {
  CHANGED=no
  # A changed unit, or changed settings (--lan, --port), take a restart; a run that changes nothing restarts nothing.
  if [ ! -f "$UNIT" ] || [ "$(unit_text)" != "$(cat "$UNIT")" ] || [ "$SETTINGS_BEFORE" != "$(cat "$INSTALL_DIR/server.env")" ]; then CHANGED=yes; fi
  unit_text | write_file "$UNIT"
  # A key this Podman does not know would otherwise leave only "unit not found".
  check=$(QUADLET_UNIT_DIRS="$UNIT_DIR" "$QUADLET" -dryrun -user 2>&1 || true)
  case "$check" in
    *"---$NAME.service---"*) ;;
    *) fail "Podman could not read the unit it was given ($UNIT): $(printf '%s' "$check" | grep -i "$NAME\|error" | head -n 3)" ;;
  esac
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
  if [ "$(env_value "$INSTALL_DIR/server.env" OMB_LAN)" = 1 ]; then say "Other devices on this network can pair over plain http; nothing on the open internet can reach it."; fi
  say ""
  say "  Pair a device   podman exec -it $NAME openmausbot pair"
  say "  Log             journalctl --user -u $NAME -f"
  say "  Update          $INSTALL_DIR/update.sh"
  say "  Data            $DATA_DIR"
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
  check_host
  choose_image
  image_user
  write_settings
  write_unit
  place_update
  start_service
  finish
}

run_uninstall() {
  user_systemd || fail "systemd for your user is not reachable (systemctl --user). Log in to this machine directly or over SSH, then run this again."
  systemctl --user stop "$NAME" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload 2>/dev/null || true
  rm -f "$INSTALL_DIR/podman.unit"
  say "MausBot's service is stopped and removed. Your data stays in $DATA_DIR."
  say "To remove the data too (some files belong to the container's other ids, so through Podman):"
  say "  podman unshare rm -rf $INSTALL_DIR"
  say "The downloaded images: podman image ls ghcr.io/milind-soni/openmausbot"
}

main() {
  settings
  parse "$@"
  case "$MODE" in
    install) run_install ;;
    uninstall) run_uninstall ;;
  esac
}

main "$@"
