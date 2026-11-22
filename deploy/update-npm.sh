#!/bin/bash -p
# Update the fixed-prefix npm installation used by the documented Linux VPS service.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077

unit=openmausbot.service
state_dir=/var/lib/openmausbot-npm-update
journal=$state_dir/pending.json
stable_url=https://raw.githubusercontent.com/milind-soni/OpenMausBot/channels/stable.json
local_url=http://127.0.0.1:8799
version_pattern='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
restore_inode=

die() { printf '%s\n' "$*" >&2; exit 1; }
property() { systemctl show --property="$1" --value "$unit"; }
as_service() {
  runuser -u "$service_user" -- /usr/bin/env -i -C "$service_home" \
    "HOME=$service_home" "USER=$service_user" "LOGNAME=$service_user" "PATH=$service_path" "$@" 9>&-
}
service_test() { as_service /usr/bin/test "$@"; }
physical_dir() {
  service_test -d "$1" && [[ $(as_service /usr/bin/readlink -f -- "$1") == "$1" ]]
}
package_version() {
  as_service /usr/bin/jq -er 'select(.name == "openmausbot" and .bin.openmausbot == "cli.js") | .version | strings' "$1/package.json"
}

read_service() {
  local account uid home exec_start env entry
  [[ $(property LoadState) == loaded && $(property NeedDaemonReload) == no &&
    $(property FragmentPath) == "/etc/systemd/system/$unit" && -z $(property DropInPaths) &&
    $(property Type) == simple && $(property KillMode) == control-group && $(property Slice) == system.slice ]] ||
    die "Expected the documented systemd unit at /etc/systemd/system/$unit, with no overrides."
  for entry in EnvironmentFiles PassEnvironment UnsetEnvironment RootDirectory RootImage \
    BindPaths BindReadOnlyPaths TemporaryFileSystem ExecStartPre ExecStartPost ExecStop ExecStopPost; do
    [[ -z $(property "$entry") ]] || die "$unit uses $entry. This installation needs a manual update."
  done
  service_user=$(property User)
  [[ $service_user =~ ^[a-z_][a-z0-9_-]*$ ]] || die "Expected a named, unprivileged service account."
  account=$(getent passwd "$service_user") || die "Can't find the service account $service_user."
  IFS=: read -r _ _ uid _ _ home _ <<<"$account"
  [[ $uid =~ ^[1-9][0-9]*$ && $home =~ ^/[[:alnum:]_./-]+$ && $home != / &&
    $(property WorkingDirectory) == "$home" ]] || die "Can't verify the service account's home."
  service_home=$home
  prefix=$home/.local
  modules=$prefix/lib/node_modules
  package_dir=$modules/openmausbot
  data_dir=$home/.openmausbot
  cli=$prefix/bin/openmausbot
  exec_start=$(property ExecStart)
  case "$exec_start" in
    "{ path=$cli ; argv[]=$cli serve --tunnel ; ignore_errors=no ; "*|\
    "{ path=$cli ; argv[]=$cli serve --tailscale ; ignore_errors=no ; "*) ;;
    *) die "$unit does not start the fixed-prefix npm CLI with --tunnel or --tailscale." ;;
  esac
  env=$(property Environment)
  [[ $env == "HOME=$home PATH="* ]] || die "$unit must set HOME and PATH as in the Linux VPS guide."
  service_path=${env#"HOME=$home PATH="}
  [[ $service_path =~ ^(/[[:alnum:]_./-]+)(:/[[:alnum:]_./-]+)*$ ]] ||
    die "$unit has additional environment settings or an unsupported PATH."
}

fetch_json() {
  curl --disable -fsS --max-time 5 --max-filesize 65536 --noproxy '*' "$1"
}
healthy() {
  local health pid group process_data
  systemctl is-active --quiet "$unit" || return 1
  health=$(fetch_json "$local_url/api/health") || return 1
  pid=$(jq -er --arg version "$1" \
    'select(.app == "openmausbot" and .version == $version) | .pid | numbers' <<<"$health") || return 1
  [[ $pid =~ ^[1-9][0-9]*$ ]] || return 1
  group=$(property ControlGroup) || return 1
  [[ $group == "/system.slice/$unit" ]] || return 1
  # serve launches the HTTP process as a child within the unit's cgroup.
  grep -Fxq "0::$group" "/proc/$pid/cgroup" &&
    grep -zFxq "OMB_DATA_DIR=$data_dir" "/proc/$pid/environ" &&
    grep -zFxq 'OMB_PORT=8799' "/proc/$pid/environ" || return 1
  process_data=$(stat -Lc '%d:%i' "/proc/$pid/root$data_dir") || return 1
  [[ $process_data == "$(stat -Lc '%d:%i' "$data_dir")" ]]
}
engine_count() {
  local count report
  if count=$(fetch_json "$local_url/api/health/engines" 2>/dev/null |
    jq -er 'select(.app == "openmausbot") | .engines | select(type == "number" and . >= 0 and floor == .)'); then
    printf '%s\n' "$count"
    return
  fi
  # Older releases expose engine readiness through doctor. A zero count can have a nonzero exit status.
  report=$(as_service /usr/bin/timeout 15 "$cli" doctor --json 2>/dev/null) || :
  jq -er 'select(.health.app == "openmausbot") | .availableEngineCount | select(type == "number" and . >= 0 and floor == .)' <<<"$report"
}
wait_healthy() {
  local attempt count consecutive=0 deadline=$((SECONDS + 120))
  for ((attempt = 0; attempt < 30 && SECONDS < deadline; attempt++)); do
    if healthy "$1" 2>/dev/null; then
      consecutive=$((consecutive + 1))
      if ((consecutive >= 3)); then
        if [[ $engine_before == 0 ]]; then return 0; fi
        if count=$(engine_count 2>/dev/null) && [[ $count =~ ^[1-9][0-9]*$ ]]; then return 0; fi
      fi
    else
      consecutive=0
    fi
    sleep 2
  done
  printf 'Version %s or its required engine did not become healthy. See journalctl -u %s.\n' "$1" "$unit" >&2
  return 1
}
stop_service() {
  local active_state events=/sys/fs/cgroup/system.slice/$unit/cgroup.events
  systemctl stop "$unit" || return 1
  active_state=$(property ActiveState) || return 1
  [[ $active_state == inactive || $active_state == failed ]] && [[ $(property MainPID) == 0 ]] &&
    { [[ ! -e $events ]] || grep -Fxq 'populated 0' "$events"; }
}

set_work_paths() {
  data_work=$service_home/.openmausbot-update.$run_id
  package_work=$modules/.openmausbot-update.$run_id
  staged_package=$package_work/install/lib/node_modules/openmausbot
}
write_phase() {
  local next=$1 temporary
  temporary=$(mktemp "$state_dir/.pending.XXXXXXXX") || return 1
  jq -n --arg phase "$next" --arg run "$run_id" --arg user "$service_user" --arg home "$service_home" \
    --arg old "$old_version" --arg target "$target_version" --arg engines "$engine_before" --arg inode "$restore_inode" \
    '{phase: $phase, run: $run, user: $user, home: $home, old: $old, target: $target, engines: $engines, restoreInode: $inode}' \
    >"$temporary" && mv -fT -- "$temporary" "$journal" || return 1
  phase=$next
  sync -f "$state_dir"
}
clear_journal() { rm -- "$journal" && sync -f "$state_dir"; }

restore_previous() {
  local staging preserved
  if [[ $phase == applying ]]; then
    physical_dir "$data_work/snapshot" || return 1
    stop_service || return 1

    if service_test -d "$package_work/previous"; then
      if service_test -d "$package_dir"; then
        as_service /usr/bin/mv -T -- "$package_dir" "$package_work/failed" || return 1
      fi
      as_service /usr/bin/mv -T -- "$package_work/previous" "$package_dir" || return 1
    fi
    [[ $(package_version "$package_dir") == "$old_version" ]] || return 1

    if ! physical_dir "$data_work/replacement"; then
      staging=$(as_service /usr/bin/mktemp -d "$data_work/restore.XXXXXXXX") || return 1
      as_service /usr/bin/cp -a --reflink=auto -- "$data_work/snapshot" "$staging/data" &&
        as_service /usr/bin/mv -T -- "$staging/data" "$data_work/replacement" || return 1
    fi
    restore_inode=$(as_service /usr/bin/stat -c %i -- "$data_work/replacement") || return 1
    as_service /usr/bin/sync -f "$package_dir" && as_service /usr/bin/sync -f "$data_work" &&
      write_phase restoring || return 1
  fi
  if [[ $phase == restoring ]]; then
    [[ $(package_version "$package_dir") == "$old_version" ]] || return 1
    stop_service || return 1
    if physical_dir "$data_work/replacement"; then
      [[ $(as_service /usr/bin/stat -c %i -- "$data_work/replacement") == "$restore_inode" ]] || return 1
      if service_test -e "$data_dir" || service_test -L "$data_dir"; then
        preserved=$(as_service /usr/bin/mktemp -d "$data_work/failed-data.XXXXXXXX") || return 1
        as_service /usr/bin/mv -T -- "$data_dir" "$preserved/data" || return 1
      fi
      as_service /usr/bin/mv -T -- "$data_work/replacement" "$data_dir" || return 1
    fi
    # A reboot between the two renames can leave a freshly created workspace at the live path.
    [[ $(as_service /usr/bin/stat -c %i -- "$data_dir") == "$restore_inode" ]] &&
      as_service /usr/bin/sync -f "$data_dir" && write_phase restored || return 1
  fi
  [[ $(package_version "$package_dir") == "$old_version" ]] &&
    systemctl start "$unit" && wait_healthy "$old_version" && clear_journal
}

failed_update() {
  printf '%s\n' "$*" >&2
  if restore_previous; then
    die "OpenMausBot $old_version is running again. Update files are in $data_work and $package_work."
  fi
  die "Recovery is incomplete. See $journal and $data_work, then run this script with --rollback."
}

read_pending() {
  phase=$(jq -er '.phase | strings' "$journal")
  run_id=$(jq -er '.run | strings' "$journal")
  old_version=$(jq -er '.old | strings' "$journal")
  target_version=$(jq -er '.target | strings' "$journal")
  engine_before=$(jq -er '.engines | strings' "$journal")
  restore_inode=$(jq -er '.restoreInode | strings' "$journal")
  [[ $phase =~ ^(stopping|applying|restoring|restored)$ && $run_id =~ ^[[:alnum:]]{8}$ &&
    $old_version =~ $version_pattern && $target_version =~ $version_pattern && $engine_before =~ ^[0-9]+$ ]] ||
    die "Can't read recovery information in $journal."
  if [[ $phase == restoring && ! $restore_inode =~ ^[1-9][0-9]*$ ]]; then
    die "Can't identify the replacement workspace in $journal."
  fi
  [[ $(jq -r '.user' "$journal") == "$service_user" && $(jq -r '.home' "$journal") == "$service_home" ]] ||
    die "$unit no longer matches the account recorded in $journal."
  set_work_paths
}

case "${1:-}" in
  "") mode=update ;;
  --rollback) mode=rollback ;;
  -h|--help)
    printf '%s\n' 'Usage: sudo ./deploy/update-npm.sh [--rollback]' \
      'Update the documented Linux npm service to stable, or recover an interrupted update.'
    exit 0 ;;
  *) die "Unknown option: $1. See --help." ;;
esac
[[ $# -le 1 ]] || die "Expected at most one option. See --help."
[[ $(uname -s) == Linux && $EUID == 0 ]] || die "Run this updater from a Linux administrator shell."
for tool in systemctl jq curl getent runuser flock mountpoint; do
  command -v "$tool" >/dev/null || die "Required command not found: $tool"
done
[[ -f /sys/fs/cgroup/cgroup.controllers ]] || die "This updater requires systemd with cgroup v2."
[[ ! -L $state_dir ]] || die "$state_dir is a symbolic link."
install -d -m 0700 -- "$state_dir"
[[ $(stat -c %u -- "$state_dir") == 0 ]] || die "$state_dir must be owned by root."
exec 9>"$state_dir/lock"
flock -n 9 || die "Another npm service update is running."
read_service
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -f $journal ]]; then
  read_pending
  [[ $mode == rollback ]] ||
    die "An update to $target_version stopped at $phase. See $journal and $data_work. Use --rollback to restore $old_version."
  printf 'Recovering OpenMausBot %s from %s.\n' "$old_version" "$data_work"
  restore_previous || die "Recovery is incomplete. Check $journal and journalctl -u $unit, then retry --rollback."
  printf 'OpenMausBot %s is running again.\n' "$old_version"
  exit 0
fi
[[ $mode == update ]] || die "There is no interrupted update to recover."

for dir in "$service_home" "$package_dir" "$data_dir"; do
  physical_dir "$dir" || die "Expected a real directory at $dir."
done
for dir in "$package_dir" "$data_dir"; do
  if mountpoint -q -- "$dir"; then die "$dir is a mount point. This installation needs a manual update."; fi
done
[[ $(as_service /usr/bin/readlink -f -- "$cli") == "$package_dir/cli.js" ]] ||
  die "The service CLI does not point into the fixed npm prefix."
old_version=$(package_version "$package_dir") || die "Can't read the installed OpenMausBot package."
[[ $old_version =~ $version_pattern ]] || die "Unsupported installed version: $old_version"
target_version=$(curl --disable -fsS --proto '=https' --max-time 15 --max-filesize 65536 "$stable_url" |
  jq -er '.version | strings') || die "Can't read the stable release. The service was not stopped."
[[ $target_version =~ $version_pattern ]] || die "The stable channel returned an invalid version."
if [[ $target_version == "$old_version" ||
  $(printf '%s\n' "$old_version" "$target_version" | LC_ALL=C sort -V | tail -n 1) != "$target_version" ]]; then
  printf 'OpenMausBot %s is already at or ahead of stable (%s).\n' "$old_version" "$target_version"
  exit 0
fi
healthy "$old_version" || die "Can't verify that $unit is serving OpenMausBot $old_version on port 8799."

run_slot=$(mktemp -d "$state_dir/run.XXXXXXXX")
run_id=${run_slot##*.}
rmdir -- "$run_slot"
set_work_paths
as_service /usr/bin/mkdir -m 0700 -- "$data_work" "$package_work"
printf 'Staging OpenMausBot %s for %s.\n' "$target_version" "$unit"
as_service npm install --global --prefix "$package_work/install" --no-audit --no-fund "openmausbot@$target_version" ||
  die "npm could not stage OpenMausBot $target_version. The service was not stopped."
[[ $(package_version "$staged_package") == "$target_version" ]] ||
  die "The staged package did not report version $target_version. The service was not stopped."
physical_dir "$staged_package" || die "npm staged the package at an unexpected path."
as_service /usr/bin/sync -f "$package_work"

healthy "$old_version" || die "The running service changed while npm was staging the update."
[[ $(property NeedDaemonReload) == no ]] || die "The service unit changed while npm was staging the update."
engine_before=$(engine_count) || die "Can't establish engine readiness before the update."
write_phase stopping || die "Can't record the update. The service was not stopped."
stop_service || failed_update "Could not stop $unit before taking a backup."
printf 'Saving the stopped workspace to %s/snapshot.\n' "$data_work"
if ! physical_dir "$data_dir" ||
  ! as_service /usr/bin/cp -a --reflink=auto -- "$data_dir" "$data_work/snapshot" ||
  ! as_service /usr/bin/sync -f "$data_work"; then
  failed_update "The workspace backup failed."
fi
write_phase applying || failed_update "Could not record the backup."

if ! as_service /usr/bin/mv -T -- "$package_dir" "$package_work/previous" ||
  ! as_service /usr/bin/mv -T -- "$staged_package" "$package_dir" ||
  ! as_service /usr/bin/sync -f "$package_dir" ||
  ! systemctl start "$unit" || ! wait_healthy "$target_version"; then
  failed_update "OpenMausBot $target_version could not be started successfully."
fi
clear_journal
printf 'OpenMausBot %s is running. Backup: %s/snapshot. Previous package: %s/previous.\n' \
  "$target_version" "$data_work" "$package_work"
