#!/usr/bin/env bash
# Updates this Docker Compose install to the stable version, with a way back:
#
#   ./update.sh                  the stable version (the newest release until a first version is made stable)
#   ./update.sh --version X.Y.Z  one released version
#   ./update.sh --check          say what would change, and change nothing
#   ./update.sh --rollback       put back the version and the data from before the last update (asks first; --yes)
#   ./update.sh --allow-older    go ahead when the version asked for is older than, or no newer than, the one running
#   ./update.sh --dir PATH       the install's folder, when it is not this one (the installer's: /opt/openmausbot)
#
# It runs on the server itself, beside docker-compose.yml, because a server cannot replace its own container. The steps
# are the ones the MausBot connector runs for a connected server (connector/src/home.ts `update`): download the new
# image by digest, stop the server and check that it stopped, copy its data into a new Docker volume and check the copy
# file by file, start the new image, and wait until it answers and can still start bots. When it does not, the old image
# and the copy are put back. The copy from the update before is removed only once the new copy has been checked.
#
# Each step is written to .update/journal before it starts. A closed terminal does not stop an update: it carries on,
# and says how it ended in .update/update.log. An update this run interrupts (Ctrl-C) is undone at once. One an earlier
# run left unfinished (a reboot, a kill) is kept when its new version is healthy; otherwise the next run asks before it
# puts the old data back, and says what that loses.
#
# Exit codes, the same ones the connector's update runner reads (connector/host/mausbot-update-runner.sh):
#   0    done, or nothing to do
#   1    the update failed, and the old version and its data are back
#   2    the old version or its data could not be brought back: see what it said; ./update.sh --rollback tries again
#   3    another update is running here
#   4    nothing was changed: refused, could not download, the folder cannot be written, or a question was not answered
#   5    nothing was changed: the version asked for is older than the one running, or either version cannot be told
#   130  interrupted (Ctrl-C) before the new version started: nothing was changed, and the server was started again
set -uo pipefail
# An SSH session that drops sends SIGHUP, and a `| tee` that dies with it would send SIGPIPE: neither may stop an
# update half-way. Output to a terminal that has gone is lost; .update/update.log keeps it.
trap '' HUP PIPE

REPO="ghcr.io/milind-soni/openmausbot"
PINNED="^ghcr\.io/milind-soni/openmausbot@sha256:[0-9a-f]{64}$"
STABLE_URL=${OMB_STABLE_URL:-https://raw.githubusercontent.com/milind-soni/OpenMausBot/channels/stable.json}
NEWEST_URL=${OMB_NEWEST_URL:-https://api.github.com/repos/milind-soni/OpenMausBot/releases/latest}
SERVICE=${OMB_UPDATE_SERVICE:-omb}
# A healthy server answers within seconds of starting; two minutes leaves room for a slow first start after an update,
# and is how long the server is down before a version that never answers is rolled back. OMB_UPDATE_WAIT_S for more.
WAIT_S=${OMB_UPDATE_WAIT_S:-120}
ENGINE_WAIT_S=${OMB_UPDATE_ENGINE_WAIT_S:-120}
POLL_S=${OMB_UPDATE_POLL_S:-5}
KEEP_TAG="openmausbot-before-update:local"
BACKUP_ROLE="com.mausbot.role=update-backup"

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
# The answers to its questions are read from fd 4, and nothing else this script starts sees them: `docker compose exec`
# forwards its standard input to the container and would swallow a `yes` typed or piped ahead of the question.
exec 4<&0 </dev/null
say() {
  printf '%s\n' "$*" >&3 2>/dev/null
  if [ -d "$STATE" ]; then printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG" 2>/dev/null; fi
  return 0
}
refuse() {
  say "$*"
  exit 4
}
# What was typed after `question`, or nothing when there is no one to answer (no terminal, end of input).
ask() {
  local answer=""
  printf '%s' "$1" >&3 2>/dev/null
  read -r answer <&4 || answer=""
  # A terminal echoes the Enter that ends the answer; anything else does not.
  [ -t 4 ] || printf '\n' >&3 2>/dev/null
  printf '%s' "$answer"
}
compose() { docker compose "$@"; }
container() { compose ps -aq "$SERVICE" 2>/dev/null | head -n 1; }
inspect() { docker inspect -f "$1" "$2" 2>/dev/null; }
image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null; }
published_ref() { docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$1" 2>/dev/null | grep "^$REPO@" | head -n 1; }
# The released version an image is labelled with; nothing for a build of main, whose label is the branch.
image_version() { docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$1" 2>/dev/null | sed -n 's/^v\{0,1\}\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p'; }
name_of() { if [ -n "${2:-}" ]; then printf '%s' "$2"; else printf '%s' "$1" | sed 's/^.*sha256:\(.\{12\}\).*$/image \1/'; fi; }
old_name() { name_of "${J_previous:-$J_previous_id}" "$J_previous_version"; }
new_name() { name_of "$J_target" "$J_version"; }
is_version() { printf '%s' "$1" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+'; }
# True when version $1 is older than version $2 (both X.Y.Z).
older_than() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)" = "$1" ]; }

# The string value of a top-level key of the JSON object on stdin, when the object has that key exactly once and it is
# a string. Nested objects and arrays (a record's `history`) are stepped over, never matched.
json_top() {
  LC_ALL=C awk -v want="$1" '
    { text = text $0 "\n" }
    END {
      n = length(text)
      depth = 0
      expect = ""
      key = ""
      found = 0
      value = ""
      for (i = 1; i <= n; i++) {
        c = substr(text, i, 1)
        if (c == "\"") {
          start = i + 1
          for (i++; i <= n; i++) {
            c = substr(text, i, 1)
            if (c == "\\") i++
            else if (c == "\"") break
          }
          s = substr(text, start, i - start)
          if (depth == 1 && expect == "value") {
            if (key == want) { found++; value = s }
            expect = ""
          } else if (depth == 1) key = s
        } else if (c == ":") {
          if (depth == 1) expect = "value"
        } else if (c == "{" || c == "[") {
          if (depth == 1 && expect == "value") { if (key == want) found += 2; expect = "" }
          depth++
        } else if (c == "}" || c == "]") {
          depth--
        } else if (c == ",") {
          if (depth == 1) expect = ""
        } else if (c !~ /[ \t\r\n]/ && depth == 1 && expect == "value") {
          if (key == want) found += 2
          expect = ""
        }
      }
      if (found != 1) exit 1
      print value
    }'
}

# GET $1 into BODY. Returns 0 with the body, 1 when there is no such file (HTTP 404, or a file:// path that is not
# there), 2 when it could not be asked (no network, a timeout, any other answer).
fetch() {
  local url=$1 got code rc headers
  BODY=""
  if command -v curl >/dev/null 2>&1; then
    got=$(curl -sSL --max-time 20 -w '\n%{http_code}' "$url" 2>/dev/null)
    rc=$?
    code=${got##*$'\n'}
    BODY=${got%$'\n'*}
    case "$rc:$code" in
      0:200 | 0:000) return 0 ;;
      0:404 | 37:*) BODY=""; return 1 ;;
      *) BODY=""; return 2 ;;
    esac
  fi
  headers=$(mktemp) || return 2
  BODY=$(wget -S -T 20 -qO- "$url" 2>"$headers")
  rc=$?
  if [ "$rc" = 0 ]; then rm -f "$headers"; return 0; fi
  BODY=""
  if grep -q 'HTTP/[0-9.]* 404' "$headers"; then rm -f "$headers"; return 1; fi
  rm -f "$headers"
  return 2
}

# The journal: one `key=value` per line, written whole and renamed into place.
J_phase="" J_target="" J_target_id="" J_version="" J_previous="" J_previous_id="" J_previous_version=""
J_data="" J_backup="" J_engine="" J_caddy="" J_running="" J_started="" J_project=""
JOURNAL_KEYS="phase target target_id version previous previous_id previous_version data backup engine caddy running started project"
write_record() {
  local file=$1 key
  for key in $JOURNAL_KEYS; do eval "printf '%s=%s\n' \"$key\" \"\$J_$key\""; done >"$file.tmp" && mv "$file.tmp" "$file"
}
read_record() {
  local file=$1 key value
  [ -f "$file" ] || return 1
  # shellcheck disable=SC2034 # `value` is read by the eval
  while IFS='=' read -r key value; do
    case " $JOURNAL_KEYS " in *" $key "*) eval "J_$key=\$value" ;; esac
  done <"$file"
}
phase() {
  J_phase=$1
  write_record "$JOURNAL"
}

take_lock() {
  if ! mkdir -p "$STATE" 2>/dev/null || ! chmod 700 "$STATE" 2>/dev/null || [ ! -w "$STATE" ] || [ ! -w "$DIR" ]; then
    printf '%s\n' "$DIR cannot be written by this user, so the update could not keep its journal or change .env. Nothing was changed. Run it as the user who owns $DIR, or with sudo."
    exit 4
  fi
  if ! mkdir "$LOCK" 2>/dev/null; then
    local other
    other=$(cat "$LOCK/pid" 2>/dev/null || true)
    if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
      printf '%s\n' "An update is already running here (process $other). Wait for it to finish."
      exit 3
    fi
    rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || { printf '%s\n' "Another update took the lock in $LOCK just now. Wait for it to finish."; exit 3; }
  fi
  echo $$ >"$LOCK/pid"
  trap 'rm -rf "$LOCK"' EXIT
}

# Helpers run in a short-lived container from the server's own image, as root and without a network.
helper() { # image, then `-v` mounts as source:target[:ro], then `--` and the shell script
  local image=$1 mounts=()
  shift
  while [ "$1" != -- ]; do mounts+=(-v "$1"); shift; done
  shift
  docker run --rm --network none --user 0:0 --label com.mausbot.role=update-helper "${mounts[@]}" --entrypoint sh "$image" -c "$1"
}
# `same A B` succeeds when the two folders hold the same entries and every file has the same checksum.
VERIFY='manifest() { (cd "$1" && find . -print | LC_ALL=C sort && find . -type f -exec sha256sum {} + | LC_ALL=C sort); }
same() {
  a=$(manifest "$1" | sha256sum) && b=$(manifest "$2" | sha256sum) || return 1
  if [ "$a" != "$b" ]; then echo "the copy differs from the original"; return 1; fi
  echo "checked: $(cd "$2" && find . -print | wc -l) entries, every file by checksum"
}
'
# A new volume for the copy, named for this update, so the copy from the update before stays until this one is checked.
new_backup_name() {
  local base name at=1
  base="${J_project:-deploy}_data-before-update-$(date -u +%Y%m%dT%H%M%SZ)"
  name=$base
  while docker volume inspect "$name" >/dev/null 2>&1; do at=$((at + 1)); name="$base-$at"; done
  printf '%s' "$name"
}
make_backup_volume() { # name image
  docker volume create --label "$BACKUP_ROLE" --label "com.mausbot.project=$J_project" --label "com.mausbot.data=$J_data" --label "com.mausbot.image=$2" "$1" >/dev/null
}
copy_aside() { # data backup image: copy, then check the copy against the data, file by file
  docker run --rm --network none --user 0:0 --label com.mausbot.role=update-helper -v "$1:/from:ro" -v "$2:/to" --entrypoint cp "$3" -a /from/. /to/ || return 1
  helper "$3" "$1:/from:ro" "$2:/to:ro" -- "$VERIFY"'same /from /to'
}
# Every copy of this install's data but the one this update made: dropped once that one has been checked.
drop_older_copies() {
  local volume
  for volume in $(docker volume ls -q --filter "label=$BACKUP_ROLE" --filter "label=com.mausbot.data=$J_data" 2>/dev/null); do
    [ "$volume" = "$J_backup" ] || docker volume rm -f "$volume" >>"$LOG" 2>&1
  done
}
# Puts the copy back. The copy goes into a new folder in the data first and is checked there; only then are the data's
# entries swapped for it, by renames on one filesystem. A restore that fails before the swap leaves the data as it was.
put_back() { # backup data image
  helper "$3" "$1:/from:ro" "$2:/to" -- "$VERIFY"'set -u
stage=/to/.omb-restore
old=/to/.omb-replaced
rm -rf "$stage" "$old"
mkdir "$stage" || exit 1
if ! cp -a /from/. "$stage"/ || ! same /from "$stage"; then rm -rf "$stage"; exit 1; fi
mkdir "$old" || exit 1
find /to -mindepth 1 -maxdepth 1 ! -name .omb-restore ! -name .omb-replaced -exec mv {} "$old"/ \; || exit 1
find "$stage" -mindepth 1 -maxdepth 1 -exec mv {} /to/ \; || exit 1
rmdir "$stage" && rm -rf "$old"'
}
room_for_copy() { # data backup image → 0 when there is room where the copy goes, or when it cannot be measured
  local sizes used free
  # The copy lands in a Docker volume, under Docker's own folder, which for a bind-mounted data folder is another disk.
  sizes=$(helper "$3" "$1:/from:ro" "$2:/to" -- 'du -sk /from | cut -f1; df -Pk /to | tail -n 1 | tr -s " " | cut -d" " -f4' 2>/dev/null) || return 0
  used=$(printf '%s\n' "$sizes" | sed -n 1p)
  free=$(printf '%s\n' "$sizes" | sed -n 2p)
  case "$used$free" in '' | *[!0-9]*) return 0 ;; esac
  NEEDED_MB=$(((used + used / 10) / 1024 + 1024))
  FREE_MB=$((free / 1024))
  [ "$FREE_MB" -ge "$NEEDED_MB" ]
}

# After a rollback .env is exactly as it was, unless it named a tag that moves: the installer's `stable`, `latest`, or no
# image at all (the Compose file's `latest`). Such a tag may have moved since, and a later run of the installer or
# `docker compose pull` would follow it and undo the rollback, so the version that ran before is pinned by its digest
# instead. A digest or a released version's own tag (`:v0.1.150`) never moves, and stays as it was. A version built on
# this machine has no digest to pin.
pin_previous() {
  local named
  case "$J_previous" in "$REPO@sha256:"*) ;; *) return 0 ;; esac
  named=$(sed -n 's/^OMB_IMAGE=//p' .env 2>/dev/null | tail -n 1)
  case "$named" in
    *@sha256:* | *:v[0-9]*.[0-9]*.[0-9]*) return 0 ;;
  esac
  pin_image "$J_previous"
}
pin_image() { # writes OMB_IMAGE=<ref> into .env, keeping every other line and the file's mode
  local tmp="$DIR/.env.update.tmp"
  if [ -f .env ]; then cp -p .env "$tmp" && grep -v '^OMB_IMAGE=' .env >"$tmp"; else : >"$tmp" && chmod 600 "$tmp"; fi
  printf 'OMB_IMAGE=%s\n' "$1" >>"$tmp" && mv "$tmp" .env
}
keep_env() {
  rm -f "$STATE/env.before" "$STATE/env.absent" "$STATE/compose.yaml.before" "$STATE/Caddyfile.before"
  if [ -f .env ]; then cp -p .env "$STATE/env.before" && chmod 600 "$STATE/env.before"; else : >"$STATE/env.absent"; fi
}
# The settings go back with the data, and with them the installer's files when this update moved them.
restore_env() {
  if [ -f "$STATE/env.before" ]; then cp -p "$STATE/env.before" "$DIR/.env.update.tmp" && mv "$DIR/.env.update.tmp" .env
  elif [ -f "$STATE/env.absent" ]; then rm -f .env; fi
  local file
  for file in compose.yaml Caddyfile; do
    if [ -f "$STATE/$file.before" ]; then cp -p "$STATE/$file.before" "$DIR/$file.update.tmp" && mv "$DIR/$file.update.tmp" "$file"; fi
  done
}

# An install the installer (deploy/install.sh) made before Caddy got its own container. Caddy shared the server's
# network then, and stayed in the old, dead one whenever the server restarted without it: HTTPS refused while both
# containers looked healthy. The installer rewrites its own two files at every run; an update does the same, with the
# copies below, which are the installer's own (scripts/server-installer.test.ts keeps them equal).
INSTALLER_MARK="# Written by MausBot's installer (deploy/install.sh)"
old_installer_layout() { [ -f compose.yaml ] && grep -qF "$INSTALLER_MARK" compose.yaml && grep -q '^ *network_mode: "service:omb"' compose.yaml; }
# A Compose file of this repository's (path B) with Caddy in the server's network: `git pull` brings the current one.
old_repository_layout() { [ -f docker-compose.yml ] && grep -q '^ *network_mode: "service:omb"' docker-compose.yml; }
move_installer_layout() {
  cp -p compose.yaml "$STATE/compose.yaml.before" && cp -p Caddyfile "$STATE/Caddyfile.before" || return 1
  installer_compose >compose.yaml.update.tmp && mv compose.yaml.update.tmp compose.yaml &&
    installer_caddyfile >Caddyfile.update.tmp && mv Caddyfile.update.tmp Caddyfile
}
installer_compose() {
  cat <<'COMPOSE'
# Written by MausBot's installer (deploy/install.sh), and written again each time it runs: put your own settings in
# .env beside this file, which the installer keeps. The server only listens on loopback inside its container, and on
# two Unix sockets in the `edge` volume, which Caddy, in its own container, reaches it through. A request on a socket is
# always a remote one to the server. Caddy does not share the server's network: a server that restarted on its own came
# back in a new one, and left Caddy refusing HTTPS in the old one.
name: openmausbot
services:
  omb:
    image: ${OMB_IMAGE:?run the installer again}
    restart: unless-stopped
    init: true
    shm_size: 512m
    volumes:
      - ./data:/data
      - edge:/run/openmausbot
    environment:
      OMB_PORT: "8799"
      OMB_WEBHOOK_PORT: "8800"
      OMB_TUNNEL_SOCKET: /run/openmausbot/http.sock
      OMB_WEBHOOK_SOCKET: /run/openmausbot/hooks.sock
      OMB_WEBHOOK_PUBLIC_URL: https://${DOMAIN}
      OMB_PUBLIC_URL: https://${DOMAIN}
      OMB_SERVER_NAME: ${OMB_SERVER_NAME:-${DOMAIN}}
      # Passed only when .env sets them: an empty one would still be set, and Settings' own lists are used when not.
      OMB_SIGNIN_EMAILS:
      OMB_SIGNIN_MEMBER_EMAILS:
      OMB_SIGNIN_SMTP_URL:
      OMB_SIGNIN_SMTP_FROM:
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://127.0.0.1:8799/api/health | grep -q openmausbot"]
      interval: 30s
      timeout: 5s
      retries: 3

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    # Started with the server, not after it is healthy: Caddy reaches it over the socket
    # whenever it answers, so `up` never waits on the server's health.
    depends_on:
      omb:
        condition: service_started
    environment:
      DOMAIN: ${DOMAIN}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - edge:/run/openmausbot
      - ./caddy/data:/data
      - ./caddy/config:/config

volumes:
  # The two sockets: in memory, made afresh by the server at each start. Not under /data, which every bot's sandbox
  # sees; the sandbox has its own /run.
  edge:
    driver_opts:
      type: tmpfs
      device: tmpfs
      o: mode=1777,size=1m
COMPOSE
}
installer_caddyfile() {
  cat <<'CADDY'
{$DOMAIN} {
	encode zstd gzip

	# Webhook ingress is designed to be reachable by third parties (it has its
	# own per-hook secrets), so it sits outside any login. The path is passed
	# through unchanged: the receiver routes on /hooks/<id>.
	handle /hooks/* {
		reverse_proxy unix//run/openmausbot/hooks.sock
	}

	handle {
		# Optional second wall in front of pairing (a shared password):
		#   basic_auth {
		#     {$BASIC_AUTH_USER} {$BASIC_AUTH_HASH}
		#   }
		# and set both variables in .env (hash with `caddy hash-password`,
		# every `$` doubled for Compose).
		reverse_proxy unix//run/openmausbot/http.sock {
			# SSE: stream events as they arrive
			flush_interval -1
			# Compression is `encode`'s job above; the server would gzip its
			# JSON on its socket otherwise, as for the phone tunnel.
			header_up -Accept-Encoding
		}
	}
}
CADDY
}

# Stops the whole project and checks that the server's container is no longer running: no copy is taken of live data.
stop_server() {
  local cid
  compose stop >>"$LOG" 2>&1 || return 1
  cid=$(container)
  [ -z "$cid" ] || [ "$(inspect '{{.State.Running}}' "$cid")" = false ]
}

answers() { compose exec -T "$SERVICE" sh -c 'curl -sf --max-time 5 "http://127.0.0.1:${OMB_PORT:-8799}/api/health"' 2>/dev/null | grep -q openmausbot; }
reported_version() {
  compose exec -T "$SERVICE" sh -c 'curl -sf --max-time 5 "http://127.0.0.1:${OMB_PORT:-8799}/.well-known/openmausbot/environment"' 2>/dev/null | json_top version
}
# How many engines can start a bot, as the server counts them (GET /api/health/engines, which a hardened server answers
# a local caller without a session); nothing from a version without that count.
engine_count() {
  compose exec -T "$SERVICE" sh -c 'curl -sf --max-time 10 "http://127.0.0.1:${OMB_PORT:-8799}/api/health/engines"' 2>/dev/null |
    sed -n 's/.*"engines":\([0-9][0-9]*\).*/\1/p' | head -n 1
}
# At least one engine can start a bot, within $1 seconds: the server's count, or `openmausbot doctor` on a version that
# has no count (it needs the owner's trust, so on a hardened version without the count this cannot tell).
engine_ready() {
  local deadline=$(($(date +%s) + ${1:-0})) count
  while :; do
    count=$(engine_count)
    if [ -n "$count" ]; then
      [ "$count" -gt 0 ] && return 0
    elif compose exec -T "$SERVICE" openmausbot doctor >/dev/null 2>&1; then
      return 0
    fi
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep "$POLL_S"
  done
}
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
  if [ "$J_engine" = ready ] && ! engine_ready "$ENGINE_WAIT_S"; then WHY="no engine can start a bot on it, and one could before"; return 1; fi
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
  if old_repository_layout; then
    say "Note: this docker-compose.yml runs Caddy in the server's network, so HTTPS goes down whenever the server restarts without Caddy (a crash, docker compose restart). git pull brings the current one, then: docker compose up -d"
  fi
  say "The data from before the update is kept in the Docker volume $J_backup until the next update."
  say "To go back to it: ./update.sh --rollback"
}

# Puts back the settings, the data and the image from before the update, then says what happened and exits. The journal
# stays until the data is back, so a rollback that could not finish is tried again, never forgotten.
roll_back() { # why, exit code when the old version is back
  local why=$1 code=$2 helper_image=$J_previous_id back=no
  trap '' INT TERM
  phase rollback
  say "$why"
  say "Putting back the version and the data from before the update…"
  if ! stop_server; then
    say "The server could not be stopped (see $LOG), so its data was left as it is. The update's journal is kept: run ./update.sh --rollback again once docker compose stop works."
    exit 2
  fi
  if ! docker volume inspect "$J_backup" >/dev/null 2>&1; then
    restore_env
    pin_previous
    compose up -d --no-build >>"$LOG" 2>&1
    rm -f "$JOURNAL" "$LAST"
    say "The copy of the data from before the update ($J_backup) is missing, so the data was left as it is. The server runs $(old_name) again."
    exit 2
  fi
  # The settings go back with the data, never before it: an old version is not started on data a newer one left.
  if ! put_back "$J_backup" "$J_data" "$helper_image" >>"$LOG" 2>&1; then
    say "The data could not be put back from the Docker volume $J_backup (see $LOG). Neither was changed: the data is as $(new_name) left it, and the volume still holds the copy. The server is stopped."
    say "Once the cause is fixed (often disk space), ./update.sh --rollback tries again. To run the server on the data as it is instead: docker compose up -d (that starts $(new_name) again)."
    exit 2
  fi
  restore_env
  pin_previous
  compose up -d --no-build >>"$LOG" 2>&1
  if [ "$(inspect '{{.Image}}' "$(container)")" != "$J_previous_id" ]; then
    # .env named a tag that has moved since: the image kept aside at the swap is the one that ran.
    pin_image "$KEEP_TAG"
    compose up -d --no-build >>"$LOG" 2>&1
  fi
  if wait_healthy "$J_previous_id"; then back=yes; fi
  rm -f "$JOURNAL" "$LAST"
  if [ "$back" = no ]; then
    say "$(old_name) and its data are back, but it did not become healthy either ($WHY). See: docker compose logs $SERVICE"
    exit 2
  fi
  say "Your server runs $(old_name) again, with its data as it was before the update."
  exit "$code"
}

# An update an earlier run left in its swap, wait or rollback step. Kept when its new version is healthy; otherwise
# nothing happens to the data until someone who can see what it costs says so.
earlier_update() {
  local answer wait=60
  [ "$WAIT_S" -lt 60 ] 2>/dev/null && wait=$WAIT_S
  if [ "$J_phase" != rollback ] && [ "$MODE" != rollback ] && WAIT_S=$wait wait_healthy "$J_target_id" "$J_version" && wait_whole; then
    say "The last update was interrupted after the new version had started, and it is healthy."
    finish
    return 0
  fi
  if [ "$J_phase" = rollback ]; then
    say "An earlier update to $(new_name) was being undone, and putting its data back did not finish."
  elif [ "$MODE" = rollback ]; then
    say "An earlier update to $(new_name), started ${J_started:-earlier}, did not finish."
  else
    say "An earlier update to $(new_name), started ${J_started:-earlier}, did not finish, and $(new_name) is not healthy now ($WHY)."
  fi
  say "Going back puts $(old_name) and the data as it was at ${J_started:-that update} back, from the Docker volume $J_backup. Everything made on this server since then (chats, files, settings) is lost."
  if [ "$MODE" = rollback ] && [ "$ASSUME_YES" = yes ]; then
    answer=yes
  elif [ "$MODE" = rollback ]; then
    answer=$(ask "Type yes to go back: ")
  else
    answer=$(ask "Type yes to go back, or keep to leave the server as it is and forget that update: ")
  fi
  case "$MODE:$answer" in
    rollback:yes) roll_back "Going back, as asked." 0 ;;
    update:yes) roll_back "Going back, as asked." 1 ;;
    update:keep)
      cp "$JOURNAL" "$LAST.tmp" && mv "$LAST.tmp" "$LAST"
      rm -f "$JOURNAL"
      say "Left as it is. The copy from before that update stays in the Docker volume $J_backup; ./update.sh --rollback puts it back."
      ;;
    *) refuse "Nothing was changed. The unfinished update stays recorded in $JOURNAL, and the next ./update.sh asks again." ;;
  esac
}

# Finishes or undoes an update that was cut short. `signal`: this run was interrupted; otherwise an earlier one was.
recover() {
  local how=${1:-}
  read_record "$JOURNAL" || return 0
  case "$J_phase" in
    pull)
      # Only this update's own, new copy is removed; the copy from the update before is never touched here.
      [ -n "$J_backup" ] && docker volume rm -f "$J_backup" >/dev/null 2>&1
      rm -f "$JOURNAL"
      [ -n "$how" ] && say "Stopped before anything was changed."
      ;;
    backup)
      docker volume rm -f "$J_backup" >/dev/null 2>&1
      [ "$J_running" = yes ] && compose up -d --no-build >>"$LOG" 2>&1
      rm -f "$JOURNAL"
      say "The update stopped while it copied the data aside. Nothing was changed, and the server was started again."
      ;;
    swap | wait | rollback)
      if [ -n "$how" ]; then roll_back "The update to $(new_name) was interrupted." 1; fi
      earlier_update
      ;;
    *) rm -f "$JOURNAL" ;;
  esac
}
# Ctrl-C undoes only what this run started. While it looks at or asks about an earlier run's update, nothing changes.
THIS_RUN=no
interrupted() {
  trap '' INT TERM
  say ""
  say "Interrupted."
  if [ "$THIS_RUN" = yes ]; then recover signal; else say "Nothing was changed."; fi
  exit 130
}

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

MODE=update WANT_VERSION="" WANT_IMAGE="" ASSUME_YES=no REPLACE_BUILD=no ALLOW_OLDER=no
while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || usage 4; WANT_VERSION=${2#v}; shift ;;
    --image) [ $# -ge 2 ] || usage 4; WANT_IMAGE=$2; shift ;;
    --dir) [ $# -ge 2 ] || usage 4; shift ;;
    --check) MODE=check ;;
    --rollback) MODE=rollback ;;
    --yes | -y) ASSUME_YES=yes ;;
    --replace-local-build) REPLACE_BUILD=yes ;;
    --allow-older) ALLOW_OLDER=yes ;;
    -h | --help) usage 0 ;;
    *) printf 'Unknown option: %s\n\n' "$1"; usage 4 ;;
  esac
  shift
done
if [ -n "$WANT_VERSION" ] && ! is_version "$WANT_VERSION"; then refuse "--version takes a released version such as 0.1.151."; fi

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
    say "This puts back $(old_name) and the data as it was before the last update${J_started:+ (taken $J_started)}."
    [ "$(ask "Everything made since then (chats, files, settings) is lost. Type yes to go on: ")" = yes ] || refuse "Nothing was changed."
  fi
  roll_back "Going back, as asked." 0
fi

# A fresh record for this update: nothing of a journal read above carries over.
J_phase="" J_target="" J_target_id="" J_version="" J_engine="" J_caddy="" J_started=""
CID=$(container)
[ -n "$CID" ] || refuse "This install has no server yet. Start it once first: docker compose up -d"
J_previous_id=$(inspect '{{.Image}}' "$CID")
J_previous=$(published_ref "$J_previous_id")
J_previous_version=$(image_version "$J_previous_id")
J_data=$(inspect '{{range .Mounts}}{{if eq .Destination "/data"}}{{if eq .Type "volume"}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' "$CID")
J_project=$(inspect '{{index .Config.Labels "com.docker.compose.project"}}' "$CID")
[ -n "$J_data" ] || refuse "The server's container has no /data volume, so its data cannot be copied aside. Nothing was changed."
if [ "$(inspect '{{.State.Running}}' "$CID")" = true ]; then J_running=yes; else J_running=no; fi
# The version the server says it is decides what counts as older: a build of main (`latest`) is labelled with the
# branch, not a version, and says the version of the release it was built after.
RUNNING_VERSION=""
[ "$J_running" = yes ] && RUNNING_VERSION=$(reported_version)
is_version "$RUNNING_VERSION" || RUNNING_VERSION=$J_previous_version

CHANNEL=""
if [ -n "$WANT_IMAGE" ]; then
  J_target=$WANT_IMAGE
elif [ -n "$WANT_VERSION" ]; then
  J_target="$REPO:v$WANT_VERSION"
  J_version=$WANT_VERSION
else
  fetch "$STABLE_URL"
  case $? in
    0)
      CHANNEL=stable
      J_target=$(printf '%s' "$BODY" | json_top image)
      J_version=$(printf '%s' "$BODY" | json_top version)
      printf '%s' "$J_target" | grep -Eq "$PINNED" && is_version "$J_version" || refuse "The stable channel names no image this script accepts. Nothing was changed."
      ;;
    1)
      # No version has been made stable yet: the newest release, as the server's own update check says then.
      fetch "$NEWEST_URL" || refuse "Could not find the newest release ($NEWEST_URL). Nothing was changed. To name a version yourself: ./update.sh --version X.Y.Z"
      J_version=$(printf '%s' "$BODY" | json_top tag_name)
      J_version=${J_version#v}
      is_version "$J_version" || refuse "The newest release names no version this script accepts. Nothing was changed."
      CHANNEL=newest
      J_target="$REPO:v$J_version"
      ;;
    *) refuse "Could not read the stable channel ($STABLE_URL). Nothing was changed. To name a version yourself: ./update.sh --version X.Y.Z" ;;
  esac
fi

# Why the version asked for may not replace the one running without --allow-older, or nothing.
older_reason() {
  if [ -z "$J_version" ]; then
    printf '%s' "$J_target names no released version, so this cannot tell whether it is older than the version running."
  elif [ -z "$RUNNING_VERSION" ]; then
    printf '%s' "This cannot tell which version the server runs (it does not answer, and its image names no released version), so it cannot tell whether $J_version is older."
  elif older_than "$J_version" "$RUNNING_VERSION"; then
    printf '%s' "This server runs $RUNNING_VERSION, which is newer than $J_version. An older version may not read what a newer one wrote."
  elif [ "$J_version" = "$RUNNING_VERSION" ] && [ -z "$J_previous_version" ]; then
    printf '%s' "This server runs a build of main that says $RUNNING_VERSION, and may hold changes made after $J_version was released. It moves to stable by itself once a version newer than $RUNNING_VERSION is stable."
  fi
}

if [ "$MODE" = check ]; then
  [ -n "$J_version" ] || J_version=$(image_version "$J_target")
  if [ -n "$RUNNING_VERSION" ] && [ "$RUNNING_VERSION" != "$J_previous_version" ]; then printf '%s\n' "This server runs $(old_name), which says it is $RUNNING_VERSION."
  else printf '%s\n' "This server runs $(old_name)."; fi
  [ "$CHANNEL" = newest ] && printf '%s\n' "No version has been made stable yet, so ./update.sh takes the newest release, $J_version."
  [ -f "$JOURNAL" ] && printf '%s\n' "An earlier update did not finish. ./update.sh first says what it would cost to go back, and asks."
  if [ -n "$J_previous" ] && [ "$J_previous" = "$J_target" ]; then printf '%s\n' "That is the version asked for. Nothing to do."
  elif [ "$ALLOW_OLDER" != yes ] && [ -n "$(older_reason)" ]; then printf '%s\n' "$(older_reason)" "./update.sh would change nothing without --allow-older."
  else printf '%s\n' "./update.sh would update it to $(new_name)."; fi
  if old_installer_layout; then printf '%s\n' "It would also move Caddy to its own container: in the server's network, HTTPS goes down whenever the server restarts without it."
  elif old_repository_layout; then printf '%s\n' "This docker-compose.yml runs Caddy in the server's network, where HTTPS goes down whenever the server restarts without it: git pull brings the current one."; fi
  exit 0
fi

if [ -z "$J_previous" ] && [ "$REPLACE_BUILD" != yes ]; then
  refuse "This server runs an image built on this machine (docker compose up --build), with whatever ENGINES you baked into it. To stay on your own build: git pull && docker compose up -d --build. To move to the published image instead: ./update.sh --replace-local-build"
fi

J_backup=$(new_backup_name)
# Gives up before anything was changed: this update's journal and its own, new copy go; nothing else does.
BACKUP_MADE=no
abandon() {
  [ "$BACKUP_MADE" = yes ] && docker volume rm -f "$J_backup" >/dev/null 2>&1
  rm -f "$JOURNAL"
}
THIS_RUN=yes
phase pull
[ "$CHANNEL" = newest ] && say "No version has been made stable yet, so this takes the newest release, $J_version."
say "Downloading $(new_name)…"
if ! docker pull -q "$J_target" >>"$LOG" 2>&1 && [ -z "$(image_id "$J_target")" ]; then
  abandon
  refuse "Could not download $J_target (see $LOG). Nothing was changed."
fi
J_target_id=$(image_id "$J_target")
case "$J_target" in
  *@sha256:*) ;;
  *) PUBLISHED=$(published_ref "$J_target_id"); [ -n "$PUBLISHED" ] && J_target=$PUBLISHED ;;
esac
[ -n "$J_version" ] || J_version=$(image_version "$J_target_id")

if [ "$J_target_id" = "$J_previous_id" ]; then
  abandon
  say "This server already runs $(new_name). Nothing to do."
  exit 0
fi
if [ "$ALLOW_OLDER" != yes ] && [ -n "$(older_reason)" ]; then
  abandon
  say "$(older_reason)"
  say "Nothing was changed. To go ahead anyway, with the data copied first: ./update.sh --allow-older${WANT_VERSION:+ --version $WANT_VERSION}${WANT_IMAGE:+ --image $WANT_IMAGE}"
  exit 5
fi
if ! OMB_IMAGE="$J_target" docker compose config 2>/dev/null | grep -qF "image: $J_target"; then
  abandon
  refuse "The Compose file in $DIR does not take its image from OMB_IMAGE. Get the current one (git pull, or run the installer again), then run this again. Nothing was changed."
fi
BACKUP_MADE=yes
if ! make_backup_volume "$J_backup" "$J_previous_id" || ! room_for_copy "$J_data" "$J_backup" "$J_previous_id"; then
  abandon
  refuse "There is not enough free disk for a copy of the data: it needs about ${NEEDED_MB:-?} MB and ${FREE_MB:-?} MB are free. Free some space, then run this again. Nothing was changed."
fi

J_engine=unknown
J_caddy=stopped
if [ "$J_running" = yes ]; then
  engine_ready && J_engine=ready
  caddy_runs && J_caddy=running
fi

J_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
phase backup
say "Stopping the server and copying its data aside…"
copied=no
if stop_server; then
  if copy_aside "$J_data" "$J_backup" "$J_previous_id" >>"$LOG" 2>&1; then copied=yes; fi
  why="Copying the data aside failed, or the copy did not match the data (see $LOG)."
else
  why="The server could not be stopped (see $LOG), so its data was not copied."
fi
if [ "$copied" != yes ]; then
  docker volume rm -f "$J_backup" >/dev/null 2>&1
  [ "$J_running" = yes ] && compose up -d --no-build >>"$LOG" 2>&1
  rm -f "$JOURNAL"
  refuse "$why Nothing was changed, and the server was started again."
fi
keep_env
docker tag "$J_previous_id" "$KEEP_TAG" >/dev/null 2>&1

phase swap
# The new copy is checked, and from here on an interruption puts it back: the copy from the update before may go now,
# and with it the way back to that one.
rm -f "$LAST"
drop_older_copies
say "Starting $(new_name)…"
if old_installer_layout; then
  if move_installer_layout; then say "Caddy moves to its own container, so HTTPS stays up whenever the server restarts on its own."
  else roll_back "The installer's compose.yaml and Caddyfile could not be rewritten (see $LOG)." 1; fi
fi
pin_image "$J_target"
# Where Caddy waits for a healthy server (a Compose file from before Caddy had its own container), `up` itself waits,
# and fails when the new version never gets there; the wait below then says why. The current files start Caddy with
# the server, so `up` returns at once and the wait below is the only one.
if ! compose up -d --no-build >>"$LOG" 2>&1 && [ "$(inspect '{{.Image}}' "$(container)")" != "$J_target_id" ]; then
  roll_back "Docker could not start $(new_name) (see $LOG)." 1
fi

phase wait
say "Waiting for it to answer and to be able to start bots…"
if ! wait_healthy "$J_target_id" "$J_version" || ! wait_whole; then
  roll_back "The update to $(new_name) did not work: $WHY." 1
fi
finish
