#!/usr/bin/env bash
# The connector end to end on a stock Ubuntu 24.04 host with Docker and AppArmor on, installed as a person installs it:
# a fake Admin (connector/test/fake-admin.ts) mints a one-time code; install.sh checks the host, installs the profiles,
# starts the connector and enrols; then start (the box passes every check), update to another digest, an unclean kill
# started again, an update forced to fail rolled back (image and data), and uninstall keeping the data.
# Nothing reaches a production service: the home's connected-apps broker points at a closed loopback port and its
# HighLevel relay is off; the Admin is the fake one on loopback.
#   OUT=<evidence folder> bash connector/e2e/run.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${OUT:-$(mktemp -d)}
mkdir -p "$OUT"
# Two published homes with the same 32-check bot box (v0.1.129 and v0.1.130).
HOME_A=ghcr.io/milind-soni/openmausbot-cloud-home@sha256:2909b6a9e02565f524db94d9ea5759f0290c8c90fc9d6e753d7f284ca5e5ba75
HOME_B=ghcr.io/milind-soni/openmausbot-cloud-home@sha256:495c1bd14a5677a1f9e8b6f8560e4971093e64bb07934fb8e8920de9f66da9d6
CONNECTOR_IMAGE=mausbot-connector:e2e
PORT=18990
ADMIN="http://127.0.0.1:$PORT"
CODE="MB-E2E-$(openssl rand -hex 4 | tr a-f A-F)"
SECRET=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$SECRET"; fi
INSTALL_ENV=(MAUSBOT_ADMIN_URL="$ADMIN" MAUSBOT_CONNECTOR_IMAGE="$CONNECTOR_IMAGE" MAUSBOT_UPDATE_WAIT_S=90)

step() { printf '\n== %s\n' "$*"; }
fail() {
  printf 'FAILED: %s\n' "$*" >&2
  docker logs mausbot-connector >"$OUT/connector.log" 2>&1 || true
  docker logs mausbot-home 2>&1 | tail -n 80 >"$OUT/home.log" || true
  exit 1
}
control() { curl -sS --max-time 30 "$ADMIN/control/$1"; }
job() { # type args-json [id] → the reply, as the Admin receives it
  curl -sS --max-time 1800 -X POST -H 'content-type: application/json' \
    --data "$(jq -cn --arg type "$1" --argjson args "$2" --arg id "${3:-}" '{type: $type, args: $args} + (if $id == "" then {} else {id: $id} end)')" \
    "$ADMIN/control/job"
}
expect() { # jq-filter json what
  jq -e "$1" >/dev/null <<<"$2" || fail "$3: $(head -c 800 <<<"$2")"
}
box_checks() { # the status reply once the home's box has run its self-check
  local status=""
  for _ in $(seq 1 60); do
    status=$(job status '{}')
    if jq -e '.result.home.health.box.checks != null' >/dev/null <<<"$status"; then break; fi
    sleep 2
  done
  printf '%s' "$status"
}
home_settings() { # the home container's settings, without its environment (it holds the secret)
  docker inspect -f '{"apparmor": {{json .AppArmorProfile}}, "host": {{json .HostConfig}}, "stopTimeout": {{json .Config.StopTimeout}}, "image": {{json .Config.Image}}}' mausbot-home
}
EVENTS=""
cleanup() {
  if [ -n "$EVENTS" ]; then kill "$EVENTS" 2>/dev/null || true; fi
  kill "$ADMIN_PID" 2>/dev/null || true
}

step "the connector image, as the release builds it"
docker build -q -t "$CONNECTOR_IMAGE" "$ROOT/connector" >/dev/null

step "a fake Admin with one one-time code"
node "$ROOT/connector/test/fake-admin.ts" "$PORT" "$CODE" >"$OUT/admin.log" 2>&1 &
ADMIN_PID=$!
trap cleanup EXIT
for _ in $(seq 1 30); do
  if control state >/dev/null 2>&1; then break; fi
  sleep 1
done
control state >/dev/null || fail "the fake Admin did not start: $(cat "$OUT/admin.log")"

step "install.sh with the code, as a person runs it"
sudo env "${INSTALL_ENV[@]}" sh "$ROOT/connector/install.sh" "$CODE" | tee "$OUT/install.txt"
[ "$(tail -n 1 "$OUT/install.txt")" = "Connected. Your server shows up in MausBot in a minute." ] || fail "install.sh did not end connected"
state=$(control state)
expect '.connected and (.servers | length) == 1' "$state" "enrolled once"
expect '.servers[0].host | .arch == "x86_64" and .apparmor and .userns and .cpus >= 2 and .diskGb >= 20 and (.docker | length) > 0' "$state" "enrolled with the host's facts"
expect '.servers[0].connector.protocol == 1 and .servers[0].connector.image == "mausbot-connector:e2e"' "$state" "enrolled with its identity"
state_dir=/var/lib/docker/volumes/mausbot-connector/_data
[ "$(sudo stat -c %a "$state_dir")" = 700 ] || fail "the connector's state folder is not root's alone"
[ "$(sudo stat -c %a "$state_dir/agent.json")" = 600 ] || fail "the agent token is not root's alone"

step "running it again repairs and stays connected, without a new code"
sudo env "${INSTALL_ENV[@]}" sh "$ROOT/connector/install.sh" | tee "$OUT/repair.txt"
[ "$(tail -n 1 "$OUT/repair.txt")" = "Connected. Your server shows up in MausBot in a minute." ] || fail "the repair did not end connected"
expect '(.servers | length) == 1 and .connections >= 2 and .connected' "$(control state)" "the same server, connected again"

step "a heartbeat with every check passing"
for _ in $(seq 1 40); do
  if [ "$(control state | jq '.heartbeats')" -ge 1 ]; then break; fi
  sleep 1
done
expect '.heartbeats >= 1 and .lastHeartbeat.host.arch == "x86_64" and ([.lastHeartbeat.host.checks[] | select(.ok | not)] | length) == 0 and (.lastHeartbeat.host.checks | any(.id == "box" and .ok))' "$(control state)" "the heartbeat"

ENV_JSON=$(jq -cn --arg secret "$SECRET" '{
  OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "e2e-connector-home", OMB_CLOUD_ADMIN_URL: "https://admin.e2e.invalid",
  OMB_PUBLIC_URL: "https://home.e2e.invalid", OMB_CLOUD_BOOTSTRAP_SECRET: $secret,
  OMB_COMPOSIO_BROKER_URL: "http://127.0.0.1:9", OMB_HIGHLEVEL_RELAY_URL: "off"
}')

step "start: the home runs with the bot box's settings, and the box passes every check"
reply=$(job start "$(jq -cn --arg image "$HOME_A" --argjson env "$ENV_JSON" '{image: $image, env: $env}')" start-1)
printf '%s\n' "$reply" >"$OUT/start.json"
expect ".ok and .result.home.state == \"running\" and .result.home.image == \"$HOME_A\" and .result.home.health.ok" "$reply" "start"
status=$(box_checks)
printf '%s\n' "$status" >"$OUT/status-start.json"
expect '.result.home.health.box | .box == "bwrap" and .checks == "32/32" and .failed == []' "$status" "the box passes 32/32"
settings=$(home_settings)
printf '%s\n' "$settings" >"$OUT/home-settings.json"
expect '.apparmor == "omb-home-narrow" and .stopTimeout == 30' "$settings" "the home's AppArmor profile and stop timeout"
expect '.host | .Init and .ShmSize == 536870912 and (.MaskedPaths // [] | length) == 0 and (.ReadonlyPaths // [] | length) == 0 and (.Privileged | not) and .OomScoreAdj == -800 and .RestartPolicy.Name == "no"' "$settings" "the home's container settings"
expect '.host | (.CapDrop | map(sub("^CAP_"; ""))) == ["ALL"] and (.CapAdd | map(sub("^CAP_"; "")) | sort) == ["CHOWN", "KILL", "SETGID", "SETUID"]' "$settings" "the home's capabilities"
expect '.host | .PortBindings["8080/tcp"] == [{"HostIp": "127.0.0.1", "HostPort": "8080"}] and (.SecurityOpt | any(startswith("seccomp="))) and (.SecurityOpt | any(. == "no-new-privileges=true" or . == "no-new-privileges"))' "$settings" "the home's port and seccomp"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' mausbot-home | grep -qx "OMB_COMPOSIO_BROKER_URL=http://127.0.0.1:9" || fail "the home could reach the production connected-apps broker"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' mausbot-home | grep -qx "OMB_HIGHLEVEL_RELAY_URL=off" || fail "the home could reach the production HighLevel relay"
docker exec -u maus mausbot-home sh -c 'echo kept > /data/e2e-marker'

step "update to another digest: a safety copy, a swap, and the new image's health"
reply=$(job update "$(jq -cn --arg image "$HOME_B" '{image: $image}')" update-1)
printf '%s\n' "$reply" >"$OUT/update.json"
expect ".ok and .result.previousImage == \"$HOME_A\" and .result.home.image == \"$HOME_B\" and .result.home.health.ok and .result.snapshot.kind == \"snapshot\"" "$reply" "update"
status=$(box_checks)
expect '.result.home.health.box.checks == "32/32"' "$status" "the box after the update"
[ "$(docker exec -u maus mausbot-home cat /data/e2e-marker)" = kept ] || fail "the data did not survive the update"
docker volume inspect mausbot-snapshot >/dev/null || fail "the update kept no safety copy"

step "a home killed uncleanly is started again on its volume"
docker kill -s KILL mausbot-home >/dev/null
for _ in $(seq 1 60); do
  if [ "$(docker inspect -f '{{.State.Running}}' mausbot-home 2>/dev/null)" = true ] && job status '{}' | jq -e '.result.home.health.ok' >/dev/null; then break; fi
  sleep 2
done
expect '.result.home.state == "running" and .result.home.health.ok' "$(job status '{}')" "the home after a SIGKILL"
docker logs mausbot-connector >"$OUT/connector.log" 2>&1
grep -q "the home stopped on its own (exit 137); starting it again" "$OUT/connector.log" || fail "the connector did not start the killed home again"
grep -q "cleared the data-directory lease records a stopped home left" "$OUT/connector.log" || fail "the connector did not clear the lease the killed home left"
[ "$(docker exec -u maus mausbot-home cat /data/e2e-marker)" = kept ] || fail "the data did not survive the kill"

step "an update forced to fail rolls back: the previous image, and the data as it was"
# The new home is frozen the moment it starts, so it never answers; what is written to the data after the swap must
# be gone once the rollback has put the safety copy back.
FIFO=$(mktemp -u)
mkfifo "$FIFO"
timeout 900 docker events --filter container=mausbot-home --filter event=start --format '{{.Actor.Attributes.image}}' >"$FIFO" &
EVENTS=$!
(
  while read -r started; do
    [ "$started" = "$HOME_A" ] || continue
    docker pause mausbot-home >/dev/null
    docker run --rm -v mausbot-data:/data --entrypoint sh "$HOME_B" -c 'echo lost > /data/e2e-after-swap'
    echo frozen >"$OUT/sabotaged"
    break
  done <"$FIFO"
) &
sleep 2
reply=$(job update "$(jq -cn --arg image "$HOME_A" '{image: $image}')" update-2)
printf '%s\n' "$reply" >"$OUT/rollback.json"
kill "$EVENTS" 2>/dev/null || true
EVENTS=""
rm -f "$FIFO"
[ -f "$OUT/sabotaged" ] || fail "the new home was never frozen, so this proved nothing: $reply"
expect ".ok == false and .error.code == \"update_rolled_back\" and .error.image == \"$HOME_B\"" "$reply" "the forced update"
status=$(job status '{}')
expect ".result.home.image == \"$HOME_B\" and .result.home.health.ok" "$status" "the previous image runs again"
[ "$(docker exec -u maus mausbot-home cat /data/e2e-marker)" = kept ] || fail "the data from before the update is gone"
if docker exec mausbot-home test -e /data/e2e-after-swap; then fail "what was written after the swap survived the rollback"; fi
status=$(box_checks)
expect '.result.home.health.box.checks == "32/32"' "$status" "the box after the rollback"

step "nothing secret in the connector's log"
docker logs mausbot-connector >"$OUT/connector.log" 2>&1
if grep -qF "$SECRET" "$OUT/connector.log"; then fail "the bootstrap secret reached the connector's log"; fi
if grep -q "ombs_" "$OUT/connector.log"; then fail "the agent token reached the connector's log"; fi

step "uninstall stops everything and keeps the data; --delete-data deletes it"
sudo env "${INSTALL_ENV[@]}" sh "$ROOT/connector/install.sh" uninstall | tee "$OUT/uninstall.txt"
for container in mausbot-connector mausbot-home; do
  if docker inspect "$container" >/dev/null 2>&1; then fail "$container is still there after uninstall"; fi
done
[ ! -e /etc/apparmor.d/omb-home-narrow ] || fail "the AppArmor profile is still installed"
[ "$(docker run --rm -v mausbot-data:/data --entrypoint cat "$HOME_B" /data/e2e-marker)" = kept ] || fail "uninstall did not keep the data"
docker volume inspect mausbot-snapshot >/dev/null || fail "uninstall did not keep the safety copy"
sudo env "${INSTALL_ENV[@]}" sh "$ROOT/connector/install.sh" uninstall --delete-data | tee -a "$OUT/uninstall.txt"
if docker volume inspect mausbot-data >/dev/null 2>&1; then fail "--delete-data kept the data"; fi

step "all passed"
