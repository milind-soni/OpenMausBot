#!/bin/sh
# Prepares a Linux Docker host for the bots' sandbox, or takes that back. Docker's default seccomp and AppArmor profiles
# do not let a container build a sandbox of its own, so this installs the two profiles that let the server's container
# run bubblewrap and nothing more: the same two the MausBot connector installs for a Cloud (connector/profiles).
#
#   sudo sh deploy/box/prepare-host.sh            installs both (again: it replaces them with these copies)
#   sudo sh deploy/box/prepare-host.sh --remove   unloads and removes both, unless a container still runs under them
#
# The installer (deploy/install.sh) runs it with MAUSBOT_PROFILES_DIR naming the profiles it downloaded, and its
# --uninstall runs it with --remove. By hand, start the server with deploy/box/compose.box.yaml added afterwards.
# It changes nothing else: no kernel setting, no Docker setting, no package.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
profiles="${MAUSBOT_PROFILES_DIR:-$here/../../connector/profiles}"
etc_dir="${MAUSBOT_ETC_DIR:-/etc/mausbot}"
apparmor_dir="${MAUSBOT_APPARMOR_DIR:-/etc/apparmor.d}"
sysroot="${MAUSBOT_SYSROOT:-}"
seccomp="seccomp-omb-home.json"
profile="omb-home-narrow"

fail() {
  echo "$1" >&2
  exit 1
}

# Whether any container on this host, running or stopped, was started under the sandbox's AppArmor profile.
profile_in_use() {
  command -v docker >/dev/null 2>&1 || return 1
  for id in $(docker ps -aq 2>/dev/null); do
    [ "$(docker inspect -f '{{.AppArmorProfile}}' "$id" 2>/dev/null || true)" != "$profile" ] || return 0
  done
  return 1
}

remove() {
  if profile_in_use; then
    echo "The sandbox's profiles stay: a container on this server still runs under them (a MausBot connector's, or another install's)."
    return 0
  fi
  if [ -f "$apparmor_dir/$profile" ] && command -v apparmor_parser >/dev/null 2>&1; then
    apparmor_parser -R "$apparmor_dir/$profile" >/dev/null 2>&1 || true
  fi
  rm -f "$apparmor_dir/$profile" "$etc_dir/$seccomp"
  rmdir "$etc_dir" 2>/dev/null || true
  echo "The sandbox's profiles are removed from this server."
}

[ "$(uname -s)" = Linux ] || fail "The bots' sandbox needs a Linux host. On macOS and Windows, Docker runs Linux inside a virtual machine this script cannot prepare."
[ "$(id -u)" = 0 ] || fail "Run this as root: sudo sh $0"
case "${1:-}" in
  --remove)
    remove
    exit 0
    ;;
  "") ;;
  *) fail "Unknown option $1. Use no option to prepare this server, or --remove to take it back." ;;
esac
if [ ! -s "$profiles/$seccomp" ] || [ ! -s "$profiles/$profile.apparmor" ]; then
  fail "The sandbox's profiles are missing from $profiles."
fi

max=$(cat "$sysroot/proc/sys/user/max_user_namespaces" 2>/dev/null || echo 1)
clone=$(cat "$sysroot/proc/sys/kernel/unprivileged_userns_clone" 2>/dev/null || echo 1)
if [ "$max" = 0 ] || [ "$clone" != 1 ]; then
  fail "This server switches off user namespaces, which the bots' sandbox needs. Run: printf 'user.max_user_namespaces=63000\\nkernel.unprivileged_userns_clone=1\\n' | sudo tee /etc/sysctl.d/90-mausbot.conf && sudo sysctl --system  and then run this again."
fi
enabled=$(cat "$sysroot/sys/module/apparmor/parameters/enabled" 2>/dev/null || true)
if [ "$enabled" != Y ] || ! command -v apparmor_parser >/dev/null 2>&1; then
  fail "This server is missing AppArmor or its tools, which the bots' sandbox needs. Run: sudo apt-get install -y apparmor  then restart the server and run this again."
fi

install -d -m 0755 "$etc_dir"
install -m 0644 "$profiles/$seccomp" "$etc_dir/$seccomp"
install -m 0644 "$profiles/$profile.apparmor" "$apparmor_dir/$profile"
apparmor_parser -r -W "$apparmor_dir/$profile" || fail "AppArmor refused the sandbox's profile (its message is above)."
if [ -r "$sysroot/sys/kernel/security/apparmor/profiles" ] && ! grep -q "^$profile " "$sysroot/sys/kernel/security/apparmor/profiles"; then
  fail "AppArmor did not load the sandbox's profile. Restart the server and run this again."
fi
echo "This server can run the bots' sandbox."
