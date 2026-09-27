// Runs only on the assigned Orgo computer. No backend credentials are included.
// Keep the distribution pinned and verify its official checksum before extraction.
export const ORGO_CODING_BOOTSTRAP = String.raw`set -eu
export PATH=/usr/local/bin:/usr/bin:/bin
command -v python3 >/dev/null
command -v git >/dev/null
if [ "$(/opt/nation-node/bin/node --version 2>/dev/null || true)" != "v24.16.0" ]; then
  case "$(uname -m)" in x86_64) arch=x64;; aarch64) arch=arm64;; *) exit 1;; esac
  work=$(mktemp -d)
  trap 'rm -rf -- "$work"' EXIT
  cd "$work"
  archive="node-v24.16.0-linux-$arch.tar.gz"
  curl --connect-timeout 10 --max-time 90 -fsSLO "https://nodejs.org/dist/v24.16.0/$archive"
  curl --connect-timeout 10 --max-time 15 -fsSLO https://nodejs.org/dist/v24.16.0/SHASUMS256.txt
  grep " $archive\$" SHASUMS256.txt | sha256sum -c -
  mkdir -p /opt/nation-node
  tar -xzf "$archive" --strip-components=1 -C /opt/nation-node
fi
ln -sfn /opt/nation-node/bin/node /usr/local/bin/node
ln -sfn /opt/nation-node/bin/npm /usr/local/bin/npm
if [ "$(/opt/nation-codex/node_modules/.bin/codex --version 2>/dev/null || true)" != "codex-cli 0.157.1" ]; then
  npm install --prefix /opt/nation-codex --ignore-scripts --no-audit --no-fund @openai/codex@0.157.1
fi
ln -sfn /opt/nation-codex/node_modules/.bin/codex /usr/local/bin/codex
test "$(codex --version)" = "codex-cli 0.157.1"
`;
