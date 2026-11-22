#!/bin/sh
# Caddy (port 8080, behind Fly's TLS) in the background, the MausBot server in the foreground.
set -e
mkdir -p /run/openmausbot
caddy run --config /etc/omb-fly/Caddyfile --adapter caddyfile &
exec node /app/dist-server/server-launcher.js
