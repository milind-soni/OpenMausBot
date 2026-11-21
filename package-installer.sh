#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: bash package-installer.sh <mac|windows>"
  echo "  mac      Build a DMG for the current Mac architecture on macOS."
  echo "  windows  Build an x64 setup EXE on Windows x64 (Git Bash)."
  echo "Installers are written to release/."
}

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 2
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

case "$1" in
  --help|-h)
    usage
    exit 0
    ;;
  mac)
    case "$(node -p 'process.platform + "-" + process.arch')" in
      darwin-arm64) arch=arm64 ;;
      darwin-x64) arch=x64 ;;
      *) echo "mac requires macOS with arm64 or x64 Node.js." >&2; exit 1 ;;
    esac
    export OPENMAUSBOT_CUA_ARCHES="$arch" OPENMAUSBOT_CUA_ARCHES_PARTIAL=1
    export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
    pnpm package:prepare
    pnpm build:speech
    pnpm build:cua
    exec pnpm exec electron-builder --mac dmg "--$arch" --publish never \
      -c.mac.identity=- -c.dmg.sign=false
    ;;
  windows)
    if [[ "$(node -p 'process.platform + "-" + process.arch')" != win32-x64 ]]; then
      echo "windows requires Windows with x64 Node.js." >&2
      exit 1
    fi
    export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
    pnpm package:prepare
    pnpm build:cua:win
    exec pnpm exec electron-builder --win nsis --x64 --publish never
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
