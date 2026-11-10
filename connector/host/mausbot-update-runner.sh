#!/bin/sh
# Runs on a customer-run server, as root, outside every container: systemd starts it when the MausBot connector leaves
# an update request (mausbot-update.path watches for the file). It hands the request to the server's own updater,
# update.sh in the install's folder, the same command its owner runs by hand, and writes down how that ended.
#
# The request is two lines, `id=<job id>` and `image=<image>`. The image must be MausBot's server image pinned by
# digest; anything else is refused here, whatever the connector wrote. Nothing else in the request is read.
set -u

DIR="${MAUSBOT_UPDATE_DIR:-/var/lib/mausbot/update}"
INSTALL_DIR="${MAUSBOT_INSTALL_DIR:-/opt/openmausbot}"
REQUEST="$DIR/request"

[ -f "$REQUEST" ] || exit 0
id=$(sed -n 's/^id=//p' "$REQUEST" | head -n 1)
image=$(sed -n 's/^image=//p' "$REQUEST" | head -n 1)
rm -f "$REQUEST"
printf '%s' "$id" | grep -Eqx '[A-Za-z0-9_-]{1,64}' || exit 0

answer() { # the updater's exit code, for the connector to read
  printf 'id=%s\ncode=%s\n' "$id" "$1" >"$DIR/result.tmp" && mv "$DIR/result.tmp" "$DIR/result"
}

if ! printf '%s' "$image" | grep -Eqx 'ghcr\.io/milind-soni/openmausbot@sha256:[0-9a-f]{64}'; then
  answer 4
  exit 0
fi
if [ ! -f "$INSTALL_DIR/update.sh" ]; then
  answer 127
  exit 0
fi
code=0
bash "$INSTALL_DIR/update.sh" --dir "$INSTALL_DIR" --image "$image" >>"$DIR/runner.log" 2>&1 || code=$?
answer "$code"
