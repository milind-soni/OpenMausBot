#!/usr/bin/env bash
# deploy/update.sh for real, on a host with Docker and nothing else running in it (CI, or a private docker:dind):
# a server on one released version, then --check, an update to a stable record naming the next release by digest, the
# same again (nothing to do), --rollback, an update to an image that never answers and damages the data (it must roll
# back and leave every file as it was), and an update killed with SIGKILL while it waits, finished by the next run.
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
if [ "$LAYOUT" = installer ]; then DIR=/opt/openmausbot DATA=/opt/openmausbot/data COPY=openmausbot_data-before-update
else DIR=/srv/openmausbot-e2e/deploy DATA=deploy_data COPY=deploy_data-before-update; fi
UPDATE=(bash "$ROOT/deploy/update.sh" --dir "$DIR")

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
# Every file of the data with its owner, mode and checksum. Read while the server is stopped.
manifest() { docker run --rm --network none --user 0:0 -v "$1:/d:ro" --entrypoint sh "$REPO:v$FROM" -c 'cd /d && find . -type f -print0 | sort -z | xargs -0 -r stat -c "%u:%g %a %n"; find . -type f -print0 | sort -z | xargs -0 -r sha256sum'; }

step "a $LAYOUT install on $FROM"
for old in /opt/openmausbot /srv/openmausbot-e2e/deploy; do
  if [ -d "$old" ]; then (cd "$old" && docker compose down -v) >/dev/null 2>&1; fi
done
docker volume rm -f "$COPY" >/dev/null 2>&1
rm -rf "$DIR" && mkdir -p "$DIR"
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
printf '{\n  "channel": "stable",\n  "version": "%s",\n  "image": "%s",\n  "history": [{ "version": "%s", "promotedAt": "2026-11-12T00:00:00.000Z" }]\n}\n' "$TO" "$STABLE" "$TO" >"$OUT/stable.json"
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
in_data 'cat /d/.openmausbot/e2e-sentinel.txt' | grep -q "written under $FROM" || fail "the data did not carry over"
[ "$(cd "$DIR" && docker compose ps --status running --services | sort | tr '\n' ' ')" = "caddy omb " ] || fail "caddy or omb is not running"
docker volume inspect "$COPY" >/dev/null || fail "no copy of the data"

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
manifest "$COPY" >"$OUT/5-copy.txt"
diff "$OUT/5-data-before.txt" "$OUT/5-copy.txt" >"$OUT/5-copy-vs-before.diff" || fail "the copy differs from the data before the update"
(cd "$DIR" && docker compose stop) >/dev/null 2>&1
manifest "$DATA" >"$OUT/5-data-after.txt"
diff "$OUT/5-data-before.txt" "$OUT/5-data-after.txt" >"$OUT/5-after-vs-before.diff"
echo "lines that differ once the old server has run again: $(grep -c '^[<>]' "$OUT/5-after-vs-before.diff")"
in_data 'grep -q "written under" /d/.openmausbot/e2e-sentinel.txt && test ! -e /d/.openmausbot/left-by-the-broken-version' || fail "the damage was not undone"
(cd "$DIR" && docker compose start) >/dev/null 2>&1
wait_version "$FROM" || fail "$FROM does not answer after the rollback"

step "6. an update killed while it waits is finished by the next run"
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
OMB_UPDATE_WAIT_S=45 "${UPDATE[@]}" | tee "$OUT/6-next-run.txt"
grep -q "Your server runs $FROM again, with its data as it was before the update." "$OUT/6-next-run.txt" || fail "the next run did not put the old version back"
[ "$(running_image)" = "$OLD_ID" ] || fail "after the recovery another image runs"
in_data 'grep -q "written under" /d/.openmausbot/e2e-sentinel.txt' || fail "after the recovery the data is damaged"
cmp -s "$DIR/.env" "$OUT/env.before" || fail "after the recovery .env differs"
cp "$DIR/.update/update.log" "$OUT/update.log"

(cd "$DIR" && docker compose down -v) >/dev/null 2>&1
docker volume rm -f "$COPY" >/dev/null 2>&1
docker image rm -f omb-e2e-broken:1 openmausbot-before-update:local >/dev/null 2>&1
step "ALL PASSED ($LAYOUT)"
