// macOS adapter for a named remote CUA worker.
//
// The transport, lease and shared readiness ladder live in
// ./remote-worker.ts. This module owns only what Windows has no counterpart
// for: the POSIX health probe, the Aqua console session, the unix-socket
// control channel, the admin-group rule, and TCC.
//
// TCC is the one check with no Windows analogue and the one an operator
// cannot script away: Accessibility and Screen Recording are granted
// per-binary, System Integrity Protection blocks writing the TCC database,
// and replacing the driver binary silently revokes them. So the probe reads
// the live grant on every poll rather than trusting a setup step that
// happened once. The probe asks the running daemon's `check_permissions` tool
// with prompting disabled and requires daemon attribution; a standalone SDK
// read would report the SSH process's responsible application instead.
import {
  applyHealthReport,
  baseWorkerStatus,
  defaultRemoteWorkerRunner,
  evaluateSharedHealth,
  failWorker,
  finishWorkerStatus,
  remoteWorkerSshBaseArgs,
  WORKER_SSH_TIMEOUT_MS,
  type RemoteWorkerLease,
  type RemoteWorkerSshRunner,
  type RemoteWorkerStatus,
} from "./remote-worker.ts";
import type { ResolvedWorker } from "./computer-workers.ts";
import { parseJson, type JsonValue } from "./schema.ts";
import { refreshParkedWorker } from "./worker-task-transport.ts";

/** Fixed by convention under the worker account's own home so the socket and
 * its directory can both be owner-private. The probe reports the resolved
 * absolute path and the control plane pins it into the MCP generation. */
export const MAC_CUA_SOCKET_RELATIVE = ".openmausbot/run/cua.sock";
export const MAC_SUPPORT_RELATIVE = "Library/Application Support/OpenMausBot";
export const MAC_POLICY_RELATIVE = `${MAC_SUPPORT_RELATIVE}/macos-policy.yaml`;
export const MAC_CAPABILITY_RELATIVE = `${MAC_SUPPORT_RELATIVE}/active-capabilities.yaml`;

// POSIX sh, no bashisms: the worker account's login shell is the operator's
// choice, so this runs under `/bin/sh -s` with the script on stdin. Every
// probe is read-only and none of them prompt.
const MAC_HEALTH_SCRIPT = String.raw`
set -u
support="$HOME/Library/Application Support/OpenMausBot"
sock="$HOME/.openmausbot/run/cua.sock"

json_str() {
  if [ -z "$1" ]; then printf 'null'; else printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; fi
}
json_bool() { if [ "$1" = "1" ]; then printf 'true'; else printf 'false'; fi; }

driver_version=$(cua-driver --version 2>/dev/null | sed -n 's/.*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1)
companion_version=$(openmausbot-worker-companion --version 2>/dev/null | sed -n 's/.*[^0-9]\([0-9][0-9]*\)$/\1/p' | head -n 1)
[ -n "$companion_version" ] || companion_version=null

# An admin worker account could rewrite the very policy that bounds it.
privileged=0
if id -Gn 2>/dev/null | tr ' ' '\n' | grep -qx admin; then privileged=1; fi

# The Aqua session that owns /dev/console is the only one with a real screen.
# Its uid doubles as the session identifier: macOS has no Windows-style
# numeric window-station id, and "whose login session" is the fact that
# actually matters for driving a desktop.
console_user=$(stat -f%Su /dev/console 2>/dev/null)
current_user=$(id -un 2>/dev/null)
interactive=0
interactive_session_id=null
if [ -n "$console_user" ] && [ "$console_user" = "$current_user" ] && launchctl print "gui/$(id -u)" >/dev/null 2>&1; then
  interactive=1
  interactive_session_id=$(id -u)
fi

# CGSSessionScreenIsLocked is absent entirely while unlocked.
locked=0
if ioreg -n Root -d1 -a 2>/dev/null | grep -q CGSSessionScreenIsLocked; then locked=1; fi

channel_available=0
channel_access=missing
if [ -S "$sock" ]; then
  channel_available=1
  if [ -r "$sock" ] && [ -w "$sock" ]; then channel_access=ok; else channel_access=denied; channel_available=0; fi
fi

digest_of() {
  if [ -f "$1" ]; then shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'; fi
}
policy_digest=$(digest_of "$support/macos-policy.yaml")
capability_digest=$(digest_of "$support/active-capabilities.yaml")

status_text=$(cua-driver status --socket "$sock" 2>/dev/null | tr '[:upper:]' '[:lower:]')
policy_loaded=0
if [ -n "$policy_digest" ] && printf '%s' "$status_text" | grep -qF "$policy_digest"; then policy_loaded=1; fi
capability_loaded=0
if [ -n "$capability_digest" ] && printf '%s' "$status_text" | grep -qF "$capability_digest"; then capability_loaded=1; fi
permission_mode=unknown
if printf '%s' "$status_text" | grep -qw bounded; then permission_mode=bounded
elif printf '%s' "$status_text" | grep -qw standard; then permission_mode=standard
elif printf '%s' "$status_text" | grep -qw unrestricted; then permission_mode=unrestricted
fi

# Ask the daemon itself. A standalone helper process reports its own launching
# app's TCC identity, not the daemon's, so readiness also pins the response's
# source attribution. Absent or unparseable output fails closed.
tcc=''
permission_probe_expired=0
if ! tcc=$(cua-driver call check_permissions '{"prompt":false}' --socket "$sock" 2>&1); then
  if printf '%s' "$tcc" | grep -Eq 'capability manifest (expired|idle timeout exceeded)'; then
    permission_probe_expired=1
  fi
  tcc=''
fi
accessibility=0
screen_recording=0
permission_attribution=unknown
if printf '%s' "$tcc" | grep -q '"accessibility"[[:space:]]*:[[:space:]]*true'; then accessibility=1; fi
if printf '%s' "$tcc" | grep -q '"screen_recording"[[:space:]]*:[[:space:]]*true'; then screen_recording=1; fi
if printf '%s' "$tcc" | grep -q '"attribution"[[:space:]]*:[[:space:]]*"driver-daemon"'; then permission_attribution=driver-daemon
elif printf '%s' "$tcc" | grep -q '"attribution"[[:space:]]*:[[:space:]]*"host"'; then permission_attribution=host
elif printf '%s' "$tcc" | grep -q '"attribution"[[:space:]]*:[[:space:]]*"caller"'; then permission_attribution=caller
fi

printf '{'
printf '"driverVersion":%s,' "$(json_str "$driver_version")"
printf '"companionVersion":%s,' "$companion_version"
printf '"privileged":%s,' "$(json_bool "$privileged")"
printf '"interactiveSession":%s,' "$(json_bool "$interactive")"
printf '"interactiveSessionId":%s,' "$interactive_session_id"
printf '"locked":%s,' "$(json_bool "$locked")"
printf '"channelPath":%s,' "$(json_str "$sock")"
printf '"channelAvailable":%s,' "$(json_bool "$channel_available")"
printf '"channelAccess":%s,' "$(json_str "$channel_access")"
printf '"policyDigest":%s,' "$(json_str "$policy_digest")"
printf '"policyLoaded":%s,' "$(json_bool "$policy_loaded")"
printf '"permissionMode":%s,' "$(json_str "$permission_mode")"
printf '"capabilityDigest":%s,' "$(json_str "$capability_digest")"
printf '"capabilityLoaded":%s,' "$(json_bool "$capability_loaded")"
printf '"permissionAttribution":%s,' "$(json_str "$permission_attribution")"
printf '"permissionProbeExpired":%s,' "$(json_bool "$permission_probe_expired")"
printf '"accessibilityGranted":%s,' "$(json_bool "$accessibility")"
printf '"screenRecordingGranted":%s' "$(json_bool "$screen_recording")"
printf '}'
`;

/** A UI poll and a turn start may observe the same expired parked daemon at
 * once. Collapse them onto one fixed companion restart per SSH alias. */
const parkedRefreshes = new Map<string, Promise<void>>();

async function refreshExpiredParked(
  worker: ResolvedWorker,
  runner: RemoteWorkerSshRunner,
): Promise<void> {
  const key = worker.sshAlias.toLowerCase();
  const current = parkedRefreshes.get(key);
  if (current) return current;
  const pending = (async () => {
    try {
      await refreshParkedWorker(worker, runner);
    } finally {
      parkedRefreshes.delete(key);
    }
  })();
  parkedRefreshes.set(key, pending);
  return pending;
}

export function macWorkerHealthArgs(sshAlias: string): string[] {
  // Keep the fixed probe off argv and on stdin, matching the Windows adapter:
  // one short, inspectable command in the worker's process listing.
  return [...remoteWorkerSshBaseArgs(sshAlias), "/bin/sh", "-s"];
}

/** The macOS-only tail of the readiness ladder. Runs after the shared checks
 * so a missing driver or an unlocked-screen fault is reported before TCC. */
export function evaluateMacHealth(status: RemoteWorkerStatus): RemoteWorkerStatus | null {
  if (status.permissionProbeExpired) {
    return failWorker(status, "policy_mismatch", "worker_capability_mismatch",
      "The CUA capability expired or idled out and must be refreshed");
  }
  if (status.permissionAttribution !== "driver-daemon") {
    return failWorker(status, "policy_mismatch", "worker_permission_attribution_mismatch",
      "CUA Driver permission status did not come from the running driver daemon");
  }
  if (status.accessibilityGranted !== true) {
    return failWorker(status, "policy_mismatch", "worker_accessibility_denied",
      "Grant Accessibility to CUA Driver in the guest's System Settings > Privacy & Security");
  }
  if (status.screenRecordingGranted !== true) {
    return failWorker(status, "policy_mismatch", "worker_screen_recording_denied",
      "Grant Screen Recording to CUA Driver in the guest's System Settings > Privacy & Security");
  }
  return null;
}

export async function macWorkerStatus(
  worker: ResolvedWorker,
  options: {
    runner?: RemoteWorkerSshRunner;
    lease?: RemoteWorkerLease;
    isBotBusy?: (botId: string) => boolean;
    expectedCapabilityDigest?: string | null;
    refreshExpiredParked?: boolean;
  } = {},
): Promise<RemoteWorkerStatus> {
  const status = baseWorkerStatus(worker);
  status.expectedCapabilityDigest = options.expectedCapabilityDigest ?? worker.expectedParkedCapabilitySha256;
  if (!worker.configured) return status;
  if (worker.paused) return failWorker(status, "paused", "worker_paused", "This worker is paused");

  const runner = options.runner ?? defaultRemoteWorkerRunner;
  let report: JsonValue;
  try {
    const result = await runner(macWorkerHealthArgs(worker.sshAlias), WORKER_SSH_TIMEOUT_MS, MAC_HEALTH_SCRIPT);
    report = parseJson(result.stdout.trim());
  } catch {
    return failWorker(status, "offline", "worker_offline", "Worker SSH is offline or unreachable");
  }

  applyHealthReport(status, report);
  const shared = evaluateSharedHealth(status);
  if (shared) return shared;
  if (
    options.refreshExpiredParked !== false
    && status.permissionProbeExpired
    && status.expectedCapabilityDigest === worker.expectedParkedCapabilitySha256
  ) {
    try {
      await refreshExpiredParked(worker, runner);
    } catch {
      return failWorker(status, "policy_mismatch", "worker_capability_mismatch",
        "The expired parked CUA capability could not be refreshed");
    }
    return macWorkerStatus(worker, { ...options, runner, refreshExpiredParked: false });
  }
  const mac = evaluateMacHealth(status);
  if (mac) return mac;
  return finishWorkerStatus(status, worker.sshAlias, options);
}
