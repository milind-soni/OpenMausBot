// Release pins: https://releases.herdr.dev/core/0.1.18/manifest.json.
// This is a dedicated worker core, never a provider/root user's personal session.
export const CLOUD_HERDR_VERSION = "0.1.18";
export const CLOUD_HERDR_SESSION = "origin-cloud";
export const CLOUD_HERDR_BIN = "/opt/origin-herdr/0.1.18/herdr-core";
export const CLOUD_HERDR_HOME = "/var/lib/origin-runner";
export const CLOUD_HERDR_ENV = `HOME=${CLOUD_HERDR_HOME} USER=origin-runner LOGNAME=origin-runner HC_SESSION=${CLOUD_HERDR_SESSION} XDG_CONFIG_HOME=${CLOUD_HERDR_HOME}/.config XDG_DATA_HOME=${CLOUD_HERDR_HOME}/.local/share XDG_CACHE_HOME=${CLOUD_HERDR_HOME}/.cache`;

export const installCloudHerdr = `set -eu
command -v curl >/dev/null; command -v sha256sum >/dev/null; command -v tar >/dev/null
case "$(uname -m)" in
  x86_64) arch=x86_64; sha=5b2f97cb4b2a9d7a6b2cc5942628203ed9fbb7cc0c2b4b09ad8a6f5648e246b7;;
  aarch64) arch=aarch64; sha=cf33393cf950bb763734dc3e16610ab9daf8492391a4ef0de56026cd7f752853;;
  *) exit 72;;
esac
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 180 "https://releases.herdr.dev/core/0.1.18/herdr-core-linux-$arch.tar.gz?src=install" -o "$tmp/core.tar.gz"
printf '%s  %s\\n' "$sha" "$tmp/core.tar.gz" | sha256sum -c - >/dev/null
tar -xzf "$tmp/core.tar.gz" -C "$tmp" herdr-core
test "$("$tmp/herdr-core" --version)" = 'hc 0.1.18'
install -d -m 755 /opt/origin-herdr/0.1.18
if test -e ${CLOUD_HERDR_BIN}; then
  cmp "$tmp/herdr-core" ${CLOUD_HERDR_BIN}
else
  install -m 755 "$tmp/herdr-core" ${CLOUD_HERDR_BIN}
fi
install -d -m 700 -o origin-runner -g origin-runner ${CLOUD_HERDR_HOME}/.local/bin ${CLOUD_HERDR_HOME}/.cache
ln -sfn ${CLOUD_HERDR_BIN} ${CLOUD_HERDR_HOME}/.local/bin/hc
ln -sfn ${CLOUD_HERDR_BIN} ${CLOUD_HERDR_HOME}/.local/bin/herdr-core
`;

export function cloudHerdrService(path: string) {
  return `[Unit]\nDescription=Origin private Herdr core\nAfter=network-online.target\n[Service]\nType=oneshot\nUser=origin-runner\nGroup=origin-runner\nEnvironment=${CLOUD_HERDR_ENV.split(" ").join("\nEnvironment=")}\nEnvironment=PATH=${path}\nWorkingDirectory=${CLOUD_HERDR_HOME}\nExecStart=${CLOUD_HERDR_BIN} server start\nExecStop=${CLOUD_HERDR_BIN} server stop\nRemainAfterExit=yes\nKillMode=control-group\nTimeoutStopSec=30\nUMask=0077\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nReadWritePaths=${CLOUD_HERDR_HOME}\nPrivateTmp=yes\n`;
}
export const CLOUD_HERDR_UNIT = "origin-cloud-herdr.service";
