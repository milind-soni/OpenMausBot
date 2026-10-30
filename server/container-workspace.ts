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
      '  target="$profiles/$2"' \\
      '  if [ -d "$source" ] && [ ! -L "$source" ] && [ -z "$(find "$target" -mindepth 1 -print -quit)" ]; then' \\
      '    cp -a "$source"/. "$target"/' \\
      '  fi' \\
      '  rm -rf "$source"' \\
      '  ln -s "$target" "$source"' \\
      '}' \\
      'migrate_profile "$HOME/.config/google-chrome" google-chrome' \\
      'migrate_profile "$HOME/.config/chromium" chromium' \\
      'migrate_profile "$HOME/.mozilla" mozilla' \\
      'if [ -d "$HOME/.local" ] && [ ! -L "$HOME/.local" ] && [ -z "$(find "$apps/local" -mindepth 1 -print -quit)" ]; then' \\
      '  cp -a "$HOME/.local"/. "$apps/local"/' \\
      'fi' \\
      'rm -rf "$HOME/.local"' \\
      'ln -s "$apps/local" "$HOME/.local"' \\
      'container_start="$(cat /proc/sys/kernel/random/boot_id):$(sed "s/.*) //" /proc/1/stat | cut -d " " -f20)"' \\
      'prepared="$HOME/.cache/openmausbot-browser-locks"' \\
      'if [ "$(cat "$prepared" 2>/dev/null || true)" != "$container_start" ]; then' \\
      '  find "$profiles" \\( -name SingletonLock -o -name SingletonSocket -o -name SingletonCookie -o -name .parentlock -o -name lock -type l \\) -delete' \\
      '  printf "%s\\n" "$container_start" > "$prepared"' \\
      'fi' \\
      > /usr/local/bin/prepare-openmausbot-workspace.sh \\
    && chmod 0755 /usr/local/bin/prepare-openmausbot-workspace.sh`;
}
