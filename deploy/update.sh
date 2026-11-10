#!/usr/bin/env bash
# Updates this Docker Compose install to the stable version, with a way back:
#
#   ./update.sh                  the stable version
#   ./update.sh --version X.Y.Z  one released version
#   ./update.sh --check          say what would change, and change nothing
#   ./update.sh --rollback       put back the version and the data from before the last update
#   ./update.sh --dir PATH       the install's folder, when it is not this one (the installer's: /opt/openmausbot)
#
# It runs on the server itself, beside docker-compose.yml, because a server cannot replace its own container. The steps
# are the ones the MausBot connector runs for a connected server (connector/src/home.ts `update`): download the new
# image by digest, stop the server, copy its data aside, start the new image, and wait until it answers and can still
# start bots. When it does not, the old image and the copy are put back. Each step is written to .update/journal
# before it starts, so an update that was interrupted (Ctrl-C, a closed terminal, a reboot) is finished safely by
# the next run, and a second run of a finished update changes nothing.
#
# Exit codes: 0 done or nothing to do, 1 the update failed and the old version is back, 2 the old version could not be
# brought back either, 3 another update is running, 4 nothing was changed (refused, or could not download).
set -uo pipefail

REPO="ghcr.io/milind-soni/openmausbot"
PINNED="^ghcr\.io/milind-soni/openmausbot@sha256:[0-9a-f]{64}$"
STABLE_URL=${OMB_STABLE_URL:-https://raw.githubusercontent.com/milind-soni/OpenMausBot/channels/stable.json}
SERVICE=${OMB_UPDATE_SERVICE:-omb}
WAIT_S=${OMB_UPDATE_WAIT_S:-300}
POLL_S=${OMB_UPDATE_POLL_S:-5}
KEEP_TAG="openmausbot-before-update:local"

# The install: --dir, else the folder this script is in when that holds a Compose file, else where the installer
# (deploy/install.sh) puts one.
DIR=${OMB_INSTALL_DIR:-}
want_dir=no
for arg in "$@"; do
  if [ "$want_dir" = yes ]; then DIR=$arg; want_dir=no; elif [ "$arg" = --dir ]; then want_dir=yes; fi
done
if [ -z "$DIR" ]; then
  DIR=$(cd "$(dirname "$0")" && pwd)
  if [ ! -f "$DIR/docker-compose.yml" ] && [ ! -f "$DIR/compose.yaml" ] && [ -f /opt/openmausbot/compose.yaml ]; then DIR=/opt/openmausbot; fi
fi
STATE="$DIR/.update"
JOURNAL="$STATE/journal"
LAST="$STATE/last"
LOCK="$STATE/lock"
LOG="$STATE/update.log"
cd "$DIR" 2>/dev/null || { printf '%s\n' "There is no folder $DIR."; exit 4; }
# The pin is read from .env, never from the shell that happens to run this.
unset OMB_IMAGE

# A step interrupted while its output goes to the log still speaks to the terminal.
exec 3>&1
say() {
  printf '%s\n' "$*" >&3
  if [ -d "$STATE" ]; then printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG"; fi
}
refuse() {
  say "$*"
  exit 4
}
compose() { docker compose "$@"; }
container() { compose ps -aq "$SERVICE" 2>/dev/null | head -n 1; }
inspect() { docker inspect -f "$1" "$2" 2>/dev/null; }
image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null; }
published_ref() { docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$1" 2>/dev/null | grep "^$REPO@" | head -n 1; }
image_version() { docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$1" 2>/dev/null | sed -n 's/^v\{0,1\}\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p'; }
name_of() { if [ -n "${2:-}" ]; then printf '%s' "$2"; else printf '%s' "$1" | sed 's/^.*sha256:\(.\{12\}\).*$/image \1/'; fi; }
old_name() { name_of "${J_previous:-$J_previous_id}" "$J_previous_version"; }
new_name() { name_of "$J_target" "$J_version"; }

# The journal: one `key=value` per line, written whole and renamed into place.
J_phase="" J_target="" J_target_id="" J_version="" J_previous="" J_previous_id="" J_previous_version=""
J_data="" J_backup="" J_engine="" J_caddy="" J_running=""
JOURNAL_KEYS="phase target target_id version previous previous_id previous_version data backup engine caddy running"
write_record() {
  local file=$1 key
  for key in $JOURNAL_KEYS; do eval "printf '%s=%s\n' \"$key\" \"\$J_$key\""; done >"$file.tmp" && mv "$file.tmp" "$file"
}
read_record() {
  local file=$1 key value
  [ -f "$file" ] || return 1
  while IFS='=' read -r key value; do
    case " $JOURNAL_KEYS " in *" $key "*) eval "J_$key=\$value" ;; esac
  done <"$file"
}
phase() {
  J_phase=$1
  write_record "$JOURNAL"
}

take_lock() {
  mkdir -p "$STATE" && chmod 700 "$STATE"
  if ! mkdir "$LOCK" 2>/dev/null; then
    local other
    other=$(cat "$LOCK/pid" 2>/dev/null || true)
    if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
      printf '%s\n' "An update is already running here (process $other). Wait for it to finish."
      exit 3
    fi
    rm -rf "$LOCK"
    mkdir "$LOCK" || exit 3
  fi
  echo $$ >"$LOCK/pid"
  trap 'rm -rf "$LOCK"' EXIT
}

# The copies run in a short-lived container from the server's own image, as root and without a network.
copy_aside() { # data backup image
  docker volume rm -f "$2" >/dev/null 2>&1
  docker volume create --label com.mausbot.role=update-backup --label "com.mausbot.image=$3" "$2" >/dev/null || return 1
  docker run --rm --network none --user 0:0 --label com.mausbot.role=update-helper -v "$1:/from:ro" -v "$2:/to" --entrypoint cp "$3" -a /from/. /to/
}
put_back() { # backup data image
  docker run --rm --network none --user 0:0 --label com.mausbot.role=update-helper -v "$1:/from:ro" -v "$2:/to" --entrypoint sh "$3" \
    -c 'find /to -mindepth 1 -delete && cp -a /from/. /to/'
}
room_for_copy() { # data image → 0 when there is room, or when it cannot be measured
  local sizes used free
  sizes=$(docker run --rm --network none --user 0:0 --label com.mausbot.role=update-helper -v "$1:/from:ro" --entrypoint sh "$2" \
    -c 'du -sk /from | cut -f1; df -Pk /from | tail -n 1 | tr -s " " | cut -d" " -f4' 2>/dev/null) || return 0
  used=$(printf '%s\n' "$sizes" | sed -n 1p)
  free=$(printf '%s\n' "$sizes" | sed -n 2p)
  case "$used$free" in '' | *[!0-9]*) return 0 ;; esac
  NEEDED_MB=$(((used + used / 10) / 1024 + 1024))
  FREE_MB=$((free / 1024))
  [ "$FREE_MB" -ge "$NEEDED_MB" ]
}

pin_image() { # writes OMB_IMAGE=<ref> into .env, keeping every other line and the file's mode
  local tmp="$DIR/.env.update.tmp"
  if [ -f .env ]; then cp -p .env "$tmp" && grep -v '^OMB_IMAGE=' .env >"$tmp"; else : >"$tmp" && chmod 600 "$tmp"; fi
  printf 'OMB_IMAGE=%s\n' "$1" >>"$tmp" && mv "$tmp" .env
}
keep_env() {
  rm -f "$STATE/env.before" "$STATE/env.absent"
  if [ -f .env ]; then cp -p .env "$STATE/env.before" && chmod 600 "$STATE/env.before"; else : >"$STATE/env.absent"; fi
}
restore_env() {
  if [ -f "$STATE/env.before" ]; then cp -p "$STATE/env.before" "$DIR/.env.update.tmp" && mv "$DIR/.env.update.tmp" .env
  elif [ -f "$STATE/env.absent" ]; then rm -f .env; fi
}

answers() { compose exec -T "$SERVICE" sh -c 'curl -sf --max-time 5 "http://127.0.0.1:${OMB_PORT:-8799}/api/health"' 2>/dev/null | grep -q openmausbot; }
reported_version() {
  compose exec -T "$SERVICE" sh -c 'curl -sf --max-time 5 "http://127.0.0.1:${OMB_PORT:-8799}/.well-known/openmausbot/environment"' 2>/dev/null \
    | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}
# `openmausbot doctor`: the server answers and at least one engine can start a bot.
engine_ready() { compose exec -T "$SERVICE" openmausbot doctor ${1:+--wait "$1"} >/dev/null 2>&1; }
caddy_runs() { compose ps --status running --services 2>/dev/null | grep -qx caddy; }
last_words() { compose logs --no-color --no-log-prefix --tail 40 "$SERVICE" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -n 1 | cut -c 1-300; }

# The server runs image $1, answers /api/health three times in a row, and (with $2) says it is version $2. Sets WHY.
wait_healthy() {
  local want=$1 version=${2:-} deadline=$(($(date +%s) + WAIT_S)) streak=0 cid state status restarts image said
  WHY=""
  while :; do
    cid=$(container)
    if [ -z "$cid" ]; then WHY="its container is gone"; return 1; fi
    state=$(inspect '{{.State.Status}} {{.RestartCount}} {{.Image}}' "$cid")
    status=${state%% *}
    restarts=$(printf '%s' "$state" | cut -d' ' -f2)
    image=${state##* }
    if [ "$image" != "$want" ]; then WHY="the server is not running the image it should"; return 1; fi
    case "$status" in
      exited | dead) WHY="it stopped as it started ($(last_words))"; return 1 ;;
    esac
    if [ "${restarts:-0}" -ge 3 ] 2>/dev/null; then WHY="it kept stopping as it started ($(last_words))"; return 1; fi
    if [ "$status" = running ] && answers; then streak=$((streak + 1)); else streak=0; fi
    [ "$streak" -ge 3 ] && break
    if [ "$(date +%s)" -ge "$deadline" ]; then WHY="it did not answer within $WAIT_S seconds"; return 1; fi
    sleep "$POLL_S"
  done
  if [ -n "$version" ]; then
    said=$(reported_version)
    if [ "$said" != "$version" ]; then WHY="it says it is version ${said:-unknown}, not $version"; return 1; fi
  fi
}
# What worked before the update still works: an engine that could start a bot, and Caddy in front.
wait_whole() {
  local tries=0
  if [ "$J_engine" = ready ] && ! engine_ready 2m; then WHY="no engine can start a bot on it, and one could before"; return 1; fi
  if [ "$J_caddy" = running ]; then
    until caddy_runs; do
      tries=$((tries + 1))
      if [ "$tries" -ge 12 ]; then WHY="Caddy, which serves it to the internet, did not start again"; return 1; fi
      sleep "$POLL_S"
    done
  fi
}

finish() {
  cp "$JOURNAL" "$LAST.tmp" && mv "$LAST.tmp" "$LAST"
  rm -f "$JOURNAL"
  say "Updated from $(old_name) to $(new_name)."
  say "The data from before the update is kept in the Docker volume $J_backup until the next update."
  say "To go back to it: ./update.sh --rollback"
}

# Puts back the settings, the data and the image from before the update, then says what happened and exits.
roll_back() { # why, exit code when the old version is back
  local why=$1 code=$2 helper_image=$J_previous_id restored=yes back=no
  trap '' INT TERM
  phase rollback
  say "$why"
  say "Putting back the version and the data from before the update…"
  compose stop >/dev/null 2>&1
  restore_env
  if docker volume inspect "$J_backup" >/dev/null 2>&1; then
    put_back "$J_backup" "$J_data" "$helper_image" >>"$LOG" 2>&1 || restored=no
  else
    restored=missing
  fi
  compose up -d --no-build >>"$LOG" 2>&1
  if [ "$(inspect '{{.Image}}' "$(container)")" != "$J_previous_id" ]; then
    # .env named a tag that has moved since: the image kept aside at the swap is the one that ran.
    pin_image "$KEEP_TAG"
    compose up -d --no-build >>"$LOG" 2>&1
  fi
  if wait_healthy "$J_previous_id"; then back=yes; fi
  rm -f "$JOURNAL" "$LAST"
  if [ "$restored" = missing ]; then
    say "The copy of the data from before the update ($J_backup) is missing, so the data was left as it is. The server runs $(old_name) again."
    exit 2
  fi
  if [ "$restored" = no ]; then
    say "The data could not be put back from the Docker volume $J_backup (see $LOG). That volume still holds it. Do not run another update before the data is back."
    exit 2
  fi
  if [ "$back" = no ]; then
    say "$(old_name) and its data are back, but it did not become healthy either ($WHY). See: docker compose logs $SERVICE"
    exit 2
  fi
  say "Your server runs $(old_name) again, with its data as it was before the update."
  exit "$code"
}

# Finishes an update that was cut short. `signal`: this run was interrupted; otherwise an earlier one was.
recover() {
  local how=${1:-}
  read_record "$JOURNAL" || return 0
  case "$J_phase" in
    pull)
      rm -f "$JOURNAL"
      [ -n "$how" ] && say "Stopped before anything was changed."
      ;;
    backup)
      docker volume rm -f "$J_backup" >/dev/null 2>&1
      [ "$J_running" = yes ] && compose up -d --no-build >>"$LOG" 2>&1
      rm -f "$JOURNAL"
      say "The update stopped while it copied the data aside. Nothing was changed, and the server was started again."
      ;;
    wait)
      if [ -z "$how" ] && WAIT_S=60 wait_healthy "$J_target_id" "$J_version" && wait_whole; then
        say "The last update was interrupted after the new version had started, and it is healthy."
        finish
        return 0
      fi
      roll_back "The update to $(new_name) was interrupted before the new version proved healthy." 1
      ;;
    swap | rollback)
      roll_back "The update to $(new_name) was interrupted." 1
      ;;
    *) rm -f "$JOURNAL" ;;
  esac
}
interrupted() {
  trap '' INT TERM
  say ""
  say "Interrupted."
  recover signal
  exit 130
}

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

MODE=update WANT_VERSION="" WANT_IMAGE="" ASSUME_YES=no REPLACE_BUILD=no
while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || usage 4; WANT_VERSION=${2#v}; shift ;;
    --image) [ $# -ge 2 ] || usage 4; WANT_IMAGE=$2; shift ;;
    --dir) [ $# -ge 2 ] || usage 4; shift ;;
    --check) MODE=check ;;
    --rollback) MODE=rollback ;;
    --yes | -y) ASSUME_YES=yes ;;
    --replace-local-build) REPLACE_BUILD=yes ;;
    -h | --help) usage 0 ;;
    *) printf 'Unknown option: %s\n\n' "$1"; usage 4 ;;
  esac
  shift
done
if [ -n "$WANT_VERSION" ] && ! printf '%s' "$WANT_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then refuse "--version takes a released version such as 0.1.151."; fi

docker compose version >/dev/null 2>&1 || refuse "This needs Docker with the Compose plugin (docker compose version)."
[ -f docker-compose.yml ] || [ -f compose.yaml ] || [ -n "${COMPOSE_FILE:-}" ] || refuse "There is no docker-compose.yml or compose.yaml in $DIR. Name the install's folder: ./update.sh --dir PATH"

if [ "$MODE" != check ]; then
  take_lock
  trap interrupted INT TERM
  recover
fi

if [ "$MODE" = rollback ]; then
  read_record "$LAST" || refuse "There is no earlier update to go back from."
  if [ "$ASSUME_YES" != yes ]; then
    printf '%s\n' "This puts back $(old_name) and the data as it was before the last update."
    printf '%s' "Everything made since then (chats, files, settings) is lost. Type yes to go on: "
    read -r answer
    [ "$answer" = yes ] || refuse "Nothing was changed."
  fi
  roll_back "Going back, as asked." 0
fi

CID=$(container)
[ -n "$CID" ] || refuse "This install has no server yet. Start it once first: docker compose up -d"
J_previous_id=$(inspect '{{.Image}}' "$CID")
J_previous=$(published_ref "$J_previous_id")
J_previous_version=$(image_version "$J_previous_id")
J_data=$(inspect '{{range .Mounts}}{{if eq .Destination "/data"}}{{if eq .Type "volume"}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' "$CID")
PROJECT=$(inspect '{{index .Config.Labels "com.docker.compose.project"}}' "$CID")
J_backup="${PROJECT:-deploy}_data-before-update"
[ -n "$J_data" ] || refuse "The server's container has no /data volume, so its data cannot be copied aside. Nothing was changed."
if [ "$(inspect '{{.State.Running}}' "$CID")" = true ]; then J_running=yes; else J_running=no; fi

if [ -n "$WANT_IMAGE" ]; then
  J_target=$WANT_IMAGE
  J_version=""
elif [ -n "$WANT_VERSION" ]; then
  J_target="$REPO:v$WANT_VERSION"
  J_version=$WANT_VERSION
else
  if command -v curl >/dev/null 2>&1; then RECORD=$(curl -fsSL --max-time 20 "$STABLE_URL" 2>/dev/null)
  else RECORD=$(wget -qO- -T 20 "$STABLE_URL" 2>/dev/null); fi
  [ -n "${RECORD:-}" ] || refuse "Could not read the stable channel ($STABLE_URL). Nothing was changed. To name a version yourself: ./update.sh --version X.Y.Z"
  RECORD=$(printf '%s' "$RECORD" | tr -d '\n\r')
  J_target=$(printf '%s' "$RECORD" | sed -n 's/.*"image"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  J_version=$(printf '%s' "$RECORD" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9][0-9.]*\)".*/\1/p')
  printf '%s' "$J_target" | grep -Eq "$PINNED" || refuse "The stable channel names no image this script accepts. Nothing was changed."
fi

if [ "$MODE" = check ]; then
  printf '%s\n' "This server runs $(old_name)."
  if [ -n "$J_previous" ] && [ "$J_previous" = "$J_target" ]; then printf '%s\n' "That is the version asked for. Nothing to do."
  else printf '%s\n' "./update.sh would update it to $(new_name)."; fi
  exit 0
fi

if [ -z "$J_previous" ] && [ "$REPLACE_BUILD" != yes ]; then
  refuse "This server runs an image built on this machine (docker compose up --build), with whatever ENGINES you baked into it. To stay on your own build: git pull && docker compose up -d --build. To move to the published image instead: ./update.sh --replace-local-build"
fi

phase pull
say "Downloading $(new_name)…"
if ! docker pull -q "$J_target" >>"$LOG" 2>&1 && [ -z "$(image_id "$J_target")" ]; then
  rm -f "$JOURNAL"
  refuse "Could not download $J_target (see $LOG). Nothing was changed."
fi
J_target_id=$(image_id "$J_target")
case "$J_target" in
  *@sha256:*) ;;
  *) PUBLISHED=$(published_ref "$J_target_id"); [ -n "$PUBLISHED" ] && J_target=$PUBLISHED ;;
esac
[ -n "$J_version" ] || J_version=$(image_version "$J_target_id")

if [ "$J_target_id" = "$J_previous_id" ]; then
  rm -f "$JOURNAL"
  say "This server already runs $(new_name). Nothing to do."
  exit 0
fi
if ! OMB_IMAGE="$J_target" docker compose config 2>/dev/null | grep -qF "image: $J_target"; then
  rm -f "$JOURNAL"
  refuse "The Compose file in $DIR does not take its image from OMB_IMAGE. Get the current one (git pull, or run the installer again), then run this again. Nothing was changed."
fi
if ! room_for_copy "$J_data" "$J_previous_id"; then
  rm -f "$JOURNAL"
  refuse "There is not enough free disk for a copy of the data: it needs about $NEEDED_MB MB and $FREE_MB MB are free. Free some space, then run this again. Nothing was changed."
fi

J_engine=unknown
J_caddy=stopped
if [ "$J_running" = yes ]; then
  engine_ready && J_engine=ready
  caddy_runs && J_caddy=running
fi

phase backup
say "Stopping the server and copying its data aside…"
rm -f "$LAST"
compose stop >>"$LOG" 2>&1
if ! copy_aside "$J_data" "$J_backup" "$J_previous_id" >>"$LOG" 2>&1; then
  docker volume rm -f "$J_backup" >/dev/null 2>&1
  [ "$J_running" = yes ] && compose up -d --no-build >>"$LOG" 2>&1
  rm -f "$JOURNAL"
  refuse "Copying the data aside failed (see $LOG). Nothing was changed, and the server was started again."
fi
keep_env
docker tag "$J_previous_id" "$KEEP_TAG" >/dev/null 2>&1

phase swap
say "Starting $(new_name)…"
pin_image "$J_target"
# Where Caddy waits for a healthy server, `up` itself fails when the new version never gets there; the wait below
# then says why.
if ! compose up -d --no-build >>"$LOG" 2>&1 && [ "$(inspect '{{.Image}}' "$(container)")" != "$J_target_id" ]; then
  roll_back "Docker could not start $(new_name) (see $LOG)." 1
fi

phase wait
say "Waiting for it to answer and to be able to start bots…"
if ! wait_healthy "$J_target_id" "$J_version" || ! wait_whole; then
  roll_back "The update to $(new_name) did not work: $WHY." 1
fi
finish
