#!/bin/sh
# The Update server button's host side, for a Docker Compose install (the installer's /opt/openmausbot, or the deploy/
# folder of a git checkout). A server in a container cannot replace its own image, so it only leaves a file in a folder
# it was given; systemd sees the file (openmausbot-update.path) and runs this, as root, outside every container. This
# runs root's own copy of update.sh on the install, and writes how that ended where the server reads it.
#
#   sudo ./update-runner.sh --install     adds the button to this install, or refreshes it (run it again after git pull)
#   sudo ./update-runner.sh --remove      takes it away again (your data and update.sh stay)
#
# SECURITY: anything that runs as the server's user can leave the request, a bot included where the bots' sandbox is
# off, so the requester is treated as hostile. The request is a file that exists, and nothing else: this script never
# reads it, follows it or passes on anything from it, and the only thing it can cause is the standard update, run by
# root's copy of update.sh with OMB_UPDATE_BY_RUNNER=1: the stable version, only when the running image's own label is
# older (never what the server says it runs), a copy of the data first that never removes the copies before it, and the
# old version back when the new one is not healthy. It cannot choose a version, an image, a URL, a flag or a path,
# cannot roll back, and cannot make updates that change something come closer than GAP_S seconds apart. Every file this
# writes is in STATE, root's folder, of which the server's container sees only `request` (its own) and `status`
# (read-only); it never sees this script, update.sh, .env or the Compose files.
set -u

SBIN_DIR=${OMB_SBIN_DIR:-/usr/local/sbin}
SYSTEMD_DIR=${OMB_SYSTEMD_DIR:-/etc/systemd/system}
STATE=${OMB_UPDATE_STATE_DIR:-/var/lib/openmausbot-update}
POLICY=${OMB_UPDATE_POLICY:-/etc/mausbot/policy.json}
GAP_S=${OMB_RUNNER_GAP_S:-240}
QUIET_S=${OMB_RUNNER_QUIET_S:-30}
UNIT=openmausbot-update
RUNNER=openmausbot-update-runner
INSTALLER_MARK="# Written by MausBot's installer (deploy/install.sh)"
OVERRIDE_MARK="# Written by update-runner.sh --install"
# Where the server's container finds the two folders (SERVER_UPDATE_DIR in server/server-update.ts).
IN_CONTAINER=/run/omb-update
REQUESTS="$STATE/request"
STATUS="$STATE/status"
UPDATER="$STATE/update.sh"

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
    -h | --help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# Writes stdin to `target` through a temporary file in STATE, root's folder, never through a path in the install's
# folder; a target that is a link is refused, never written through.
place() { # target mode
  [ ! -L "$1" ] || fail "$1 is a link, so it was left alone."
  tmp=$(mktemp "$STATE/.place.XXXXXX") || fail "Could not write in $STATE."
  if ! cat >"$tmp" || ! chmod "$2" "$tmp" || ! mv -f "$tmp" "$1"; then
    rm -f "$tmp"
    fail "Could not write $1."
  fi
}
write_status() { # file, then key=value lines
  file=$1
  shift
  printf '%s\n' "$@" | place "$STATUS/$file" 644
}
status_value() { sed -n "s/^$2=//p" "$STATUS/$1" 2>/dev/null | head -n 1; }
number() { case "$1" in '' | *[!0-9]*) echo 0 ;; *) echo "$1" ;; esac; }
held() { grep -Eq '"updates"[[:space:]]*:[[:space:]]*"hold"' "$POLICY" 2>/dev/null; }
held_word() { if held; then echo yes; else echo no; fi; }
# The server's container, and when it started: unchanged across a run, the run stopped nothing.
server_mark() {
  cid=$( (cd "$DIR" && docker compose ps -aq omb) 2>/dev/null | head -n 1)
  [ -z "$cid" ] || docker inspect -f '{{.Id}} {{.State.StartedAt}}' "$cid" 2>/dev/null
}

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

# systemd starts this when the request appears or the owner's policy changes: the policy's hold is said again either way.
run_requested() {
  [ -d "$STATUS" ] || exit 0
  layout=$(status_value runner layout)
  if [ -n "$layout" ]; then write_status runner "layout=$layout" "dir=$DIR" "held=$(held_word)"; fi
  [ -e "$REQUESTS/request" ] || [ -L "$REQUESTS/request" ] || exit 0
  # The server's file, in the server's folder: removed (a link itself, never what it names), never read.
  rm -rf -- "$REQUESTS/request"
  run=$(($(number "$(status_value last run)") + 1))
  ran=$(number "$(status_value last ran)")
  # Runs that change nothing are cheap, so they never use up the gap; they only come no closer than QUIET_S apart.
  since=$(($(date +%s) - $(number "$(status_value last at)")))
  if [ "$since" -lt "$QUIET_S" ]; then sleep $((QUIET_S - since)); fi
  now=$(date +%s)
  done_with() { write_status last "run=$run" state=done "result=$1" "at=$(date +%s)" "ran=$ran"; }
  if held; then done_with held; return; fi
  if [ $((now - ran)) -lt "$GAP_S" ]; then done_with too-soon; return; fi
  if [ ! -f "$UPDATER" ]; then done_with no-updater; return; fi
  write_status last "run=$run" state=running "at=$now" "ran=$ran"
  before=$(server_mark)
  code=0
  OMB_UPDATE_BY_RUNNER=1 bash "$UPDATER" --dir "$DIR" </dev/null || code=$?
  if [ -z "$before" ] || [ "$before" != "$(server_mark)" ]; then ran=$now; fi
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
  [ ! -L "$file" ] || fail "$file is a link, so it was left alone."
  if [ -f "$file" ] && ! grep -qF "$OVERRIDE_MARK" "$file"; then
    fail "$file is yours, so it was left alone. Add this to its omb service, then run this again:
    volumes:
      - $REQUESTS:$IN_CONTAINER/request
      - $STATUS:$IN_CONTAINER/status:ro"
  fi
  if grep -q '^COMPOSE_FILE=' "$DIR/.env" 2>/dev/null; then
    fail "$DIR/.env names its Compose files (COMPOSE_FILE), so Compose would not read $file. Add $(basename "$file") to COMPOSE_FILE, then run this again."
  fi
}

write_override() {
  place "$(override_file)" 644 <<OVERRIDE
$OVERRIDE_MARK: the Update server button's two folders, the request one the server writes to and the status one
# it reads. update-runner.sh --remove takes this file away.
services:
  omb:
    volumes:
      - $REQUESTS:$IN_CONTAINER/request
      - $STATUS:$IN_CONTAINER/status:ro
OVERRIDE
}

# The user and group that own the server's /data on the host, as numbers: the container runs as them.
data_owner() {
  cid=$( (cd "$DIR" && docker compose ps -aq omb) 2>/dev/null | head -n 1)
  [ -n "$cid" ] || return 0
  source=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$cid" 2>/dev/null)
  [ -n "$source" ] || return 0
  stat -c '%u:%g' "$source" 2>/dev/null || stat -f '%u:%g' "$source" 2>/dev/null
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
  [ -n "$USER_IDS" ] || USER_IDS=$(data_owner)
  case "$USER_IDS" in
    *[!0-9:]* | : | :* | *: | *:*:* | "") fail "Could not tell who owns the server's data. Start it first (docker compose up -d), or name the owner: --user UID:GID" ;;
  esac
  [ ! -L "$STATE" ] || fail "$STATE is a link, so it was left alone."
  install -d -m 0755 -o 0 -g 0 "$STATE" "$STATUS"
  install -d -m 0700 -o "${USER_IDS%%:*}" -g "${USER_IDS##*:}" "$REQUESTS"
  install -d -m 0755 "$SBIN_DIR"
  # Root's own copies: a checkout's folder is its owner's, so what root runs never comes from it at the time of a run.
  place "$UPDATER" 755 <"$DIR/update.sh"
  place "$SBIN_DIR/$RUNNER" 755 <"$0"
  # Root's own settings at the time of the install, never anything the server writes.
  extra=""
  for name in OMB_STABLE_URL OMB_NEWEST_URL OMB_UPDATE_WAIT_S OMB_RUNNER_GAP_S OMB_RUNNER_QUIET_S; do
    value=$(printenv "$name" || true)
    case "$value" in '' | *[!A-Za-z0-9:/._-]*) ;; *) extra="$extra $name=$value" ;; esac
  done
  place "$SYSTEMD_DIR/$UNIT.path" 644 <<UNIT
[Unit]
Description=Runs MausBot's update.sh when the server asks (Settings, Update server)

[Path]
PathExists=$REQUESTS/request
PathChanged=$POLICY

[Install]
WantedBy=multi-user.target
UNIT
  place "$SYSTEMD_DIR/$UNIT.service" 644 <<UNIT
[Unit]
Description=MausBot's update.sh for $DIR, asked for from the app

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
  say "The app can update this server now: Settings, Updates, Update server. After a git pull, run this again so it uses the new update.sh. To take the button away: sudo $0 --remove"
}

remove_button() {
  need_root --remove
  if command -v systemctl >/dev/null 2>&1; then systemctl disable --now "$UNIT.path" >/dev/null 2>&1 || true; fi
  rm -f "$SYSTEMD_DIR/$UNIT.path" "$SYSTEMD_DIR/$UNIT.service" "$SBIN_DIR/$RUNNER"
  if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload >/dev/null 2>&1 || true; fi
  for file in "$DIR/compose.override.yaml" "$DIR/docker-compose.override.yml"; do
    if [ -f "$file" ] && [ ! -L "$file" ] && grep -qF "$OVERRIDE_MARK" "$file"; then rm -f "$file"; fi
  done
  if [ ! -L "$STATE" ]; then rm -rf -- "$STATE"; fi
  say "The app no longer updates this server. Update it here: cd $DIR && sudo ./update.sh"
}

case "$MODE" in
  install) install_button ;;
  remove) remove_button ;;
  *) run_requested ;;
esac
