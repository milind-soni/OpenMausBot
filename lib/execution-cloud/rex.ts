import { REX_VERSION, REX_SOCKET } from "../../runner/rex.mjs";
export { REX_VERSION as CLOUD_REX_VERSION, REX_SOCKET as CLOUD_REX_SOCKET };
export const CLOUD_REX_BIN = `/opt/origin-rex/${REX_VERSION}/rex`;
export const CLOUD_REX_UNIT = "origin-cloud-rex.service";
// Official preview. Explicit version/hash review is required before changing either architecture.
export const installCloudRex = `set -eu
command -v curl >/dev/null; command -v sha256sum >/dev/null; command -v tar >/dev/null
case "$(uname -m)" in
  x86_64) arch=amd64; sha=b7ee40e9f8ce199ad9992a7601536cd03f5d25166f63c06e6dc1cf866b773a5a;;
  aarch64) arch=arm64; sha=250e05847fedd78d6ca850a222f0db74038070150e3b502c165b111b3f286284;;
  *) exit 72;;
esac
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --max-time 180 "https://blob.superlogical.com/download/rex/preview/1b6654811346488b696ded8f3c7e6701c57242f1/rex-linux-$arch.tar.gz" -o "$tmp/rex.tar.gz"
printf '%s  %s\\n' "$sha" "$tmp/rex.tar.gz" | sha256sum -c - >/dev/null
tar -xzf "$tmp/rex.tar.gz" -C "$tmp" rex
install -d -m 755 /opt/origin-rex/${REX_VERSION}
if test -e ${CLOUD_REX_BIN}; then cmp "$tmp/rex" ${CLOUD_REX_BIN}; else install -m 755 "$tmp/rex" ${CLOUD_REX_BIN}; fi
install -d -m 700 -o origin-runner -g origin-runner /var/lib/origin-runner/.local/state /var/lib/origin-runner/.local/state/origin-rex
`;
export function cloudRexService(path: string) {
  return `[Unit]\nDescription=Origin private Rex server\nAfter=network-online.target\n[Service]\nType=simple\nUser=origin-runner\nGroup=origin-runner\nEnvironment=HOME=/var/lib/origin-runner\nEnvironment=PATH=${path}\nWorkingDirectory=/var/lib/origin-runner\nExecStart=${CLOUD_REX_BIN} server run --listen unix://${REX_SOCKET} --state-dir /var/lib/origin-runner/.local/state/origin-rex --socket-mode 0600\nExecStartPost=/bin/sh -c 'i=0; until ${CLOUD_REX_BIN} --autostart=false --server unix://${REX_SOCKET} server status --json >/dev/null 2>&1; do i=$$((i+1)); [ "$$i" -lt 30 ] || exit 1; sleep 1; done'\nTimeoutStartSec=45\nKillMode=control-group\nTimeoutStopSec=30\nUMask=0077\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nReadWritePaths=/var/lib/origin-runner\nPrivateTmp=yes\n`;
}
