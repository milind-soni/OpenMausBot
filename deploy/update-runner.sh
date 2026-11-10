#!/bin/sh
# The Update server button's host side, for a Docker Compose install (the installer's /opt/openmausbot, or the deploy/
# folder of a git checkout). A server in a container cannot replace its own image, so it only leaves a file in a folder
# it was given; systemd sees the file (openmausbot-update.path) and runs this, as root, outside every container. This
# runs update.sh beside the Compose file, as an owner runs it, and writes how that ended where the server reads it.
#
#   sudo ./update-runner.sh --install     adds the button to this install: systemd's two units and the two folders
#   sudo ./update-runner.sh --remove      takes it away again (your data and update.sh stay)
#
# SECURITY: the request is a file that exists, and nothing else. This script never reads it, follows it or passes on
# anything from it: the server can ask for one thing, "run ./update.sh now", which takes the stable version with a copy
# of the data first and puts the old version back when the new one is not healthy. It cannot choose a version, an image,
# a URL, a flag or a path, cannot roll back (an unfinished update is never undone without a person at a terminal), and
# cannot ask more often than once every GAP_S seconds. The server's container sees the request folder (its own) and the
# status folder read-only; it never sees this script, update.sh, .env or the Compose files.
set -u

SBIN_DIR=${OMB_SBIN_DIR:-/usr/local/sbin}
SYSTEMD_DIR=${OMB_SYSTEMD_DIR:-/etc/systemd/system}
POLICY=${OMB_UPDATE_POLICY:-/etc/mausbot/policy.json}
GAP_S=${OMB_RUNNER_GAP_S:-240}
UNIT=openmausbot-update
RUNNER=openmausbot-update-runner
INSTALLER_MARK="# Written by MausBot's installer (deploy/install.sh)"
OVERRIDE_MARK="# Written by update-runner.sh --install"
# Where the server's container finds the two folders (SERVER_UPDATE_DIR in server/server-update.ts).
IN_CONTAINER=/run/omb-update

say() { printf '%s\n' "$*"; }
fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

DIR=${OMB_INSTALL_DIR:-}
MODE=run
USER_IDS=""
RESTART=yes
while [ $# -gt 0 ]; do
  case "$1" in
    --install) MODE=install ;;
    --remove) MODE=remove ;;
    --dir) [ $# -ge 2 ] || fail "--dir needs a folder."; DIR=$2; shift ;;
    --user) [ $# -ge 2 ] || fail "--user needs UID:GID."; USER_IDS=$2; shift ;;
    --no-restart) RESTART=no ;;
    -h | --help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
  shift
done
if [ -z "$DIR" ]; then
  DIR=$(cd "$(dirname "$0")" && pwd)
  if [ ! -f "$DIR/compose.yaml" ] && [ ! -f "$DIR/docker-compose.yml" ] && [ -f /opt/openmausbot/compose.yaml ]; then DIR=/opt/openmausbot; fi
fi
case "$DIR" in
  /*) ;;
  *) fail "--dir needs a full path, like /opt/openmausbot." ;;
esac
case "$DIR" in
  *[!A-Za-z0-9/._-]*) fail "The install's folder may hold only letters, digits, / . _ and -." ;;
esac
BUTTON="$DIR/server-update"
REQUESTS="$BUTTON/request"
STATUS="$BUTTON/status"

# One `key=value` per line, written whole and renamed into place, in root's own folder.
write_status() { # file, then key=value lines
  file=$1
  shift
  printf '%s\n' "$@" >"$STATUS/$file.tmp" && chmod 644 "$STATUS/$file.tmp" && mv "$STATUS/$file.tmp" "$STATUS/$file"
}
last_value() { sed -n "s/^$1=//p" "$STATUS/last" 2>/dev/null | head -n 1; }
held() { grep -Eq '"updates"[[:space:]]*:[[:space:]]*"hold"' "$POLICY" 2>/dev/null; }
held_word() { if held; then echo yes; else echo no; fi; }

# update.sh's exit code, as the server reads it (deploy/update.sh lists them).
result_of() {
  case "$1" in
    0) echo updated ;;
    1) echo rolled-back ;;
    2) echo rollback-failed ;;
    3) echo busy ;;
    4) echo refused ;;
    5) echo older ;;
    *) echo failed ;;
  esac
}

run_requested() {
  [ -e "$REQUESTS/request" ] || [ -L "$REQUESTS/request" ] || exit 0
  # The server's file, in the server's folder: removed (a link itself, never what it names), never read.
  rm -rf -- "$REQUESTS/request"
  [ -d "$STATUS" ] || exit 0
  run=$(last_value run)
  case "$run" in '' | *[!0-9]*) run=0 ;; esac
  run=$((run + 1))
  ran=$(last_value ran)
  case "$ran" in '' | *[!0-9]*) ran=0 ;; esac
  now=$(date +%s)
  done_with() { write_status last "run=$run" state=done "result=$1" "at=$(date +%s)" "ran=$ran"; }
  if held; then done_with held; return; fi
  if [ $((now - ran)) -lt "$GAP_S" ]; then done_with too-soon; return; fi
  if [ ! -f "$DIR/update.sh" ]; then done_with no-updater; return; fi
  ran=$now
  write_status last "run=$run" state=running "at=$now" "ran=$ran"
  code=0
  bash "$DIR/update.sh" --dir "$DIR" </dev/null || code=$?
  done_with "$(result_of "$code")"
}

need_root() {
  [ "$(id -u)" = 0 ] || fail "Run this as root: sudo $0 $*"
}

layout_of() {
  if [ -f "$DIR/compose.yaml" ] && grep -qF "$INSTALLER_MARK" "$DIR/compose.yaml"; then echo installer
  elif [ -f "$DIR/compose.yaml" ] || [ -f "$DIR/docker-compose.yml" ]; then echo compose
  fi
}

# The checkout's own Compose file stays as git has it: the two folders go in Compose's override file beside it.
override_file() {
  if [ -f "$DIR/compose.yaml" ]; then echo "$DIR/compose.override.yaml"; else echo "$DIR/docker-compose.override.yml"; fi
}

check_override() {
  file=$(override_file)
  if [ -f "$file" ] && ! grep -qF "$OVERRIDE_MARK" "$file"; then
    fail "$file is yours, so it was left alone. Add this to its omb service, then run this again:
    volumes:
      - ./server-update/request:$IN_CONTAINER/request
      - ./server-update/status:$IN_CONTAINER/status:ro"
  fi
  if grep -q '^COMPOSE_FILE=' "$DIR/.env" 2>/dev/null; then
    fail "$DIR/.env names its Compose files (COMPOSE_FILE), so Compose would not read $file. Add $(basename "$file") to COMPOSE_FILE, then run this again."
  fi
}

write_override() {
  file=$(override_file)
  cat >"$file.tmp" <<OVERRIDE
$OVERRIDE_MARK: the Update server button's two folders, the request one the server writes to and the status one
# it reads. update-runner.sh --remove takes this file away.
services:
  omb:
    volumes:
      - ./server-update/request:$IN_CONTAINER/request
      - ./server-update/status:$IN_CONTAINER/status:ro
OVERRIDE
  mv "$file.tmp" "$file"
}

server_ids() { # the user and group the server's container runs as
  (cd "$DIR" && docker compose exec -T omb sh -c 'echo "$(id -u):$(id -g)"' 2>/dev/null) | tr -d '\r' | tail -n 1
}

install_button() {
  need_root --install
  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d "$SYSTEMD_DIR" ]; then
    fail "This server has no systemd, so the app cannot update it. Update it here instead: cd $DIR && sudo ./update.sh"
  fi
  [ -f "$DIR/update.sh" ] || fail "There is no update.sh in $DIR. Get it first (git pull, or run the installer again)."
  layout=$(layout_of)
  [ -n "$layout" ] || fail "There is no compose.yaml or docker-compose.yml in $DIR. Name the install's folder: --dir PATH"
  [ "$layout" = installer ] || check_override
  [ -n "$USER_IDS" ] || USER_IDS=$(server_ids)
  case "$USER_IDS" in
    *[!0-9:]* | : | :* | *: | *:*:* | "") fail "Could not tell which user the server runs as. Start it first (docker compose up -d), or name it: --user UID:GID" ;;
  esac
  install -d -m 0755 -o 0 -g 0 "$BUTTON" "$STATUS"
  install -d -m 0700 -o "${USER_IDS%%:*}" -g "${USER_IDS##*:}" "$REQUESTS"
  install -d -m 0755 "$SBIN_DIR"
  if ! cp "$0" "$SBIN_DIR/$RUNNER.tmp" || ! chmod 0755 "$SBIN_DIR/$RUNNER.tmp" || ! mv "$SBIN_DIR/$RUNNER.tmp" "$SBIN_DIR/$RUNNER"; then
    fail "Could not place $SBIN_DIR/$RUNNER."
  fi
  # Root's own settings at the time of the install, never anything the server writes.
  extra=""
  for name in OMB_STABLE_URL OMB_NEWEST_URL OMB_UPDATE_WAIT_S OMB_RUNNER_GAP_S; do
    value=$(printenv "$name" || true)
    case "$value" in '' | *[!A-Za-z0-9:/._%-]*) ;; *) extra="$extra $name=$value" ;; esac
  done
  cat >"$SYSTEMD_DIR/$UNIT.path" <<UNIT
[Unit]
Description=Runs MausBot's update.sh when the server asks (Settings, Update server)

[Path]
PathExists=$REQUESTS/request

[Install]
WantedBy=multi-user.target
UNIT
  cat >"$SYSTEMD_DIR/$UNIT.service" <<UNIT
[Unit]
Description=MausBot's update.sh in $DIR, asked for from the app

[Service]
Type=oneshot
Environment=HOME=/root OMB_INSTALL_DIR=$DIR$extra
ExecStart=$SBIN_DIR/$RUNNER
UNIT
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable --now "$UNIT.path" >/dev/null 2>&1 || fail "systemd did not switch on $UNIT.path. See: systemctl status $UNIT.path"
  [ "$layout" = installer ] || write_override
  [ -f "$STATUS/last" ] || write_status last run=0 state=done result=updated at=0 ran=0
  write_status runner "layout=$layout" "dir=$DIR" "held=$(held_word)"
  if [ "$RESTART" = yes ]; then
    say "Restarting the server so it sees the button's folders..."
    (cd "$DIR" && docker compose up -d --no-build) >/dev/null || fail "docker compose up -d did not finish. Run it in $DIR."
  fi
  say "The app can update this server now: Settings, Updates, Update server. To take that away: sudo $0 --remove"
}

remove_button() {
  need_root --remove
  if command -v systemctl >/dev/null 2>&1; then systemctl disable --now "$UNIT.path" >/dev/null 2>&1 || true; fi
  rm -f "$SYSTEMD_DIR/$UNIT.path" "$SYSTEMD_DIR/$UNIT.service" "$SBIN_DIR/$RUNNER"
  if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload >/dev/null 2>&1 || true; fi
  for file in "$DIR/compose.override.yaml" "$DIR/docker-compose.override.yml"; do
    if [ -f "$file" ] && grep -qF "$OVERRIDE_MARK" "$file"; then rm -f "$file"; fi
  done
  rm -rf -- "$BUTTON"
  say "The app no longer updates this server. Update it here: cd $DIR && sudo ./update.sh"
}

case "$MODE" in
  install) install_button ;;
  remove) remove_button ;;
  *) run_requested ;;
esac
