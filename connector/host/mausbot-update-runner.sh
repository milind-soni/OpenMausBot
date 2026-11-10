#!/bin/sh
# Runs on a customer-run server, as root, outside every container: systemd starts it when the MausBot connector leaves
# an update request (mausbot-update.path watches for the file). It hands the request to the server's own updater,
# update.sh in the install's folder, the same command its owner runs by hand, and writes down how that ended.
#
# The request is two lines, `id=<job id>` and `image=<image>`. The image must be MausBot's server image pinned by
# digest, and its version must not be older than the one running here or than FLOOR; anything else is refused here,
# whatever the connector wrote. Nothing else in the request is read. To go back to an older version, run update.sh
# yourself: that is yours to decide, never MausBot's.
set -u

DIR="${MAUSBOT_UPDATE_DIR:-/var/lib/mausbot/update}"
INSTALL_DIR="${MAUSBOT_INSTALL_DIR:-/opt/openmausbot}"
REQUEST="$DIR/request"
FLOOR=0.0.0
VERSION_LABEL=org.opencontainers.image.version

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

version_of() { # image → its released version as "1 2 3", or nothing
  docker image inspect -f "{{index .Config.Labels \"$VERSION_LABEL\"}}" "$1" 2>/dev/null |
    sed -n 's/^v\{0,1\}\([0-9]\{1,5\}\)\.\([0-9]\{1,5\}\)\.\([0-9]\{1,5\}\)$/\1 \2 \3/p'
}
older() { # "a b c" "x y z": true when the first is the older version
  # shellcheck disable=SC2086
  set -- $1 $2
  [ "$1" -lt "$4" ] || { [ "$1" -eq "$4" ] && { [ "$2" -lt "$5" ] || { [ "$2" -eq "$5" ] && [ "$3" -lt "$6" ]; }; }; }
}
docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >>"$DIR/runner.log" 2>&1 || { answer 4; exit 0; }
wanted=$(version_of "$image")
running=""
container=$(docker ps -aq --filter label=com.docker.compose.project=openmausbot --filter label=com.docker.compose.service=omb 2>/dev/null | head -n 1)
if [ -n "$container" ]; then running=$(version_of "$(docker inspect -f '{{.Image}}' "$container" 2>/dev/null)"); fi
if [ -z "$wanted" ] || older "$wanted" "$(printf '%s' "$FLOOR" | tr . ' ')" || { [ -n "$running" ] && older "$wanted" "$running"; }; then
  answer 5
  exit 0
fi
code=0
bash "$INSTALL_DIR/update.sh" --dir "$INSTALL_DIR" --image "$image" >>"$DIR/runner.log" 2>&1 || code=$?
answer "$code"
