#!/bin/sh
# Prepares a Linux Docker host for the bots' sandbox, or takes that back. Docker's default seccomp and AppArmor profiles
# do not let a container build a sandbox of its own, so this installs the two profiles that let the server's container
# run bubblewrap and nothing more: the same two the MausBot connector installs for a Cloud (connector/profiles).
#
#   sudo sh deploy/box/prepare-host.sh            installs both (again: it replaces them with these copies, unless they
#                                                 differ and another container may run under them)
#   sudo sh deploy/box/prepare-host.sh --remove   unloads and removes both, unless a container may still run under them
#
# "May": when Docker cannot be asked about every container, the profiles count as in use, and are kept as they are.
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

# Who runs under the sandbox's AppArmor profile, among every container on this host, running or stopped: none, own (only
# containers of the Compose project MAUSBOT_OWN_PROJECT, the installer's own server), others, or unknown when Docker could
# not list them all or tell about one of them.
profile_users() {
  command -v docker >/dev/null 2>&1 || { echo none; return; }
  ids=$(docker ps -aq 2>/dev/null) || { echo unknown; return; }
  users=none
  for id in $ids; do
    seen=$(docker inspect -f '{{.AppArmorProfile}}|{{index .Config.Labels "com.docker.compose.project"}}' "$id" 2>/dev/null) || { echo unknown; return; }
    [ "${seen%%|*}" = "$profile" ] || continue
    if [ -n "${MAUSBOT_OWN_PROJECT:-}" ] && [ "${seen#*|}" = "$MAUSBOT_OWN_PROJECT" ]; then users=own; else echo others; return; fi
  done
  echo "$users"
}

remove() {
  case "$(profile_users)" in
    none) ;;
    unknown)
      echo "The sandbox's profiles stay: Docker could not say whether a container still runs under them."
      return 0
      ;;
    *)
      echo "The sandbox's profiles stay: a container on this server still runs under them (a MausBot connector's, or another install's)."
      return 0
      ;;
  esac
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

# A copy that differs from what is installed replaces it only when no other container may run under it: a connector's
# Cloud keeps the profile it was started with, and the copy already there serves this server too.
users=$(profile_users)
case "$users" in
  none | own) replace=yes ;;
  *) replace=no ;;
esac
if [ "$replace" = no ] && { { [ -f "$etc_dir/$seccomp" ] && ! cmp -s "$profiles/$seccomp" "$etc_dir/$seccomp"; } || { [ -f "$apparmor_dir/$profile" ] && ! cmp -s "$profiles/$profile.apparmor" "$apparmor_dir/$profile"; }; }; then
  if [ "$users" = unknown ]; then why="Docker could not say whether a container runs under them"; else why="another container runs under them"; fi
  echo "The sandbox's profiles on this server differ from this copy, and $why: they are kept as they are."
fi
install -d -m 0755 "$etc_dir"
if [ "$replace" = yes ] || [ ! -f "$etc_dir/$seccomp" ]; then install -m 0644 "$profiles/$seccomp" "$etc_dir/$seccomp"; fi
if [ "$replace" = yes ] || [ ! -f "$apparmor_dir/$profile" ]; then install -m 0644 "$profiles/$profile.apparmor" "$apparmor_dir/$profile"; fi
apparmor_parser -r -W "$apparmor_dir/$profile" || fail "AppArmor refused the sandbox's profile (its message is above)."
if [ -r "$sysroot/sys/kernel/security/apparmor/profiles" ] && ! grep -q "^$profile " "$sysroot/sys/kernel/security/apparmor/profiles"; then
  fail "AppArmor did not load the sandbox's profile. Restart the server and run this again."
fi
echo "This server can run the bots' sandbox."
