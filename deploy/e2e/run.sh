#!/usr/bin/env bash
# The server installer (deploy/install.sh) on a stock Ubuntu 24.04 host with Docker, run as a person runs it: the checks
# alone, then a real install of the published image, a second run, an uninstall that keeps the data, and an install on
# top of that data. The host has no domain of its own, so the DNS check is shown to fail and is then skipped, and no
# certificate can be issued: the installer must say exactly that, with the server healthy behind Caddy.
#   OUT=<evidence folder> bash deploy/e2e/run.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${OUT:-$(mktemp -d)}
mkdir -p "$OUT"
DOMAIN=installer-e2e.invalid
DIR=/opt/openmausbot
INSTALL=(sudo env OMB_INSTALL_SKIP_DNS=1 OMB_INSTALL_HTTPS_WAIT_S=20 sh "$ROOT/deploy/install.sh")

as_root() { sudo "$@"; }
step() { printf '\n== %s\n' "$*"; }
fail() {
  printf 'FAILED: %s\n' "$*" >&2
  as_root docker compose --project-directory "$DIR" logs --tail 80 >"$OUT/compose.log" 2>&1 || true
  exit 1
}
contains() { # file words what
  grep -qF -- "$2" "$1" || fail "$3: $(tail -n 20 "$1")"
}
# No certificate can be issued for a made-up name: the install must stop there, with the server up, and say so.
install_until_https() { # evidence-file
  local status=0
  "${INSTALL[@]}" --domain "$DOMAIN" >"$1" 2>&1 || status=$?
  cat "$1"
  [ "$status" = 1 ] || fail "the install exited $status, not 1"
  contains "$1" "MausBot is running, but https://$DOMAIN did not answer within 20 seconds" "the install did not end at the certificate"
  [ "$(sudo docker inspect --format '{{.State.Health.Status}}' "$(cd "$DIR" && sudo docker compose ps -q omb)")" = healthy ] || fail "the server is not healthy"
  (cd "$DIR" && sudo docker compose exec -T omb curl -sf http://127.0.0.1:8799/api/health) | grep -q openmausbot || fail "the server does not answer inside its container"
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: $DOMAIN" http://127.0.0.1/ | grep -qx 308 || fail "Caddy does not redirect port 80 to HTTPS"
}

step "the checks alone, with a name that points nowhere: one thing to fix, nothing changed"
status=0
as_root sh "$ROOT/deploy/install.sh" --check --domain "$DOMAIN" >"$OUT/check.txt" 2>&1 || status=$?
cat "$OUT/check.txt"
[ "$status" = 1 ] || fail "--check exited $status, not 1"
[ "$(grep -c '^  FIX   ' "$OUT/check.txt")" = 1 ] || fail "--check found more than the DNS record to fix"
contains "$OUT/check.txt" "  FIX   $DOMAIN does not resolve yet." "--check did not name the DNS record"
for line in "operating system: Ubuntu 24.04" "processor: x86-64" "processor cores:" "memory:" "Docker:" "free disk:" "ports 80 and 443: free" "outbound:" "user namespaces: on" "clock: right" "version:"; do
  contains "$OUT/check.txt" "  ok    $line" "--check did not pass: $line"
done
[ ! -e "$DIR" ] || fail "--check made $DIR"
[ -z "$(sudo docker ps -aq)" ] || fail "--check started a container"

step "the checks pass once the DNS record is set aside"
sudo env OMB_INSTALL_SKIP_DNS=1 sh "$ROOT/deploy/install.sh" --check --domain "$DOMAIN" | tee "$OUT/check-ready.txt"
contains "$OUT/check-ready.txt" "This server is ready for MausBot. Nothing was changed." "--check did not pass"

step "install: the server is healthy behind Caddy, on a pinned release, with its data in one folder"
install_until_https "$OUT/install.txt"
image=$(sudo sed -n 's/^OMB_IMAGE=//p' "$DIR/.env")
case "$image" in
  ghcr.io/milind-soni/openmausbot:stable | ghcr.io/milind-soni/openmausbot:v[0-9]*) ;;
  *) fail "the install pinned $image" ;;
esac
[ "$(sudo stat -c %a "$DIR/.env")" = 600 ] || fail ".env is readable by others"
[ "$(sudo stat -c %a "$DIR/data")" = 700 ] || fail "the data folder is open to others"
[ "$(sudo stat -c %u "$DIR/data")" = "$(sudo docker run --rm --entrypoint id "$image" -u)" ] || fail "the data folder is not the server's own"
[ -n "$(sudo ls -A "$DIR/data")" ] || fail "the server did not write its data under $DIR/data"

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
