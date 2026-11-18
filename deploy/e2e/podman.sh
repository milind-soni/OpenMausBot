#!/usr/bin/env bash
# The rootless Podman install (deploy/podman/install.sh) on a stock Ubuntu 24.04 host, as its own user runs it: install a
# published release as the user's systemd service, run it again, a bot turn with the repository's fake engine, Chrome in
# the server's container, a kill of the server and a restart of the user's systemd (what a boot does), the LAN switch and
# back, an update to the next release, an update that cannot start and is rolled back, and an uninstall that keeps the
# data. It also records whether the bots' sandbox (bubblewrap) can run in a rootless container, and with what.
# The files the installer places (update.sh) come from this checkout.
# ONLY ON A THROWAWAY HOST (a CI runner): it writes into this user's ~/.local/share/openmausbot and removes it at the
# end, and restarts this user's systemd. It refuses to start where a MausBot Podman install already exists, and anywhere
# but a CI runner (GITHUB_ACTIONS or CI set to true): it runs sudo.
#   OUT=<evidence folder> bash deploy/e2e/podman.sh
set -euo pipefail
if [ "${GITHUB_ACTIONS:-}" != true ] && [ "${CI:-}" != true ]; then
  echo "This changes the host with sudo (linger, subordinate ids, a restart of this user's systemd): it runs only on a CI runner, where GITHUB_ACTIONS or CI is true." >&2
  exit 2
fi
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${OUT:-$(mktemp -d)}
mkdir -p "$OUT"
REPO=ghcr.io/milind-soni/openmausbot
OLD_VERSION=${OMB_E2E_OLD_VERSION:-0.1.165}
NEW_VERSION=${OMB_E2E_NEW_VERSION:-0.1.166}
DIR="$HOME/.local/share/openmausbot"
UNIT="$HOME/.config/containers/systemd/openmausbot.container"
INSTALL=(env "OMB_INSTALL_SOURCE=file://$ROOT" sh "$ROOT/deploy/podman/install.sh")
FINDINGS="$OUT/findings.txt"
if [ -e "$DIR" ] || [ -e "$UNIT" ]; then
  echo "This user already has a MausBot Podman install ($DIR or $UNIT). This test replaces and removes it: run it on a throwaway host." >&2
  exit 2
fi
: >"$FINDINGS"

step() { printf '\n== %s\n' "$*"; }
finding() { printf '%s\n' "$*" | tee -a "$FINDINGS"; }
fail() {
  printf 'FAILED: %s\n' "$*" >&2
  journalctl --user -u openmausbot -n 120 --no-pager >"$OUT/journal.txt" 2>&1 || true
  tail -n 60 "$OUT/journal.txt" >&2 || true
  exit 1
}
contains() { # file words what
  grep -qF -- "$2" "$1" || fail "$3: $(tail -n 20 "$1")"
}
healthy() { curl -sf --max-time 5 "http://127.0.0.1:8799/api/health" 2>/dev/null | grep -q openmausbot; }
healthy_again() {
  local _
  for _ in $(seq 1 80); do
    healthy && return 0
    sleep 3
  done
  fail "the server did not answer again"
}
container_id() { podman inspect -f '{{.Id}}' openmausbot 2>/dev/null || true; }
in_server() { podman exec openmausbot "$@"; }

step "this host: rootless Podman, and systemd for this user without a login (linger, as a server has it)"
sudo loginctl enable-linger "$(id -un)"
XDG_RUNTIME_DIR="/run/user/$(id -u)"
export XDG_RUNTIME_DIR
for _ in $(seq 1 30); do [ -S "$XDG_RUNTIME_DIR/bus" ] && break; sleep 1; done
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
systemctl --user show-environment >/dev/null || fail "no systemd for this user"
if ! grep -q "^$(id -un):" /etc/subuid; then
  sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$(id -un)"
  podman system migrate
fi
podman version | tee "$OUT/podman-version.txt"
# What listens beyond loopback before MausBot: with the host's network, anything the server or Chrome opens is a host port.
outside() { ss -ltnH | awk '{ print $4 }' | grep -vE '^(127\.[0-9.]+|\[::1\]|\[::ffff:127\.[0-9.]+\]):[0-9]+$' | sort -u; }
outside >"$OUT/outside-before.txt"
new_outside() { outside | comm -13 "$OUT/outside-before.txt" -; }
finding "host: $(sed -n 's/^PRETTY_NAME=//p' /etc/os-release | tr -d '"'), kernel $(uname -r), $(uname -m), Podman $(podman version --format '{{.Client.Version}}'), $(podman info --format '{{.Host.NetworkBackend}} network, {{.Host.CgroupsVersion}}, rootless={{.Host.Security.Rootless}}')"
finding "host: kernel.apparmor_restrict_unprivileged_userns=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent)"

step "the repository's fake engine, wired into the data folder before the first start"
fake="$DIR/data/.openmausbot/fake-engine"
mkdir -p "$fake"
# The fake and every file of server/testing it imports, however that list grows (CI runs this on the merge with main).
copy_fake() {
  local dep
  if [ -e "$fake/$1" ]; then return 0; fi
  cp "$ROOT/server/testing/$1" "$fake/"
  { grep -o 'from "\./[A-Za-z0-9_-]*\.ts"' "$ROOT/server/testing/$1" || true; } | sed 's|^from "\./\(.*\)"$|\1|' >"$fake/.imports-$1"
  while read -r dep; do copy_fake "$dep"; done <"$fake/.imports-$1"
  rm -f "$fake/.imports-$1"
}
copy_fake fake-claude-cli.ts
chmod 755 "$fake/fake-claude-cli.ts"
cat >"$DIR/data/.openmausbot/config.json" <<'JSON'
{
  "features": { "smartSetupChoices": false },
  "instances": {
    "claude": { "driver": "claudeAgent", "displayName": "E2E fake engine", "config": { "cli": "/data/.openmausbot/fake-engine/fake-claude-cli.ts" } }
  }
}
JSON
chmod 700 "$DIR/data"

step "without linger the installer prints the one sudo line, and never runs sudo"
stubs=$(mktemp -d)
cat >"$stubs/loginctl" <<'STUB'
#!/bin/sh
if [ "$1" = show-user ]; then echo no; exit 0; fi
exec /usr/bin/loginctl "$@"
STUB
printf '#!/bin/sh\necho "sudo $*" >>"%s/sudo-called"\nexit 97\n' "$stubs" >"$stubs/sudo"
chmod 755 "$stubs/loginctl" "$stubs/sudo"
# Piped, as the one-line install runs it.
PATH="$stubs:$PATH" OMB_INSTALL_IMAGE="$REPO:v$OLD_VERSION" OMB_INSTALL_SOURCE="file://$ROOT" sh -s -- <"$ROOT/deploy/podman/install.sh" >"$OUT/install-no-linger.txt" 2>&1 || { cat "$OUT/install-no-linger.txt"; fail "the install without linger failed"; }
contains "$OUT/install-no-linger.txt" "  sudo loginctl enable-linger $(id -un)" "the install did not print the linger line"
[ ! -e "$stubs/sudo-called" ] || fail "the installer ran sudo: $(cat "$stubs/sudo-called")"
rm -rf "$stubs"
finding "linger: without it the installer printed 'sudo loginctl enable-linger $(id -un)' and ran no sudo"

step "install $OLD_VERSION as this user's service (run again, now with linger)"
OMB_INSTALL_IMAGE="$REPO:v$OLD_VERSION" "${INSTALL[@]}" >"$OUT/install.txt" 2>&1 || { cat "$OUT/install.txt"; fail "the install failed"; }
cat "$OUT/install.txt"
contains "$OUT/install.txt" "MausBot is running as your user's service (openmausbot), on http://127.0.0.1:8799." "the install did not finish"
contains "$OUT/install.txt" "It starts at boot, without anyone logged in." "the install did not see linger"
grep -q "^Image=$REPO@sha256:[0-9a-f]\{64\}$" "$UNIT" || fail "the unit does not pin the image by digest: $(grep '^Image=' "$UNIT")"
grep -q "^UserNS=keep-id:uid=[0-9]*,gid=[0-9]*$" "$UNIT" || fail "the unit does not map the image's user to this one"
cp "$UNIT" "$OUT/openmausbot.container"
/usr/libexec/podman/quadlet -dryrun -user >"$OUT/quadlet-dryrun.txt" 2>&1 || true
contains "$OUT/quadlet-dryrun.txt" "---openmausbot.service---" "quadlet did not make the service"
systemctl --user is-active --quiet openmausbot || fail "the service is not active"
healthy || fail "the server does not answer on 127.0.0.1:8799"
# The health check reads the port in the container when it runs (server.env's OMB_PORT): systemd made the unit's $$ one $.
health_test=$(podman inspect -f '{{json .Config.Healthcheck.Test}}' openmausbot)
# shellcheck disable=SC2016 # the literal text the check must hold
grep -qF '${OMB_PORT:-8799}/api/health' <<<"$health_test" || fail "the health check does not read OMB_PORT when it runs: $health_test"
# The mark the app knows this install by (its update command): the folder, as this user writes it.
# shellcheck disable=SC2016,SC2088 # read in the container; the ~ is text
[ "$(in_server sh -c 'printf %s "$OMB_PODMAN_SERVICE"')" = "~/.local/share/openmausbot" ] || fail "the server does not see OMB_PODMAN_SERVICE=~/.local/share/openmausbot"
ss -ltnH >"$OUT/listening.txt"
grep -q "127.0.0.1:8799 " "$OUT/listening.txt" || fail "nothing listens on 127.0.0.1:8799: $(cat "$OUT/listening.txt")"
[ -z "$(new_outside)" ] || fail "the server listens beyond this machine without --lan: $(new_outside)"
grep -q "127.0.0.1:8800 " "$OUT/listening.txt" || fail "the webhook port 8800 is not on loopback"
[ "$(stat -c %u "$DIR/data")" = "$(id -u)" ] || fail "the data folder is not this user's"
[ -z "$(find "$DIR/data" ! -user "$(id -u)" -print -quit)" ] || fail "the server wrote files that are not this user's on the host: $(find "$DIR/data" ! -user "$(id -u)" | head -n 5)"
{ [ "$(stat -c %a "$DIR/.env")" = 600 ] && [ "$(stat -c %a "$DIR/server.env")" = 600 ]; } || fail "the settings are readable by others"
{ [ -x "$DIR/update.sh" ] && cmp -s "$ROOT/deploy/update.sh" "$DIR/update.sh"; } || fail "update.sh was not placed"
finding "install: service active, 127.0.0.1:8799 only, image pinned by digest, data owned by the user on the host"

step "running it again changes nothing"
first=$(container_id)
"${INSTALL[@]}" >"$OUT/install-again.txt" 2>&1 || { cat "$OUT/install-again.txt"; fail "the second run failed"; }
contains "$OUT/install-again.txt" "the one already installed" "the second run did not keep the installed version"
[ "$(container_id)" = "$first" ] || fail "the second run restarted the server"
finding "idempotent: a second run kept the version and did not restart the server"

step "a bot turn with the fake engine"
in_server openmausbot new-bot Probe --json >"$OUT/new-bot.json" 2>"$OUT/new-bot.err" || { cat "$OUT/new-bot.json" "$OUT/new-bot.err"; fail "new-bot failed"; }
in_server openmausbot run Probe "hello from the podman e2e" --json --timeout 2m >"$OUT/run.json" 2>"$OUT/run.err" || { cat "$OUT/run.json" "$OUT/run.err"; fail "the turn failed"; }
contains "$OUT/run.json" "hello from fake claude" "the turn did not answer with the fake engine's reply"
finding "turn: new-bot + run answered \"hello from fake claude\" through the server in the rootless container"

step "Chrome in the server's container"
# agent-browser, run directly in the server's container, as a bot's browser call runs it.
python3 -m http.server 8765 --bind 127.0.0.1 --directory "$(mktemp -d)" >/dev/null 2>&1 &
page_server=$!
if in_server sh -c 'agent-browser open "data:text/html,<title>podman-e2e</title>" >/dev/null && agent-browser get title' >"$OUT/chrome.txt" 2>&1 &&
  grep -q podman-e2e "$OUT/chrome.txt"; then
  podman top openmausbot args | awk 'tolower($0) ~ /chrom/ && n < 3 { print; n++ }' >"$OUT/chrome-argv.txt" || true
  in_server agent-browser open http://127.0.0.1:8765/ >>"$OUT/chrome.txt" 2>&1 || fail "the browser did not load a page over http"
  [ -z "$(new_outside)" ] || fail "with Chrome open, something listens beyond this machine: $(new_outside)"
  in_server agent-browser close >/dev/null 2>&1 || true
  sandbox_flag=no
  if grep -q -- '--no-sandbox' "$OUT/chrome-argv.txt"; then sandbox_flag=yes; fi
  finding "chrome: agent-browser started the image's Chrome in the rootless container and loaded a data: page and an http page; --no-sandbox on its command line: $sandbox_flag (the container marker /run/.containerenv); no listener beyond loopback"
else
  cat "$OUT/chrome.txt"
  fail "the image's browser did not start in the rootless container"
fi
kill "$page_server" 2>/dev/null || true

step "the bots' sandbox (bubblewrap) in a rootless container: the first setting that lets it run"
image=$(sed -n 's/^Image=//p' "$UNIT")
userns=$(sed -n 's/^UserNS=//p' "$UNIT")
printf 'FROM %s\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends bubblewrap socat && rm -rf /var/lib/apt/lists/*\nUSER maus\n' "$image" >"$OUT/Containerfile.box"
podman build -q -t localhost/omb-box-probe:e2e -f "$OUT/Containerfile.box" "$OUT" >/dev/null
# The criterion is the server's own self-check of the box (as deploy/install.sh judges it): bubblewrap runs, and a bot
# cannot read the server's settings. Each rung adds one setting to the one before.
box_rung=""
seccomp=(--security-opt "seccomp=$ROOT/connector/profiles/seccomp-omb-home.json")
for rung in default unmask-proc seccomp-unmask-proc seccomp-unmask-all apparmor-unconfined; do
  extra=()
  case "$rung" in
    unmask-proc) extra=(--security-opt "unmask=/proc/*") ;;
    seccomp-unmask-proc) extra=("${seccomp[@]}" --security-opt "unmask=/proc/*") ;;
    seccomp-unmask-all) extra=("${seccomp[@]}" --security-opt unmask=ALL) ;;
    apparmor-unconfined) extra=("${seccomp[@]}" --security-opt unmask=ALL --security-opt apparmor=unconfined) ;;
  esac
  podman run --rm --userns "$userns" --network host -e OMB_BOT_BOX=1 -e OMB_DATA_DIR=/tmp/box-data ${extra[@]+"${extra[@]}"} \
    --entrypoint node localhost/omb-box-probe:e2e dist-server/bot-box/box-check.js --public=none >"$OUT/box-check-$rung.json" 2>&1 || true
  summary=$(jq -c '{box, passed, total, failed, error: (.error // null | if . then .[0:160] else . end)}' "$OUT/box-check-$rung.json" 2>/dev/null || head -c 300 "$OUT/box-check-$rung.json")
  if jq -e '.box == "bwrap" and .total > 0 and ([.results[] | select(.ok) | .id] | index("config-hidden") != null)' "$OUT/box-check-$rung.json" >/dev/null 2>&1; then
    box_rung=$rung
    finding "bot box: the self-check runs at rung $rung (${extra[*]:-no options}): $summary"
    break
  fi
  finding "bot box: not at rung $rung (${extra[*]:-no options}): $summary"
done
[ -n "$box_rung" ] || finding "bot box: the self-check did not run in a rootless container with any of the settings tried"
podman rmi -f localhost/omb-box-probe:e2e >/dev/null 2>&1 || true

step "a server that is killed is started again by systemd"
before=$(container_id)
launcher=$(podman top openmausbot hpid args | awk '/server-launcher/ { print $1; exit }')
[ -n "$launcher" ] || fail "no server process to kill"
kill -9 "$launcher"
for _ in $(seq 1 40); do [ "$(container_id)" != "$before" ] && [ -n "$(container_id)" ] && break; sleep 2; done
healthy_again
[ "$(container_id)" != "$before" ] || fail "the killed server was not started again"
finding "restart: kill -9 of server-launcher; systemd started a new container ($(systemctl --user show -p NRestarts --value openmausbot) restart(s)) and it answered"

step "a server that stops answering is stopped by its health check and started again"
before=$(container_id)
# The process that answers on 8799 (the launcher's child): it runs as this user, so ss names it.
server=$(ss -ltnpH "( sport = :8799 )" | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -n 1)
[ -n "$server" ] || fail "no server process to pause"
# Past the health check's start period first: failures inside it do not count.
for _ in $(seq 1 60); do [ "$(podman inspect -f '{{.State.Health.Status}}' openmausbot)" = healthy ] && break; sleep 5; done
[ "$(podman inspect -f '{{.State.Health.Status}}' openmausbot)" = healthy ] ||
  fail "the health check never passed: $(podman inspect -f '{{json .State.Health}}' openmausbot 2>&1 | head -c 600)"
finding "health: the check ran in the container as $health_test, and passed"
podman inspect -f '{{.State.Health.Status}} {{json .Config.Healthcheck}} {{.Config.HealthcheckOnFailureAction}}' openmausbot >"$OUT/health-before.txt" 2>&1 || true
systemctl --user list-timers --all --no-pager >"$OUT/timers.txt" 2>&1 || true
kill -STOP "$server"
for _ in $(seq 1 100); do [ -n "$(container_id)" ] && [ "$(container_id)" != "$before" ] && break; sleep 3; done
if [ "$(container_id)" = "$before" ]; then
  podman inspect -f '{{json .State.Health}}' openmausbot >"$OUT/health-after.json" 2>&1 || true
  kill -CONT "$server" 2>/dev/null || true
  fail "the health check did not restart a server that stopped answering: $(cat "$OUT/health-before.txt"); $(head -c 600 "$OUT/health-after.json"); timers: $(grep -c "$before" "$OUT/timers.txt" || true)"
fi
healthy_again
finding "health: a paused server (SIGSTOP) was killed by HealthOnFailure=kill and systemd started a new container"

step "a restart of this user's systemd (what a boot does, with linger) starts it again"
sudo systemctl restart "user@$(id -u).service"
for _ in $(seq 1 30); do systemctl --user show-environment >/dev/null 2>&1 && break; sleep 1; done
healthy_again
systemctl --user is-active --quiet openmausbot || fail "the service did not start with the user's systemd"
finding "boot: after systemctl restart user@$(id -u).service the service came back by itself (WantedBy=default.target)"

step "--lan: other devices on this network reach it, and must pair; --local takes it back"
"${INSTALL[@]}" --lan >"$OUT/install-lan.txt" 2>&1 || { cat "$OUT/install-lan.txt"; fail "the --lan run failed"; }
healthy_again
address=$(ip -4 -o route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')
# The pairing command the installer prints, without a terminal: a code, and a link on this network's address.
in_server openmausbot pair >"$OUT/pair-lan.txt" 2>&1 || { cat "$OUT/pair-lan.txt"; fail "pair failed"; }
contains "$OUT/pair-lan.txt" "http://$address:8799/pair#code=" "pair did not give a link on this network's address"
ss -ltnH | grep -qE "(0\.0\.0\.0|\*):8799 " || fail "the server does not listen beyond loopback with --lan"
ss -ltnH | grep -E ":8800 " >"$OUT/lan-8800.txt" || true
from_lan=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$address:8799/api/bots" || true)
from_here=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:8799/api/bots" || true)
[ "$from_lan" = 403 ] || [ "$from_lan" = 401 ] || fail "a request from $address got $from_lan from /api/bots, not a refusal"
[ "$from_here" = 200 ] || fail "this machine's own request got $from_here from /api/bots"
"${INSTALL[@]}" --local >"$OUT/install-local.txt" 2>&1 || { cat "$OUT/install-local.txt"; fail "the --local run failed"; }
healthy_again
[ -z "$(new_outside)" ] || fail "--local left something listening beyond loopback: $(new_outside)"
finding "lan: webhook port with --lan: $(awk '{ print $4 }' "$OUT/lan-8800.txt" | tr '\n' ' ')"
finding "pair: under --lan, openmausbot pair in the container gave a code and a link on http://$address:8799"
finding "lan: with --lan, $address got $from_lan and 127.0.0.1 got $from_here on /api/bots; --local went back to loopback"

step "update to $NEW_VERSION, through update.sh"
"$DIR/update.sh" --version "$NEW_VERSION" >"$OUT/update.txt" 2>&1 || { cat "$OUT/update.txt"; fail "the update failed"; }
cat "$OUT/update.txt"
contains "$OUT/update.txt" "Updated from $OLD_VERSION to $NEW_VERSION." "the update did not finish"
new_image=$(sed -n 's/^Image=//p' "$UNIT")
{ [ "$new_image" != "$image" ] && grep -qx "OMB_IMAGE=$new_image" "$DIR/.env"; } || fail "the unit and .env do not name the new image"
[ "$(podman inspect -f '{{.Image}}' openmausbot)" = "$(podman image inspect -f '{{.Id}}' "$new_image")" ] || fail "the server does not run the new image"
in_server sh -c 'curl -sf http://127.0.0.1:8799/.well-known/openmausbot/environment' | grep -q "\"version\":\"$NEW_VERSION\"" || fail "the server does not say it is $NEW_VERSION"
in_server openmausbot bots --json | grep -q Probe || fail "the bot made before the update is gone"
podman volume ls -q | grep -q "^openmausbot_data-before-update-" || fail "no copy of the data was kept"
finding "update: $OLD_VERSION -> $NEW_VERSION by digest, data copied to a Podman volume first, the bot made before it still there"

step "an update to a version that cannot start is rolled back"
printf 'FROM %s\nCMD ["sh", "-c", "echo broken on purpose; exit 3"]\n' "$new_image" >"$OUT/Containerfile.broken"
podman build -q -t localhost/omb-broken:e2e -f "$OUT/Containerfile.broken" "$OUT" >/dev/null
status=0
OMB_UPDATE_WAIT_S=90 "$DIR/update.sh" --image localhost/omb-broken:e2e --allow-older >"$OUT/update-broken.txt" 2>&1 || status=$?
cat "$OUT/update-broken.txt"
[ "$status" = 1 ] || fail "the broken update exited $status, not 1"
contains "$OUT/update-broken.txt" "did not work: it stopped as it started (broken on purpose)." "the broken update did not say why in the server's own words"
contains "$OUT/update-broken.txt" "Your server runs $NEW_VERSION again, with its data as it was before the update." "the broken update was not rolled back"
[ "$(sed -n 's/^Image=//p' "$UNIT")" = "$new_image" ] || fail "the unit does not name $NEW_VERSION again"
healthy_again
in_server openmausbot bots --json | grep -q Probe || fail "the bot is gone after the rollback"
finding "rollback: an image that exits at start was rolled back to $NEW_VERSION with its data; the service answers"
podman rmi -f localhost/omb-broken:e2e >/dev/null 2>&1 || true

step "uninstall keeps the data"
"${INSTALL[@]}" --uninstall >"$OUT/uninstall.txt" 2>&1 || { cat "$OUT/uninstall.txt"; fail "the uninstall failed"; }
cat "$OUT/uninstall.txt"
[ ! -e "$UNIT" ] || fail "the unit is still there"
if systemctl --user is-active --quiet openmausbot; then fail "the service still runs"; fi
if healthy; then fail "the server still answers"; fi
[ -f "$DIR/data/.openmausbot/config.json" ] || fail "the uninstall removed the data"
finding "uninstall: the service and its unit are gone, the data stays"

step "clean up"
podman volume ls -q | grep "^openmausbot_data-before-update-" | xargs -r podman volume rm -f >/dev/null
podman unshare rm -rf "$DIR"
podman image ls --format '{{.Repository}}:{{.Tag}} {{.Size}}' | tee "$OUT/images.txt"
echo
echo "findings:"
cat "$FINDINGS"
