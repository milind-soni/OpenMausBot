// Giving tunnels back once the relay has replaced them, and the version
// cutoffs that clear what is left. Nothing here deletes a provider resource:
// a release only marks a ready row 'deleting', and the cleanup sweep removes
// it through the same ownership-verified path as an owner's DELETE. The row
// and its hostname stay, so a computer the relay later cannot serve gets the
// same address back by provisioning again.
import { TUNNEL_CONNECTED_CODE } from "./cloudflare-api";
import type { ControlPlaneConfig } from "./config";
import { ACTED_ON_ENDPOINT_SQL, actedOnAccounts, appVersionAtLeast } from "./endpoint-accounts";
import type { JSONValue } from "./http";
import { readRelaySettings, RELAY_FRESH_MS, relayAdmits } from "./relay";

const DAY_MS = 24 * 60 * 60 * 1_000;
const VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$/;
/** Three days: longer than a weekend away, so a phone that still dials the
 * tunnel has had working days to show up as an old phone and stop the wait. */
export const DEFAULT_RELEASE_DAYS = 3;
/** A computer called the control plane this recently, so what is stored about
 * it is current: a desktop with remote access on checks in every few minutes,
 * and a relay-capable one reports its release with each hourly relay token. */
export const SEEN_FRESH_MS = 2 * DAY_MS;
/** Release marks per cron run, all reasons together: with the cleanup sweep's
 * 20 rows a run, a wave never outgrows what cleanup removes. */
export const RELEASE_MARK_LIMIT = 20;
/** A forced removal that met a tunnel still connected: by name, and as Cloudflare's own code from before it was named. */
const STILL_CONNECTED_CODES = JSON.stringify([TUNNEL_CONNECTED_CODE, "cf_api_1022"]);
/** Rows read per run before a percentage is applied. */
const PROVEN_SCAN_LIMIT = 5_000;

export type ReleaseReason = "legacy_cutoff" | "min_version" | "relay_proven";

export interface TunnelPolicy {
  /** RELAY_CAPABLE_MIN_VERSION: the first desktop release that reaches phones through the relay. */
  relayMinVersion: string | null;
  /** RELAY_TUNNEL_RELEASE_PERCENT: the share of computers whose tunnel is released once proven on the relay. */
  releasePercent: number;
  /** RELAY_TUNNEL_RELEASE_DAYS. */
  releaseMs: number;
  /** TUNNEL_MIN_APP_VERSION: a desktop below it neither gets nor keeps a tunnel. */
  minAppVersion: string | null;
  /** TUNNEL_REASON_MIN_VERSION: the first desktop release that reads `tunnel` on 409 relay_capable and keeps
   * asking afterwards. Only from it is a full account answered with relay_capable instead of 503. */
  tunnelReasonMinVersion: string | null;
  /** TUNNEL_LEGACY_PHONE_CUTOFF_PERCENT: the share of relay-served computers that give up their tunnel whatever
   * phones they have, so an old phone app no longer holds one. */
  legacyCutoffPercent: number;
}

function version(value: unknown): string | null {
  return typeof value === "string" && VERSION.test(value.trim()) ? value.trim() : null;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "string" && /^[0-9]{1,3}$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

/** Every switch is off unless set, and an invalid value reads as off. */
export function readTunnelPolicy(env: Env): TunnelPolicy {
  const vars = env as unknown as Partial<Record<string, unknown>>;
  const relayMinVersion = version(vars.RELAY_CAPABLE_MIN_VERSION);
  return {
    relayMinVersion,
    releasePercent: relayMinVersion === null ? 0 : integer(vars.RELAY_TUNNEL_RELEASE_PERCENT, 0, 0, 100),
    releaseMs: integer(vars.RELAY_TUNNEL_RELEASE_DAYS, DEFAULT_RELEASE_DAYS, 1, 90) * DAY_MS,
    minAppVersion: version(vars.TUNNEL_MIN_APP_VERSION),
    tunnelReasonMinVersion: version(vars.TUNNEL_REASON_MIN_VERSION),
    legacyCutoffPercent: relayMinVersion === null ? 0 : integer(vars.TUNNEL_LEGACY_PHONE_CUTOFF_PERCENT, 0, 0, 100),
  };
}

/** A missing or unreadable version is below every minimum. */
export function belowMinimum(policy: TunnelPolicy, appVersion: string | null): boolean {
  return policy.minAppVersion !== null && !appVersionAtLeast(appVersion, policy.minAppVersion);
}

export function readsTunnelReason(policy: TunnelPolicy, appVersion: string | null): boolean {
  return policy.tunnelReasonMinVersion !== null && appVersionAtLeast(appVersion, policy.tunnelReasonMinVersion);
}

export function relayCapableVersion(policy: TunnelPolicy, appVersion: string | null): boolean {
  return policy.relayMinVersion !== null && appVersionAtLeast(appVersion, policy.relayMinVersion);
}

// A ready tunnel of an active installation, in an account this Worker acts on.
const HELD_TUNNEL_SQL = `e.status = 'ready'
        AND e.tunnel_id IS NOT NULL
        AND i.revoked_at IS NULL
        AND ${ACTED_ON_ENDPOINT_SQL}`;

/** The relay gave this computer a token lately. */
const RELAY_SERVED_SQL = "a.token_at IS NOT NULL AND a.token_at >= ?";

/** Every paired phone has used the encrypted connection (a phone that has
 * never dials the tunnel again), none is an old phone, and that has held for
 * the whole wait. Binds: fresh cutoff twice, then the wait cutoff. */
const RELAY_PROVEN_SQL = `${RELAY_SERVED_SQL}
        AND a.updated_at >= ?
        AND a.legacy_devices = 0
        AND a.e2e_devices > 0
        AND a.legacy_clear_at IS NOT NULL
        AND a.legacy_clear_at <= ?`;

/** The stored release can be trusted as current: the computer called lately,
 * and had it updated to a relay-capable release it would have said so with
 * its relay token. A computer that has been off is left to idle reclaim. */
const SEEN_LATELY_SQL = "i.last_seen_at IS NOT NULL AND i.last_seen_at >= ?";

interface VersionRow {
  /** Of `tunnels`, those whose computer called lately. */
  seen: number;
  proven: number;
  relay_served: number;
  tunnels: number;
  version: string;
}

/** Held tunnels by desktop version, with how many of each the relay serves
 * and how many are proven on it. Throws without migration 0015. */
async function heldByVersion(env: Env, config: ControlPlaneConfig, policy: TunnelPolicy, now: number): Promise<VersionRow[]> {
  const fresh = now - RELAY_FRESH_MS;
  const found = await env.DB.prepare(
    `SELECT COALESCE(i.app_version, '') AS version,
            COUNT(*) AS tunnels,
            COALESCE(SUM(CASE WHEN ${SEEN_LATELY_SQL} THEN 1 ELSE 0 END), 0) AS seen,
            COALESCE(SUM(CASE WHEN ${RELAY_SERVED_SQL} THEN 1 ELSE 0 END), 0) AS relay_served,
            COALESCE(SUM(CASE WHEN ${RELAY_PROVEN_SQL} THEN 1 ELSE 0 END), 0) AS proven
       FROM installation_endpoints e
       JOIN installations i ON i.id = e.installation_id
       LEFT JOIN relay_adoption a ON a.installation_id = e.installation_id
      WHERE ${HELD_TUNNEL_SQL}
      GROUP BY 1`,
  ).bind(now - SEEN_FRESH_MS, fresh, fresh, fresh, now - policy.releaseMs, actedOnAccounts(config)).all<VersionRow>();
  return found.results;
}

export interface ReleasePreview {
  /** Held tunnels of desktops seen in the last two days below
   * TUNNEL_MIN_APP_VERSION, or, while that is unset, below
   * RELAY_CAPABLE_MIN_VERSION: what a version cutoff would clear. */
  belowMinVersion: number;
  /** Held tunnels of relay-served desktops that are not yet proven: what the
   * old-phone cutoff would clear beyond the release. */
  legacyPhones: number;
  /** Held tunnels proven on the relay: what the release clears at 100%. */
  relayProven: number;
}

function preview(rows: readonly VersionRow[], policy: TunnelPolicy): ReleasePreview {
  const cutoff = policy.minAppVersion ?? policy.relayMinVersion;
  const totals: ReleasePreview = { belowMinVersion: 0, legacyPhones: 0, relayProven: 0 };
  for (const row of rows) {
    if (cutoff !== null && !appVersionAtLeast(row.version, cutoff)) {
      totals.belowMinVersion += row.seen;
      continue;
    }
    if (!relayCapableVersion(policy, row.version)) continue;
    totals.relayProven += row.proven;
    totals.legacyPhones += row.relay_served - row.proven;
  }
  return totals;
}

const HEALTH_MEMO_MS = 5 * 60 * 1_000;
let healthMemo: { at: number; value: JSONValue | null } | null = null;

/** Test-only. */
export function forgetTunnelRelease(): void {
  healthMemo = null;
}

/** Counts only, for /healthz: the switches as set, and what each would clear
 * now, so the numbers can be read before a switch is turned. Read at most
 * every five minutes per isolate; left out without migration 0015. */
export async function tunnelReleaseHealth(env: Env, config: ControlPlaneConfig, now = Date.now()): Promise<JSONValue | null> {
  if (healthMemo && now - healthMemo.at < HEALTH_MEMO_MS) return healthMemo.value;
  const policy = readTunnelPolicy(env);
  const value = await heldByVersion(env, config, policy, now).then((rows): JSONValue => {
    const counts = preview(rows, policy);
    return {
      relayProven: { percent: policy.releasePercent, days: policy.releaseMs / DAY_MS, eligible: counts.relayProven },
      legacyPhoneCutoff: { percent: policy.legacyCutoffPercent, eligible: counts.legacyPhones },
      minAppVersion: { on: policy.minAppVersion !== null, eligible: counts.belowMinVersion },
    };
  }, () => null);
  healthMemo = { at: now, value };
  return value;
}

interface Candidate {
  installation_id: string;
  relay_host_id: string | null;
}

export interface ReleaseSummary {
  marked: Record<ReleaseReason, number>;
  preview: ReleasePreview;
}

/** `guard` is re-checked inside the UPDATE, so a report that lands between
 * the read and the write (an old phone appears, the desktop updates) wins. */
async function mark(env: Env, config: ControlPlaneConfig, installationId: string, guard: string, bindings: unknown[], now: number): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE installation_endpoints
        SET status = 'deleting',
            delete_requested_at = ?,
            reclaim_requested_at = NULL,
            cleanup_attempts = 0,
            last_cleanup_attempt_at = NULL,
            last_error_code = NULL,
            updated_at = ?
      WHERE installation_id = ?
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        AND EXISTS (
          SELECT 1
            FROM installation_endpoints e
            JOIN installations i ON i.id = e.installation_id
            LEFT JOIN relay_adoption a ON a.installation_id = e.installation_id
           WHERE e.installation_id = installation_endpoints.installation_id
             AND ${HELD_TUNNEL_SQL}
             AND ${guard}
        )`,
  ).bind(now, now, installationId, now, actedOnAccounts(config), ...bindings).run();
  return result.meta.changes > 0;
}

const VERSION_IN_SQL = "COALESCE(i.app_version, '') IN (SELECT value FROM json_each(?))";

/**
 * One bounded step, before the cleanup sweep. In order: desktops below the
 * minimum version, then (with the old-phone cutoff on) every computer the
 * relay serves, then computers proven on the relay inside the release
 * percentage. With every switch off it only reads the counts it logs.
 */
export async function releaseTunnels(
  env: Env,
  config: ControlPlaneConfig,
  requestId: string,
  now = Date.now(),
): Promise<ReleaseSummary | null> {
  const policy = readTunnelPolicy(env);
  let rows: VersionRow[];
  try {
    rows = await heldByVersion(env, config, policy, now);
  } catch {
    // Migration 0015 is not applied yet: nothing is released.
    return null;
  }
  const summary: ReleaseSummary = {
    marked: { legacy_cutoff: 0, min_version: 0, relay_proven: 0 },
    preview: preview(rows, policy),
  };
  // Never more waiting for cleanup than one sweep removes: while the sweep is
  // failing or rate-limited its queue stays full and nothing more is marked,
  // so no owner is left with a row it cannot take back. A forced removal
  // whose tunnel was still connected after its cleanup rounds is not a failing
  // sweep: it backs off and retries on its own, and does not hold the queue.
  const queued = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM installation_endpoints e
      WHERE e.status = 'deleting' AND ${ACTED_ON_ENDPOINT_SQL}
        AND NOT (e.reclaim_requested_at IS NULL AND COALESCE(e.last_error_code, '') IN (SELECT value FROM json_each(?)))`,
  ).bind(actedOnAccounts(config), STILL_CONNECTED_CODES).first<{ count: number }>();
  let budget = Math.max(0, Math.min(RELEASE_MARK_LIMIT, config.capacity.cleanupSweepLimit) - (queued?.count ?? 0));
  const fresh = now - RELAY_FRESH_MS;
  const versions = rows.map((row) => row.version);
  const below = JSON.stringify(versions.filter((each) => belowMinimum(policy, each)));
  const capable = JSON.stringify(versions.filter((each) => relayCapableVersion(policy, each) && !belowMinimum(policy, each)));
  // With the relay switched off, or a computer outside its rollout, nobody is
  // moved onto it: the same `relayAdmits` provisioning answers by, so a tunnel
  // provisioning would hand back is never marked.
  const relay = await readRelaySettings(env);
  const inside = (percent: number) => async (row: Candidate) => {
    const { admitted, bucket } = await relayAdmits(relay, { installationId: row.installation_id, hostId: row.relay_host_id, blocked: false });
    return admitted && bucket !== null && bucket < percent;
  };

  const run = async (reason: ReleaseReason, guard: string, bindings: unknown[], admit?: (row: Candidate) => Promise<boolean>) => {
    if (budget <= 0) return;
    const found = await env.DB.prepare(
      `SELECT e.installation_id, i.relay_host_id
         FROM installation_endpoints e
         JOIN installations i ON i.id = e.installation_id
         LEFT JOIN relay_adoption a ON a.installation_id = e.installation_id
        WHERE ${HELD_TUNNEL_SQL}
          AND (e.lease_expires_at IS NULL OR e.lease_expires_at <= ?)
          AND ${guard}
        ORDER BY e.updated_at ASC, e.installation_id ASC
        LIMIT ?`,
    ).bind(actedOnAccounts(config), now, ...bindings, admit ? PROVEN_SCAN_LIMIT : budget)
      .all<Candidate>();
    for (const row of found.results) {
      if (budget <= 0) break;
      if (admit && !(await admit(row))) continue;
      if (await mark(env, config, row.installation_id, guard, bindings, now)) {
        budget -= 1;
        summary.marked[reason] += 1;
      }
    }
  };

  if (policy.minAppVersion !== null) {
    await run("min_version", `${VERSION_IN_SQL} AND ${SEEN_LATELY_SQL}`, [below, now - SEEN_FRESH_MS]);
  }
  const servedGuard = `${VERSION_IN_SQL} AND i.relay_blocked_at IS NULL`;
  if (relay && policy.legacyCutoffPercent > 0) {
    await run("legacy_cutoff", `${servedGuard} AND ${RELAY_SERVED_SQL}`, [capable, fresh], inside(policy.legacyCutoffPercent));
  }
  if (relay && policy.releasePercent > 0) {
    await run(
      "relay_proven",
      `${servedGuard} AND ${RELAY_PROVEN_SQL}`,
      [capable, fresh, fresh, now - policy.releaseMs],
      inside(policy.releasePercent),
    );
  }

  console.log(JSON.stringify({
    message: "managed endpoint tunnel release",
    requestId,
    releasePercent: policy.releasePercent,
    releaseDays: policy.releaseMs / DAY_MS,
    legacyCutoffPercent: policy.legacyCutoffPercent,
    minAppVersion: policy.minAppVersion !== null,
    marked: summary.marked,
    eligible: summary.preview,
  }));
  return summary;
}
