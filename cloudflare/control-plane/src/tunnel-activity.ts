// Pure connection-state rules for idle tunnel reclaim. Everything here is
// conservative: an unknown status, a missing or unparseable timestamp, or any
// sign of a live connection means "not idle".

export const NEVER_CONNECTED_RECLAIM_MS = 7 * 24 * 60 * 60 * 1_000;

export interface TunnelActivity {
  /** Provider timestamps in epoch milliseconds, or null when absent. */
  connsActiveAt: number | null;
  connsInactiveAt: number | null;
  createdAt: number | null;
  /** Entries in the deprecated `connections` array (normally empty). */
  connectionCount: number;
  /** True when a timestamp was present but could not be parsed. */
  malformed: boolean;
  /** `inactive` (never run), `down`, `degraded`, `healthy`, or null. */
  status: string | null;
}

export type IdleReason = "never_connected" | "offline";

export interface IdlePolicy {
  neverConnectedMs: number;
  offlineMs: number;
}

interface RawTunnelActivity {
  connections?: unknown[] | null;
  conns_active_at?: string | null;
  conns_inactive_at?: string | null;
  created_at?: string | null;
  status?: string | null;
}

function timestamp(value: string | null | undefined): { malformed: boolean; value: number | null } {
  if (value === undefined || value === null || value === "") return { malformed: false, value: null };
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? { malformed: false, value: parsed } : { malformed: true, value: null };
}

export function tunnelActivity(raw: RawTunnelActivity): TunnelActivity {
  const active = timestamp(raw.conns_active_at);
  const inactive = timestamp(raw.conns_inactive_at);
  const created = timestamp(raw.created_at);
  return {
    connsActiveAt: active.value,
    connsInactiveAt: inactive.value,
    createdAt: created.value,
    connectionCount: raw.connections?.length ?? 0,
    malformed: active.malformed || inactive.malformed || created.malformed,
    status: typeof raw.status === "string" ? raw.status : null,
  };
}

/** How long the installation and endpoint must also have been quiet before
 * a tunnel idle for `reason` may be reclaimed. */
export function quietPeriodMs(reason: IdleReason, policy: IdlePolicy): number {
  return reason === "never_connected" ? policy.neverConnectedMs : policy.offlineMs;
}

/**
 * Returns why a tunnel may be reclaimed, or null when it must be left alone.
 *
 * - `never_connected`: the provider says it has never run (`inactive`), it has
 *   no activation time, and it was created at least `neverConnectedMs` ago.
 * - `offline`: the provider says it is `down`, and its last connection ended
 *   at least `offlineMs` ago with no later activation.
 *
 * `healthy` and `degraded` tunnels, any reported connection, and any status
 * this code does not know are never idle.
 */
export function idleTunnelReason(
  activity: TunnelActivity | undefined,
  now: number,
  policy: IdlePolicy,
): IdleReason | null {
  if (!activity || activity.malformed || activity.connectionCount > 0) return null;

  if (activity.status === "inactive") {
    if (activity.connsActiveAt !== null) return null;
    if (activity.createdAt === null || activity.createdAt > now - policy.neverConnectedMs) return null;
    if (activity.connsInactiveAt !== null && activity.connsInactiveAt > now - policy.neverConnectedMs) {
      return null;
    }
    return "never_connected";
  }

  if (activity.status === "down") {
    if (activity.connsInactiveAt === null || activity.connsInactiveAt > now - policy.offlineMs) return null;
    if (activity.connsActiveAt !== null && activity.connsActiveAt >= activity.connsInactiveAt) return null;
    if (activity.createdAt !== null && activity.createdAt > now - policy.offlineMs) return null;
    return "offline";
  }

  return null;
}
