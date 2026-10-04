#!/usr/bin/env bash
set -euo pipefail

# Every shim that branches on `#available` is a ViewModifier, never a
# `@ViewBuilder` extension on View — the rule at the top of
# ios/App/BackDeployCompat.swift. The builder form returns a
# `_ConditionalContent` whose payloads each hold the whole view it was
# applied to, so a chain of N calls builds a view type 2^N–3^N times the
# size, and IRGen on the batch that holds both the shim and its caller runs
# for as long as the job cap allows (5 → 25+ minutes on CI, Oct 2026). The
# type checker's -warn-long-* flags in ios/project.yml do not see that, and
# a build killed at the cap prints nothing, so the shape is caught here, at
# the source, in a second: any `#available(` inside an `extension View { … }`
# block fails with its file:line. A ViewModifier branches over its
# placeholder Content and never trips this.
cd "$(dirname "$0")/.."

hits=$(find ios -name '*.swift' -not -path '*/.build/*' -print0 | xargs -0 awk '
  FNR == 1 { inside = 0; depth = 0 }
  {
    line = $0
    gsub(/"([^"\\]|\\.)*"/, "\"\"", line)     # string literals: a brace or // inside one is text
    sub(/(^|[[:space:]])\/\/.*$/, "", line)   # line comments; "https://" survives
    if (!inside && line ~ /^[[:space:]]*((public|internal|fileprivate|private)[[:space:]]+)?extension[[:space:]]+View([[:space:]]|\{|$)/) inside = 1
    if (!inside) next
    if (line ~ /#available\(/) { shown = $0; sub(/^[[:space:]]+/, "", shown); print FILENAME ":" FNR ": " shown }
    opens = gsub(/\{/, "{", line); closes = gsub(/\}/, "}", line)
    depth += opens - closes
    if (opens + closes > 0 && depth <= 0) { inside = 0; depth = 0 }
  }
')

if [ -n "$hits" ]; then
  printf '%s\n' "$hits"
  echo "::error::An #available branch inside a View extension doubles the caller's view type at every call. Make it a ViewModifier that branches over its content, as in ios/App/BackDeployCompat.swift."
  exit 1
fi
echo "No #available branch inside a View extension."
