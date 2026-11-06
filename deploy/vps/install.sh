#!/bin/sh
# Installs a white-label OpenMausBot reseller fleet on a blank Debian or Ubuntu VPS.
# OMB_VPS_OS_RELEASE and OMB_VPS_PREFIX are test seams: an os-release file to read,
# and a directory that replaces / for every file this script writes and holds the
# only bin/ searched before the system tools.
set -eu

DOMAIN=
ADMINS=
WORKSPACE=main
HOST=
RESELLER_NAME=
CURRENCY=
LOGO=
ACCENT=
TAGLINE=
SUPPORT_URL=
LICENSE_KEY_FILE=
ANTHROPIC_KEY_FILE=
OPERATOR=
VERSION=latest
ENGINE=
CAP=
DRY_RUN=0

P=${OMB_VPS_PREFIX:-}
OS_RELEASE=${OMB_VPS_OS_RELEASE:-/etc/os-release}
if [ -n "$P" ]; then
  PATH="$P/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  export PATH
fi
export DEBIAN_FRONTEND=noninteractive

FLEET_JSON="$P/etc/openmausbot/fleet.json"
CADDYFILE="$P/etc/caddy/Caddyfile"
KEYRING="$P/usr/share/keyrings/caddy-stable-archive-keyring.gpg"
CADDY_LIST="$P/etc/apt/sources.list.d/caddy-stable.list"
WORK=
FLEET_EXISTED=0

usage() {
  cat <<'EOF'
Usage: install.sh --domain DOMAIN --admin EMAIL --reseller-name NAME [options]

Installs Node 24, Caddy and OpenMausBot on a blank Debian 12+ or Ubuntu 24.04+
server, starts a white-label fleet for DOMAIN and creates the first workspace.
Run it as root. It can be run again: it resumes where an earlier run stopped.

Required:
  --domain DOMAIN            the domain whose subdomains the workspaces live at
  --admin EMAIL              first workspace admin; repeat for more
  --reseller-name NAME       your brand name (1 to 40 characters)

Workspace:
  --workspace NAME           first workspace name (default: main)
  --host HOST                serve it at HOST instead of NAME.DOMAIN
  --cap USD                  monthly spend cap for it, such as 50 or 49.99
  --anthropic-key-file FILE  seed it with an Anthropic API key read from FILE

Brand (applies to every workspace; needs the whitelabel licence entitlement):
  --logo FILE|URL            PNG, JPEG, WebP, GIF or SVG file, or an https:// URL
  --accent '#RRGGBB'         accent colour
  --tagline TEXT             one line under the name
  --support-url URL          https:// help address
  --license-key-file FILE    licence key read from FILE (or set OMB_LICENSE_KEY)

Server:
  --operator USER            Unix user whose workspace manages the fleet
  --currency CODE            billing currency, two decimals only (default USD)
  --version VERSION          openmausbot version or tag to install (default: latest)
  --engine claude            also install the Claude Code CLI for the workspaces
  --dry-run                  print every step and change nothing
  -h, --help                 show this text
EOF
}

quote() {
  case $1 in
    '') printf "''" ;;
    *[!A-Za-z0-9_@%+=:,./-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}

run() {
  printf '+'
  for word in "$@"; do
    printf ' '
    quote "$word"
  done
  printf '\n'
  if [ "$DRY_RUN" = 0 ]; then
    "$@"
  fi
}

phase() {
  printf '\n== %s ==\n' "$1"
}

note() {
  printf '%s\n' "$*"
}

warn() {
  printf 'warning: %s\n' "$*"
}

die() {
  printf 'install.sh: %s\n' "$2" >&2
  exit "$1"
}

bad_usage() {
  printf 'install.sh: %s\nRun install.sh --help for the options.\n' "$1" >&2
  exit 2
}

stop_or_warn() {
  if [ "$DRY_RUN" = 1 ]; then
    warn "a real run would stop here: $1"
  else
    die 1 "$1"
  fi
}

have() {
  command -v "$1" >/dev/null 2>&1
}

cleanup() {
  if [ -n "$WORK" ] && [ "$DRY_RUN" = 0 ]; then
    rm -rf "$WORK"
  fi
}

trap cleanup EXIT

need_work_dir() {
  if [ -n "$WORK" ]; then
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    WORK="${TMPDIR:-/tmp}/openmausbot-install.XXXXXX"
  else
    WORK=$(mktemp -d "${TMPDIR:-/tmp}/openmausbot-install.XXXXXX")
  fi
}

write_file() {
  printf '+ write %s (mode %s)\n' "$1" "$2"
  printf '%s\n' "$3" | sed 's/^/    /'
  if [ "$DRY_RUN" = 0 ]; then
    staging="$1.new.$$"
    printf '%s\n' "$3" >"$staging"
    chmod "$2" "$staging"
    mv "$staging" "$1"
  fi
}

absolute() {
  case $1 in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$PWD" "$1" ;;
  esac
}

is_domain() {
  [ "${#1}" -le 253 ] && printf '%s\n' "$1" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
}

is_email() {
  printf '%s\n' "$1" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,63}$'
}

value_of() {
  if [ "$2" -lt 2 ]; then
    bad_usage "$1 needs a value"
  fi
  case $3 in
    -*) bad_usage "$1 needs a value, not $3" ;;
    *'
'*) bad_usage "$1 must be a single line" ;;
  esac
}

readable_file() {
  if [ ! -f "$2" ] || [ ! -r "$2" ] || [ ! -s "$2" ]; then
    bad_usage "$1: $2 is not a readable, non-empty file"
  fi
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    flag=$1
    case $flag in
      -h | --help)
        usage
        exit 0
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        continue
        ;;
      --domain | --admin | --workspace | --host | --reseller-name | --currency | --logo | --accent | --tagline | --support-url | --license-key-file | --anthropic-key-file | --operator | --version | --engine | --cap)
        value_of "$flag" "$#" "${2-}"
        given=$2
        ;;
      *)
        bad_usage "unknown option $flag"
        ;;
    esac
    case $flag in
      --domain) DOMAIN=$(printf '%s' "$given" | tr '[:upper:]' '[:lower:]') ;;
      --admin)
        is_email "$given" || bad_usage "--admin takes an email address, not $given"
        ADMINS="${ADMINS:+$ADMINS
}$given"
        ;;
      --workspace) WORKSPACE=$given ;;
      --host) HOST=$(printf '%s' "$given" | tr '[:upper:]' '[:lower:]') ;;
      --reseller-name) RESELLER_NAME=$given ;;
      --currency) CURRENCY=$(printf '%s' "$given" | tr '[:lower:]' '[:upper:]') ;;
      --logo) LOGO=$given ;;
      --accent) ACCENT=$given ;;
      --tagline) TAGLINE=$given ;;
      --support-url) SUPPORT_URL=$given ;;
      --license-key-file) LICENSE_KEY_FILE=$given ;;
      --anthropic-key-file) ANTHROPIC_KEY_FILE=$given ;;
      --operator) OPERATOR=$given ;;
      --version) VERSION=$given ;;
      --engine) ENGINE=$given ;;
      --cap) CAP=$given ;;
    esac
    shift 2
  done
}

validate_args() {
  [ -n "$DOMAIN" ] || bad_usage "--domain is required"
  is_domain "$DOMAIN" || bad_usage "--domain takes a bare hostname such as example.com, not $DOMAIN"
  case $DOMAIN in
    *.local | *.internal | *.invalid | *.localhost) bad_usage "--domain needs a public domain name that resolves to this server" ;;
  esac
  [ -n "$ADMINS" ] || bad_usage "--admin is required"
  [ -n "$RESELLER_NAME" ] || bad_usage "--reseller-name is required"
  [ "${#RESELLER_NAME}" -le 40 ] || bad_usage "--reseller-name must be 40 characters or fewer"
  printf '%s\n' "$WORKSPACE" | grep -Eq '^[a-z][a-z0-9-]{1,30}$' || bad_usage "--workspace takes 2 to 31 lowercase letters, digits or dashes, starting with a letter"
  if [ -n "$HOST" ]; then
    is_domain "$HOST" || bad_usage "--host takes a bare hostname such as app.customer.example, not $HOST"
    [ "$HOST" != "$DOMAIN" ] || bad_usage "--host cannot be the fleet domain itself"
    case $HOST in
      *."$DOMAIN") [ "$HOST" = "$WORKSPACE.$DOMAIN" ] || bad_usage "--host cannot sit under $DOMAIN; leave it out to use $WORKSPACE.$DOMAIN" ;;
    esac
  fi
  if [ -n "$CURRENCY" ]; then
    printf '%s\n' "$CURRENCY" | grep -Eq '^[A-Z]{3}$' || bad_usage "--currency takes a three-letter code such as USD"
  fi
  if [ -n "$ACCENT" ]; then
    printf '%s\n' "$ACCENT" | grep -Eq '^#[0-9A-Fa-f]{6}$' || bad_usage "--accent takes a colour such as #C2510A"
  fi
  if [ "${#TAGLINE}" -gt 120 ]; then
    bad_usage "--tagline must be 120 characters or fewer"
  fi
  if [ -n "$SUPPORT_URL" ]; then
    printf '%s\n' "$SUPPORT_URL" | grep -Eq '^https://[^/@[:space:]]+(/[^[:space:]]*)?$' || bad_usage "--support-url takes an https:// address without credentials"
  fi
  if [ -n "$OPERATOR" ]; then
    printf '%s\n' "$OPERATOR" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || bad_usage "--operator takes a Unix user name"
  fi
  printf '%s\n' "$VERSION" | grep -Eq '^[0-9A-Za-z][0-9A-Za-z.+_-]*$' || bad_usage "--version takes a version such as 0.1.145 or a tag such as latest"
  if [ -n "$ENGINE" ] && [ "$ENGINE" != claude ]; then
    bad_usage "--engine takes claude"
  fi
  if [ -n "$CAP" ]; then
    printf '%s\n' "$CAP" | grep -Eq '^[0-9]+(\.[0-9]{1,2})?$' || bad_usage "--cap takes a dollar amount such as 50 or 49.99"
  fi
  if [ -n "$LICENSE_KEY_FILE" ]; then
    LICENSE_KEY_FILE=$(absolute "$LICENSE_KEY_FILE")
    readable_file --license-key-file "$LICENSE_KEY_FILE"
  fi
  if [ -n "$ANTHROPIC_KEY_FILE" ]; then
    ANTHROPIC_KEY_FILE=$(absolute "$ANTHROPIC_KEY_FILE")
    readable_file --anthropic-key-file "$ANTHROPIC_KEY_FILE"
  fi
  if [ -n "$LOGO" ]; then
    case $LOGO in
      [Hh][Tt][Tt][Pp][Ss]://*) printf '%s\n' "$LOGO" | grep -Eq '^[^[:space:]]+$' || bad_usage "--logo address must not contain spaces" ;;
      *://*) bad_usage "--logo takes an image file or an https:// address" ;;
      *)
        LOGO=$(absolute "$LOGO")
        if [ ! -f "$LOGO" ] || [ ! -r "$LOGO" ]; then
          bad_usage "--logo: $LOGO is not a readable file"
        fi
        ;;
    esac
  fi
}

workspace_host() {
  if [ -n "$HOST" ]; then
    printf '%s' "$HOST"
  else
    printf '%s.%s' "$WORKSPACE" "$DOMAIN"
  fi
}

check_prereqs() {
  phase check_prereqs
  if [ "$DRY_RUN" = 1 ]; then
    note "dry run: nothing below is executed"
  fi
  if [ "$(id -u)" != 0 ]; then
    stop_or_warn "run this as root (sudo sh install.sh ...)"
  fi
  os_id=
  os_version=
  if [ -r "$OS_RELEASE" ]; then
    os_id=$(sed -n 's/^ID=//p' "$OS_RELEASE" | head -n 1 | tr -d '"')
    os_version=$(sed -n 's/^VERSION_ID=//p' "$OS_RELEASE" | head -n 1 | tr -d '"')
  fi
  os_major=${os_version%%.*}
  case $os_major in
    '' | *[!0-9]*) os_major=0 ;;
  esac
  supported=0
  if [ "$os_id" = ubuntu ] && [ "$os_major" -ge 24 ]; then supported=1; fi
  if [ "$os_id" = debian ] && [ "$os_major" -ge 12 ]; then supported=1; fi
  if [ "$supported" = 1 ]; then
    note "os: $os_id $os_version"
  else
    stop_or_warn "this installer supports Ubuntu 24.04+ and Debian 12+ (found ${os_id:-an unknown system} ${os_version})"
  fi
  if ! have apt-get; then
    stop_or_warn "apt-get is missing; this installer needs an apt-based system"
  fi
  if systemctl is-active --quiet caddy 2>/dev/null; then
    note "ports: caddy from an earlier run holds 80 and 443"
  elif have ss; then
    busy=$(ss -H -ltn 2>/dev/null | awk '$4 ~ /:(80|443)$/ { print $4 }')
    if [ -n "$busy" ]; then
      stop_or_warn "ports 80 and 443 must be free for Caddy; something already listens on: $(printf '%s' "$busy" | tr '\n' ' ')"
    else
      note "ports: 80 and 443 are free"
    fi
  else
    warn "ss is not installed; could not check that ports 80 and 443 are free"
  fi
  if [ -n "$OPERATOR" ] && [ "$DRY_RUN" = 0 ]; then
    id -u "$OPERATOR" >/dev/null 2>&1 || die 1 "--operator $OPERATOR is not a Unix user on this server; create it first"
  fi
}

install_packages() {
  phase install_packages
  run apt-get update
  run apt-get install -y nftables curl ca-certificates gnupg
}

node_major() {
  major=0
  if have node; then
    version=$(node -v 2>/dev/null || true)
    version=${version#v}
    version=${version%%.*}
    case $version in
      '' | *[!0-9]*) ;;
      *) major=$version ;;
    esac
  fi
  printf '%s' "$major"
}

install_node() {
  phase install_node
  if [ "$(node_major)" -ge 24 ]; then
    note "node $(node -v) is already installed"
    return 0
  fi
  need_work_dir
  run curl -fsSL --proto '=https' --tlsv1.2 -o "$WORK/nodesource_setup.sh" https://deb.nodesource.com/setup_24.x
  run bash "$WORK/nodesource_setup.sh"
  run apt-get install -y nodejs
}

install_caddy() {
  phase install_caddy
  if have caddy; then
    note "caddy is already installed"
  else
    need_work_dir
    run mkdir -p "$(dirname "$KEYRING")" "$(dirname "$CADDY_LIST")"
    run curl -fsSL --proto '=https' --tlsv1.2 -o "$WORK/caddy.gpg.key" https://dl.cloudsmith.io/public/caddy/stable/gpg.key
    run gpg --batch --yes --dearmor -o "$KEYRING" "$WORK/caddy.gpg.key"
    run chmod 0644 "$KEYRING"
    run curl -fsSL --proto '=https' --tlsv1.2 -o "$WORK/caddy-stable.list" https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt
    run install -m 0644 "$WORK/caddy-stable.list" "$CADDY_LIST"
    run apt-get update
    run apt-get install -y caddy
  fi
  write_caddyfile
}

only_email_block() {
  grep -Ev '^[[:space:]]*$' "$1" | tr -d '\n' | grep -Eq '^\{[[:space:]]*email [^[:space:]{}]+[[:space:]]*\}$'
}

write_caddyfile() {
  acme_email=${ADMINS%%
*}
  if [ -f "$CADDYFILE" ] && grep -q 'omb\.d' "$CADDYFILE"; then
    note "$CADDYFILE already imports the workspaces folder; leaving it alone"
    return 0
  fi
  if [ -s "$CADDYFILE" ] && ! grep -q '/usr/share/caddy' "$CADDYFILE" && ! only_email_block "$CADDYFILE"; then
    stop_or_warn "$CADDYFILE is not the stock file from the Caddy package. Put '{ email $acme_email }' at its very top, then run this installer again"
    return 0
  fi
  if [ -s "$CADDYFILE" ] && [ ! -e "$CADDYFILE.pre-openmausbot" ] && ! only_email_block "$CADDYFILE"; then
    run cp -p "$CADDYFILE" "$CADDYFILE.pre-openmausbot"
  fi
  run mkdir -p "$(dirname "$CADDYFILE")"
  write_file "$CADDYFILE" 0644 "{
	email $acme_email
}"
  run caddy validate --config "$CADDYFILE" --adapter caddyfile
}

install_openmausbot() {
  phase install_openmausbot
  run npm install -g "openmausbot@$VERSION"
}

install_engine() {
  phase install_engine
  if [ -z "$ENGINE" ]; then
    note "no engine requested; workspaces sign an engine in from Settings -> Engines"
    return 0
  fi
  run npm install -g @anthropic-ai/claude-code
}

private_address() {
  case $1 in
    10.* | 192.168.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].* | 100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].* | 127.* | 169.254.*) return 0 ;;
  esac
  return 1
}

public_addresses() {
  ip -o -4 addr show scope global 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }' | while IFS= read -r candidate; do
    if [ -n "$candidate" ] && ! private_address "$candidate"; then
      printf '%s\n' "$candidate"
    fi
  done
}

check_dns() {
  phase check_dns
  target=$(workspace_host)
  if [ "$DRY_RUN" = 1 ]; then
    note "a real run requires $target to resolve to this server before Caddy is first reloaded"
    return 0
  fi
  resolved=$(getent ahostsv4 "$target" 2>/dev/null | awk '{ print $1 }' | sort -u || true)
  if [ -z "$resolved" ]; then
    die 1 "$target does not resolve yet. Create the DNS record shown at the end of --dry-run, wait for it to propagate, then run this installer again; nothing is lost by re-running"
  fi
  shown=$(printf '%s' "$resolved" | tr '\n' ' ')
  public=$(public_addresses)
  if printf '%s\n' "$public" | awk -v answers="$resolved" 'BEGIN { n = split(answers, a, "\n"); for (i = 1; i <= n; i += 1) want[a[i]] = 1 } want[$1] { hit = 1 } END { exit !hit }'; then
    note "dns: $target resolves to this server"
  elif [ -z "$public" ]; then
    warn "$target resolves to $shown, but this server shows no public address (behind NAT?), so the match could not be checked"
  else
    die 1 "$target resolves to $shown, which is not an address of this server. Fix the DNS record, wait for it to propagate, then run this installer again"
  fi
}

fleet_init() {
  phase fleet_init
  if [ -f "$FLEET_JSON" ]; then
    FLEET_EXISTED=1
    grep -Fq "\"domain\": \"$DOMAIN\"" "$FLEET_JSON" || die 1 "$FLEET_JSON belongs to a different domain than $DOMAIN; one server is one reseller and one domain"
  fi
  set -- fleet init --domain "$DOMAIN" --reseller-name "$RESELLER_NAME"
  if [ -n "$CURRENCY" ]; then set -- "$@" --currency "$CURRENCY"; fi
  if [ -n "$OPERATOR" ]; then set -- "$@" --operator "$OPERATOR"; fi
  if [ "$FLEET_EXISTED" = 1 ]; then set -- "$@" --yes; fi
  run openmausbot "$@"
}

fleet_brand() {
  phase fleet_brand
  if [ -z "$LOGO$ACCENT$TAGLINE$SUPPORT_URL" ]; then
    note "no brand options given; workspaces carry only the name $RESELLER_NAME"
    return 0
  fi
  set -- fleet brand --default
  if [ -n "$ACCENT" ]; then set -- "$@" --accent "$ACCENT"; fi
  if [ -n "$TAGLINE" ]; then set -- "$@" --tagline "$TAGLINE"; fi
  if [ -n "$SUPPORT_URL" ]; then set -- "$@" --support-url "$SUPPORT_URL"; fi
  if [ -n "$LOGO" ]; then set -- "$@" --logo "$LOGO"; fi
  run openmausbot "$@"
}

fleet_row() {
  if have openmausbot; then
    openmausbot fleet list 2>/dev/null | awk -v name="$WORKSPACE" '$1 == name && $2 ~ /^https:\/\// { print; exit }' || true
  fi
}

fleet_create() {
  phase fleet_create
  row=
  if [ "$FLEET_EXISTED" = 1 ]; then
    row=$(fleet_row)
  fi
  if [ -n "$row" ]; then
    state=$(printf '%s' "$row" | awk '{ print $4 }')
    case $state in
      error | provisioning | retained) die 1 "workspace $WORKSPACE is $state; recover it as docs/verification/fleet.md describes before running this installer again" ;;
      *) note "workspace $WORKSPACE already exists (${state:-unknown}); not creating it again" ;;
    esac
    return 0
  fi
  set -- fleet create "$WORKSPACE"
  while IFS= read -r admin; do
    set -- "$@" --admin "$admin"
  done <<EOF
$ADMINS
EOF
  if [ -n "$HOST" ]; then set -- "$@" --host "$HOST"; fi
  if [ -n "$CAP" ]; then set -- "$@" --cap "$CAP"; fi
  if [ -n "$ANTHROPIC_KEY_FILE" ]; then set -- "$@" --anthropic-key-file "$ANTHROPIC_KEY_FILE"; fi
  if [ -n "$LICENSE_KEY_FILE" ]; then set -- "$@" --license-key-file "$LICENSE_KEY_FILE"; fi
  run openmausbot "$@"
}

summary() {
  phase summary
  url="https://$(workspace_host)"
  first_admin=${ADMINS%%
*}
  address=
  port=
  if [ "$DRY_RUN" = 0 ]; then
    address=$(public_addresses | head -n 1)
    port=$(fleet_row | awk '{ sub(/^:/, "", $3); print $3 }')
  fi
  address=${address:-"<public IPv4 of this server>"}
  port=${port:-"<port from: openmausbot fleet list>"}
  note "Workspace $WORKSPACE for $RESELLER_NAME: $url"
  note ""
  note "DNS records (at your DNS provider, before the first sign-in):"
  if [ -n "$HOST" ]; then
    note "  A    $HOST    $address"
  else
    note "  A    *.$DOMAIN    $address    (one wildcard record covers every workspace)"
  fi
  note ""
  note "Sign in: open $url and enter $first_admin; a code is emailed and the admin signs in with it."
  if [ -n "$ENGINE" ] && [ -n "$ANTHROPIC_KEY_FILE" ]; then
    note "Engine: Claude Code is installed and the workspace is seeded with your Anthropic key. Admins can also sign Claude in from Settings -> Engines."
  elif [ -n "$ENGINE" ]; then
    note "Engine: Claude Code is installed. Sign it in from Settings -> Engines in the workspace."
  else
    note "Engine: none installed. Sign one in from Settings -> Engines in the workspace, or rerun with --engine claude."
  fi
  note "Billing: openmausbot fleet billing --license-key-file FILE    (usage by workspace and user, as tenant-reported evidence)"
  note "More workspaces: openmausbot fleet create NAME --admin EMAIL [--host HOST]"
  if [ "$FLEET_EXISTED" = 1 ]; then
    note "Existing workspaces keep their old release until you run: openmausbot fleet upgrade"
  fi
  if [ -z "$LICENSE_KEY_FILE" ] && [ -z "${OMB_LICENSE_KEY:-}" ]; then
    warn "no licence key: the brand will not apply and fleet billing will refuse. Rerun with --license-key-file FILE."
  fi
  if [ ! -f "$FLEET_JSON" ] || ! grep -q '"smtp"' "$FLEET_JSON"; then
    warn "no sign-in mail relay (reseller.smtp in /etc/openmausbot/fleet.json): sign-in codes are mailed through the vendor control plane. Until you set one, give a first admin a code yourself:"
    note "  openmausbot pair --port $port --public-url $url --label first-admin"
    note "  (a workspace that refuses command-line pairing needs the mail relay instead; see docs/reseller/install-vps.md)"
  fi
  if [ "$DRY_RUN" = 1 ]; then
    note ""
    note "dry run complete: nothing was changed"
  fi
}

main() {
  parse_args "$@"
  validate_args
  check_prereqs
  install_packages
  install_node
  install_caddy
  install_openmausbot
  install_engine
  check_dns
  fleet_init
  fleet_brand
  fleet_create
  summary
}

main "$@"
