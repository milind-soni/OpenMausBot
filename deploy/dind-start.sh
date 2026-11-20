#!/bin/sh
# Entrypoint of the server-dind image (Dockerfile).
# Wants root, `privileged: true` and a volume on /var/lib/docker; without them
# the server starts anyway, with no container runtime.
set -u

serve() {
  cd /app
  if [ "$(id -u)" = 0 ]; then
    exec chroot --skip-chdir --userspec=maus:maus / /usr/bin/tini -s -- node /app/dist-server/server-launcher.js
  fi
  exec /usr/bin/tini -s -- node /app/dist-server/server-launcher.js
}

start_dockerd() {
  [ "$(id -u)" = 0 ] || { echo "Docker-in-Docker needs root (user: \"0:0\"); starting without it." >&2; return 1; }
  mkdir -p /var/lib/docker /var/run /data/.openmausbot
  chown maus:maus /data/.openmausbot
  if [ -x /usr/sbin/iptables-legacy ] && iptables-legacy -t nat -L -n >/dev/null 2>&1; then
    update-alternatives --set iptables /usr/sbin/iptables-legacy || true
    update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy || true
  elif [ -x /usr/sbin/iptables-nft ]; then
    update-alternatives --set iptables /usr/sbin/iptables-nft || true
    update-alternatives --set ip6tables /usr/sbin/ip6tables-nft || true
  fi
  rm -rf /var/run/docker /var/run/docker.pid /var/run/docker.sock
  dockerd \
    --host=unix:///var/run/docker.sock \
    --storage-driver="${OMB_DIND_STORAGE_DRIVER:-overlay2}" \
    --userland-proxy=true \
    >/var/lib/docker/dockerd.log 2>&1 &
  pid=$!
  tries=0
  until docker info >/dev/null 2>&1; do
    tries=$((tries + 1))
    if ! kill -0 "$pid" 2>/dev/null || [ "$tries" -gt 150 ]; then
      echo "dockerd did not start (Docker-in-Docker needs \`privileged: true\` and a volume on /var/lib/docker); starting without it. Log:" >&2
      cat /var/lib/docker/dockerd.log >&2 || true
      kill "$pid" 2>/dev/null || true
      return 1
    fi
    sleep 0.2
  done
  chmod 666 /var/run/docker.sock
}

start_dockerd || true
serve
