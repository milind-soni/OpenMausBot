#!/bin/sh
# Prepares a Linux Docker host for the bot box (docs/self-hosting.md, "The hardened profile"). A container may not build
# a sandbox of its own under Docker's default seccomp and AppArmor profiles, so this installs the two profiles that let
# the server's container run bubblewrap and nothing more: the same two the MausBot connector installs
# (connector/profiles). Run it once, as root, from a checkout of this repository:
#
#   sudo sh deploy/box/prepare-host.sh
#
# Then start the server with deploy/box/compose.box.yaml added, or with the four --security-opt flags it holds.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
profiles="${MAUSBOT_PROFILES_DIR:-$here/../../connector/profiles}"
etc_dir="${MAUSBOT_ETC_DIR:-/etc/mausbot}"
apparmor_dir="${MAUSBOT_APPARMOR_DIR:-/etc/apparmor.d}"
seccomp=seccomp-omb-home.json
profile=omb-home-narrow

fail() {
  echo "$1" >&2
  exit 1
}

[ "$(uname -s)" = Linux ] || fail "The bot box needs a Linux host. On macOS and Windows, Docker runs Linux inside a virtual machine this script cannot prepare."
[ "$(id -u)" = 0 ] || fail "Run this as root: sudo sh $0"
[ -s "$profiles/$seccomp" ] && [ -s "$profiles/$profile.apparmor" ] || fail "The profiles are missing from $profiles. Run this from a checkout of the OpenMausBot repository."

max=$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 1)
clone=$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)
if [ "$max" = 0 ] || [ "$clone" != 1 ]; then
  fail "This server switches off a Linux feature the bot box needs. Run: printf 'user.max_user_namespaces=63000\\nkernel.unprivileged_userns_clone=1\\n' | sudo tee /etc/sysctl.d/90-mausbot.conf && sudo sysctl --system  and then run this again."
fi
enabled=$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null || true)
if [ "$enabled" != Y ] || ! command -v apparmor_parser >/dev/null 2>&1; then
  fail "This server is missing AppArmor or its tools, a standard part of Ubuntu and Debian. Run: sudo apt-get install -y apparmor  then restart the server and run this again."
fi

install -d -m 0755 "$etc_dir"
install -m 0644 "$profiles/$seccomp" "$etc_dir/$seccomp"
install -m 0644 "$profiles/$profile.apparmor" "$apparmor_dir/$profile"
apparmor_parser -r -W "$apparmor_dir/$profile" || fail "AppArmor refused the bot box's profile (its message is above)."
if [ -r /sys/kernel/security/apparmor/profiles ] && ! grep -q "^$profile " /sys/kernel/security/apparmor/profiles; then
  fail "AppArmor did not load the bot box's profile. Restart the server and run this again."
fi

echo "This server can run the bot box."
echo "Start MausBot with the box's settings added, for example:"
echo "  docker compose -f compose.yaml -f deploy/box/compose.box.yaml up -d"
