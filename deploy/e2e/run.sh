#!/usr/bin/env bash
# The server installer (deploy/install.sh) on a stock Ubuntu 24.04 host with Docker, run as a person runs it: the checks
# alone, then a real install of the published image, a second run, an uninstall that keeps the data, and an install on
# top of that data. The host has no domain of its own, so the DNS check is shown to fail and is then skipped, and no
# public certificate can be issued: the installer must say exactly that, with the server healthy behind Caddy. The name
# ends in .internal, for which Caddy issues a certificate of its own CA at once, so HTTPS through Caddy is checked too:
# after every way the server restarts without Caddy, and after the documented backup and restore.
# The files the installer places (update.sh, the sandbox's host preparation) come from this checkout. Where the image
# has the bots' sandbox (OMB_IMAGE=server) it must be on, required and holding: a bot cannot read config.json. With
# OMB_INSTALL_IMAGE set (the workflow builds this checkout's image and serves it from a registry on the runner), that
# image is installed instead of the published release, and at the end an install of the release before the sandbox
# (OLD_IMAGE) is updated to it with update.sh, as an existing server is: it keeps working, says the sandbox is off and
# how to turn it on, and the installer run again turns it on. Runs on Ubuntu 22.04 and 24.04.
#   OUT=<evidence folder> bash deploy/e2e/run.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${OUT:-$(mktemp -d)}
mkdir -p "$OUT"
DOMAIN=installer-e2e.internal
DIR=/opt/openmausbot
SETTINGS=(OMB_INSTALL_SKIP_DNS=1 OMB_INSTALL_HTTPS_WAIT_S=20 "OMB_INSTALL_SOURCE=file://$ROOT")
# The workflow's token, when it gives one, reaches the installer's lookup of the newest release (deploy/install.sh
# newest_release): api.github.com answers few reads without one from a runner's shared address. sudo keeps it out of the
# command line.
AS_ROOT=(sudo)
if [ -n "${OMB_INSTALL_GITHUB_TOKEN:-}" ]; then AS_ROOT=(sudo --preserve-env=OMB_INSTALL_GITHUB_TOKEN); fi
# Without a version asked for: what a person's later run is, which must keep the version update.sh pinned.
# Under umask 000, as a root shell may have it: what the installer makes must not take its modes from there.
UMASK_000=(sh -c "umask 000; exec sh \"\$0\" \"\$@\"")
PLAIN_INSTALL=("${AS_ROOT[@]}" env "${SETTINGS[@]}" "${UMASK_000[@]}" "$ROOT/deploy/install.sh")
if [ -n "${OMB_INSTALL_IMAGE:-}" ]; then SETTINGS+=("OMB_INSTALL_IMAGE=$OMB_INSTALL_IMAGE"); fi
INSTALL=("${AS_ROOT[@]}" env "${SETTINGS[@]}" "${UMASK_000[@]}" "$ROOT/deploy/install.sh")
box_check() { (cd "$DIR" && sudo docker compose exec -T omb node dist-server/bot-box/box-check.js --public=none "$@"); }
OLD_IMAGE=${OLD_IMAGE:-ghcr.io/milind-soni/openmausbot:v0.1.182}
OS_VERSION=$(sed -n 's/^VERSION_ID="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/os-release)
# The botSandbox field of /api/config, as an admin's session reads it (Settings shows it).
sandbox_status() {
  local code token
  code=$( (cd "$DIR" && sudo docker compose exec -T omb openmausbot pair --label e2e-sandbox) | grep -o 'code=[A-Z2-9-]*' | head -n 1 | cut -d= -f2)
  token=$( (cd "$DIR" && sudo docker compose exec -T omb curl -sf -X POST -H 'content-type: application/json' -d "{\"code\":\"$code\"}" http://127.0.0.1:8799/api/auth/pair) | jq -r .token)
  (cd "$DIR" && sudo docker compose exec -T omb curl -sf -H "authorization: Bearer $token" http://127.0.0.1:8799/api/config) | jq -c '.botSandbox'
}

as_root() { sudo "$@"; }
step() { printf '\n== %s\n' "$*"; }
fail() {
  printf 'FAILED: %s\n' "$*" >&2
  as_root docker compose --project-directory "$DIR" logs --tail 80 >"$OUT/compose.log" 2>&1 || true
  if [ -f "$DIR/compose.box.yaml" ]; then
    echo "the sandbox self-check, as it is now:"
    (cd "$DIR" && sudo docker compose exec -T omb node dist-server/bot-box/box-check.js --public=none 2>&1 | tee "$OUT/box-check-failed.txt" | head -c 6000) || true
    (cd "$DIR" && sudo docker compose logs omb 2>&1 | grep -E "bot box|server profile|local requests" | tail -n 10) || true
  fi
  exit 1
}
# HTTPS through Caddy, with its own CA's certificate: the server's health answers, and a request through Caddy is a
# remote one (it must pair), never a local one.
through_caddy() { # what happened
  local _
  for _ in $(seq 1 60); do
    if curl -sk --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" 2>/dev/null | grep -qx '{"app":"openmausbot"}' &&
      [ "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/bots")" = 403 ]; then
      echo "HTTPS through Caddy answers after: $1"
      return 0
    fi
    sleep 2
  done
  (cd "$DIR" && sudo docker compose ps) || true
  fail "HTTPS through Caddy did not come back after: $1"
}
healthy_again() {
  local _
  for _ in $(seq 1 60); do
    [ "$(sudo docker inspect --format '{{.State.Health.Status}}' "$(cd "$DIR" && sudo docker compose ps -q omb)" 2>/dev/null)" = healthy ] && return 0
    sleep 3
  done
  fail "the server did not become healthy again"
}
contains() { # file words what
  grep -qF -- "$2" "$1" || fail "$3: $(tail -n 20 "$1")"
}
# No certificate can be issued for a made-up name: the install must stop there, with the server up, and say so.
install_until_https() { # evidence-file [the install command, when not the usual one]
  local status=0 file=$1
  shift
  if [ $# = 0 ]; then set -- "${INSTALL[@]}"; fi
  set -- "$@" --domain "$DOMAIN"
  "$@" >"$file" 2>&1 || status=$?
  set -- "$file"
  cat "$1"
  [ "$status" = 1 ] || fail "the install exited $status, not 1"
  contains "$1" "MausBot is running, but https://$DOMAIN did not answer within 20 seconds" "the install did not end at the certificate"
  [ "$(sudo docker inspect --format '{{.State.Health.Status}}' "$(cd "$DIR" && sudo docker compose ps -q omb)")" = healthy ] || fail "the server is not healthy"
  (cd "$DIR" && sudo docker compose exec -T omb curl -sf http://127.0.0.1:8799/api/health) | grep -q openmausbot || fail "the server does not answer inside its container"
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: $DOMAIN" http://127.0.0.1/ | grep -qx 308 || fail "Caddy does not redirect port 80 to HTTPS"
  through_caddy "the install"
}

# The folders above the install, as the Update server button checks them (update-runner.sh): a fresh Ubuntu server has
# / and /opt root's and closed to others. A CI image may not; it is set as a server has it, never the check weakened.
prepare_like_a_server() {
  stat -c '%U:%G %a %n' / /opt /srv 2>/dev/null || true
  getfacl -p / /opt /srv 2>/dev/null || true
  for folder in / /opt /srv; do
    [ -d "$folder" ] || continue
    # A default ACL hands new folders under it modes no umask decides; a server has none.
    if getfacl -p "$folder" 2>/dev/null | grep -q '^default:'; then
      echo "CI host: $folder has a default ACL; removed, as on a server"
      sudo setfacl -b "$folder"
    fi
    if [ "$(stat -c %u "$folder")" != 0 ] || [ $((8#$(stat -c %a "$folder") & 8#022)) != 0 ]; then
      echo "CI host: $folder is $(stat -c '%U:%G %a' "$folder"); made root's and closed to others, as on a server"
      sudo chown root:root "$folder" && sudo chmod go-w "$folder"
    fi
  done
}
prepare_like_a_server
echo "host: Ubuntu $OS_VERSION, kernel $(uname -r)"
for f in /proc/sys/kernel/apparmor_restrict_unprivileged_userns /proc/sys/user/max_user_namespaces /proc/sys/kernel/unprivileged_userns_clone; do echo "$f: $(cat "$f" 2>/dev/null || echo absent)"; done
# As a stock Ubuntu 24.04 server has it; a CI runner may relax it. 22.04 has no such setting.
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=1; fi

step "the checks alone, with a name that points nowhere: one thing to fix, nothing changed"
status=0
containers_before=$(sudo docker ps -aq | sort)
"${AS_ROOT[@]}" sh "$ROOT/deploy/install.sh" --check --domain "$DOMAIN" >"$OUT/check.txt" 2>&1 || status=$?
cat "$OUT/check.txt"
[ "$status" = 1 ] || fail "--check exited $status, not 1"
[ "$(grep -c '^  FIX   ' "$OUT/check.txt")" = 1 ] || fail "--check found more than the DNS record to fix"
contains "$OUT/check.txt" "  FIX   $DOMAIN does not resolve yet." "--check did not name the DNS record"
for line in "operating system: Ubuntu $OS_VERSION" "processor: x86-64" "processor cores:" "memory:" "Docker:" "free disk:" "ports 80 and 443: free" "outbound:" "user namespaces: on" "bots' sandbox: AppArmor is on" "clock: right" "version:"; do
  contains "$OUT/check.txt" "  ok    $line" "--check did not pass: $line"
done
[ ! -e "$DIR" ] || fail "--check made $DIR"
[ "$(sudo docker ps -aq | sort)" = "$containers_before" ] || fail "--check started a container"

step "the checks pass once the DNS record is set aside"
"${INSTALL[@]}" --check --domain "$DOMAIN" | tee "$OUT/check-ready.txt"
contains "$OUT/check-ready.txt" "This server is ready for MausBot. Nothing was changed." "--check did not pass"

step "install: the server is healthy behind Caddy, on a pinned release, with its data in one folder"
install_until_https "$OUT/install.txt"
image=$(sudo sed -n 's/^OMB_IMAGE=//p' "$DIR/.env")
case "$image" in
  ghcr.io/milind-soni/openmausbot:stable | ghcr.io/milind-soni/openmausbot:v[0-9]*) ;;
  *) [ "$image" = "${OMB_INSTALL_IMAGE:-}" ] || fail "the install pinned $image" ;;
esac
[ "$(sudo stat -c %a "$DIR/.env")" = 600 ] || fail ".env is readable by others"
[ "$(sudo stat -c %a "$DIR/data")" = 700 ] || fail "the data folder is open to others"
[ "$(sudo stat -c %u "$DIR/data")" = "$(sudo docker run --rm --entrypoint id "$image" -u)" ] || fail "the data folder is not the server's own"
[ -n "$(sudo ls -A "$DIR/data")" ] || fail "the server did not write its data under $DIR/data"

step "the bots' sandbox: on and holding where the image has it, left out with a sentence where it does not"
if sudo grep -qx "COMPOSE_FILE=compose.yaml:compose.box.yaml" "$DIR/.env"; then
  contains "$OUT/install.txt" "The bots' sandbox is on: a bot cannot read the server's settings, keys or other bots' files." "the install did not say the sandbox is on"
  sudo cmp "$ROOT/deploy/box/compose.box.yaml" "$DIR/compose.box.yaml" || fail "the sandbox's Compose settings are not the repository's"
  sudo cmp "$ROOT/connector/profiles/seccomp-omb-home.json" /etc/mausbot/seccomp-omb-home.json || fail "the seccomp profile on the host is not the repository's"
  sudo grep -q '^omb-home-narrow ' /sys/kernel/security/apparmor/profiles || fail "the AppArmor profile is not loaded"
  container=$(cd "$DIR" && sudo docker compose ps -q omb)
  [ "$(sudo docker inspect -f '{{.AppArmorProfile}}' "$container")" = omb-home-narrow ] || fail "the server does not run under the sandbox's AppArmor profile"
  [ "$(sudo docker inspect -f '{{.HostConfig.Privileged}} {{json .HostConfig.CapAdd}}' "$container")" = "false null" ] || fail "the server was given privileges"
  (cd "$DIR" && sudo docker compose logs omb 2>&1) | grep -F "bot box: on (bubblewrap" || fail "the server did not start its bot box"
  sudo docker inspect -f '{{json .Config.Env}}' "$container" | grep -qF '"OMB_BOT_BOX=required"' || fail "the server was not told the sandbox is required"
  status=$(sandbox_status)
  echo "Settings shows: $status"
  jq -e '.state == "on" and .required == true' <<<"$status" >/dev/null || fail "Settings does not show the sandbox on and required: $status"
  # The installer has already judged every result (it stops on all but a few named ones); here, the ones this is about.
  checks=$(box_check || true)
  printf '%s\n' "$checks" >"$OUT/box-check.json"
  jq -e '.box == "bwrap" and ([.results[] | select(.ok) | .id] | index("config-hidden") != null and index("messages-db-hidden") != null)' <<<"$checks" >/dev/null || fail "the sandbox does not hide config.json: $checks"
  # The check has teeth: with the data folder's cover taken away, config.json is readable and the check says so.
  bound=$(box_check --mutate=bind-data || true)
  jq -e '.failed | index("config-hidden") != null' <<<"$bound" >/dev/null || fail "the self-check did not notice an uncovered data folder: $bound"
  echo "sandbox: $(jq -r '"\(.passed)/\(.total) checks passed"' <<<"$checks"); uncovered, it fails $(jq -c '.failed' <<<"$bound")"
  # One command confined as a bot's turn is, in this server's own layout: it runs, and cannot read a file in the
  # server's data folder that the server itself reads.
  confined() { (cd "$DIR" && sudo docker compose exec -T omb node dist-server/bot-box/box-check.js --exec -- "$@"); }
  (cd "$DIR" && sudo docker compose exec -T omb sh -c 'echo outside-canary > /data/.openmausbot/e2e-outside.txt')
  [ "$(confined /bin/echo confined-ran)" = confined-ran ] || fail "a confined command did not run"
  [ "$( (cd "$DIR" && sudo docker compose exec -T omb cat /data/.openmausbot/e2e-outside.txt) )" = outside-canary ] || fail "the server cannot read its own canary"
  if confined cat /data/.openmausbot/e2e-outside.txt; then fail "a confined command read the server's data folder"; fi
  if confined sh -c 'test -e /data/.openmausbot/messages.db || test -e /data/.openmausbot/config.json'; then fail "a confined command sees the server's database or settings"; fi
  (cd "$DIR" && sudo docker compose exec -T omb rm -f /data/.openmausbot/e2e-outside.txt)
  echo "a confined command runs, and cannot read the server's data folder"
else
  contains "$OUT/install.txt" "has no bots' sandbox yet." "the install neither turned the sandbox on nor said why not"
  echo "this image has no sandbox; the install said so"
fi

step "what the installer made has fixed modes, though it ran under umask 000"
getfacl -p /opt 2>/dev/null || true
for want in "755 $DIR" "644 $DIR/compose.yaml" "644 $DIR/Caddyfile" "600 $DIR/.env" "700 $DIR/data" "755 $DIR/caddy/data" "755 $DIR/caddy/config"; do
  [ "$(sudo stat -c '%a %n' "${want#* }")" = "$want" ] || fail "$(sudo stat -c '%a %n' "${want#* }"), not $want"
done
if [ -f "$DIR/update.sh" ]; then [ "$(sudo stat -c %a "$DIR/update.sh")" = 755 ] || fail "update.sh is $(sudo stat -c %a "$DIR/update.sh"), not 755"; fi
echo "the install's folder 755, its files 644 and 755, .env 600, data 700"

step "update.sh is placed as the repository has it"
if [ -f "$ROOT/deploy/update.sh" ]; then
  sudo cmp "$ROOT/deploy/update.sh" "$DIR/update.sh" || fail "update.sh was not placed"
  sudo test -x "$DIR/update.sh" || fail "update.sh cannot be run"
else
  sudo test ! -e "$DIR/update.sh" || fail "an update.sh appeared from nowhere"
  echo "this checkout has no deploy/update.sh; nothing to place"
fi

step "the Update server button: systemd watches for the server's request, which only the server's own folder takes"
if [ -f "$ROOT/deploy/update-runner.sh" ]; then
  systemctl is-enabled --quiet openmausbot-update.path || fail "the button's path unit is not enabled"
  sudo grep -qx "layout=installer" /var/lib/openmausbot-update/status/runner || fail "the runner did not say it is there"
  in_server() { (cd "$DIR" && sudo docker compose exec -T omb sh -c "$1"); }
  in_server 'test -w /run/omb-update/request' || fail "the server cannot leave a request"
  if in_server 'echo x > /run/omb-update/status/last' 2>/dev/null; then fail "the server can write the runner's status"; fi
  echo "the request folder is the server's, the status folder is read-only to it"
fi

step "HTTPS comes back by itself whenever the server restarts without Caddy"
# Caddy used to share the server's network, and stayed in the old, dead one after each of these, with 443 refused.
(cd "$DIR" && sudo docker compose restart >/dev/null 2>&1) && healthy_again && through_caddy "docker compose restart"
before=$(sudo docker inspect -f '{{.RestartCount}}' "$(cd "$DIR" && sudo docker compose ps -q omb)")
launcher=$(sudo docker top "$(cd "$DIR" && sudo docker compose ps -q omb)" -eo pid,args | awk '/server-launcher/ { print $1; exit }')
[ -n "$launcher" ] || fail "no server process to kill"
sudo kill -9 "$launcher"
sleep 5
healthy_again && through_caddy "kill -9 of the server process"
[ "$(sudo docker inspect -f '{{.RestartCount}}' "$(cd "$DIR" && sudo docker compose ps -q omb)")" -gt "$before" ] || fail "Docker did not restart the killed server"
(cd "$DIR" && sudo docker compose stop omb >/dev/null 2>&1 && sudo docker compose start omb >/dev/null 2>&1) && healthy_again && through_caddy "stop omb, then start omb"

step "the documented backup and restore, each with the whole project stopped and started"
echo before-backup | sudo tee "$DIR/data/e2e-backup" >/dev/null
# docs/deploy-vps.md, "Back up", with the installer: exactly as written there.
(cd /opt/openmausbot && sudo docker compose stop && sudo sh -c 'set -e; install -d -m 700 backups; f="backups/backup-$(date -u +%Y%m%dT%H%M%SZ).tgz"; (umask 077; tar --warning=no-file-ignored -czf "$f" data .env); chmod 600 "$f"'; sudo docker compose start) >"$OUT/backup.txt" 2>&1
archive=$(cd "$DIR" && sudo sh -c 'ls backups/backup-*.tgz' | head -n 1)
[ -n "$archive" ] || fail "the backup made no archive: $(cat "$OUT/backup.txt")"
grep -q "socket ignored" "$OUT/backup.txt" && fail "tar listed sockets: $(cat "$OUT/backup.txt")"
[ "$(sudo stat -c %a "$DIR/$archive")" = 600 ] || fail "the archive is readable by others"
[ "$(sudo stat -c %a "$DIR/backups")" = 700 ] || fail "the backups folder is open to others"
healthy_again && through_caddy "the backup"
echo after-backup | sudo tee "$DIR/data/e2e-backup" >/dev/null
(cd /opt/openmausbot && sudo docker compose stop && sudo sh -c "set -e; tar -tzf $archive data/ >/dev/null; rm -rf data.before-restore; mv data data.before-restore; tar -xzpf $archive data"; sudo docker compose start) >"$OUT/restore.txt" 2>&1
[ "$(sudo cat "$DIR/data/e2e-backup")" = before-backup ] || fail "the restore did not put the data back: $(cat "$OUT/restore.txt")"
[ "$(sudo stat -c '%u:%a' "$DIR/data")" = "$(sudo stat -c '%u:%a' "$DIR/data.before-restore")" ] || fail "the restore changed the data folder's owner or mode"
sudo rm -rf "$DIR/data.before-restore" "$DIR/$archive"
healthy_again && through_caddy "the restore"

step "the first admin's sign-in link, made the way the installer says"
(cd "$DIR" && sudo docker compose exec -T omb openmausbot pair --label "First admin") >"$OUT/pair.txt" 2>&1 || fail "pair failed: $(cat "$OUT/pair.txt")"
grep -q "https://$DOMAIN/pair#code=" "$OUT/pair.txt" || fail "pair printed no link for $DOMAIN"
rm -f "$OUT/pair.txt"

step "run again: the same server, the person's settings and data untouched"
echo "OMB_SERVER_NAME=Installer e2e" | sudo tee -a "$DIR/.env" >/dev/null
echo kept | sudo tee "$DIR/data/e2e-marker" >/dev/null
before=$(sudo stat -c '%u:%g:%a' "$DIR/data")
install_until_https "$OUT/again.txt"
sudo grep -qx "OMB_SERVER_NAME=Installer e2e" "$DIR/.env" || fail "the second run dropped a setting"
[ "$(sudo cat "$DIR/data/e2e-marker")" = kept ] || fail "the second run touched the data"
[ "$(sudo stat -c '%u:%g:%a' "$DIR/data")" = "$before" ] || fail "the second run changed the data folder"

step "a version pinned by digest, as update.sh pins it, survives a run of the installer"
pin=$(sudo docker image inspect -f '{{index .RepoDigests 0}}' "$image")
case "$pin" in *@sha256:*) ;; *) fail "the installed image has no digest: $pin" ;; esac
sudo sed -i "s|^OMB_IMAGE=.*|OMB_IMAGE=$pin|" "$DIR/.env"
install_until_https "$OUT/pinned.txt" "${PLAIN_INSTALL[@]}"
contains "$OUT/pinned.txt" "version: the one update.sh pinned here" "the installer did not keep the pin"
sudo grep -qx "OMB_IMAGE=$pin" "$DIR/.env" || fail "the installer overwrote the pinned version"

step "an install from before, with Caddy in the server's network, moves to the new layout when the installer runs"
sudo tee "$DIR/compose.yaml" >/dev/null <<'OLD'
name: openmausbot
services:
  omb:
    image: ${OMB_IMAGE:?run the installer again}
    restart: unless-stopped
    init: true
    shm_size: 512m
    volumes:
      - ./data:/data
    ports:
      - "80:80"
      - "443:443"
    environment:
      OMB_PORT: "8799"
      OMB_WEBHOOK_PORT: "8800"
      OMB_WEBHOOK_PUBLIC_URL: https://${DOMAIN}
      OMB_PUBLIC_URL: https://${DOMAIN}
      OMB_SERVER_NAME: ${OMB_SERVER_NAME:-${DOMAIN}}
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://127.0.0.1:8799/api/health | grep -q openmausbot"]
      interval: 30s
      timeout: 5s
      retries: 3
  caddy:
    image: caddy:2
    restart: unless-stopped
    network_mode: "service:omb"
    depends_on:
      omb:
        condition: service_healthy
    environment:
      DOMAIN: ${DOMAIN}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy/data:/data
      - ./caddy/config:/config
OLD
sudo sed -i 's#unix//run/openmausbot/hooks.sock#127.0.0.1:8800#; s#unix//run/openmausbot/http.sock#127.0.0.1:8799#' "$DIR/Caddyfile"
(cd "$DIR" && sudo docker compose up -d --remove-orphans >/dev/null 2>&1) && healthy_again
(cd "$DIR" && sudo docker compose restart >/dev/null 2>&1) && healthy_again
if curl -sk --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" >/dev/null 2>&1; then
  echo "(the layout from before happened to come back after this restart)"
else
  echo "the layout from before: HTTPS refused after docker compose restart, as found on a real server"
fi
install_until_https "$OUT/migrated.txt" "${PLAIN_INSTALL[@]}"
sudo grep -q network_mode "$DIR/compose.yaml" && fail "the run left Caddy in the server's network"
(cd "$DIR" && sudo docker compose restart >/dev/null 2>&1) && healthy_again && through_caddy "docker compose restart, once moved"

step "uninstall: the server stops, the data stays"
sudo sh "$ROOT/deploy/install.sh" --uninstall | tee "$OUT/uninstall.txt"
contains "$OUT/uninstall.txt" "Your data is kept in $DIR/data" "uninstall did not say where the data is"
[ -z "$(sudo docker ps -aq --filter label=com.docker.compose.project=openmausbot)" ] || fail "uninstall left a container"
[ "$(sudo cat "$DIR/data/e2e-marker")" = kept ] || fail "uninstall touched the data"

step "install again on the kept data"
"${INSTALL[@]}" >"$OUT/reinstall.txt" 2>&1 || true
cat "$OUT/reinstall.txt"
contains "$OUT/reinstall.txt" "MausBot is running, but https://$DOMAIN did not answer" "the reinstall did not come back up"
[ "$(sudo cat "$DIR/data/e2e-marker")" = kept ] || fail "the reinstall touched the data"

step "uninstall takes the host's preparation back"
sudo sh "$ROOT/deploy/install.sh" --uninstall | tee "$OUT/uninstall-again.txt"
if [ -n "${OMB_INSTALL_IMAGE:-}" ]; then
  [ ! -e /etc/mausbot/seccomp-omb-home.json ] || fail "uninstall left the sandbox's seccomp profile"
  [ ! -e /etc/apparmor.d/omb-home-narrow ] || fail "uninstall left the sandbox's AppArmor profile"
  if sudo grep -q '^omb-home-narrow ' /sys/kernel/security/apparmor/profiles; then fail "uninstall left the AppArmor profile loaded"; fi
  contains "$OUT/uninstall-again.txt" "The sandbox's profiles are removed from this server." "uninstall did not say it removed the profiles"
fi

if [ -n "${OMB_INSTALL_IMAGE:-}" ]; then
  step "an install from before the sandbox ($OLD_IMAGE), updated with update.sh to this version: it keeps working and says how to turn the sandbox on"
  sudo rm -rf "$DIR"
  BEFORE=("${AS_ROOT[@]}" env "${SETTINGS[@]}" "OMB_INSTALL_IMAGE=$OLD_IMAGE" "${UMASK_000[@]}" "$ROOT/deploy/install.sh")
  install_until_https "$OUT/before.txt" "${BEFORE[@]}"
  contains "$OUT/before.txt" "has no bots' sandbox yet." "the release before the sandbox was installed with it"
  if sudo grep -q '^COMPOSE_FILE=' "$DIR/.env"; then fail "an install without the sandbox names Compose files"; fi
  echo kept-through-update | sudo tee "$DIR/data/e2e-update-marker" >/dev/null
  status=0
  # shellcheck disable=SC2024 # the evidence file is the runner's, not root's
  sudo "$DIR/update.sh" --image "$OMB_INSTALL_IMAGE" --allow-older >"$OUT/update.txt" 2>&1 || status=$?
  cat "$OUT/update.txt"
  [ "$status" = 0 ] || fail "update.sh exited $status"
  healthy_again
  [ "$(sudo cat "$DIR/data/e2e-update-marker")" = kept-through-update ] || fail "the update lost the data"
  container=$(cd "$DIR" && sudo docker compose ps -q omb)
  sudo docker inspect -f '{{json .Config.Env}}' "$container" | grep -qF '"OMB_IMAGE=server"' || fail "the update did not start this version"
  (cd "$DIR" && sudo docker compose logs omb 2>&1) | grep -F "bot box: off (userns-refused): bots run beside the server" || fail "the updated server did not say its bots run without the sandbox"
  engines=$( (cd "$DIR" && sudo docker compose exec -T omb curl -sf http://127.0.0.1:8799/api/health/engines) )
  jq -e '.sandbox == null' <<<"$engines" >/dev/null || fail "the updated server refuses bots: $engines"
  status=$(sandbox_status)
  echo "Settings shows: $status"
  jq -e '.state == "off" and .reason == "userns-refused" and .required == false' <<<"$status" >/dev/null || fail "Settings does not show the sandbox off, with the reason: $status"
  through_caddy "the update"

  step "the command Settings names, the installer run again, turns the sandbox on and makes it required"
  install_until_https "$OUT/switch-on.txt"
  contains "$OUT/switch-on.txt" "The bots' sandbox is on: a bot cannot read the server's settings, keys or other bots' files." "the installer did not turn the sandbox on"
  sudo grep -qx "COMPOSE_FILE=compose.yaml:compose.box.yaml" "$DIR/.env" || fail "the installer did not add the sandbox's settings"
  status=$(sandbox_status)
  echo "Settings shows: $status"
  jq -e '.state == "on" and .required == true' <<<"$status" >/dev/null || fail "Settings does not show the sandbox on: $status"
  [ "$(sudo cat "$DIR/data/e2e-update-marker")" = kept-through-update ] || fail "turning the sandbox on touched the data"

  step "a new container for a sandboxed install, as update.sh's swap makes one, comes back required and on"
  (cd "$DIR" && sudo docker compose up -d --force-recreate omb >/dev/null 2>&1) && healthy_again
  status=$(sandbox_status)
  jq -e '.state == "on" and .required == true' <<<"$status" >/dev/null || fail "the sandbox did not survive an update: $status"
  sudo sh "$ROOT/deploy/install.sh" --uninstall >/dev/null
fi

printf '\nAll steps passed. Evidence: %s\n' "$OUT"
