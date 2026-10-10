#!/bin/sh
set -eu

# dpkg runs the old postrm during an upgrade too. Keep the installed profile
# until the package is actually removed or purged.
case "${1:-}" in
  remove|purge) ;;
  *) exit 0 ;;
esac

if [ -n "${OPENMAUSBOT_POSTINSTALL_TEST_ROOT:-}" ]; then
  TEST_ROOT="$(realpath -e -- "$OPENMAUSBOT_POSTINSTALL_TEST_ROOT")"
  case "$TEST_ROOT" in
    /tmp/*) ;;
    *) echo "OpenMausBot test install root must stay under /tmp" >&2; exit 1 ;;
  esac
  APPARMOR_DIR=$TEST_ROOT/test-system/apparmor.d
  APPARMOR_PARSER=$TEST_ROOT/test-system/apparmor_parser
  APPARMOR_STATUS=$TEST_ROOT/test-system/apparmor_status
  APPARMOR_PROFILES=$TEST_ROOT/test-system/apparmor-profiles
  TEST_MODE=1
else
  APPARMOR_DIR=/etc/apparmor.d
  APPARMOR_PARSER=/sbin/apparmor_parser
  APPARMOR_STATUS=/sbin/apparmor_status
  APPARMOR_PROFILES=/sys/kernel/security/apparmor/profiles
  TEST_MODE=0
fi

# Preserve electron-builder's cleanup of the exact legacy launcher. Never
# remove an unrelated file that now happens to use the same command name.
if [ "$TEST_MODE" -eq 0 ]; then
  if command -v update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove openmausbot /opt/OpenMausBot/openmausbot
  elif [ -L /usr/bin/openmausbot ] && [ "$(readlink /usr/bin/openmausbot)" = /opt/OpenMausBot/openmausbot ]; then
    rm -- /usr/bin/openmausbot
  fi
fi

profile=$APPARMOR_DIR/openmausbot-browser
if [ ! -e "$profile" ] && [ ! -L "$profile" ]; then exit 0; fi
if [ -L "$APPARMOR_DIR" ] || [ -L "$profile" ] || [ ! -f "$profile" ]; then
  echo "OpenMausBot AppArmor profile is unsafe; refusing to remove it: $profile" >&2
  exit 1
fi
if [ "$TEST_MODE" -eq 0 ] && [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; then
  : # Removing from an image must not change the host's loaded profiles.
elif [ -x "$APPARMOR_STATUS" ] && ! "$APPARMOR_STATUS" --enabled >/dev/null 2>&1; then
  : # No live policy exists when AppArmor is disabled; remove the staged file.
elif [ -r "$APPARMOR_PROFILES" ] && ! grep -q '^openmausbot-browser ' "$APPARMOR_PROFILES"; then
  : # Already unloaded; purge must also work after an earlier removal.
elif [ -x "$APPARMOR_PARSER" ]; then
  # A profile may already be unloaded (for example during purge after remove).
  # Keep the policy file if unloading genuinely fails so an administrator can
  # inspect/retry the exact rule instead of leaving an invisible kernel rule.
  if ! "$APPARMOR_PARSER" -R "$profile"; then
    echo "OpenMausBot could not unload its browser AppArmor profile: $profile" >&2
    exit 1
  fi
elif [ -r "$APPARMOR_PROFILES" ]; then
  echo "OpenMausBot needs apparmor_parser to unload its browser profile: $profile" >&2
  exit 1
fi
rm -- "$profile"
