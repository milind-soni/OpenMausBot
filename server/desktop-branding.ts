// Guest presentation is independent of persistent container names/labels.
// Keeping those identities lets existing desktops retain their files.
export const DESKTOP_HOSTNAME = "nation-computer";

// Also applied inside existing managed guests, as the desktop user. No root,
// container replacement, shell history rewrite, or change to saved work.
// Existing shells need a new terminal (or a source of .bashrc) to pick this up.
export const DESKTOP_BRANDING_SCRIPT = `set -eu
profile="$HOME/.config/nation/terminal-v1.bash"
hook='[ ! -r "$HOME/.config/nation/terminal-v1.bash" ] || . "$HOME/.config/nation/terminal-v1.bash"'
if [ ! -f "$profile" ]; then
  mkdir -p "$HOME/.config/nation"
  previous_umask=$(umask)
  umask 077
  cat > "$profile.$$" <<'NATION_TERMINAL'
case $- in *i*) ;; *) return ;; esac
if [ "\${_NATION_TERMINAL_READY:-}" = 1 ]; then return; fi
_NATION_TERMINAL_READY=1
_nation_terminal_prompt() {
  local last_status=$?
  PS1="\${PS1//\\\\h/nation-computer}"
  PS1="\${PS1//\\\\H/nation-computer}"
  PS1="\${PS1//openmausbot-computer/nation-computer}"
  printf '\\033]0;NATION Computer\\007'
  return "$last_status"
}
# Retain user prompt callbacks, including Bash's array form.
if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
  PROMPT_COMMAND+=(_nation_terminal_prompt)
else
  PROMPT_COMMAND="\${PROMPT_COMMAND:+$PROMPT_COMMAND; }_nation_terminal_prompt"
fi
_nation_terminal_prompt
NATION_TERMINAL
  mv "$profile.$$" "$profile"
  umask "$previous_umask"
fi
if ! grep -Fqx "$hook" "$HOME/.bashrc" 2>/dev/null; then
  printf '\\n%s\\n' "$hook" >> "$HOME/.bashrc"
fi
exec "$@"`;
