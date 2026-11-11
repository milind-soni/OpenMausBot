#!/usr/bin/env bash
# deploy/update.sh for real, on a host with Docker and nothing else running in it (CI, or a private docker:dind):
# a server on one released version, then --check, an update to a stable record (with a history of earlier versions)
# naming the next release by digest, the same again (nothing to do), --rollback, an update to an image that never
# answers and damages the data (it must roll back and leave every file as it was), an update killed with SIGKILL while
# it waits (the next run asks before it puts the data back), a rollback whose restore fails (data and copy untouched,
# tried again on request), an update whose terminal hangs up half-way (it finishes), a refused downgrade, and a
# `docker compose stop` that fails (no copy, nothing changed), and the Update server button (deploy/update-runner.sh
# under systemd): a request the server writes, carrying flags and another image, still runs only the standard update.
#   LAYOUT=installer  /opt/openmausbot with compose.yaml and a ./data folder, as deploy/install.sh lays it out
#   LAYOUT=checkout   a copy of deploy/ with docker-compose.yml and the named volume `data`
#   OUT=<evidence folder> LAYOUT=installer bash deploy/e2e/update.sh
# It removes whatever is in its install folder first. Nothing reaches a real server: the domain is made up.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${OUT:-$(mktemp -d)}
LAYOUT=${LAYOUT:-installer}
REPO=ghcr.io/milind-soni/openmausbot
FROM=${FROM_VERSION:-0.1.150}
TO=${TO_VERSION:-0.1.151}
mkdir -p "$OUT"
if [ "$LAYOUT" = installer ]; then DIR=/opt/openmausbot DATA=/opt/openmausbot/data
else DIR=/srv/openmausbot-e2e/deploy DATA=deploy_data; fi
# Under umask 000, as a root shell may have it: what update.sh writes must not take its modes from there.
UPDATE=(bash -c "umask 000; exec bash \"\$0\" \"\$@\"" "$ROOT/deploy/update.sh" --dir "$DIR")

step() { printf '\n== %s\n' "$*"; }
fail() {
  printf 'FAILED: %s\n' "$*"
  (cd "$DIR" && docker compose logs --tail 40 omb) >"$OUT/omb.log" 2>&1
  exit 1
}
running_image() { docker inspect -f '{{.Image}}' "$(cd "$DIR" && docker compose ps -q omb)"; }
version() { (cd "$DIR" && docker compose exec -T omb curl -sf http://127.0.0.1:8799/.well-known/openmausbot/environment) | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }
wait_version() { for _ in $(seq 1 60); do [ "$(version)" = "$1" ] && return 0; sleep 3; done; return 1; }
in_data() { docker run --rm --network none --user 0:0 -v "$DATA:/d" --entrypoint sh "$REPO:v$FROM" -c "$1"; }
# The copies of the data the updates made: one Docker volume each, and never more than one once an update is done.
copies() { docker volume ls -q --filter label=com.mausbot.role=update-backup; }
copy() {
  local found
  found=$(copies)
  [ "$(printf '%s\n' "$found" | grep -c .)" = 1 ] || fail "expected one copy of the data, found: $(printf '%s ' $found)"
  printf '%s' "$found"
}
# Every file of the data with its owner, mode and checksum. Read while the server is stopped.
manifest() { docker run --rm --network none --user 0:0 -v "$1:/d:ro" --entrypoint sh "$REPO:v$FROM" -c 'cd /d && find . -type f -print0 | sort -z | xargs -0 -r stat -c "%u:%g %a %n"; find . -type f -print0 | sort -z | xargs -0 -r sha256sum'; }

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
      setfacl -b "$folder"
    fi
    if [ "$(stat -c %u "$folder")" != 0 ] || [ $((8#$(stat -c %a "$folder") & 8#022)) != 0 ]; then
      echo "CI host: $folder is $(stat -c '%U:%G %a' "$folder"); made root's and closed to others, as on a server"
      chown root:root "$folder" && chmod go-w "$folder"
    fi
  done
}
prepare_like_a_server

step "a $LAYOUT install on $FROM"
for old in /opt/openmausbot /srv/openmausbot-e2e/deploy; do
  if [ -d "$old" ]; then (cd "$old" && docker compose down -v) >/dev/null 2>&1; fi
done
for volume in $(copies); do docker volume rm -f "$volume" >/dev/null 2>&1; done
rm -rf "$DIR" && install -d -m 755 "$(dirname "$DIR")" "$DIR"
docker pull -q "$REPO:v$FROM" >/dev/null && docker pull -q "$REPO:v$TO" >/dev/null || fail "could not pull the two releases"
if [ "$LAYOUT" = installer ]; then
  mkdir -p "$DIR/caddy/data" "$DIR/caddy/config"
  cp "$ROOT/deploy/Caddyfile" "$DIR/Caddyfile"
  cat >"$DIR/compose.yaml" <<'COMPOSE'
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
      OMB_PUBLIC_URL: https://${DOMAIN}
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
COMPOSE
  owner=$(docker run --rm --network none --entrypoint id "$REPO:v$FROM" -u)
  mkdir -m 700 "$DIR/data" && chown "$owner:$owner" "$DIR/data"
else
  cp "$ROOT/deploy/docker-compose.yml" "$ROOT/deploy/Caddyfile" "$DIR/"
fi
printf '%s\n' '# settings' 'DOMAIN=update-e2e.invalid' "OMB_IMAGE=$REPO:v$FROM" >"$DIR/.env" && chmod 600 "$DIR/.env"
(cd "$DIR" && docker compose up -d --no-build) >/dev/null 2>&1 || fail "compose up"
wait_version "$FROM" || fail "$FROM did not come up"
(cd "$DIR" && docker compose exec -T omb sh -c "echo 'written under $FROM' > /data/.openmausbot/e2e-sentinel.txt")
OLD_ID=$(running_image)
cp "$DIR/.env" "$OUT/env.before"
STABLE=$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$REPO:v$TO" | grep "^$REPO@" | head -n 1)
# As promote-stable.yml writes it: the history names older versions after the current one.
printf '{\n  "channel": "stable",\n  "version": "%s",\n  "image": "%s",\n  "history": [\n    { "version": "%s", "promotedAt": "2026-11-12T00:00:00.000Z" },\n    { "version": "%s", "promotedAt": "2026-11-05T00:00:00.000Z" },\n    { "version": "0.1.140", "promotedAt": "2026-10-01T00:00:00.000Z" }\n  ]\n}\n' "$TO" "$STABLE" "$TO" "$FROM" >"$OUT/stable.json"
export OMB_STABLE_URL="file://$OUT/stable.json"
echo "the stable record names $STABLE"

step "1. --check changes nothing"
"${UPDATE[@]}" --check | tee "$OUT/1-check.txt"
[ ! -e "$DIR/.update" ] || fail "--check wrote state"

step "2. update to the stable version"
"${UPDATE[@]}" | tee "$OUT/2-update.txt"
[ "${PIPESTATUS[0]}" = 0 ] || fail "the update did not exit 0"
[ "$(version)" = "$TO" ] || fail "the server says $(version)"
grep -qx "OMB_IMAGE=$STABLE" "$DIR/.env" || fail ".env is not pinned by digest"
[ "$(stat -c %a "$DIR/.env")" = 600 ] || fail ".env changed its mode"
[ "$(stat -c %a "$DIR/.update")" = 700 ] || fail ".update is $(stat -c %a "$DIR/.update"), not 700, though update.sh ran under umask 000"
in_data 'cat /d/.openmausbot/e2e-sentinel.txt' | grep -q "written under $FROM" || fail "the data did not carry over"
[ "$(cd "$DIR" && docker compose ps --status running --services | sort | tr '\n' ' ')" = "caddy omb " ] || fail "caddy or omb is not running"
copy >/dev/null || fail "expected one copy of the data"

step "3. the same again: nothing to do"
"${UPDATE[@]}" | tee "$OUT/3-again.txt"
grep -q "Nothing to do" "$OUT/3-again.txt" || fail "the second run did something"

step "4. --rollback puts $FROM and its data back"
(cd "$DIR" && docker compose exec -T omb sh -c "echo 'written under $TO' > /data/.openmausbot/after-update.txt")
"${UPDATE[@]}" --rollback --yes | tee "$OUT/4-rollback.txt"
[ "${PIPESTATUS[0]}" = 0 ] || fail "--rollback did not exit 0"
[ "$(version)" = "$FROM" ] || fail "after --rollback the server says $(version)"
[ "$(running_image)" = "$OLD_ID" ] || fail "after --rollback another image runs"
cmp -s "$DIR/.env" "$OUT/env.before" || fail "after --rollback .env differs"
in_data 'test ! -e /d/.openmausbot/after-update.txt' || fail "data written after the update survived the rollback"

step "5. a new version that never answers and damages the data: rolled back, every file as it was"
docker build -q -t omb-e2e-broken:1 - >/dev/null <<DOCKERFILE
FROM $REPO:v$TO
CMD ["sh", "-c", "echo damaged > /data/.openmausbot/e2e-sentinel.txt; rm -f /data/.openmausbot/bots.json; echo x > /data/.openmausbot/left-by-the-broken-version; exec sleep 100000"]
DOCKERFILE
# From a stopped server, so the data the update copies aside is exactly this manifest.
(cd "$DIR" && docker compose stop) >/dev/null 2>&1
manifest "$DATA" >"$OUT/5-data-before.txt"
echo "files before: $(($(wc -l <"$OUT/5-data-before.txt") / 2))"
OMB_UPDATE_WAIT_S=45 "${UPDATE[@]}" --image omb-e2e-broken:1 | tee "$OUT/5-failed-update.txt"
[ "${PIPESTATUS[0]}" = 1 ] || fail "the failed update did not exit 1"
grep -q "did not work: it did not answer within 45 seconds" "$OUT/5-failed-update.txt" || fail "no plain reason"
grep -q "Your server runs $FROM again, with its data as it was before the update." "$OUT/5-failed-update.txt" || fail "no plain outcome"
[ "$(running_image)" = "$OLD_ID" ] || fail "after the rollback another image runs"
cmp -s "$DIR/.env" "$OUT/env.before" || fail "after the rollback .env differs"
snapshot=$(copy) || fail "expected one copy of the data"
manifest "$snapshot" >"$OUT/5-copy.txt"
diff "$OUT/5-data-before.txt" "$OUT/5-copy.txt" >"$OUT/5-copy-vs-before.diff" || fail "the copy differs from the data before the update"
(cd "$DIR" && docker compose stop) >/dev/null 2>&1
manifest "$DATA" >"$OUT/5-data-after.txt"
diff "$OUT/5-data-before.txt" "$OUT/5-data-after.txt" >"$OUT/5-after-vs-before.diff"
echo "lines that differ once the old server has run again: $(grep -c '^[<>]' "$OUT/5-after-vs-before.diff")"
in_data 'grep -q "written under" /d/.openmausbot/e2e-sentinel.txt && test ! -e /d/.openmausbot/left-by-the-broken-version' || fail "the damage was not undone"
(cd "$DIR" && docker compose start) >/dev/null 2>&1
wait_version "$FROM" || fail "$FROM does not answer after the rollback"

step "6. an update killed while it waits: the next run asks, changes nothing unanswered, and puts the data back on yes"
OMB_UPDATE_WAIT_S=120 "${UPDATE[@]}" --image omb-e2e-broken:1 >"$OUT/6-killed.txt" 2>&1 &
pid=$!
for _ in $(seq 1 180); do grep -q "^phase=wait" "$DIR/.update/journal" 2>/dev/null && break; sleep 1; done
grep -q "^phase=wait" "$DIR/.update/journal" || fail "the update never reached its wait"
sleep 3
kill -9 "$pid"
wait "$pid" 2>/dev/null
cat "$OUT/6-killed.txt"
[ -f "$DIR/.update/journal" ] || fail "no journal after the kill"
in_data 'grep -qx damaged /d/.openmausbot/e2e-sentinel.txt && test -e /d/.openmausbot/left-by-the-broken-version' || fail "the broken version did not damage the data, so this proves nothing"
echo "the killed update left the broken version running on damaged data"
OMB_UPDATE_WAIT_S=45 "${UPDATE[@]}" </dev/null | tee "$OUT/6-unanswered.txt"
[ "${PIPESTATUS[0]}" = 4 ] || fail "a run nobody answered did not exit 4"
grep -q "Everything made on this server since then (chats, files, settings) is lost." "$OUT/6-unanswered.txt" || fail "the question does not say what is lost"
[ -f "$DIR/.update/journal" ] || fail "a run nobody answered dropped the journal"
in_data 'grep -qx damaged /d/.openmausbot/e2e-sentinel.txt' || fail "a run nobody answered changed the data"
printf 'yes\n' | OMB_UPDATE_WAIT_S=45 "${UPDATE[@]}" | tee "$OUT/6-next-run.txt"
grep -q "Your server runs $FROM again, with its data as it was before the update." "$OUT/6-next-run.txt" || fail "the next run did not put the old version back"
[ "$(running_image)" = "$OLD_ID" ] || fail "after the recovery another image runs"
in_data 'grep -q "written under" /d/.openmausbot/e2e-sentinel.txt' || fail "after the recovery the data is damaged"
cmp -s "$DIR/.env" "$OUT/env.before" || fail "after the recovery .env differs"

step "7. a rollback whose restore fails leaves the data and the copy alone, keeps the journal, and is tried again on request"
(cd "$DIR" && docker compose stop) >/dev/null 2>&1
manifest "$DATA" >"$OUT/7-data-before.txt"
OMB_UPDATE_WAIT_S=120 "${UPDATE[@]}" --image omb-e2e-broken:1 >"$OUT/7-failed-restore.txt" 2>&1 &
pid=$!
for _ in $(seq 1 180); do grep -q "^phase=wait" "$DIR/.update/journal" 2>/dev/null && break; sleep 1; done
grep -q "^phase=wait" "$DIR/.update/journal" || fail "the update never reached its wait"
# The restore runs in a helper from the old image: without it, putting the data back fails before it starts.
docker image rm -f "$OLD_ID" >/dev/null || fail "could not remove the old image"
wait "$pid"
code=$?
cat "$OUT/7-failed-restore.txt"
[ "$code" = 2 ] || fail "a rollback whose restore failed exited $code, not 2"
grep -q "Neither was changed" "$OUT/7-failed-restore.txt" || fail "no plain account of the failed restore"
[ -f "$DIR/.update/journal" ] || fail "the failed restore dropped the journal"
[ -z "$(cd "$DIR" && docker compose ps -q --status running omb)" ] || fail "a server was started on data that was not put back"
docker pull -q "$REPO:v$FROM" >/dev/null || fail "could not pull $FROM again"
in_data 'grep -qx damaged /d/.openmausbot/e2e-sentinel.txt && test ! -e /d/.omb-restore && test ! -e /d/.omb-replaced' || fail "the failed restore changed the data"
snapshot=$(copy) || fail "expected one copy of the data"
manifest "$snapshot" >"$OUT/7-copy.txt"
diff "$OUT/7-data-before.txt" "$OUT/7-copy.txt" >/dev/null || fail "the failed restore changed the copy"
OMB_UPDATE_WAIT_S=120 "${UPDATE[@]}" --rollback --yes | tee "$OUT/7-again.txt"
[ "${PIPESTATUS[0]}" = 0 ] || fail "--rollback after the failed restore did not exit 0"
[ "$(running_image)" = "$OLD_ID" ] || fail "after the second try another image runs"
in_data 'grep -q "written under" /d/.openmausbot/e2e-sentinel.txt' || fail "after the second try the data is damaged"
[ ! -f "$DIR/.update/journal" ] || fail "the journal outlived a finished rollback"

step "8. an update whose terminal hangs up half-way finishes"
"${UPDATE[@]}" >"$OUT/8-hangup.txt" 2>&1 &
pid=$!
for _ in $(seq 1 180); do grep -q "^phase=wait" "$DIR/.update/journal" 2>/dev/null && break; sleep 1; done
grep -q "^phase=wait" "$DIR/.update/journal" || fail "the update never reached its wait"
kill -HUP "$pid"
wait "$pid"
code=$?
cat "$OUT/8-hangup.txt"
[ "$code" = 0 ] || fail "the update exited $code after a hangup"
[ "$(version)" = "$TO" ] || fail "after the hangup the server says $(version)"
[ ! -f "$DIR/.update/journal" ] || fail "the hung-up update left its journal"

step "9. no older version without --allow-older"
"${UPDATE[@]}" --version "$FROM" | tee "$OUT/9-older.txt"
[ "${PIPESTATUS[0]}" = 5 ] || fail "going back to $FROM did not exit 5"
[ "$(version)" = "$TO" ] || fail "a refused downgrade changed the version"

step "10. when docker compose stop fails, no copy is taken and nothing changes"
# A stand-in for the docker CLI that refuses `compose stop` and passes everything else to the real one.
mkdir -p "$OUT/stop-fails"
printf '#!/bin/sh\nif [ "$1" = compose ] && [ "$2" = stop ]; then echo "e2e: compose stop refused" >&2; exit 1; fi\nexec %s "$@"\n' "$(command -v docker)" >"$OUT/stop-fails/docker"
chmod +x "$OUT/stop-fails/docker"
copies_before=$(copies)
cp "$DIR/.env" "$OUT/env.before-stop"
PATH="$OUT/stop-fails:$PATH" "${UPDATE[@]}" --image omb-e2e-broken:1 | tee "$OUT/10-stop-fails.txt"
[ "${PIPESTATUS[0]}" = 4 ] || fail "an update whose stop failed did not exit 4"
grep -q "The server could not be stopped" "$OUT/10-stop-fails.txt" || fail "no plain account of the failed stop"
[ "$(version)" = "$TO" ] || fail "after the failed stop the server says $(version)"
[ "$(copies)" = "$copies_before" ] || fail "a copy was taken or dropped although the server did not stop"
cmp -s "$DIR/.env" "$OUT/env.before-stop" || fail "after the failed stop .env differs"
[ ! -f "$DIR/.update/journal" ] || fail "the failed stop left a journal"
cp "$DIR/.update/update.log" "$OUT/update.log"

step "11. the Update server button: the server asks with a file, systemd runs the standard update, the outcome is written back"
"${UPDATE[@]}" --rollback --yes >"$OUT/11-back.txt" 2>&1 || fail "could not go back to $FROM for the button's run"
[ "$(version)" = "$FROM" ] || fail "not on $FROM before the button's run"
cp "$ROOT/deploy/update.sh" "$DIR/update.sh"
OMB_RUNNER_GAP_S=0 OMB_RUNNER_QUIET_S=0 bash "$ROOT/deploy/update-runner.sh" --install --dir "$DIR" | tee "$OUT/11-install.txt"
[ "${PIPESTATUS[0]}" = 0 ] || fail "update-runner.sh --install failed"
systemctl is-active --quiet openmausbot-update.path || fail "the path unit is not watching"
wait_version "$FROM" || fail "$FROM did not come back with the button's folders"
in_server() { (cd "$DIR" && docker compose exec -T omb sh -c "$1"); }
if in_server 'echo x > /run/omb-update/status/last' 2>/dev/null; then fail "the server can write the runner's status"; fi
# As a server that wants more than "update now" would: flags, an image of its choosing, an older version.
in_server "printf '%s\\n' --rollback --allow-older 'image=$REPO:v$FROM' 'version=0.1.1' > /run/omb-update/request/request" || fail "the server could not leave its request"
for _ in $(seq 1 120); do grep -qx 'state=done' /var/lib/openmausbot-update/status/last && grep -qx 'run=1' /var/lib/openmausbot-update/status/last && break; sleep 3; done
tee "$OUT/11-last.txt" </var/lib/openmausbot-update/status/last
grep -qx 'result=updated' /var/lib/openmausbot-update/status/last || fail "the button's update did not end as updated"
wait_version "$TO" || fail "after the button's update the server says $(version)"
grep -qx "OMB_IMAGE=$STABLE" "$DIR/.env" || fail "the button's update did not pin the stable image"
[ ! -e /var/lib/openmausbot-update/request/request ] || fail "the request was left behind"
journalctl -u openmausbot-update.service --no-pager >"$OUT/11-journal.txt" 2>&1 || true
bash "$ROOT/deploy/update-runner.sh" --remove --dir "$DIR" >/dev/null || fail "update-runner.sh --remove failed"
[ ! -e /etc/systemd/system/openmausbot-update.path ] || fail "--remove left the path unit"

(cd "$DIR" && docker compose down -v) >/dev/null 2>&1
for volume in $(copies); do docker volume rm -f "$volume" >/dev/null 2>&1; done
docker image rm -f omb-e2e-broken:1 openmausbot-before-update:local >/dev/null 2>&1
step "ALL PASSED ($LAYOUT)"
