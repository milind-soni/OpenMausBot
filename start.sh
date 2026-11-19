#!/bin/bash
set -euo pipefail

if [[ "${RAILWAY_VOLUME_MOUNT_PATH:-}" != /data ]] || ! mountpoint -q /data; then
    echo 'Attach the Railway volume at /data before starting.' >&2
    exit 1
fi

: "${RAILWAY_PUBLIC_DOMAIN:?Generate a Railway HTTPS domain first}"
export OMB_PUBLIC_URL="https://${RAILWAY_PUBLIC_DOMAIN}"

chown maus:maus /data
chmod 0700 /data
install -d -o maus -g maus -m 0700 /run/openmausbot /data/.codex

setpriv --reuid=maus --regid=maus --init-groups node /app/dist-server/server-launcher.js &
server_pid=$!
setpriv --reuid=maus --regid=maus --init-groups caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
proxy_pid=$!

shutdown() {
    trap '' TERM INT
    kill -TERM "$server_pid" "$proxy_pid" 2>/dev/null || true
    wait "$server_pid" "$proxy_pid" || true
}

trap 'shutdown; exit 0' TERM INT
wait -n "$server_pid" "$proxy_pid" || true
shutdown
exit 1
