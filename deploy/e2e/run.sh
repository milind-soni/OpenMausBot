#!/usr/bin/env bash
# The server installer (deploy/install.sh) on a stock Ubuntu 24.04 host with Docker, run as a person runs it: the checks
# alone, then a real install of the published image, a second run, an uninstall that keeps the data, and an install on
# top of that data. The host has no domain of its own, so the DNS check is shown to fail and is then skipped, and no
# public certificate can be issued: the installer must say exactly that, with the server healthy behind Caddy. The name
# ends in .internal, for which Caddy issues a certificate of its own CA at once, so HTTPS through Caddy is checked too:
# after every way the server restarts without Caddy, and after the documented backup and restore.
# The files the installer places (update.sh, the sandbox's host preparation) come from this checkout. Where the image
# runs the hardened profile the bots' sandbox must be on and hold: a bot cannot read config.json. With
# OMB_INSTALL_IMAGE set (the workflow builds this checkout's image and serves it from a registry on the runner), that
# image is installed instead of the published release.
#   OUT=<evidence folder> bash deploy/e2e/run.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${OUT:-$(mktemp -d)}
mkdir -p "$OUT"
DOMAIN=installer-e2e.internal
DIR=/opt/openmausbot
SETTINGS=(OMB_INSTALL_SKIP_DNS=1 OMB_INSTALL_HTTPS_WAIT_S=20 "OMB_INSTALL_SOURCE=file://$ROOT")
# Without a version asked for: what a person's later run is, which must keep the version update.sh pinned.
PLAIN_INSTALL=(sudo env "${SETTINGS[@]}" sh "$ROOT/deploy/install.sh")
if [ -n "${OMB_INSTALL_IMAGE:-}" ]; then SETTINGS+=("OMB_INSTALL_IMAGE=$OMB_INSTALL_IMAGE"); fi
INSTALL=(sudo env "${SETTINGS[@]}" sh "$ROOT/deploy/install.sh")
box_check() { (cd "$DIR" && sudo docker compose exec -T omb node dist-server/bot-box/box-check.js --public=none "$@"); }

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

step "the checks alone, with a name that points nowhere: one thing to fix, nothing changed"
status=0
containers_before=$(sudo docker ps -aq | sort)
as_root sh "$ROOT/deploy/install.sh" --check --domain "$DOMAIN" >"$OUT/check.txt" 2>&1 || status=$?
cat "$OUT/check.txt"
[ "$status" = 1 ] || fail "--check exited $status, not 1"
[ "$(grep -c '^  FIX   ' "$OUT/check.txt")" = 1 ] || fail "--check found more than the DNS record to fix"
contains "$OUT/check.txt" "  FIX   $DOMAIN does not resolve yet." "--check did not name the DNS record"
for line in "operating system: Ubuntu 24.04" "processor: x86-64" "processor cores:" "memory:" "Docker:" "free disk:" "ports 80 and 443: free" "outbound:" "user namespaces: on" "bots' sandbox: AppArmor is on" "clock: right" "version:"; do
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
  # The installer has already judged every result (it stops on all but a few named ones); here, the ones this is about.
  checks=$(box_check || true)
  printf '%s\n' "$checks" >"$OUT/box-check.json"
  jq -e '.box == "bwrap" and ([.results[] | select(.ok) | .id] | index("config-hidden") != null and index("messages-db-hidden") != null)' <<<"$checks" >/dev/null || fail "the sandbox does not hide config.json: $checks"
  # The check has teeth: with the data folder's cover taken away, config.json is readable and the check says so.
  bound=$(box_check --mutate=bind-data || true)
  jq -e '.failed | index("config-hidden") != null' <<<"$bound" >/dev/null || fail "the self-check did not notice an uncovered data folder: $bound"
  echo "sandbox: $(jq -r '"\(.passed)/\(.total) checks passed"' <<<"$checks"); uncovered, it fails $(jq -c '.failed' <<<"$bound")"
else
  contains "$OUT/install.txt" "has no bots' sandbox yet." "the install neither turned the sandbox on nor said why not"
  echo "this image has no sandbox; the install said so"
fi

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
  sudo grep -qx "layout=installer" "$DIR/server-update/status/runner" || fail "the runner did not say it is there"
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

printf '\nAll steps passed. Evidence: %s\n' "$OUT"
