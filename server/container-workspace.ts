export function workspacePreparationDockerfile(workspace: string): string {
  return `RUN printf '%s\\n' \\
      '#!/bin/sh' \
      'set -eu' \
      'workspace=${workspace}' \
      'profiles="$workspace/.browser-profiles"' \
      'apps="$workspace/.desktop-apps"' \
      'for directory in "$workspace" "$profiles" "$apps" "$profiles/google-chrome" "$profiles/chromium" "$profiles/mozilla" "$apps/local"; do' \
      '  if [ -L "$directory" ] || { [ -e "$directory" ] && [ ! -d "$directory" ]; }; then' \
      '    printf "%s\\n" "openmausbot: $directory is not a real directory; refusing to write through it" >&2' \
      '    exit 1' \
      '  fi' \
      'done' \
      'mkdir -p "$profiles/google-chrome" "$profiles/chromium" "$profiles/mozilla" "$apps/local" "$HOME/.config" "$HOME/.cache"' \
      'if ! chmod 0700 "$workspace" "$profiles" "$profiles/google-chrome" "$profiles/chromium" "$profiles/mozilla" 2>/dev/null; then' \
      '  for directory in "$workspace" "$profiles" "$profiles/google-chrome" "$profiles/chromium" "$profiles/mozilla"; do' \
      '    test -r "$directory" && test -w "$directory" && test -x "$directory"' \
      '  done' \
      'fi' \
      'read_link() {' \
      '  if ! _raw=$(readlink "$1" && printf x); then' \
      '    return 1' \
      '  fi' \
      '  _raw=\${_raw%x}' \
      '  _nl=$(printf "\\n."); _nl=\${_nl%.}' \
      '  case "$_raw" in' \
      '    *"$_nl") link_value=\${_raw%"$_nl"} ;;' \
      '    *) link_value=$_raw ;;' \
      '  esac' \
      '}' \
      'require_real_dir() {' \
      '  if [ -L "$1" ] || [ ! -d "$1" ]; then' \
      '    printf "%s\\n" "openmausbot: $1 is not a real directory; refusing to write through it" >&2' \
      '    return 1' \
      '  fi' \
      '}' \
      'copy_entry() {' \
      '  if ! _err=$(cp -an "$1" "$2" 2>&1); then' \
      '    printf "%s\\n" "$_err" >&2' \
      '    return 1' \
      '  fi' \
      '}' \
      'preserve_home() {' \
      '  _source=$1' \
      '  _parent=\${_source%/*}' \
      '  _base=\${_source##*/}' \
      '  if ! _held=$(mktemp -d "$_parent/unmerged-$_base-XXXXXX"); then' \
      '    printf "%s\\n" "openmausbot: could not reserve a recovery directory for $_source; leaving it in place" >&2' \
      '    return 1' \
      '  fi' \
      '  if ! mv "$_source" "$_held/$_base"; then' \
      '    rmdir "$_held" 2>/dev/null || true' \
      '    printf "%s\\n" "openmausbot: could not move $_source aside; leaving it in place" >&2' \
      '    return 1' \
      '  fi' \
      '  printf "%s\\n" "openmausbot: preserved $_source at $_held/$_base; this recovery directory is in the container writable layer and disappears when the container is replaced" >&2' \
      '}' \
      'merge_entry() (' \
      '  src=$1' \
      '  dst=$2' \
      '  status=0' \
      '  if [ -L "$src" ]; then' \
      '    if [ -e "$dst" ] || [ -L "$dst" ]; then' \
      '      if [ ! -L "$dst" ]; then' \
      '        exit 1' \
      '      fi' \
      '    else' \
      '      copy_entry "$src" "$dst" || status=1' \
      '    fi' \
      '    if [ ! -L "$dst" ]; then' \
      '      exit 1' \
      '    fi' \
      '    read_link "$src" || exit 1' \
      '    src_link=$link_value' \
      '    read_link "$dst" || exit 1' \
      '    if [ "$src_link" != "$link_value" ]; then' \
      '      exit 1' \
      '    fi' \
      '    exit "$status"' \
      '  fi' \
      '  if [ -f "$src" ]; then' \
      '    if [ -L "$dst" ]; then' \
      '      exit 1' \
      '    fi' \
      '    if [ ! -e "$dst" ]; then' \
      '      copy_entry "$src" "$dst" || status=1' \
      '    fi' \
      '    if [ -L "$dst" ] || [ ! -f "$dst" ]; then' \
      '      exit 1' \
      '    fi' \
      '    if ! cmp -s "$src" "$dst"; then' \
      '      status=1' \
      '    fi' \
      '    exit "$status"' \
      '  fi' \
      '  if [ ! -d "$src" ]; then' \
      '    exit 1' \
      '  fi' \
      '  if [ -L "$dst" ]; then' \
      '    exit 1' \
      '  fi' \
      '  if [ ! -e "$dst" ]; then' \
      '    copy_entry "$src" "$dst" || status=1' \
      '  fi' \
      '  if [ -L "$dst" ] || [ ! -d "$dst" ]; then' \
      '    exit 1' \
      '  fi' \
      '  if [ ! -r "$src" ] || [ ! -x "$src" ] || [ ! -r "$dst" ] || [ ! -x "$dst" ]; then' \
      '    exit 1' \
      '  fi' \
      '  _nl=$(printf "\\n."); _nl=\${_nl%.}' \
      '  IFS=$_nl' \
      '  for pattern in "*" ".[!.]*" "..?*"; do' \
      '    for src_entry in "$src"/$pattern; do' \
      '      [ -e "$src_entry" ] || [ -L "$src_entry" ] || continue' \
      '      name=\${src_entry##*/}' \
      '      dst_entry=$dst/$name' \
      '      if ! merge_entry "$src_entry" "$dst_entry"; then' \
      '        status=1' \
      '      fi' \
      '    done' \
      '  done' \
      '  exit "$status"' \
      ')' \
      'migrate_home() {' \
      '  source=$1' \
      '  target=$2' \
      '  if [ -L "$source" ]; then' \
      '    read_link "$source" || return 1' \
      '    if [ "$link_value" = "$target" ]; then' \
      '      return 0' \
      '    fi' \
      '  elif [ ! -e "$source" ]; then' \
      '    require_real_dir "$target" || return 1' \
      '    require_real_dir "\${target%/*}" || return 1' \
      '    ln -s "$target" "$source"' \
      '    return 0' \
      '  fi' \
      '  require_real_dir "$target" || return 1' \
      '  require_real_dir "\${target%/*}" || return 1' \
      '  if [ -L "$source" ] || [ ! -d "$source" ]; then' \
      '    preserve_home "$source" || return 1' \
      '    ln -s "$target" "$source"' \
      '    return 0' \
      '  fi' \
      '  if merge_entry "$source" "$target"; then' \
      '    if [ -L "$source" ] || [ ! -d "$source" ]; then' \
      '      printf "%s\\n" "openmausbot: $source changed during migration; leaving it in place" >&2' \
      '      return 1' \
      '    fi' \
      '    rm -rf "$source"' \
      '    ln -s "$target" "$source"' \
      '    return 0' \
      '  fi' \
      '  preserve_home "$source" || return 1' \
      '  ln -s "$target" "$source"' \
      '}' \
      'migrate_home "$HOME/.config/google-chrome" "$profiles/google-chrome"' \
      'migrate_home "$HOME/.config/chromium" "$profiles/chromium"' \
      'migrate_home "$HOME/.mozilla" "$profiles/mozilla"' \
      'migrate_home "$HOME/.local" "$apps/local"' \
      'container_start="$(cat /proc/sys/kernel/random/boot_id):$(sed "s/.*) //" /proc/1/stat | cut -d " " -f20)"' \
      'prepared="$HOME/.cache/openmausbot-browser-locks"' \
      'if [ "$(cat "$prepared" 2>/dev/null || true)" != "$container_start" ]; then' \
      '  find "$profiles" \\( -name SingletonLock -o -name SingletonSocket -o -name SingletonCookie -o -name .parentlock -o -name lock -type l \\) -delete' \
      '  printf "%s\\n" "$container_start" > "$prepared"' \
      'fi' \
      > /usr/local/bin/prepare-openmausbot-workspace.sh \\
    && chmod 0755 /usr/local/bin/prepare-openmausbot-workspace.sh`;
}
