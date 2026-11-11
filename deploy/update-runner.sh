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
# reads it, follows it or passes on anything from it. What any request can cause, at most once per stable image:
#   - root's copy of update.sh, run with OMB_UPDATE_BY_RUNNER=1: the stable version, only when it is not older than the
#     running image's own label (never what the server says it runs), a copy of the data first, and the old version
#     back when the new one is not healthy;
#   - after a rollback, never that same stable image again on this server until a person runs update.sh or another
#     stable image is out (STATE/blocked), so a server that fails a version cannot be stopped and copied over and over;
#   - the runner's own copies of the data are capped at the two newest; a person's own copy is never removed.
# Runs that stop the server are GAP_S apart; runs with nothing to do are answered from STATE/idle for IDLE_S without
# asking GitHub or the registry, and any two runs are QUIET_S apart. It cannot choose a version, an image, a URL, a flag
# or a path, and cannot roll back. Every file this writes is in STATE, root's folder, of which the server's container
# sees only `request` (its own) and `status` (read-only). In a checkout, the folder's owner decides what root's
# `docker compose up` starts (the Compose files and .env are theirs), so --install and every run want that owner to be
# root, able to run Docker already, or trusted at --install, and the folder and those above it closed to anyone else.
set -u
# Every file and folder this makes has its mode set by the write; nothing is left to the caller's umask.
umask 022

SBIN_DIR=${OMB_SBIN_DIR:-/usr/local/sbin}
SYSTEMD_DIR=${OMB_SYSTEMD_DIR:-/etc/systemd/system}
STATE=${OMB_UPDATE_STATE_DIR:-/var/lib/openmausbot-update}
POLICY=${OMB_UPDATE_POLICY:-/etc/mausbot/policy.json}
GAP_S=${OMB_RUNNER_GAP_S:-240}
QUIET_S=${OMB_RUNNER_QUIET_S:-30}
IDLE_S=${OMB_RUNNER_IDLE_S:-300}
UNIT=openmausbot-update
RUNNER=openmausbot-update-runner
INSTALLER_MARK="# Written by MausBot's installer (deploy/install.sh)"
OVERRIDE_MARK="# Written by update-runner.sh --install"
# Where the server's container finds the two folders (SERVER_UPDATE_DIR in server/server-update.ts).
IN_CONTAINER=/run/omb-update
REQUESTS="$STATE/request"
STATUS="$STATE/status"
UPDATER="$STATE/update.sh"
BLOCKED="$STATE/blocked"
IDLE="$STATE/idle"
TRUST="$STATE/trust"
VERSION_LABEL=org.opencontainers.image.version

say() { printf '%s\n' "$*"; }
fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

DIR=${OMB_INSTALL_DIR:-}
MODE=run
USER_IDS=""
RESTART=yes
TRUST_OWNER=no
while [ $# -gt 0 ]; do
  case "$1" in
    --install) MODE=install ;;
    --remove) MODE=remove ;;
    --dir) [ $# -ge 2 ] || fail "--dir needs a folder."; DIR=$2; shift ;;
    --user) [ $# -ge 2 ] || fail "--user needs UID:GID."; USER_IDS=$2; shift ;;
    --no-restart) RESTART=no ;;
    --trust-folder-owner) TRUST_OWNER=yes ;;
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
state_value() { sed -n "s/^$2=//p" "$STATE/$1" 2>/dev/null | head -n 1; }
number() { case "$1" in '' | *[!0-9]*) echo 0 ;; *) echo "$1" ;; esac; }
held() { grep -Eq '"updates"[[:space:]]*:[[:space:]]*"hold"' "$POLICY" 2>/dev/null; }
held_word() { if held; then echo yes; else echo no; fi; }
server_container() { (cd "$DIR" && docker compose ps -aq omb) 2>/dev/null | head -n 1; }
# The server's container, and when it started: unchanged across a run, the run stopped nothing. A server that restarts by
# itself during a run makes that run count as one that did.
server_mark() {
  cid=$(server_container)
  [ -z "$cid" ] || docker inspect -f '{{.Id}} {{.State.StartedAt}}' "$cid" 2>/dev/null
}
server_image() {
  cid=$(server_container)
  [ -z "$cid" ] || docker inspect -f '{{.Image}}' "$cid" 2>/dev/null
}
# yes when the running image is labelled with a released version (a build of main is labelled with its branch).
released() {
  image=$(server_image)
  label=$( [ -z "$image" ] || docker image inspect -f "{{index .Config.Labels \"$VERSION_LABEL\"}}" "$image" 2>/dev/null)
  if printf '%s' "$label" | grep -Eqx 'v?[0-9]+\.[0-9]+\.[0-9]+'; then echo yes; else echo no; fi
}
write_runner() { write_status runner "layout=$1" "dir=$DIR" "held=$(held_word)" "release=$(released)"; }
# The install's update.sh, when it is a file and root's copy is the same; a checkout's after a git pull is newer.
# A file swapped for a pipe after the check would hold cmp for ever, and with it this oneshot: it gets ten seconds.
same_updater() {
  [ -f "$DIR/update.sh" ] && [ ! -L "$DIR/update.sh" ] || return 1
  if command -v timeout >/dev/null 2>&1; then timeout 10 cmp -s "$DIR/update.sh" "$UPDATER"; else cmp -s "$DIR/update.sh" "$UPDATER"; fi
}
owner_of() { stat -L -c %u "$1" 2>/dev/null || stat -L -f %u "$1" 2>/dev/null; }
mode_of() { # the permission bits, sticky included, as a number
  m=$(stat -L -c %a "$1" 2>/dev/null) || m=$(stat -L -f %p "$1" 2>/dev/null | sed 's/.*\(....\)$/\1/')
  printf '%d' "0$m"
}
stat_of() { stat -L -c "$1" "$3" 2>/dev/null || stat -L -f "$2" "$3" 2>/dev/null; }
# "user:group mode" of a folder, as the refusal names it.
folder_line() { printf '%s %o' "$(stat_of '%U:%G' '%Su:%Sg' "$1")" "$(mode_of "$1")"; }
# A group whose only member is the folder's owner, of the owner's own name: the private group Ubuntu and Fedora give each
# user, which their umask 002 makes every new folder writable by.
private_group() {
  user=$(stat_of %U %Su "$1")
  # GNU stat says UNKNOWN for an id with no name: two of those are not one user's group.
  [ -n "$user" ] && [ "$user" != UNKNOWN ] && [ "$user" = "$(stat_of %G %Sg "$1")" ] || return 1
  entry=$(getent group "$user" 2>/dev/null) && [ -n "$entry" ] || return 1
  members=$(printf '%s' "$entry" | cut -d: -f4)
  [ -z "$members" ] || [ "$members" = "$user" ] || return 1
  # Nor when anyone else has it as their own group, or the users cannot be listed to tell.
  users=$(getent passwd 2>/dev/null) && [ -n "$users" ] || return 1
  [ -z "$(printf '%s\n' "$users" | awk -F: -v gid="$(printf '%s' "$entry" | cut -d: -f3)" -v user="$user" '$4 == gid && $1 != user')" ]
}
# True when someone besides root and the folder's owner may change it: writable by all without the sticky bit, or by a
# group other than root's or the owner's private one.
open_to_others() {
  mode=$(mode_of "$1")
  [ $((mode & 512)) = 0 ] || return 1
  [ $((mode & 2)) = 0 ] || return 0
  [ $((mode & 16)) != 0 ] || return 1
  [ "$(stat_of %g %g "$1")" != 0 ] || return 1
  ! private_group "$1"
}
# SECURITY: in a checkout the folder's owner can change what root runs here (its Compose files and .env decide what
# `docker compose up` starts), and so can whoever may change the folder or rename one above it. Prints the problem and the
# folder it is in, as "owner|writable PATH user:group mode": `owner` when the owner is neither root, nor in the docker
# group, nor trusted at --install; `writable` when the folder, or one above it, is open to others (open_to_others), or a
# folder above it belongs to anyone but root and that owner.
folder_problem() {
  owner=$(owner_of "$DIR")
  if [ "$owner" != 0 ]; then
    name=$(stat_of %U %Su "$DIR")
    case " $(id -nG "$name" 2>/dev/null) " in
      *" docker "*) ;;
      *) [ "$TRUST_OWNER" = yes ] || { [ "$MODE" = run ] && [ "$(state_value trust dir)" = "$DIR" ]; } || { echo "owner $DIR $(folder_line "$DIR")"; return 0; } ;;
    esac
  fi
  if open_to_others "$DIR"; then echo "writable $DIR $(folder_line "$DIR")"; return 0; fi
  parent=$(dirname "$DIR")
  while :; do
    up=$(owner_of "$parent")
    if { [ "$up" != 0 ] && [ "$up" != "$owner" ]; } || open_to_others "$parent"; then echo "writable $parent $(folder_line "$parent")"; return 0; fi
    [ "$parent" = / ] && return 0
    parent=$(dirname "$parent")
  done
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
    6) echo no-room ;;
    *) echo failed ;;
  esac
}

# systemd starts this when the request appears, the owner's policy changes or .env does (an update pins its image there):
# what the status says of the hold and of the running image is said again each time.
run_requested() {
  [ -d "$STATUS" ] || exit 0
  layout=$(status_value runner layout)
  if [ -n "$layout" ]; then write_runner "$layout"; fi
  [ -e "$REQUESTS/request" ] || [ -L "$REQUESTS/request" ] || exit 0
  # The server's files, in the server's folder: removed (a link itself, never what it names), never read. `fresh` says the
  # server's own check knows of a newer stable version than the last answer: then that answer is checked, not reused.
  fresh=no
  if [ -e "$REQUESTS/fresh" ] || [ -L "$REQUESTS/fresh" ]; then fresh=yes; fi
  rm -rf -- "$REQUESTS/request" "$REQUESTS/fresh"
  run=$(($(number "$(status_value last run)") + 1))
  ran=$(number "$(status_value last ran)")
  since=$(($(date +%s) - $(number "$(status_value last at)")))
  if [ "$since" -lt "$QUIET_S" ]; then sleep $((QUIET_S - since)); fi
  now=$(date +%s)
  version=""
  detail=""
  done_with() { write_status last "run=$run" state=done "result=$1" "at=$(date +%s)" "ran=$ran" ${version:+"version=$version"} ${detail:+"detail=$detail"}; }
  if held; then done_with held; return; fi
  problem=$(folder_problem)
  if [ -n "$problem" ]; then detail=${problem#* }; done_with unsafe; return; fi
  image=$(server_image)
  if [ "$(released)" != yes ]; then done_with unreleased; return; fi
  if [ ! -f "$UPDATER" ] || [ ! -f "$DIR/update.sh" ] || [ -L "$DIR/update.sh" ]; then done_with no-updater; return; fi
  if ! same_updater; then done_with stale; return; fi
  ask_target() { OMB_UPDATE_BY_RUNNER=1 bash "$UPDATER" --dir "$DIR" --print-target </dev/null 2>/dev/null; }
  target=""
  # Nothing to do a moment ago, on the same image: the same answer, without asking GitHub or the registry again; when the
  # server knows of a newer version, only GitHub is asked whether the stable image is still the same.
  if [ "$(state_value idle image)" = "$image" ] && [ $((now - $(number "$(state_value idle at)"))) -lt "$IDLE_S" ]; then
    if [ "$fresh" = yes ]; then target=$(ask_target) || { done_with refused; return; }; fi
    if [ "$fresh" = no ] || [ "${target% *}" = "$(state_value idle target)" ]; then
      version=$(state_value idle version)
      done_with updated
      return
    fi
  fi
  if [ $((now - ran)) -lt "$GAP_S" ]; then done_with too-soon; return; fi
  [ -n "$target" ] || target=$(ask_target) || { done_with refused; return; }
  version=${target##* }
  if [ "$(state_value blocked image)" = "$image" ] && [ "$(state_value blocked target)" = "${target% *}" ]; then done_with not-retried; return; fi
  write_status last "run=$run" state=running "at=$now" "ran=$ran" "version=$version"
  before=$(server_mark)
  code=0
  OMB_UPDATE_BY_RUNNER=1 bash "$UPDATER" --dir "$DIR" </dev/null || code=$?
  if [ -z "$before" ] || [ "$before" != "$(server_mark)" ]; then ran=$now; fi
  rm -f "$IDLE"
  if [ "$code" = 0 ] && [ "$ran" != "$now" ]; then printf '%s\n' "image=$image" "at=$now" "target=${target% *}" "version=$version" | place "$IDLE" 600; fi
  if [ "$code" = 1 ]; then printf '%s\n' "image=$image" "target=${target% *}" | place "$BLOCKED" 600; fi
  if [ "$code" = 0 ] && [ "$ran" = "$now" ]; then rm -f "$BLOCKED"; fi
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

# SECURITY: in a checkout the folder's owner can change what root runs here (its Compose files and .env decide what
# `docker compose up` starts). Fine when that owner is root or may run Docker already; anyone else, only when asked.
check_owner() {
  problem=$(folder_problem)
  where=${problem#* }
  case "$problem" in
    owner*) fail "${where% * *} (${where#* }) belongs to someone who cannot run Docker. Whoever owns it can change what root runs when the app asks for an update (its Compose files and .env decide what docker compose up starts). Move it to a folder root owns, or run this again with --trust-folder-owner if that is what you want." ;;
    writable*) fail "${where% * *} (${where#* }) can be changed by someone other than root and the owner of $DIR, who could then change what root runs when the app asks for an update. Make it writable by its owner only (chmod go-w ${where% * *}), then run this again." ;;
  esac
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
  check_owner
  other=$(status_value runner dir)
  if [ -n "$other" ] && [ "$other" != "$DIR" ]; then
    fail "This server's button already updates $other: one install per server. To move it: sudo $0 --remove --dir $other, then run this again."
  fi
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
  for name in OMB_STABLE_URL OMB_NEWEST_URL OMB_UPDATE_WAIT_S OMB_RUNNER_GAP_S OMB_RUNNER_QUIET_S OMB_RUNNER_IDLE_S; do
    value=$(printenv "$name" || true)
    case "$value" in '' | *[!A-Za-z0-9:/._-]*) ;; *) extra="$extra $name=$value" ;; esac
  done
  place "$SYSTEMD_DIR/$UNIT.path" 644 <<UNIT
[Unit]
Description=Runs MausBot's update.sh when the server asks (Settings, Update server)

[Path]
PathExists=$REQUESTS/request
PathChanged=$POLICY
PathChanged=$DIR/.env

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
TimeoutStartSec=4h
UNIT
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable --now "$UNIT.path" >/dev/null 2>&1 || fail "systemd did not switch on $UNIT.path. See: systemctl status $UNIT.path"
  [ "$layout" = installer ] || write_override
  [ -f "$STATUS/last" ] || write_status last run=0 state=done result=updated at=0 ran=0
  rm -f "$BLOCKED" "$IDLE" "$TRUST"
  if [ "$TRUST_OWNER" = yes ]; then printf '%s\n' "dir=$DIR" | place "$TRUST" 600; fi
  write_runner "$layout"
  if [ "$RESTART" = yes ]; then
    say "Restarting the server so it sees the button's folders..."
    (cd "$DIR" && docker compose up -d --no-build) >/dev/null || fail "docker compose up -d did not finish. Run it in $DIR."
  fi
  say "The app can update this server now: Settings, Updates, Update server. After a git pull, run this again so it uses the new update.sh. To take the button away: sudo $0 --remove"
}

remove_button() {
  need_root --remove
  other=$(status_value runner dir)
  if [ -n "$other" ] && [ "$other" != "$DIR" ]; then
    fail "This server's button updates $other, not $DIR, so nothing was removed. To remove it: sudo $0 --remove --dir $other"
  fi
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
