#!/bin/sh
# MausBot on a server of your own: checks the server, installs the bot box's two security profiles, starts the MausBot
# connector and connects it to MausBot with the one-time code MausBot shows. Running it again repairs the install.
#
#   curl -fsSL https://cloud.openmausbot.com/install.sh | sudo sh -s -- <code>
#
# On a server where you already installed MausBot yourself (deploy/install.sh, in /opt/openmausbot) it connects that
# MausBot instead of starting another: the connector then runs in customer-run mode, where MausBot may only start,
# stop, update and back up your server and learns only its versions, health and seat count (connector/src/customer-run.ts).
#
#   curl -fsSL https://cloud.openmausbot.com/install.sh | sudo sh -s -- uninstall               (keeps your data)
#   curl -fsSL https://cloud.openmausbot.com/install.sh | sudo sh -s -- uninstall --delete-data (deletes it too)
#
# MausBot serves this file with its own address and the connector's image (pinned by digest) filled in below.
set -eu

ADMIN_URL="${MAUSBOT_ADMIN_URL:-@MAUSBOT_ADMIN_URL@}"
CONNECTOR_IMAGE="${MAUSBOT_CONNECTOR_IMAGE:-@MAUSBOT_CONNECTOR_IMAGE@}"

ETC_DIR="${MAUSBOT_ETC_DIR:-/etc/mausbot}"
AUDIT_DIR="${MAUSBOT_AUDIT_DIR:-/var/log/mausbot}"
APPARMOR_DIR="${MAUSBOT_APPARMOR_DIR:-/etc/apparmor.d}"
PROFILE=omb-home-narrow
SECCOMP=seccomp-omb-home.json
CONNECTOR=mausbot-connector
CONNECTOR_NEXT=mausbot-connector-next
HOME_CONTAINER=mausbot-home
DATA_VOLUME=mausbot-data
STATE_VOLUME=mausbot-connector
SNAPSHOT_VOLUME=mausbot-snapshot
ROLE_LABEL=com.mausbot.role
INSTALL_DIR="${MAUSBOT_INSTALL_DIR:-/opt/openmausbot}"
UPDATE_DIR="${MAUSBOT_UPDATE_DIR:-/var/lib/mausbot/update}"
SBIN_DIR="${MAUSBOT_SBIN_DIR:-/usr/local/sbin}"
SYSTEMD_DIR="${MAUSBOT_SYSTEMD_DIR:-/etc/systemd/system}"
UPDATE_RUNNER=mausbot-update-runner
UPDATE_UNIT=mausbot-update
MODE=operated
MIN_DOCKER=24
MIN_CPUS=2
MIN_MEMORY_MB=3500
MIN_DISK_GB=20

say() { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() {
  printf '\n%s\n' "$*" >&2
  exit 1
}

command_line() { # what to run again, as the person ran it
  printf 'curl -fsSL %s/install.sh | sudo sh -s -- %s' "$ADMIN_URL" "$*"
}

need_root() {
  [ "$(id -u)" = 0 ] || fail "Please run this as root: put sudo before sh, like this: $(command_line "$@")"
}

need_settings() {
  case "$ADMIN_URL" in
    @*) fail "This installer was not downloaded from MausBot. Copy the install command from MausBot and run that." ;;
  esac
  case "$CONNECTOR_IMAGE" in
    @*) fail "This installer was not downloaded from MausBot. Copy the install command from MausBot and run that." ;;
  esac
}

tty_available() {
  [ -t 1 ] || return 1
  (exec </dev/tty) 2>/dev/null
}

check_os() {
  [ -r /etc/os-release ] || fail "This server's operating system can't be identified. MausBot runs on Ubuntu 22.04 or 24.04, or Debian 12."
  os_id=$(. /etc/os-release && printf '%s' "${ID:-}")
  os_version=$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")
  os_name=$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-$os_id $os_version}")
  case "$os_id $os_version" in
    "ubuntu 22.04" | "ubuntu 24.04" | "debian 12") note "operating system: $os_name" ;;
    *)
      if [ "${MAUSBOT_ALLOW_UNTESTED_OS:-}" = 1 ]; then
        note "operating system: $os_name (not one MausBot is tested on; going on as asked)"
      else
        fail "MausBot runs on Ubuntu 22.04 or 24.04, or Debian 12. This server runs $os_name. Please pick one of those, or run again with MAUSBOT_ALLOW_UNTESTED_OS=1 to try anyway."
      fi
      ;;
  esac
}

check_arch() {
  arch=$(uname -m)
  [ "$arch" = x86_64 ] || fail "This server has an ARM processor ($arch). MausBot runs on Intel or AMD (x86-64) servers for now. Please pick an x86-64 server."
  note "processor: x86-64"
}

install_docker() {
  say "Installing Docker with Docker's official script (get.docker.com)..."
  tmp_docker=$(mktemp)
  curl -fsSL https://get.docker.com -o "$tmp_docker" || fail "Docker's install script could not be downloaded. Check that this server can reach https://get.docker.com, then run this command again."
  sh "$tmp_docker" || fail "Docker's install script failed (its output is above). Fix that, then run this command again."
  rm -f "$tmp_docker"
  if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker >/dev/null 2>&1 || true; fi
}

offer_docker() { # what is wrong, in one sentence
  if [ "${MAUSBOT_INSTALL_DOCKER:-}" = 1 ]; then
    install_docker
    return
  fi
  if tty_available; then
    printf "%s Install the current Docker now with Docker's official script (get.docker.com)? [Y/n] " "$1" >/dev/tty
    answer=""
    read -r answer </dev/tty || answer=n
    case "$answer" in
      "" | y | Y | yes | Yes) install_docker; return ;;
    esac
  fi
  fail "$1 Install the current Docker with: curl -fsSL https://get.docker.com | sudo sh  and then run this command again (or run it with --install-docker)."
}

docker_server() {
  server=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
  if [ -z "$server" ]; then
    fail "Docker is installed but not running. Start it with: sudo systemctl enable --now docker  and then run this command again."
  fi
  major=${server%%.*}
  case "$major" in '' | *[!0-9]*) major=0 ;; esac
}

check_docker() {
  command -v docker >/dev/null 2>&1 || offer_docker "Docker isn't installed."
  docker_server
  # Debian 12's own Docker is 20.10: Docker's script replaces it with the current one, keeping its containers and volumes.
  if [ "$major" -lt "$MIN_DOCKER" ]; then
    offer_docker "Docker $server is too old; MausBot needs Docker $MIN_DOCKER or newer."
    docker_server
    [ "$major" -ge "$MIN_DOCKER" ] || fail "Docker is still $server after the update (Docker's output is above). Fix that, then run this command again."
  fi
  security=$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null || true)
  case "$security" in
    *rootless*) fail "Docker runs in rootless mode here. MausBot needs the standard Docker service: run curl -fsSL https://get.docker.com | sudo sh" ;;
  esac
  note "Docker: $server"
}

check_apparmor() {
  enabled=$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null || true)
  # Debian 12's cloud images run AppArmor in the kernel without its tools; installing them needs no restart.
  if [ "$enabled" = Y ] && ! command -v apparmor_parser >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
    say "Installing AppArmor's tools..."
    { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq apparmor; } >/dev/null 2>&1 ||
      fail "AppArmor's tools could not be installed. Run: sudo apt-get install -y apparmor  and then run this command again."
  fi
  case "$security" in
    *name=apparmor*name=seccomp* | *name=seccomp*name=apparmor*) docker_confines=yes ;;
    *) docker_confines=no ;;
  esac
  if [ "$enabled" != Y ] || ! command -v apparmor_parser >/dev/null 2>&1 || [ "$docker_confines" != yes ]; then
    fail "Your server is missing AppArmor's tools, a standard part of Ubuntu and Debian. Run: sudo apt-get install -y apparmor  then restart the server and run this command again."
  fi
  note "AppArmor: on"
}

check_userns() {
  max=$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 1)
  clone=$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)
  if [ "$max" = 0 ] || [ "$clone" != 1 ]; then
    fail "Your server switches off a Linux feature our bots' safety box needs. Run: printf 'user.max_user_namespaces=63000\\nkernel.unprivileged_userns_clone=1\\n' | sudo tee /etc/sysctl.d/90-mausbot.conf && sudo sysctl --system  and then run this command again."
  fi
}

check_resources() {
  cpus=$(nproc 2>/dev/null || echo 1)
  [ "$cpus" -ge "$MIN_CPUS" ] || fail "This server has $cpus processor core. MausBot needs at least $MIN_CPUS. Please pick a bigger server."
  memory_mb=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)
  memory_gb=$(awk -v m="$memory_mb" 'BEGIN { printf "%.1f", m / 1024 }')
  [ "$memory_mb" -ge "$MIN_MEMORY_MB" ] || fail "This server has $memory_gb GB of memory. MausBot needs at least 4 GB (and 32 GB for a team of five). Please pick a bigger server."
  root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
  [ -d "$root" ] || root=/
  free_gb=$(df -Pk "$root" | awk 'NR == 2 { print int($4 / 1048576) }')
  used_pct=$(df -Pk "$root" | awk 'NR == 2 { sub("%", "", $5); print $5 }')
  [ "$free_gb" -ge "$MIN_DISK_GB" ] || fail "Your server has only $free_gb GB free. MausBot needs at least $MIN_DISK_GB GB: free some space or add a disk."
  note "size: $cpus cores, $memory_gb GB memory, $free_gb GB free disk"
  if [ "$memory_mb" -lt 7500 ]; then note "note: with $memory_gb GB of memory, bots will be slow when several work at once. We suggest at least 8 GB."; fi
  if [ "${used_pct:-0}" -ge 85 ]; then note "note: the disk is $used_pct% full. Free some space or add a disk before it fills up."; fi
}

reachable() { # url: any HTTP answer counts
  curl -sS -o /dev/null --max-time 15 "$1" >/dev/null 2>&1
}

check_network() {
  blocked=""
  for url in https://ghcr.io/v2/ https://pkg-containers.githubusercontent.com/ "$ADMIN_URL/" https://cloudflare.com/cdn-cgi/trace; do
    if ! reachable "$url"; then
      host=$(printf '%s' "$url" | sed -e 's#^[a-z]*://##' -e 's#/.*##')
      blocked="$blocked $host"
    fi
  done
  if [ -n "$blocked" ]; then
    if [ -n "${https_proxy:-}${HTTPS_PROXY:-}" ]; then
      fail "This server reaches the internet only through a web proxy, and MausBot can't use a web proxy yet. It needs direct outbound HTTPS (port 443) to:$blocked"
    fi
    fail "Your network blocks outbound HTTPS (port 443) to:$blocked. Ask your IT team to allow it, then run this command again."
  fi
  note "network: MausBot, ghcr.io and Cloudflare reachable"
}

check_clock() {
  admin_date=$(curl -sSI --max-time 15 "$ADMIN_URL/" 2>/dev/null | tr -d '\r' | sed -n 's/^[Dd]ate: //p' | head -n 1)
  if [ -n "$admin_date" ]; then
    theirs=$(date -d "$admin_date" +%s 2>/dev/null || echo "")
    if [ -n "$theirs" ]; then
      skew=$(( $(date +%s) - theirs ))
      [ "$skew" -lt 0 ] && skew=$(( -skew ))
      if [ "$skew" -gt 300 ]; then
        fail "Your server's clock is $(( skew / 60 )) minutes off, so it can't check MausBot's messages. Run: sudo timedatectl set-ntp true  and then run this command again."
      fi
    fi
  fi
  if command -v timedatectl >/dev/null 2>&1 && [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo yes)" != yes ]; then
    note "note: this server's clock is not kept in time. Run: sudo timedatectl set-ntp true"
  fi
}

pull_connector() {
  if ! docker image inspect "$CONNECTOR_IMAGE" >/dev/null 2>&1; then
    docker pull -q "$CONNECTOR_IMAGE" >/dev/null || fail "The MausBot connector could not be downloaded from ghcr.io. Check that this server can reach https://ghcr.io, then run this command again."
  fi
}

install_profiles() {
  say "Installing the bot box's security profiles..."
  tmp_profiles=$(mktemp -d)
  docker run --rm --network none --entrypoint cat "$CONNECTOR_IMAGE" "/app/profiles/$SECCOMP" >"$tmp_profiles/$SECCOMP"
  docker run --rm --network none --entrypoint cat "$CONNECTOR_IMAGE" "/app/profiles/$PROFILE.apparmor" >"$tmp_profiles/$PROFILE"
  install -d -m 0755 "$ETC_DIR"
  install -m 0644 "$tmp_profiles/$SECCOMP" "$ETC_DIR/$SECCOMP"
  install -m 0644 "$tmp_profiles/$PROFILE" "$APPARMOR_DIR/$PROFILE"
  rm -rf "$tmp_profiles"
  apparmor_parser -r -W "$APPARMOR_DIR/$PROFILE" || fail "AppArmor refused the bot box's profile (its message is above). Run this command again; if it still fails, send us that message."
  if [ -r /sys/kernel/security/apparmor/profiles ] && ! grep -q "^$PROFILE " /sys/kernel/security/apparmor/profiles; then
    fail "AppArmor did not load the bot box's profile. Restart the server and run this command again."
  fi
}

# A MausBot its owner installed is here: the connector attaches to it and never starts a second one.
own_server_here() {
  [ -f "$INSTALL_DIR/compose.yaml" ]
}

# The server's own updater: update.sh in the install's folder, started by systemd when the connector asks. The
# connector's container can only leave the request; the update itself runs here, on the server, as its owner's does.
install_updater() {
  install -d -m 0700 "$UPDATE_DIR"
  rm -f "$UPDATE_DIR/runner"
  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d "$SYSTEMD_DIR" ]; then
    note "note: this server has no systemd, so MausBot cannot update it for you. Update it yourself with: $INSTALL_DIR/update.sh"
    return
  fi
  install -d -m 0755 "$SBIN_DIR"
  docker run --rm --network none --entrypoint cat "$CONNECTOR_IMAGE" "/app/host/$UPDATE_RUNNER.sh" >"$SBIN_DIR/$UPDATE_RUNNER.tmp" ||
    fail "The updater could not be read from the connector's image. Run this command again."
  chmod 0755 "$SBIN_DIR/$UPDATE_RUNNER.tmp"
  mv "$SBIN_DIR/$UPDATE_RUNNER.tmp" "$SBIN_DIR/$UPDATE_RUNNER"
  cat >"$SYSTEMD_DIR/$UPDATE_UNIT.path" <<UNIT
[Unit]
Description=Runs MausBot's updater when the MausBot connector asks for an update

[Path]
PathExists=$UPDATE_DIR/request

[Install]
WantedBy=multi-user.target
UNIT
  cat >"$SYSTEMD_DIR/$UPDATE_UNIT.service" <<UNIT
[Unit]
Description=MausBot's updater ($INSTALL_DIR/update.sh), for an update the MausBot connector asked for

[Service]
Type=oneshot
Environment=MAUSBOT_UPDATE_DIR=$UPDATE_DIR MAUSBOT_INSTALL_DIR=$INSTALL_DIR
ExecStart=$SBIN_DIR/$UPDATE_RUNNER
UNIT
  systemctl daemon-reload >/dev/null 2>&1 || true
  if systemctl enable --now "$UPDATE_UNIT.path" >/dev/null 2>&1; then
    echo 1 >"$UPDATE_DIR/runner"
  else
    note "note: the updater could not be switched on, so MausBot cannot update this server for you. Update it yourself with: $INSTALL_DIR/update.sh"
  fi
  if [ ! -f "$INSTALL_DIR/update.sh" ]; then
    note "note: there is no update.sh in $INSTALL_DIR yet. Until it is there, MausBot's updates are refused and nothing is changed."
  fi
}

remove_updater() {
  if command -v systemctl >/dev/null 2>&1; then systemctl disable --now "$UPDATE_UNIT.path" >/dev/null 2>&1 || true; fi
  rm -f "$SYSTEMD_DIR/$UPDATE_UNIT.path" "$SYSTEMD_DIR/$UPDATE_UNIT.service" "$SBIN_DIR/$UPDATE_RUNNER"
  if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload >/dev/null 2>&1 || true; fi
  rm -rf "$UPDATE_DIR"
}

start_connector() {
  say "Starting the MausBot connector..."
  docker volume create "$STATE_VOLUME" >/dev/null
  install -d -m 0755 "$ETC_DIR"
  # The audit log: every job MausBot runs here, root's, for you to read (mausbot-connector audit).
  install -d -m 0750 "$AUDIT_DIR"
  docker rm -f "$CONNECTOR" "$CONNECTOR_NEXT" >/dev/null 2>&1 || true
  instance=$(cat /proc/sys/kernel/random/uuid)
  set -- --label "$ROLE_LABEL=connector" --label "com.mausbot.instance=$instance" \
    -e "MAUSBOT_INSTANCE=$instance" -e "MAUSBOT_CONNECTOR_IMAGE=$CONNECTOR_IMAGE"
  case "${MAUSBOT_UPDATE_WAIT_S:-}" in
    '' | *[!0-9]*) ;;
    *) set -- "$@" -e "MAUSBOT_UPDATE_WAIT_S=$MAUSBOT_UPDATE_WAIT_S" ;;
  esac
  if [ "$MODE" = customer-run ]; then
    set -- "$@" -e MAUSBOT_MODE=customer-run -v "$UPDATE_DIR:/var/lib/mausbot/update"
  fi
  docker run -d --name "$CONNECTOR" --restart unless-stopped --network host \
    --security-opt no-new-privileges=true --cap-drop ALL --read-only --tmpfs /tmp \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$STATE_VOLUME:/state" -v "$ETC_DIR:/etc/mausbot:ro" -v "$AUDIT_DIR:/var/log/mausbot" \
    --log-opt max-size=10m --log-opt max-file=3 \
    "$@" "$CONNECTOR_IMAGE" run >/dev/null || fail "The MausBot connector could not be started (Docker's message is above). Run this command again."
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if docker exec "$CONNECTOR" mausbot-connector version >/dev/null 2>&1; then return; fi
    sleep 1
  done
  fail "The MausBot connector did not start. Its log: $(docker logs --tail 5 "$CONNECTOR" 2>&1 | tr '\n' ' ')"
}

check_box() {
  say "Checking that the bots' safety box works here..."
  probe=$(docker exec "$CONNECTOR" mausbot-connector probe 2>&1 || true)
  problems=$(printf '%s\n' "$probe" | sed -n 's/^fail [a-z]* //p')
  warnings=$(printf '%s\n' "$probe" | sed -n 's/^warn [a-z]* //p')
  if [ -n "$warnings" ]; then printf '%s\n' "$warnings" | sed 's/^/  note: /'; fi
  [ -z "$problems" ] || fail "$problems"
  printf '%s\n' "$probe" | grep -q '^ok box' || fail "The bots' safety box could not be checked on this server. Run this command again."
}

connect() {
  code=$1
  if [ -n "$code" ]; then
    say "Connecting to MausBot..."
    # The code works once: its refusal is read from this one attempt.
    if ! refusal=$(printf '%s\n' "$code" | docker exec -i -e "MAUSBOT_ADMIN_URL=$ADMIN_URL" "$CONNECTOR" mausbot-connector enroll 2>&1 >/dev/null); then
      fail "$(printf '%s\n' "$refusal" | tail -n 1)"
    fi
  elif ! docker exec "$CONNECTOR" mausbot-connector status | grep -q '"enrolled":true'; then
    fail "Add the one-time code MausBot shows next to the install command, like this: $(command_line '<code>')"
  fi
  waited=0
  while [ "$waited" -lt 60 ]; do
    if docker exec "$CONNECTOR" mausbot-connector status 2>/dev/null | grep -q '"connected":true'; then return; fi
    sleep 1
    waited=$((waited + 1))
  done
  fail "The connector could not reach MausBot at $ADMIN_URL. Its log: $(docker logs --tail 5 "$CONNECTOR" 2>&1 | tr '\n' ' ')"
}

install_connector() {
  code=""
  for arg in "$@"; do
    case "$arg" in
      --install-docker) MAUSBOT_INSTALL_DOCKER=1 ;;
      --customer-run) MODE=customer-run ;;
      -*) fail "Unknown option $arg. Usage: $(command_line '<code>')" ;;
      *) code=$arg ;;
    esac
  done
  case "$code" in
    *[!A-Za-z0-9-]*) fail "That code doesn't look right. Copy the install command from MausBot again." ;;
  esac
  need_root "${code:-<code>}"
  need_settings
  if own_server_here; then
    MODE=customer-run
  elif [ "$MODE" = customer-run ]; then
    fail "MausBot isn't installed in $INSTALL_DIR yet. Install it first with the server's install command, then run this again to connect it."
  fi
  say "Checking this server..."
  check_os
  check_arch
  check_docker
  if [ "$MODE" = customer-run ]; then
    note "MausBot is already installed in $INSTALL_DIR: connecting that server, as it is"
    check_resources
    check_network
    check_clock
    pull_connector
    install_updater
    start_connector
    connect "$code"
    say ""
    say "Connected. Your server shows up in MausBot in a minute, for your team's Owner to accept."
    say "You run this server: MausBot can start, stop, update and back it up, and sees its versions, health and seat count."
    say "  What it was asked to do:  sudo docker exec $CONNECTOR mausbot-connector audit"
    say "  Pause remote management:  sudo docker exec $CONNECTOR mausbot-connector pause"
    say "Only you can replace the connector or restore a backup: sudo docker exec $CONNECTOR mausbot-connector job <self-update|restore>"
    return
  fi
  check_apparmor
  check_userns
  check_resources
  check_network
  check_clock
  pull_connector
  install_profiles
  start_connector
  check_box
  connect "$code"
  say ""
  say "Connected. Your server shows up in MausBot in a minute, for your team's Owner to accept."
}

# Removal never deletes the data, its safety copy or its backups unless --delete-data is typed.
uninstall() {
  delete=no
  for arg in "$@"; do
    case "$arg" in
      --delete-data) delete=yes ;;
      *) fail "Unknown option $arg. Usage: $(command_line uninstall) [--delete-data]" ;;
    esac
  done
  need_root uninstall
  command -v docker >/dev/null 2>&1 || fail "Docker isn't installed here, so MausBot isn't either."
  if own_server_here; then
    say "Disconnecting this server from MausBot..."
    docker rm -f "$CONNECTOR" "$CONNECTOR_NEXT" >/dev/null 2>&1 || true
    for container in $(docker ps -aq --filter "label=$ROLE_LABEL=helper" 2>/dev/null); do
      docker rm -f "$container" >/dev/null 2>&1 || true
    done
    remove_updater
    docker volume rm "$STATE_VOLUME" >/dev/null 2>&1 || true
    if [ "$delete" = yes ]; then
      for volume in "$SNAPSHOT_VOLUME" $(docker volume ls -q --filter "label=$ROLE_LABEL=backup" 2>/dev/null); do
        docker volume rm "$volume" >/dev/null 2>&1 || true
      done
      rm -rf "$AUDIT_DIR"
      say "This server is disconnected. The backups MausBot made and the audit log are deleted."
    else
      say "This server is disconnected. The backups MausBot made are kept as Docker volumes, and the audit log in $AUDIT_DIR."
    fi
    say "Your MausBot in $INSTALL_DIR and its data were not touched, and it keeps running."
    return
  fi
  say "Stopping MausBot on this server..."
  docker rm -f "$CONNECTOR" "$CONNECTOR_NEXT" >/dev/null 2>&1 || true
  docker stop -t 30 "$HOME_CONTAINER" >/dev/null 2>&1 || true
  for container in "$HOME_CONTAINER" $(docker ps -aq --filter "label=$ROLE_LABEL=helper" 2>/dev/null); do
    docker rm -f "$container" >/dev/null 2>&1 || true
  done
  if command -v apparmor_parser >/dev/null 2>&1 && [ -f "$APPARMOR_DIR/$PROFILE" ]; then apparmor_parser -R "$APPARMOR_DIR/$PROFILE" >/dev/null 2>&1 || true; fi
  rm -f "$APPARMOR_DIR/$PROFILE" "$ETC_DIR/$SECCOMP"
  rmdir "$ETC_DIR" 2>/dev/null || true
  # The connector's own state (its key, the home's settings) is not your data: a new code makes a new key.
  docker volume rm "$STATE_VOLUME" >/dev/null 2>&1 || true
  if [ "$delete" = yes ]; then
    for volume in "$DATA_VOLUME" "$SNAPSHOT_VOLUME" $(docker volume ls -q --filter "label=$ROLE_LABEL=backup" 2>/dev/null); do
      docker volume rm "$volume" >/dev/null 2>&1 || true
    done
    rm -rf "$AUDIT_DIR"
    say "MausBot is removed from this server, and so is its data."
  else
    say "MausBot is removed from this server. Your data is kept in the Docker volume $DATA_VOLUME, with its backups, and the audit log in $AUDIT_DIR."
    say "To delete the data too, run: $(command_line uninstall --delete-data)"
  fi
}

case "${1:-}" in
  uninstall)
    shift
    uninstall "$@"
    ;;
  -h | --help)
    say "Usage: $(command_line '<code>')"
    say "       $(command_line uninstall) [--delete-data]"
    ;;
  *) install_connector "$@" ;;
esac
