#!/bin/sh
# Run during the Daytona desktop snapshot build, never on NATION's host.
# Keep Python, git, a POSIX shell and Node/npm in that snapshot.
set -eu
command -v python3 >/dev/null
command -v git >/dev/null
command -v node >/dev/null
command -v npm >/dev/null
npm install --prefix /opt/nation-codex --ignore-scripts --no-audit --no-fund @openai/codex@0.157.1
ln -sfn /opt/nation-codex/node_modules/.bin/codex /usr/local/bin/codex
test "$(codex --version)" = "codex-cli 0.157.1"
python3 -c 'import gzip, json, pathlib, subprocess, threading, urllib.request'
