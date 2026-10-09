// Provider capacity for managed companion endpoints: the idle-tunnel scan,
// the usage alert, the /healthz detail, and the short provisioning gate used
// while Cloudflare is rejecting new tunnels or DNS records.
//
// Nothing here deletes a provider resource. A reclaim only moves an idle
// endpoint row to 'deleting'; the existing ownership-verified cleanup path
// (endpoints.ts deleteClaim) does the deletion and re-checks the tunnel's
// connection state immediately before each destructive call.
import { CloudflareAPI, CloudflareAPIError, type CloudflareFetch } from "./cloudflare-api";
import type { ControlPlaneConfig } from "./config";
import type { JSONValue } from "./http";
import {
  idleTunnelReason,
  NEVER_CONNECTED_RECLAIM_MS,
  quietPeriodMs,
  type IdlePolicy,
  type IdleReason,
} from "./tunnel-activity";

/** Cloudflare's tunnel quota (1045) and DNS record quota (81045). */
const CAPACITY_ERROR_CODES: ReadonlySet<string> = new Set(["cf_api_1045", "cf_api_81045"]);
/** After a quota rejection, new allocations are answered locally for this
 * long instead of spending shared API budget on a request that will fail. */
export const CAPACITY_GATE_MS = 10 * 60 * 1_000;
export const CAPACITY_RETRY_AFTER_SECONDS = 600;
export const CAPACITY_ALERT_PERCENT = 90;
/** One page per five-minute run. 100 tunnels keep the response far below the
 * client's 512 KiB bound even with the deprecated connections array filled. */
export const TUNNEL_SCAN_PAGE_SIZE = 100;
/** Bounded reclaim marks per run, so the cleanup queue cannot outgrow the
 * cleanup sweep by more than one run's worth. */
export const RECLAIM_MARK_LIMIT = 20;
const MAX_SCAN_PAGE = 1_000;
const SNAPSHOT_STALE_MS = 30 * 60 * 1_000;
const MANAGED_TUNNEL_NAME = /^omb-c-[0-9a-f]{32}$/;
/** /healthz is the busiest public path, and its capacity detail is only a
 * report: allocation gating reads D1 directly. Each data center reuses one
 * read of the snapshot row for this long instead of a D1 round trip per probe. */
const CAPACITY_HEALTH_CACHE_SECONDS = 120;
const CAPACITY_HEALTH_CACHE = "healthz-capacity";
// Never routed. Bump the version when CapacityRow changes: copies outlive deploys.
const CAPACITY_HEALTH_CACHE_PATH = "/__internal/healthz-capacity-row/v1";

interface CapacityRow {
  capacity_rejected_at: number | null;
  capacity_rejected_code: string | null;
  checked_at: number | null;
  dns_record_count: number | null;
  reclaim_pending: number;
  scan_page: number;
  tunnel_count: number | null;
}

interface ScanEndpointRow {
  installation_id: string;
  tunnel_name: string;
}

export interface TunnelScanSummary {
  dnsRecordCount: number | null;
  /** Idle tunnels that also passed every D1 guard (marked when mode is on). */
  eligible: number;
  /** Tunnels the provider reports idle that belong to an endpoint row. */
  idle: Record<IdleReason, number>;
  managed: number;
  marked: number;
  nextPage: number;
  page: number;
  reclaimPending: number;
  returned: number;
  tunnelCount: number | null;
  unmatched: number;
}

export function isCapacityErrorCode(code: string): boolean {
  return CAPACITY_ERROR_CODES.has(code);
}

export function idlePolicy(config: ControlPlaneConfig): IdlePolicy {
  return {
    neverConnectedMs: NEVER_CONNECTED_RECLAIM_MS,
    offlineMs: config.capacity.offlineReclaimMs,
  };
}

async function capacityRow(env: Env): Promise<CapacityRow | null> {
  return env.DB.prepare(
    `SELECT scan_page, tunnel_count, dns_record_count, reclaim_pending, checked_at,
            capacity_rejected_at, capacity_rejected_code
       FROM managed_endpoint_capacity
      WHERE id = 1`,
  ).first<CapacityRow>();
}

function capacityCacheKey(config: ControlPlaneConfig): string {
  return new URL(CAPACITY_HEALTH_CACHE_PATH, config.authBaseURL).toString();
}

/** Drops the cached row in this data center only; others keep theirs until it
 * expires. Cron runs land in an arbitrary data center, so this delete is
 * opportunistic: the cache TTL is the real staleness bound. Best effort, never
 * throws. */
export async function forgetCachedCapacity(config: ControlPlaneConfig): Promise<void> {
  await caches.open(CAPACITY_HEALTH_CACHE)
    .then((cache) => cache.delete(capacityCacheKey(config)))
    .catch(() => false);
}

/** Any cache failure, or a zone without a cache, falls through to D1. */
async function cachedCapacityRow(
  env: Env,
  config: ControlPlaneConfig,
  ctx: ExecutionContext,
): Promise<CapacityRow | null> {
  const key = capacityCacheKey(config);
  const cache = await caches.open(CAPACITY_HEALTH_CACHE).catch(() => null);
  const hit = await cache?.match(key).catch(() => undefined);
  const cached = hit ? await hit.json<CapacityRow>().catch(() => null) : null;
  if (cached) return cached;
  const row = await capacityRow(env);
  if (row && cache) {
    ctx.waitUntil(cache.put(key, Response.json(row, {
      headers: { "cache-control": `max-age=${CAPACITY_HEALTH_CACHE_SECONDS}` },
    })).catch(() => undefined));
  }
  return row;
}

/** True while a recent quota rejection should short-circuit new allocations. */
export async function capacityRejectionActive(env: Env, now = Date.now()): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT capacity_rejected_at FROM managed_endpoint_capacity WHERE id = 1`,
  ).first<{ capacity_rejected_at: number | null }>();
  const rejectedAt = row?.capacity_rejected_at ?? null;
  return rejectedAt !== null && rejectedAt > now - CAPACITY_GATE_MS && rejectedAt <= now;
}

export async function recordCapacityRejection(
  env: Env,
  config: ControlPlaneConfig,
  code: string,
  now = Date.now(),
): Promise<void> {
  await env.DB.prepare(
    `UPDATE managed_endpoint_capacity
        SET capacity_rejected_at = ?, capacity_rejected_code = ?, updated_at = ?
      WHERE id = 1`,
  ).bind(now, code.slice(0, 64), now).run();
  await forgetCachedCapacity(config);
}

/** Called after cleanup freed provider resources: the next allocation may
 * succeed, so stop answering it locally. */
export async function clearCapacityRejection(
  env: Env,
  config: ControlPlaneConfig,
  now = Date.now(),
): Promise<void> {
  await env.DB.prepare(
    `UPDATE managed_endpoint_capacity
        SET capacity_rejected_at = NULL, capacity_rejected_code = NULL, updated_at = ?
      WHERE id = 1 AND capacity_rejected_at IS NOT NULL`,
  ).bind(now).run();
  await forgetCachedCapacity(config);
}

// The D1 side of "has been seen recently" lives only here, so the same SQL
// decides both the observe-mode count and the real mark, and a concurrent
// reconcile, revocation, or installation check-in that lands between the
// provider read and the write always wins.
const RECLAIM_GUARD_SQL = `installation_id = ?
        AND tunnel_name = ?
        AND (tunnel_id IS NULL OR tunnel_id = ?)
        AND status IN ('ready', 'error')
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        AND updated_at <= ?
        AND COALESCE(last_reconciled_at, 0) <= ?
        AND EXISTS (
          SELECT 1 FROM installations i
           WHERE i.id = installation_endpoints.installation_id
             AND i.revoked_at IS NULL
             AND COALESCE(i.last_seen_at, i.created_at) <= ?
        )`;

function reclaimGuardBindings(
  row: ScanEndpointRow,
  tunnelId: string,
  reason: IdleReason,
  policy: IdlePolicy,
  now: number,
): unknown[] {
  const quietCutoff = now - quietPeriodMs(reason, policy);
  return [row.installation_id, row.tunnel_name, tunnelId, now, quietCutoff, quietCutoff, quietCutoff];
}

async function reclaimEligible(
  env: Env,
  row: ScanEndpointRow,
  tunnelId: string,
  reason: IdleReason,
  policy: IdlePolicy,
  now: number,
): Promise<boolean> {
  const found = await env.DB.prepare(
    `SELECT 1 AS eligible FROM installation_endpoints WHERE ${RECLAIM_GUARD_SQL}`,
  ).bind(...reclaimGuardBindings(row, tunnelId, reason, policy, now)).first<{ eligible: number }>();
  return found !== null;
}

async function markIdleEndpoint(
  env: Env,
  row: ScanEndpointRow,
  tunnelId: string,
  reason: IdleReason,
  policy: IdlePolicy,
  now: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE installation_endpoints
        SET status = 'deleting',
            reclaim_requested_at = ?,
            delete_requested_at = ?,
            cleanup_attempts = 0,
            last_cleanup_attempt_at = NULL,
            last_error_code = NULL,
            updated_at = ?
      WHERE ${RECLAIM_GUARD_SQL}`,
  ).bind(now, now, now, ...reclaimGuardBindings(row, tunnelId, reason, policy, now)).run();
  return result.meta.changes > 0;
}

function capacityAlert(
  requestId: string,
  resource: "dns_records" | "tunnels",
  used: number | null,
  limit: number,
): void {
  if (used === null || used * 100 < limit * CAPACITY_ALERT_PERCENT) return;
  // A stable `alert` field gives Workers Logs a single filter for alerting.
  console.error(JSON.stringify({
    message: "managed endpoint capacity high",
    alert: "managed_endpoint_capacity",
    requestId,
    resource,
    used,
    limit,
    usagePercent: Math.floor((used * 100) / limit),
    thresholdPercent: CAPACITY_ALERT_PERCENT,
    full: used >= limit,
  }));
}

/**
 * One bounded step of the account-wide tunnel scan: a single provider page,
 * at most RECLAIM_MARK_LIMIT reclaim marks, one zone record count, and one
 * capacity snapshot. Successive runs walk the pages and wrap around.
 */
export async function scanTunnelCapacity(
  env: Env,
  config: ControlPlaneConfig,
  fetcher: CloudflareFetch,
  requestId: string,
  now = Date.now(),
): Promise<TunnelScanSummary | null> {
  const state = await capacityRow(env);
  const page = Math.min(Math.max(state?.scan_page ?? 1, 1), MAX_SCAN_PAGE);
  const api = new CloudflareAPI(config.cloudflare, fetcher);

  let listing: Awaited<ReturnType<CloudflareAPI["listTunnelPage"]>>;
  try {
    listing = await api.listTunnelPage(page, TUNNEL_SCAN_PAGE_SIZE);
  } catch (error) {
    console.error(JSON.stringify({
      message: "managed endpoint tunnel scan failed",
      requestId,
      errorCode: error instanceof CloudflareAPIError ? error.code : "endpoint_internal",
    }));
    return null;
  }

  let dnsRecordCount: number | null = null;
  try {
    dnsRecordCount = await api.countDNSRecords();
  } catch (error) {
    console.error(JSON.stringify({
      message: "managed endpoint DNS record count failed",
      requestId,
      errorCode: error instanceof CloudflareAPIError ? error.code : "endpoint_internal",
    }));
  }

  const managed = listing.tunnels.filter((tunnel) => (
    tunnel.managedConfig && MANAGED_TUNNEL_NAME.test(tunnel.name)
  ));
  const rows = new Map<string, ScanEndpointRow>();
  if (managed.length > 0) {
    const found = await env.DB.prepare(
      `SELECT installation_id, tunnel_name
         FROM installation_endpoints
        WHERE tunnel_name IN (SELECT value FROM json_each(?))`,
    ).bind(JSON.stringify(managed.map((tunnel) => tunnel.name))).all<ScanEndpointRow>();
    for (const row of found.results) rows.set(row.tunnel_name, row);
  }

  const policy = idlePolicy(config);
  const idle: Record<IdleReason, number> = { never_connected: 0, offline: 0 };
  let unmatched = 0;
  let eligible = 0;
  let marked = 0;
  for (const tunnel of managed) {
    const row = rows.get(tunnel.name);
    if (!row) {
      // No endpoint row claims this name, so ownership cannot be verified.
      // Leave it for an operator rather than guessing.
      unmatched += 1;
      continue;
    }
    const reason = idleTunnelReason(tunnel.activity, now, policy);
    if (!reason) continue;
    idle[reason] += 1;
    if (config.capacity.reclaimMode !== "on") {
      if (await reclaimEligible(env, row, tunnel.id, reason, policy, now)) eligible += 1;
      continue;
    }
    if (marked >= RECLAIM_MARK_LIMIT) continue;
    if (await markIdleEndpoint(env, row, tunnel.id, reason, policy, now)) {
      marked += 1;
      eligible += 1;
    }
  }

  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM installation_endpoints
      WHERE status = 'deleting' AND reclaim_requested_at IS NOT NULL`,
  ).first<{ count: number }>();
  const reclaimPending = pending?.count ?? 0;

  const lastPage = listing.returned < TUNNEL_SCAN_PAGE_SIZE
    || (listing.totalCount !== null && page * TUNNEL_SCAN_PAGE_SIZE >= listing.totalCount)
    || page >= MAX_SCAN_PAGE;
  const nextPage = lastPage ? 1 : page + 1;
  const tunnelCount = listing.totalCount
    ?? (page === 1 && listing.returned < TUNNEL_SCAN_PAGE_SIZE ? listing.returned : null);

  await env.DB.prepare(
    `UPDATE managed_endpoint_capacity
        SET scan_page = ?, tunnel_count = ?, dns_record_count = ?, reclaim_pending = ?,
            checked_at = ?, updated_at = ?
      WHERE id = 1`,
  ).bind(nextPage, tunnelCount, dnsRecordCount, reclaimPending, now, now).run();
  await forgetCachedCapacity(config);

  capacityAlert(requestId, "tunnels", tunnelCount, config.capacity.tunnelLimit);
  capacityAlert(requestId, "dns_records", dnsRecordCount, config.capacity.dnsRecordLimit);

  const summary: TunnelScanSummary = {
    dnsRecordCount,
    eligible,
    idle,
    managed: managed.length,
    marked,
    nextPage,
    page,
    reclaimPending,
    returned: listing.returned,
    tunnelCount,
    unmatched,
  };
  console.log(JSON.stringify({
    message: "managed endpoint tunnel scan",
    requestId,
    reclaimMode: config.capacity.reclaimMode,
    ...summary,
  }));
  return summary;
}

type CapacityStatus = "full" | "high" | "ok" | "unknown";

function usageStatus(used: number | null, limit: number): CapacityStatus {
  if (used === null) return "unknown";
  if (used >= limit) return "full";
  if (used * 100 >= limit * CAPACITY_ALERT_PERCENT) return "high";
  return "ok";
}

const STATUS_RANK: Record<Exclude<CapacityStatus, "unknown">, number> = { ok: 0, high: 1, full: 2 };

function worstKnownStatus(statuses: CapacityStatus[]): CapacityStatus {
  let worst: CapacityStatus = "unknown";
  for (const status of statuses) {
    if (status === "unknown") continue;
    if (worst === "unknown" || STATUS_RANK[status] > STATUS_RANK[worst]) worst = status;
  }
  return worst;
}

/** Counts and timestamps only: safe for the unauthenticated health check. */
export async function capacityHealth(
  env: Env,
  config: ControlPlaneConfig,
  ctx: ExecutionContext,
  now = Date.now(),
): Promise<JSONValue | null> {
  const row = await cachedCapacityRow(env, config, ctx);
  if (!row) return null;
  const stale = row.checked_at === null || row.checked_at < now - SNAPSHOT_STALE_MS;
  const tunnelStatus = stale ? "unknown" : usageStatus(row.tunnel_count, config.capacity.tunnelLimit);
  const dnsStatus = stale ? "unknown" : usageStatus(row.dns_record_count, config.capacity.dnsRecordLimit);
  const rejected = row.capacity_rejected_at !== null
    && row.capacity_rejected_at > now - CAPACITY_GATE_MS
    && row.capacity_rejected_at <= now;
  const status: CapacityStatus = rejected ? "full" : worstKnownStatus([tunnelStatus, dnsStatus]);
  return {
    status,
    checkedAt: row.checked_at,
    tunnels: { used: row.tunnel_count, limit: config.capacity.tunnelLimit },
    dnsRecords: { used: row.dns_record_count, limit: config.capacity.dnsRecordLimit },
    providerRejectedAt: rejected ? row.capacity_rejected_at : null,
    reclaim: { mode: config.capacity.reclaimMode, pending: row.reclaim_pending },
  };
}
