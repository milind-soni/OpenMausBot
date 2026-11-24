export function workspacePreparationDockerfile(workspace: string): string {
  return `RUN printf '%s\\n' \\
      '#!/bin/sh' \\
      'set -eu' \\
      'workspace=${workspace}' \\
      'profiles="$workspace/.browser-profiles"' \\
      'apps="$workspace/.desktop-apps"' \\
      'mkdir -p "$profiles/google-chrome" "$profiles/chromium" "$profiles/mozilla" "$apps/local" "$HOME/.config" "$HOME/.cache"' \\
      'if ! chmod 0700 "$workspace" "$profiles" "$profiles/google-chrome" "$profiles/chromium" "$profiles/mozilla" 2>/dev/null; then' \\
      '  for directory in "$workspace" "$profiles" "$profiles/google-chrome" "$profiles/chromium" "$profiles/mozilla"; do' \\
      '    test -r "$directory" && test -w "$directory" && test -x "$directory"' \\
      '  done' \\
      'fi' \\
      'migrate_profile() {' \\
      '  source="$1"' \\
      '  target="$2"' \\
      '  if [ -e "$source" ] && [ ! -L "$source" ]; then' \\
      '    if [ -d "$source" ]; then' \\
      '      cp -an "$source/." "$target/" || true' \\
      '      missing=$(cd "$source" && find . -mindepth 1 -print | while IFS= read -r item; do' \\
      '        if [ -L "$item" ]; then' \\
      '          [ "$(readlink "$item")" = "$(readlink "$target/$item" || true)" ] || echo "$item"' \\
      '        elif [ -f "$item" ]; then' \\
      '          cmp -s "$item" "$target/$item" || echo "$item"' \\
      '        elif [ ! -e "$target/$item" ]; then' \\
      '          echo "$item"' \\
      '        fi' \\
      '      done)' \\
      '      if [ -z "$missing" ]; then' \\
      '        rm -rf "$source"' \\
      '      else' \\
      '        mv "$source" "$workspace/unmerged-$(basename "$target")-$(date +%s)-$$"' \\
      '      fi' \\
      '    else' \\
      '      name=$(basename "$source")' \\
      '      if [ -f "$target/$name" ] && cmp -s "$source" "$target/$name"; then' \\
      '        rm -f "$source"' \\
      '      elif [ ! -e "$target/$name" ]; then' \\
      '        cp -a "$source" "$target/$name"' \\
      '        rm -f "$source"' \\
      '      else' \\
      '        mv "$source" "$workspace/unmerged-$name-$(date +%s)-$$"' \\
      '      fi' \\
      '    fi' \\
      '  fi' \\
      '  rm -rf "$source"' \\
      '  ln -s "$target" "$source"' \\
      '}' \\
      'migrate_profile "$HOME/.config/google-chrome" "$profiles/google-chrome"' \\
      'migrate_profile "$HOME/.config/chromium" "$profiles/chromium"' \\
      'migrate_profile "$HOME/.mozilla" "$profiles/mozilla"' \\
      'migrate_profile "$HOME/.local" "$apps/local"' \\
      'container_start="$(cat /proc/sys/kernel/random/boot_id):$(sed "s/.*) //" /proc/1/stat | cut -d " " -f20)"' \\
      'prepared="$HOME/.cache/openmausbot-browser-locks"' \\
      'if [ "$(cat "$prepared" 2>/dev/null || true)" != "$container_start" ]; then' \\
      '  find "$profiles" \\( -name SingletonLock -o -name SingletonSocket -o -name SingletonCookie -o -name .parentlock -o -name lock -type l \\) -delete' \\
      '  printf "%s\\n" "$container_start" > "$prepared"' \\
      'fi' \\
      > /usr/local/bin/prepare-openmausbot-workspace.sh \\
    && chmod 0755 /usr/local/bin/prepare-openmausbot-workspace.sh`;
}
