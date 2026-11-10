#!/bin/sh
# MausBot on a server of your own: checks the server, then installs the MausBot server with HTTPS on your domain.
# Running it again repairs or updates the install and never touches your data.
#
#   curl -fsSL https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/deploy/install.sh | sudo sh -s -- --domain maus.example.com
#   ... | sudo sh -s -- --check --domain maus.example.com    only checks the server; changes nothing
#   ... | sudo sh -s -- --uninstall                          stops the server; keeps your data
#   ... | sudo sh -s -- --domain maus.example.com <code>     also connects the server to MausBot with a one-time code
#
# Nothing runs until the last line calls main, so a download that is cut off part-way runs nothing. It sends no
# telemetry. The addresses it contacts are the ones the checks name: the image registries, Let's Encrypt, GitHub's
# release list and this repository's files, and cloudflare.com/cdn-cgi/trace to learn this server's public address.
set -eu

settings() {
  SYSROOT="${OMB_INSTALL_SYSROOT:-}"
  INSTALL_DIR="${OMB_INSTALL_DIR:-/opt/openmausbot}"
  IMAGE_REPO=milind-soni/openmausbot
  RELEASES_URL=https://api.github.com/repos/milind-soni/OpenMausBot/releases/latest
  ADMIN_URL="${MAUSBOT_ADMIN_URL:-https://cloud.openmausbot.com}"
  SCRIPT_URL=https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/deploy/install.sh
  # Where the files this installer places come from: this repository, or a copy of it (https://… or file:///…).
  SOURCE="${OMB_INSTALL_SOURCE:-https://raw.githubusercontent.com/milind-soni/OpenMausBot/main}"
  SECCOMP=seccomp-omb-home.json
  APPARMOR_PROFILE=omb-home-narrow
  PROJECT=openmausbot
  MIN_DOCKER=24
  MIN_CPUS=2
  MIN_MEMORY_MB=3500
  MIN_DISK_GB=20
  MAX_CLOCK_SKEW_S=300
  HEALTH_WAIT_S="${OMB_INSTALL_HEALTH_WAIT_S:-240}"
  HTTPS_WAIT_S="${OMB_INSTALL_HTTPS_WAIT_S:-180}"

  MODE=install
  DOMAIN=""
  EMAIL=""
  CODE=""
  INSTALL_DOCKER="${OMB_INSTALL_DOCKER:-}"
  SANDBOX=yes
  FAILED=0
  DOCKER_STATE=unknown
  DOCKER_PROBLEM=""
  IMAGE=""
  PUBLIC_IP=""
  REGISTRY_TOKEN=""
  REGISTRY_STATUS=000
}

say() { printf '%s\n' "$*"; }
fail() {
  printf '\n%s\n' "$*" >&2
  exit 1
}
ok() { printf '  ok    %s\n' "$*"; }
note() { printf '  note  %s\n' "$*"; }
fix() {
  printf '  FIX   %s\n' "$*"
  FAILED=$((FAILED + 1))
}

command_line() { # what to run again, as the person ran it
  printf 'curl -fsSL %s | sudo sh -s -- %s' "$SCRIPT_URL" "$*"
}

usage() {
  say "Usage: $(command_line '--domain maus.example.com')"
  say "       $(command_line '--check --domain maus.example.com')   only checks this server; changes nothing"
  say "       $(command_line '--uninstall')                        stops the server; keeps your data"
  say ""
  say "  --domain NAME      the name people will open, already pointing at this server"
  say "  --email ADDRESS    the first admin's email, so they can sign in with an emailed code"
  say "  --install-docker   install Docker with Docker's official script when it is missing, without asking"
  say "  --dir PATH         where the install lives (default /opt/openmausbot)"
  say "  --no-sandbox       do not prepare this server for the bots' sandbox (only for a server you alone sign in to)"
  say "  <code>             the one-time code MausBot shows, to also connect this server to MausBot"
}

parse() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) MODE=check ;;
      --uninstall) MODE=uninstall ;;
      --install-docker) INSTALL_DOCKER=1 ;;
      --no-sandbox) SANDBOX=no ;;
      --domain | --email | --dir)
        [ $# -ge 2 ] || fail "$1 needs a value. $(usage)"
        case "$1" in
          --domain) DOMAIN=$2 ;;
          --email) EMAIL=$2 ;;
          --dir) INSTALL_DIR=$2 ;;
        esac
        shift
        ;;
      --domain=*) DOMAIN=${1#--domain=} ;;
      --email=*) EMAIL=${1#--email=} ;;
      --dir=*) INSTALL_DIR=${1#--dir=} ;;
      -h | --help)
        usage
        exit 0
        ;;
      -*) fail "Unknown option $1. $(usage)" ;;
      *) CODE=$1 ;;
    esac
    shift
  done
  DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')
  case "$DOMAIN" in
    "") ;;
    *[!a-z0-9.-]* | .* | *. | -* | *..*) fail "$DOMAIN is not a domain name. Give the name alone, like maus.example.com, without https:// or a path." ;;
    *.*) ;;
    *) fail "$DOMAIN is not a full domain name. Give a name like maus.example.com." ;;
  esac
  case "$EMAIL" in
    "") ;;
    *[!A-Za-z0-9@._+-]* | *@*@*) fail "That email address doesn't look right. Give one address, like you@example.com." ;;
    ?*@?*.?*) ;;
    *) fail "That email address doesn't look right. Give one address, like you@example.com." ;;
  esac
  case "$CODE" in
    *[!A-Za-z0-9-]*) fail "That code doesn't look right. Copy the install command from MausBot again." ;;
  esac
  case "$INSTALL_DIR" in
    /?*) ;;
    *) fail "--dir needs a full path, like /opt/openmausbot." ;;
  esac
  case "$INSTALL_DIR" in
    *[!A-Za-z0-9/._-]*) fail "--dir may hold only letters, digits, / . _ and -." ;;
  esac
}

is_root() { [ "$(id -u)" = 0 ]; }

need_root() {
  is_root || fail "Please run this as root: put sudo before sh, like this: $(command_line "$@")"
}

tty_available() {
  [ -t 1 ] || return 1
  (exec </dev/tty) 2>/dev/null
}

# From the install's folder, as a person and update.sh run it: Compose reads .env there, COMPOSE_FILE included.
compose() {
  (cd "$INSTALL_DIR" && docker compose "$@")
}

env_value() { # name: its value in the install's .env, or nothing
  [ -r "$INSTALL_DIR/.env" ] || return 0
  sed -n "s/^$1=//p" "$INSTALL_DIR/.env" | tail -n 1
}

reachable() { # url: any HTTP answer counts
  curl -sS -o /dev/null --max-time 15 "$1" >/dev/null 2>&1
}

host_of() { printf '%s' "$1" | sed -e 's#^[a-z]*://##' -e 's#/.*##'; }

# The checks. Each one that fails prints one sentence saying what to fix, and none of them changes anything.

check_tools() {
  command -v curl >/dev/null 2>&1 || fix "curl isn't installed. Run: sudo apt-get install -y curl  and then run this again."
}

check_os() {
  release="$SYSROOT/etc/os-release"
  if [ ! -r "$release" ]; then
    fix "This server's operating system can't be identified. MausBot's installer runs on Ubuntu 22.04 or 24.04: pick one of those."
    return
  fi
  field() { sed -n "s/^$1=//p" "$release" | head -n 1 | tr -d '"'; }
  os_id=$(field ID)
  os_version=$(field VERSION_ID)
  os_name=$(field PRETTY_NAME)
  [ -n "$os_name" ] || os_name="$os_id $os_version"
  case "$os_id $os_version" in
    "ubuntu 22.04" | "ubuntu 24.04") ok "operating system: $os_name" ;;
    *)
      if [ "${OMB_INSTALL_ALLOW_UNTESTED_OS:-}" = 1 ]; then
        note "This server runs $os_name, which the installer is not tested on; going on as asked."
      else
        fix "This server runs $os_name. MausBot's installer runs on Ubuntu 22.04 or 24.04: pick one of those, or run again with OMB_INSTALL_ALLOW_UNTESTED_OS=1 to try anyway."
      fi
      ;;
  esac
}

check_arch() {
  arch=$(uname -m)
  if [ "$arch" = x86_64 ]; then
    ok "processor: x86-64"
  else
    fix "This server's processor is $arch. The installer supports Intel and AMD (x86-64) servers for now: pick an x86-64 server."
  fi
}

check_cpus() {
  cpus=$(nproc 2>/dev/null || echo 0)
  case "$cpus" in '' | *[!0-9]*) cpus=0 ;; esac
  if [ "$cpus" -ge "$MIN_CPUS" ]; then
    ok "processor cores: $cpus"
  else
    fix "This server has $cpus processor core. MausBot needs at least $MIN_CPUS: pick a bigger server."
  fi
}

check_memory() {
  memory_mb=$(awk '/^MemTotal:/ { print int($2 / 1024) }' "$SYSROOT/proc/meminfo" 2>/dev/null || true)
  case "$memory_mb" in '' | *[!0-9]*) memory_mb=0 ;; esac
  memory_gb=$(awk -v m="$memory_mb" 'BEGIN { printf "%.1f", m / 1024 }')
  if [ "$memory_mb" -lt "$MIN_MEMORY_MB" ]; then
    fix "This server has $memory_gb GB of memory. MausBot needs at least 4 GB: pick a bigger server."
    return
  fi
  ok "memory: $memory_gb GB"
  if [ "$memory_mb" -lt 7500 ]; then note "With $memory_gb GB of memory, bots will be slow when several work at once. We suggest at least 8 GB."; fi
}

existing_parent() {
  path=$1
  while [ ! -d "$path" ]; do path=$(dirname "$path"); done
  printf '%s' "$path"
}

free_gb() { df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print int($4 / 1048576) }'; }

check_disk() {
  places=$(existing_parent "$INSTALL_DIR")
  if [ "$DOCKER_STATE" = ready ]; then
    docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
    if [ -n "$docker_root" ] && [ -d "$docker_root" ]; then places="$places $docker_root"; fi
  fi
  least=""
  for place in $places; do
    free=$(free_gb "$place")
    case "$free" in '' | *[!0-9]*) free=0 ;; esac
    if [ -z "$least" ] || [ "$free" -lt "$least" ]; then
      least=$free
      least_place=$place
    fi
  done
  if [ "$least" -ge "$MIN_DISK_GB" ]; then
    ok "free disk: $least GB"
  else
    fix "This server has only $least GB free at $least_place. MausBot needs at least $MIN_DISK_GB GB: free some space or add a disk."
  fi
}

# DOCKER_STATE: ready, or missing (the one thing the installer offers to install), or broken (the person fixes it).
check_docker() {
  DOCKER_PROBLEM=""
  if ! command -v docker >/dev/null 2>&1; then
    DOCKER_STATE=missing
    DOCKER_PROBLEM="Docker isn't installed."
    return
  fi
  DOCKER_STATE=broken
  server=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
  if [ -z "$server" ]; then
    if is_root; then
      fix "Docker is installed but not running. Start it with: sudo systemctl enable --now docker  and then run this again."
    else
      fix "Docker did not answer. Run this with sudo, or start Docker with: sudo systemctl enable --now docker"
    fi
    return
  fi
  major=${server%%.*}
  case "$major" in '' | *[!0-9]*) major=0 ;; esac
  if [ "$major" -lt "$MIN_DOCKER" ]; then
    fix "Docker $server is too old; MausBot needs Docker $MIN_DOCKER or newer. Update it with: curl -fsSL https://get.docker.com | sudo sh  and then run this again."
    return
  fi
  security=$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null || true)
  case "$security" in
    *rootless*)
      fix "Docker runs in rootless mode here. MausBot needs the standard Docker service: run curl -fsSL https://get.docker.com | sudo sh  and then run this again."
      return
      ;;
  esac
  if ! docker compose version >/dev/null 2>&1; then
    fix "Docker is here without its Compose plugin. Run: sudo apt-get install -y docker-compose-plugin  and then run this again."
    return
  fi
  DOCKER_STATE=ready
  ok "Docker: $server, with Compose"
}

report_docker_missing() {
  if [ "$DOCKER_STATE" = missing ]; then
    fix "$DOCKER_PROBLEM Run this again with --install-docker to install it with Docker's official script, or install it yourself with: curl -fsSL https://get.docker.com | sudo sh"
  fi
}

listener_on() { # port: the listening line, or nothing
  ss -Hltnp "sport = :$1" 2>/dev/null | head -n 1
}

check_ports() {
  if ! command -v ss >/dev/null 2>&1; then
    note "Ports 80 and 443 could not be checked because the ss tool is missing; if something else uses them, the install will say so."
    return
  fi
  busy=""
  own=""
  for port in 80 443; do
    line=$(listener_on "$port")
    [ -n "$line" ] || continue
    if [ "$DOCKER_STATE" = ready ] && [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "publish=$port" 2>/dev/null)" ]; then
      own=yes
      continue
    fi
    owner=$(printf '%s' "$line" | sed -n 's/.*users:(("\([^"]*\)".*/\1/p')
    if [ "$owner" = docker-proxy ]; then
      fix "Port $port is already in use by another Docker container. Find it with: sudo docker ps  and stop it, then run this again."
    else
      fix "Port $port is already in use${owner:+ by $owner}. Stop what uses it${owner:+ (for example: sudo systemctl disable --now $owner)}, then run this again."
    fi
    busy=yes
  done
  if [ -n "$busy" ]; then return; fi
  if [ -n "$own" ]; then ok "ports 80 and 443: held by this install"; else ok "ports 80 and 443: free"; fi
}

public_address() {
  curl -4 -fsS --max-time 10 https://cloudflare.com/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p' | head -n 1
}

local_addresses() {
  ip -o -4 addr show scope global 2>/dev/null | awk '{ print $4 }' | cut -d/ -f1
}

check_dns() {
  if [ -z "$DOMAIN" ]; then
    note "No --domain was given, so its DNS record was not checked."
    return
  fi
  if [ "${OMB_INSTALL_SKIP_DNS:-}" = 1 ]; then
    note "The DNS record of $DOMAIN was not checked, as asked."
    return
  fi
  PUBLIC_IP=$(public_address || true)
  resolved=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' ' || true)
  resolved=${resolved% }
  target=${PUBLIC_IP:-this server\'s public address}
  if [ -z "$resolved" ]; then
    fix "$DOMAIN does not resolve yet. Add an A record for it pointing at $target at your DNS provider, wait a few minutes, then run this again."
    return
  fi
  for address in $resolved; do
    for mine in $PUBLIC_IP $(local_addresses); do
      if [ "$address" = "$mine" ]; then
        ok "DNS: $DOMAIN points at this server ($address)"
        return
      fi
    done
  done
  fix "$DOMAIN points at $resolved, not at this server ($target). Change its A record to $target (on Cloudflare, set the record to DNS only), then run this again; or set OMB_INSTALL_SKIP_DNS=1 if a load balancer forwards ports 80 and 443 here."
}

check_outbound() {
  targets="https://ghcr.io/v2/ https://pkg-containers.githubusercontent.com/ https://registry-1.docker.io/v2/ https://auth.docker.io/ https://production.cloudflare.docker.com/ https://acme-v02.api.letsencrypt.org/directory"
  if [ "$DOCKER_STATE" = missing ]; then targets="$targets https://get.docker.com/ https://download.docker.com/"; fi
  if [ -n "$CODE" ]; then targets="$targets $ADMIN_URL/"; fi
  case "$SOURCE" in https://*) targets="$targets https://$(host_of "$SOURCE")/" ;; esac
  blocked=""
  for url in $targets; do
    reachable "$url" || blocked="$blocked $(host_of "$url")"
  done
  if [ -n "$blocked" ]; then
    if [ -n "${https_proxy:-}${HTTPS_PROXY:-}" ]; then
      fix "This server reaches the internet only through a web proxy, which the installer can't use. It needs direct outbound HTTPS (port 443) to:$blocked"
    else
      fix "This server can't reach$blocked over HTTPS (port 443). Allow outbound HTTPS to them in your firewall, then run this again."
    fi
    return
  fi
  ok "outbound: the image registries and Let's Encrypt are reachable"
  if ! reachable https://accounts.openmausbot.com/; then
    note "accounts.openmausbot.com is not reachable, so signing in with an emailed code needs a mail server of your own (OMB_SIGNIN_SMTP_URL). Pairing codes work without it."
  fi
}

check_userns() {
  max=$(cat "$SYSROOT/proc/sys/user/max_user_namespaces" 2>/dev/null || echo 1)
  clone=$(cat "$SYSROOT/proc/sys/kernel/unprivileged_userns_clone" 2>/dev/null || echo 1)
  if [ "$max" = 0 ] || [ "$clone" != 1 ]; then
    fix "This server switches off user namespaces, which the bots' sandbox needs. Run: printf 'user.max_user_namespaces=63000\\nkernel.unprivileged_userns_clone=1\\n' | sudo tee /etc/sysctl.d/90-mausbot.conf && sudo sysctl --system  and then run this again."
  else
    ok "user namespaces: on"
  fi
}

# The bots' sandbox needs two profiles on the host, which the install puts there. This only looks.
check_sandbox() {
  if [ "$SANDBOX" != yes ]; then
    note "This server will not be prepared for the bots' sandbox, as asked. Do this only on a server you alone sign in to."
    return
  fi
  enabled=$(cat "$SYSROOT/sys/module/apparmor/parameters/enabled" 2>/dev/null || true)
  if [ "$enabled" != Y ] || ! command -v apparmor_parser >/dev/null 2>&1; then
    fix "This server is missing AppArmor or its tools, which the bots' sandbox needs. Run: sudo apt-get install -y apparmor  then restart the server and run this again; or add --no-sandbox to install without the sandbox, on a server you alone sign in to."
    return
  fi
  ok "bots' sandbox: AppArmor is on, so this server can be prepared for it"
}

check_clock() {
  now=$(date -u +%s)
  theirs=""
  header=$(curl -sSI --max-time 15 https://ghcr.io/v2/ 2>/dev/null | tr -d '\r' | sed -n 's/^[Dd]ate: //p' | head -n 1 || true)
  if [ -n "$header" ]; then theirs=$(date -u -d "$header" +%s 2>/dev/null || true); fi
  case "$theirs" in '' | *[!0-9]*) theirs="" ;; esac
  if [ -z "$theirs" ]; then
    if [ "$(date -u +%Y)" -lt 2025 ]; then
      fix "This server's clock says $(date -u +%Y), so HTTPS certificates will be refused. Run: sudo timedatectl set-ntp true  and then run this again."
    else
      note "The clock could not be compared with the internet's; it says $(date -u '+%Y-%m-%d %H:%M') UTC."
    fi
    return
  fi
  skew=$((now - theirs))
  [ "$skew" -ge 0 ] || skew=$((-skew))
  if [ "$skew" -gt "$MAX_CLOCK_SKEW_S" ]; then
    fix "This server's clock is $((skew / 60)) minutes off, so HTTPS certificates will be refused. Run: sudo timedatectl set-ntp true  and then run this again."
    return
  fi
  ok "clock: right"
  if command -v timedatectl >/dev/null 2>&1 && [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo yes)" != yes ]; then
    note "This server's clock is not kept in time. Run: sudo timedatectl set-ntp true"
  fi
}

registry_token() {
  curl -fsS --max-time 15 "https://ghcr.io/token?scope=repository:$IMAGE_REPO:pull" 2>/dev/null | sed -n 's/.*"token":"\([^"]*\)".*/\1/p' | head -n 1
}

# REGISTRY_STATUS: the registry's HTTP answer for a tag (200 it has it, 404 it does not), or 000 when it gave none.
registry_ask() { # tag
  REGISTRY_STATUS=000
  for _ in 1 2 3; do
    if [ -z "$REGISTRY_TOKEN" ]; then REGISTRY_TOKEN=$(registry_token || true); fi
    if [ -n "$REGISTRY_TOKEN" ]; then
      # The pull token goes to curl on its standard input, never on a command line.
      REGISTRY_STATUS=$(printf 'header = "Authorization: Bearer %s"\n' "$REGISTRY_TOKEN" | curl -K - -s -o /dev/null -w '%{http_code}' --max-time 15 -I \
        -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
        "https://ghcr.io/v2/$IMAGE_REPO/manifests/$1" 2>/dev/null || true)
      case "$REGISTRY_STATUS" in
        200 | 404) return 0 ;;
        401 | 403) REGISTRY_TOKEN="" ;;
      esac
    fi
    sleep 2
  done
}

newest_release() {
  curl -fsS --max-time 15 "$RELEASES_URL" 2>/dev/null | sed -n 's/.*"tag_name": *"\(v[0-9][0-9.]*\)".*/\1/p' | head -n 1
}

# The stable channel when it is published, else the newest release. Never `latest`, which follows every commit.
check_version() {
  chosen="${OMB_INSTALL_IMAGE:-}"
  if [ -n "$chosen" ]; then
    case "$chosen" in
      *[!A-Za-z0-9/:._@-]*)
        fix "OMB_INSTALL_IMAGE is not an image name."
        return
        ;;
    esac
    case "${chosen##*/}" in
      *:latest) fix "OMB_INSTALL_IMAGE names the latest tag, which follows every commit. Name a release, like ghcr.io/$IMAGE_REPO:v0.1.151." ;;
      *:?*)
        IMAGE=$chosen
        ok "version: $IMAGE, as asked"
        ;;
      *) fix "OMB_INSTALL_IMAGE needs a release tag, like ghcr.io/$IMAGE_REPO:v0.1.151." ;;
    esac
    return
  fi
  pinned=$(env_value OMB_IMAGE)
  case "$pinned" in
    *@sha256:*)
      IMAGE=$pinned
      ok "version: the one update.sh pinned here; it stays until update.sh changes it"
      return
      ;;
  esac
  registry_ask stable
  if [ "$REGISTRY_STATUS" = 200 ]; then
    IMAGE="ghcr.io/$IMAGE_REPO:stable"
    ok "version: the stable channel"
    return
  fi
  if [ "$REGISTRY_STATUS" != 404 ]; then
    fix "The image registry ghcr.io did not say which versions exist (it answered $REGISTRY_STATUS). Check this server's outbound HTTPS, then run this again."
    return
  fi
  release=$(newest_release || true)
  if [ -z "$release" ]; then
    fix "The newest MausBot release could not be read from api.github.com. Check this server's outbound HTTPS, then run this again in a few minutes."
    return
  fi
  registry_ask "$release"
  if [ "$REGISTRY_STATUS" = 404 ]; then
    fix "MausBot $release has no server image yet. Run this again in a few minutes."
    return
  fi
  if [ "$REGISTRY_STATUS" != 200 ]; then
    fix "The image registry ghcr.io did not say whether it has MausBot $release (it answered $REGISTRY_STATUS). Run this again in a few minutes."
    return
  fi
  IMAGE="ghcr.io/$IMAGE_REPO:$release"
  ok "version: $release, the newest release"
}

preflight() {
  say "Checking this server..."
  check_tools
  check_os
  check_arch
  check_cpus
  check_memory
  check_docker
  check_disk
  check_ports
  check_userns
  check_sandbox
  if ! command -v curl >/dev/null 2>&1; then
    note "The domain, outbound reach, the clock and the version were not checked, because they need curl."
    return
  fi
  check_dns
  check_outbound
  check_clock
  check_version
}

install_docker() {
  say "Installing Docker with Docker's official script (get.docker.com)..."
  tmp_docker=$(mktemp)
  curl -fsSL https://get.docker.com -o "$tmp_docker" || fail "Docker's install script could not be downloaded. Check that this server can reach https://get.docker.com, then run this again."
  sh "$tmp_docker" || fail "Docker's install script failed (its output is above). Fix that, then run this again."
  rm -f "$tmp_docker"
  if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker >/dev/null 2>&1 || true; fi
}

# Docker is the one thing the installer installs for you, and only when you say so: the flag, or yes at the prompt.
offer_docker() {
  if [ "$INSTALL_DOCKER" != 1 ]; then
    answer=n
    if tty_available; then
      printf "%s Install the current Docker now with Docker's official script (get.docker.com)? [Y/n] " "$DOCKER_PROBLEM" >/dev/tty
      read -r answer </dev/tty || answer=n
    fi
    case "$answer" in
      "" | y | Y | yes | Yes) ;;
      *) fail "$DOCKER_PROBLEM Install it with: curl -fsSL https://get.docker.com | sudo sh  and then run this again, or run this again with --install-docker." ;;
    esac
  fi
  install_docker
  FAILED=0
  check_docker
  report_docker_missing
  [ "$FAILED" = 0 ] || fail "Docker still isn't usable after its install. Fix the line above, then run this again."
}

write_file() { # path, with the content on standard input: replaced in one step
  tmp_file=$(mktemp "$1.XXXXXX")
  cat >"$tmp_file"
  chmod "${2:-644}" "$tmp_file"
  mv "$tmp_file" "$1"
}

write_compose() {
  write_file "$INSTALL_DIR/compose.yaml" <<'COMPOSE'
# Written by MausBot's installer (deploy/install.sh), and written again each time it runs: put your own settings in
# .env beside this file, which the installer keeps. Caddy shares the server's network, so the server itself only
# listens on loopback.
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
      OMB_SIGNIN_EMAILS: ${OMB_SIGNIN_EMAILS:-}
      OMB_SIGNIN_MEMBER_EMAILS: ${OMB_SIGNIN_MEMBER_EMAILS:-}
      OMB_SIGNIN_SMTP_URL: ${OMB_SIGNIN_SMTP_URL:-}
      OMB_SIGNIN_SMTP_FROM: ${OMB_SIGNIN_SMTP_FROM:-}
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
}

write_caddyfile() {
  write_file "$INSTALL_DIR/Caddyfile" <<'CADDY'
{$DOMAIN} {
	encode zstd gzip

	# Webhook ingress is designed to be reachable by third parties (it has its
	# own per-hook secrets), so it sits outside any login. The path is passed
	# through unchanged: the receiver routes on /hooks/<id>.
	handle /hooks/* {
		reverse_proxy 127.0.0.1:8800
	}

	handle {
		# Optional second wall in front of pairing (a shared password):
		#   basic_auth {
		#     {$BASIC_AUTH_USER} {$BASIC_AUTH_HASH}
		#   }
		# and set both variables in .env (hash with `caddy hash-password`,
		# every `$` doubled for Compose).
		reverse_proxy 127.0.0.1:8799 {
			# SSE: stream events as they arrive
			flush_interval -1
		}
	}
}
CADDY
}

set_env() { # name value: that one line of .env, leaving every other line as the person wrote it
  env_file="$INSTALL_DIR/.env"
  {
    if [ -f "$env_file" ]; then grep -v "^$1=" "$env_file" || true; fi
    printf '%s=%s\n' "$1" "$2"
  } | write_file "$env_file" 600
}

unset_env() { # name
  env_file="$INSTALL_DIR/.env"
  if grep -q "^$1=" "$env_file" 2>/dev/null; then
    { grep -v "^$1=" "$env_file" || true; } | write_file "$env_file" 600
  fi
}

write_settings() {
  if [ ! -f "$INSTALL_DIR/.env" ]; then
    write_file "$INSTALL_DIR/.env" 600 <<'ENV'
# MausBot's settings on this server. The installer sets DOMAIN, OMB_IMAGE and COMPOSE_FILE and keeps every other line.
# Who may sign in with an emailed code: OMB_SIGNIN_EMAILS (admins) and OMB_SIGNIN_MEMBER_EMAILS, comma-separated.
ENV
  fi
  set_env DOMAIN "$DOMAIN"
  set_env OMB_IMAGE "$IMAGE"
  if [ -n "$EMAIL" ]; then
    current=$(env_value OMB_SIGNIN_EMAILS)
    case ",$(printf '%s' "$current" | tr -d ' ')," in
      *",$EMAIL,"*) ;;
      *) set_env OMB_SIGNIN_EMAILS "${current:+$current,}$EMAIL" ;;
    esac
  fi
}

fetch() { # path-in-the-repository destination [mode]: 1 when it is not there
  tmp_fetch=$(mktemp "$2.XXXXXX")
  if curl -fsSL --max-time 60 "$SOURCE/$1" -o "$tmp_fetch" 2>/dev/null && [ -s "$tmp_fetch" ]; then
    chmod "${3:-644}" "$tmp_fetch"
    mv "$tmp_fetch" "$2"
    return 0
  fi
  rm -f "$tmp_fetch"
  return 1
}

# update.sh (deploy/update.sh) updates with a backup and a way back; it is this repository's file, placed as it is.
place_update() {
  fetch deploy/update.sh "$INSTALL_DIR/update.sh" 755 || true
}

# The sandbox's host preparation and Compose settings are this repository's own (deploy/box, connector/profiles),
# fetched and used as they are. 1 when they are not published where SOURCE points.
fetch_sandbox() {
  mkdir -p "$INSTALL_DIR/box/profiles"
  fetch deploy/box/prepare-host.sh "$INSTALL_DIR/box/prepare-host.sh" 755 &&
    fetch deploy/box/compose.box.yaml "$INSTALL_DIR/compose.box.yaml" &&
    fetch "connector/profiles/$SECCOMP" "$INSTALL_DIR/box/profiles/$SECCOMP" &&
    fetch "connector/profiles/$APPARMOR_PROFILE.apparmor" "$INSTALL_DIR/box/profiles/$APPARMOR_PROFILE.apparmor"
}

# An image that runs the hardened profile says so in its settings (OMB_IMAGE=server).
image_has_sandbox() {
  case "$(docker image inspect -f '{{json .Config.Env}}' "$IMAGE" 2>/dev/null || true)" in
    *'"OMB_IMAGE=server"'*) return 0 ;;
  esac
  return 1
}

# Sets SANDBOX to on when the server will start with the sandbox's settings, and says why when it will not.
prepare_sandbox() {
  if [ "$SANDBOX" != yes ]; then
    unset_env COMPOSE_FILE
    return
  fi
  if ! image_has_sandbox; then
    unset_env COMPOSE_FILE
    SANDBOX=absent
    note "This MausBot version has no bots' sandbox yet. Run this command again after updating to a version that has it."
    return
  fi
  if ! fetch_sandbox; then
    fail "The files that prepare this server for the bots' sandbox could not be downloaded from $SOURCE. Check this server's outbound HTTPS and run this again; or add --no-sandbox to install without the sandbox, on a server you alone sign in to."
  fi
  say "Preparing this server for the bots' sandbox..."
  MAUSBOT_PROFILES_DIR="$INSTALL_DIR/box/profiles" sh "$INSTALL_DIR/box/prepare-host.sh" >/dev/null ||
    fail "This server could not be prepared for the bots' sandbox (the reason is above). Fix that and run this again; or add --no-sandbox to install without the sandbox, on a server you alone sign in to."
  set_env COMPOSE_FILE compose.yaml:compose.box.yaml
  SANDBOX=on
}

# The server's own self-check of the sandbox, as a bot meets it: among its checks, that config.json cannot be read.
check_sandbox_runs() {
  [ "$SANDBOX" = on ] || return 0
  say "Checking that the bots' sandbox holds..."
  report=$(compose exec -T omb node dist-server/bot-box/box-check.js --public=none 2>/dev/null | tr -d ' \n' || true)
  case "$report" in
    *'"box":"bwrap"'*'"failed":[]'* | *'"failed":[]'*'"box":"bwrap"'*)
      case "$report" in
        *'"config-hidden"'*) say "The bots' sandbox is on: a bot cannot read the server's settings, keys or other bots' files." ;;
        *) fail "MausBot is running, but its sandbox self-check did not test that a bot cannot read the server's settings. Send us this line." ;;
      esac
      ;;
    *) fail "MausBot is running, but its bots' sandbox failed its self-check, so bots are not safely separated from the server. See it with: cd $INSTALL_DIR && sudo docker compose exec omb node dist-server/bot-box/box-check.js --public=none  and send us what it prints." ;;
  esac
}

# A new data folder is handed to the user the image runs as. A folder that already exists is never touched.
prepare_data() {
  if [ -d "$INSTALL_DIR/data" ]; then return; fi
  owner=$(docker run --rm --network none --entrypoint id "$IMAGE" -u 2>/dev/null || true)
  group=$(docker run --rm --network none --entrypoint id "$IMAGE" -g 2>/dev/null || true)
  case "$owner:$group" in
    *[!0-9:]* | : | :* | *:) fail "The MausBot image did not say which user it runs as. Run this again; if it still fails, send us this line." ;;
  esac
  mkdir -m 700 "$INSTALL_DIR/data"
  chown "$owner:$group" "$INSTALL_DIR/data"
}

wait_healthy() {
  waited=0
  while [ "$waited" -lt "$HEALTH_WAIT_S" ]; do
    container=$(compose ps -q omb 2>/dev/null | head -n 1 || true)
    if [ -n "$container" ] && [ "$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || true)" = healthy ]; then return 0; fi
    sleep 5
    waited=$((waited + 5))
  done
  return 1
}

https_answers() {
  curl -fsS --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" 2>/dev/null | grep -q openmausbot
}

wait_https() {
  waited=0
  while [ "$waited" -lt "$HTTPS_WAIT_S" ]; do
    if https_answers; then return 0; fi
    sleep 5
    waited=$((waited + 5))
  done
  return 1
}

install_server() {
  say ""
  say "Installing MausBot in $INSTALL_DIR..."
  mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/caddy/data" "$INSTALL_DIR/caddy/config"
  write_compose
  write_caddyfile
  write_settings
  say "Downloading MausBot..."
  compose pull -q || fail "MausBot could not be downloaded (Docker's message is above). Check this server's outbound HTTPS, then run this again."
  place_update
  prepare_sandbox
  prepare_data
  say "Starting MausBot..."
  compose up -d --remove-orphans >/dev/null || fail "MausBot could not be started (Docker's message is above). Fix that, then run this again."
  wait_healthy || fail "MausBot started but did not report healthy within $HEALTH_WAIT_S seconds. Its log: cd $INSTALL_DIR && sudo docker compose logs omb --tail 50"
  check_sandbox_runs
  say "Waiting for the HTTPS certificate of $DOMAIN..."
  wait_https || fail "MausBot is running, but https://$DOMAIN did not answer within $HTTPS_WAIT_S seconds, usually because the certificate could not be issued. Check that $DOMAIN points at this server and that ports 80 and 443 are open in your provider's firewall, then run this again. Caddy's reason: cd $INSTALL_DIR && sudo docker compose logs caddy --tail 30"
}

# The connector has its own installer, which MausBot serves with its address and the connector's image filled in.
# It is run as it is, with the code.
connect_server() {
  say ""
  say "Connecting this server to MausBot..."
  connector_script="${MAUSBOT_CONNECTOR_INSTALLER:-}"
  fetched=""
  if [ -z "$connector_script" ]; then
    fetched=$(mktemp)
    connector_script=$fetched
    if ! curl -fsSL --max-time 60 "$ADMIN_URL/install.sh" -o "$connector_script"; then
      rm -f "$fetched"
      fail "MausBot is installed and running here, but the connector's installer could not be downloaded from $ADMIN_URL. Nothing needs reinstalling: run this again with your code once that address answers."
    fi
  fi
  if ! grep -q 'mausbot-connector' "$connector_script" 2>/dev/null; then
    [ -z "$fetched" ] || rm -f "$fetched"
    fail "MausBot is installed and running here, but what $ADMIN_URL sent is not the connector's installer. Nothing needs reinstalling: copy the install command from MausBot again."
  fi
  status=0
  if [ "$INSTALL_DOCKER" = 1 ]; then
    MAUSBOT_ADMIN_URL="$ADMIN_URL" sh "$connector_script" --install-docker "$CODE" || status=$?
  else
    MAUSBOT_ADMIN_URL="$ADMIN_URL" sh "$connector_script" "$CODE" || status=$?
  fi
  [ -z "$fetched" ] || rm -f "$fetched"
  [ "$status" = 0 ] || fail "MausBot is installed and running here, but connecting it did not finish (the reason is above). Nothing needs reinstalling: fix that and run this again with a new code."
}

finish() {
  say ""
  say "MausBot is running at https://$DOMAIN"
  say ""
  say "To sign in as the first admin, make a one-time link on this server and open it in your browser:"
  say "  cd $INSTALL_DIR && sudo docker compose exec omb openmausbot pair --label \"First admin\""
  admins=$(env_value OMB_SIGNIN_EMAILS)
  if [ -n "$admins" ]; then
    say "Or open https://$DOMAIN/pair and sign in with an emailed code as: $admins"
  fi
  say ""
  if [ -x "$INSTALL_DIR/update.sh" ]; then
    say "To update later, with a backup first and a way back:  sudo $INSTALL_DIR/update.sh"
  else
    say "To update later, run this command again."
  fi
  say ""
  say "Settings: $INSTALL_DIR/.env    Your data: $INSTALL_DIR/data    Run this command again to repair."
}

run_install() {
  need_root "--domain ${DOMAIN:-maus.example.com}"
  if [ -z "$DOMAIN" ]; then DOMAIN=$(env_value DOMAIN); fi
  [ -n "$DOMAIN" ] || fail "Say which name people will open, like this: $(command_line '--domain maus.example.com')"
  preflight
  if [ "$FAILED" != 0 ]; then
    report_docker_missing
    fail "This server is not ready: fix the $FAILED line(s) marked FIX above, then run this again. Nothing was changed."
  fi
  if [ "$DOCKER_STATE" = missing ]; then offer_docker; fi
  install_server
  if [ -n "$CODE" ]; then connect_server; fi
  finish
}

run_check() {
  if [ -z "$DOMAIN" ]; then DOMAIN=$(env_value DOMAIN); fi
  preflight
  report_docker_missing
  if [ "$FAILED" != 0 ]; then
    fail "This server is not ready: fix the $FAILED line(s) marked FIX above. Nothing was changed."
  fi
  say ""
  say "This server is ready for MausBot. Nothing was changed."
}

# Stops the server and removes its containers. The data, the settings and the certificates stay where they are.
run_uninstall() {
  need_root --uninstall
  [ -f "$INSTALL_DIR/compose.yaml" ] || fail "MausBot isn't installed in $INSTALL_DIR, so there is nothing to stop."
  command -v docker >/dev/null 2>&1 || fail "Docker isn't installed here, so MausBot isn't running. Your data is in $INSTALL_DIR/data."
  say "Stopping MausBot..."
  compose down --remove-orphans >/dev/null || fail "MausBot could not be stopped (Docker's message is above)."
  say "MausBot is stopped and its containers are removed."
  say "Your data is kept in $INSTALL_DIR/data, your settings in $INSTALL_DIR/.env and the HTTPS certificates in $INSTALL_DIR/caddy."
  say "To start it again: $(command_line "--domain $(env_value DOMAIN)")"
  say "This command never deletes your data. To delete it yourself: sudo rm -rf $INSTALL_DIR"
  if [ -f "$SYSROOT/etc/mausbot/$SECCOMP" ]; then
    say "The sandbox's two profiles stay on this server: /etc/mausbot/$SECCOMP and /etc/apparmor.d/$APPARMOR_PROFILE."
  fi
  if [ -n "$(docker ps -aq --filter name=mausbot-connector 2>/dev/null || true)" ]; then
    say "This server is still connected to MausBot. To disconnect it, run the uninstall command MausBot shows for the connector."
  fi
}

main() {
  settings
  parse "$@"
  case "$MODE" in
    check) run_check ;;
    uninstall) run_uninstall ;;
    *) run_install ;;
  esac
}

main "$@"
