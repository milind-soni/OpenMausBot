#!/usr/bin/env bash
# One-shot PR open: uses the GitHub credential stored by Git Credential Manager
# (created the first time you sign in during a push). Stores nothing.
set -euo pipefail
cd "$(dirname "$0")"

REPO=$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# GCM_INTERACTIVE=Never makes `git credential fill` fail fast instead of
# popping a sign-in window — sign-in belongs to `git push`, not to this script.
CRED=$(printf "protocol=https\nhost=github.com\n\n" | GCM_INTERACTIVE=Never git credential fill 2>/dev/null || true)
TOKEN=$(printf '%s' "$CRED" | grep '^password=' | cut -d= -f2- || true)
if [ -z "${TOKEN:-}" ]; then
  echo "No GitHub credential stored yet."
  echo "Run:  git push -u origin $BRANCH   (sign in once at the popup)"
  exit 1
fi

export ASTRA_REPO="$REPO" ASTRA_BRANCH="$BRANCH" ASTRA_TOKEN="$TOKEN"
node -e '
const { ASTRA_REPO: repo, ASTRA_BRANCH: branch, ASTRA_TOKEN: token } = process.env;
const body = require("fs").readFileSync(".omb-pr-body.md", "utf8");
fetch(`https://api.github.com/repos/${repo}/pulls`, {
  method: "POST",
  headers: {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    title: "Windows CUA packaging, Vision unified driver, Deepgram dictate + call STT, API-engine computer use",
    base: "main",
    head: branch,
    body,
  }),
}).then(async (r) => {
  const data = await r.json();
  if (r.ok) console.log("PR opened:", data.html_url);
  else { console.error("Failed:", r.status, JSON.stringify(data).slice(0, 500)); process.exit(1); }
});
'
