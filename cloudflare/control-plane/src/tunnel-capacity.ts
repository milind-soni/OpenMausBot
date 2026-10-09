// Provider capacity for managed companion endpoints, per Cloudflare account:
// the idle-tunnel scan, the usage alerts, the /healthz detail, and the short
// provisioning gate used while Cloudflare is refusing an account new tunnels
// or DNS records.
//
// Nothing here deletes a provider resource. A reclaim only moves an idle
// endpoint row to 'deleting'; the existing ownership-verified cleanup path
// (endpoints.ts deleteClaim) does the deletion and re-checks the tunnel's
// connection state immediately before each destructive call.
import { CloudflareAPI, CloudflareAPIError, type CloudflareFetch } from "./cloudflare-api";
import type { ControlPlaneConfig, EndpointAccount } from "./config";
import {
  ACTED_ON_ENDPOINT_SQL,
  actedOnAccounts,
  emptySnapshot,
  opaqueHostnameSQL,
  rejectionActive,
  snapshotFresh,
  type AccountSnapshot,
} from "./endpoint-accounts";
import type { JSONValue } from "./http";
import {
  idleTunnelReason,
  NEVER_CONNECTED_RECLAIM_MS,
  quietPeriodMs,
  type IdlePolicy,
  type IdleReason,
} from "./tunnel-activity";

/** Cloudflare's tunnel quota (1045), a tunnel-creation 429 while the account
 * is at its tunnel limit (`cf_tunnel_quota`, see endpoints.ts), and the zone's
 * DNS record quota (81045). */
const CAPACITY_ERROR_CODES: ReadonlySet<string> = new Set(["cf_api_1045", "cf_tunnel_quota", "cf_api_81045"]);
export const CAPACITY_RETRY_AFTER_SECONDS = 600;
export const CAPACITY_ALERT_PERCENT = 90;
/** One page per account per five-minute run. 100 tunnels keep the response
 * far below the client's 512 KiB bound even with the deprecated connections
 * array filled. */
export const TUNNEL_SCAN_PAGE_SIZE = 100;
/** Bounded reclaim marks per run, shared by every account, so the cleanup
 * queue cannot outgrow the cleanup sweep by more than one run's worth. */
export const RECLAIM_MARK_LIMIT = 20;
const MAX_SCAN_PAGE = 1_000;
const MANAGED_TUNNEL_NAME = /^omb-c-[0-9a-f]{32}$/;
/** /healthz is the busiest public path, and its capacity detail is only a
 * report: allocation gating reads D1 directly. Each data center reuses one
 * read of the snapshot rows for this long instead of a D1 round trip per probe. */
const CAPACITY_HEALTH_CACHE_SECONDS = 120;
const CAPACITY_HEALTH_CACHE = "healthz-capacity";
// Never routed. Bump the version when AccountSnapshot changes: copies outlive deploys.
const CAPACITY_HEALTH_CACHE_PATH = "/__internal/healthz-capacity-row/v2";

interface ScanEndpointRow {
  installation_id: string;
  tunnel_name: string;
}

export interface TunnelScanSummary {
  dnsRecordCount: number | null;
  /** Idle tunnels that also passed every D1 guard (marked when mode is on). */
  eligible: number;
  hostSuffix: string;
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

function accountIds(config: ControlPlaneConfig): string[] {
  return config.endpointAccounts.map((account) => account.accountId);
}

async function snapshotRows(env: Env, config: ControlPlaneConfig): Promise<AccountSnapshot[]> {
  const found = await env.DB.prepare(
    `SELECT provider_account, scan_page, tunnel_count, dns_record_count, reclaim_pending,
            dormant_endpoints, checked_at, capacity_rejected_at, capacity_rejected_code
       FROM managed_endpoint_account_capacity
      WHERE provider_account IN (SELECT value FROM json_each(?))`,
  ).bind(JSON.stringify(accountIds(config))).all<AccountSnapshot>();
  return found.results;
}

/** One snapshot per configured account; an account with no row yet reads as
 * empty (never scanned, never refused). */
function snapshotMap(config: ControlPlaneConfig, rows: readonly AccountSnapshot[]): Map<string, AccountSnapshot> {
  const snapshots = new Map(accountIds(config).map((id) => [id, emptySnapshot(id)]));
  for (const row of rows) {
    if (snapshots.has(row.provider_account)) snapshots.set(row.provider_account, row);
  }
  return snapshots;
}

/** Every configured account's capacity state in one D1 read. */
export async function accountSnapshots(env: Env, config: ControlPlaneConfig): Promise<Map<string, AccountSnapshot>> {
  return snapshotMap(config, await snapshotRows(env, config));
}

function capacityCacheKey(config: ControlPlaneConfig): string {
  return new URL(CAPACITY_HEALTH_CACHE_PATH, config.authBaseURL).toString();
}

/** Drops the cached rows in this data center only; others keep theirs until
 * they expire. Cron runs land in an arbitrary data center, so this delete is
 * opportunistic: the cache TTL is the real staleness bound. Best effort,
 * never throws. */
export async function forgetCachedCapacity(config: ControlPlaneConfig): Promise<void> {
  await caches.open(CAPACITY_HEALTH_CACHE)
    .then((cache) => cache.delete(capacityCacheKey(config)))
    .catch(() => false);
}

/** Any cache failure, or a zone without a cache, falls through to D1. */
async function cachedSnapshots(
  env: Env,
  config: ControlPlaneConfig,
  ctx: ExecutionContext,
): Promise<Map<string, AccountSnapshot>> {
  const key = capacityCacheKey(config);
  const cache = await caches.open(CAPACITY_HEALTH_CACHE).catch(() => null);
  const hit = await cache?.match(key).catch(() => undefined);
  const cached = hit ? await hit.json<AccountSnapshot[]>().catch(() => null) : null;
  if (Array.isArray(cached)) return snapshotMap(config, cached);
  const rows = await snapshotRows(env, config);
  if (cache) {
    ctx.waitUntil(cache.put(key, Response.json(rows, {
      headers: { "cache-control": `max-age=${CAPACITY_HEALTH_CACHE_SECONDS}` },
    })).catch(() => undefined));
  }
  return snapshotMap(config, rows);
}

/** Cloudflare refused `account` a new tunnel or DNS record (`code` is a
 * capacity code), or refused its token: for the next ten minutes no new
 * endpoint goes there, and its allocations are answered locally. */
export async function recordAccountRefusal(
  env: Env,
  config: ControlPlaneConfig,
  account: EndpointAccount,
  code: string,
  now = Date.now(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO managed_endpoint_account_capacity
       (provider_account, capacity_rejected_at, capacity_rejected_code, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(provider_account) DO UPDATE SET
       capacity_rejected_at = excluded.capacity_rejected_at,
       capacity_rejected_code = excluded.capacity_rejected_code,
       updated_at = excluded.updated_at`,
  ).bind(account.accountId, now, code.slice(0, 64), now).run();
  await forgetCachedCapacity(config);
}

/** What one cleanup sweep did in one account. */
export interface AccountCleanup {
  /** It deleted an endpoint, so Cloudflare may take a new resource there. */
  deleted: boolean;
  /** Provider resources it deleted, which the account's last scan counted. */
  dnsRecords: number;
  tunnels: number;
}

/** Called after a cleanup sweep. An account where it deleted an endpoint is
 * no longer answered locally: its next allocation may succeed. And the
 * account's last scan stops counting the tunnels and DNS records cleanup
 * deleted, so until the next scan neither the ranking nor a tunnel-creation
 * 429 judged by the scan (endpoints.ts classifyCreate429) takes a slot
 * cleanup freed for a used one. */
export async function releaseCleanedCapacity(
  env: Env,
  config: ControlPlaneConfig,
  cleaned: ReadonlyMap<string, AccountCleanup>,
  now = Date.now(),
): Promise<void> {
  if (cleaned.size === 0) return;
  // An unknown count (NULL) stays unknown.
  await env.DB.batch([...cleaned].map(([account, each]) => env.DB.prepare(
    `UPDATE managed_endpoint_account_capacity
        SET tunnel_count = MAX(tunnel_count - ?, 0),
            dns_record_count = MAX(dns_record_count - ?, 0),
            capacity_rejected_at = CASE WHEN ? = 1 THEN NULL ELSE capacity_rejected_at END,
            capacity_rejected_code = CASE WHEN ? = 1 THEN NULL ELSE capacity_rejected_code END,
            updated_at = ?
      WHERE provider_account = ?`,
  ).bind(each.tunnels, each.dnsRecords, each.deleted ? 1 : 0, each.deleted ? 1 : 0, now, account)));
  await forgetCachedCapacity(config);
}

// The D1 side of "has been seen recently" lives only here, so the same SQL
// decides both the observe-mode count and the real mark, and a concurrent
// reconcile, revocation, or installation check-in that lands between the
// provider read and the write always wins. A row is only ever matched to a
// tunnel listed in its own account.
const RECLAIM_GUARD_SQL = `installation_id = ?
        AND provider_account = ?
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
  account: EndpointAccount,
  row: ScanEndpointRow,
  tunnelId: string,
  reason: IdleReason,
  policy: IdlePolicy,
  now: number,
): unknown[] {
  const quietCutoff = now - quietPeriodMs(reason, policy);
  return [
    row.installation_id,
    account.accountId,
    row.tunnel_name,
    tunnelId,
    now,
    quietCutoff,
    quietCutoff,
    quietCutoff,
  ];
}

async function reclaimEligible(
  env: Env,
  account: EndpointAccount,
  row: ScanEndpointRow,
  tunnelId: string,
  reason: IdleReason,
  policy: IdlePolicy,
  now: number,
): Promise<boolean> {
  const found = await env.DB.prepare(
    `SELECT 1 AS eligible FROM installation_endpoints WHERE ${RECLAIM_GUARD_SQL}`,
  ).bind(...reclaimGuardBindings(account, row, tunnelId, reason, policy, now)).first<{ eligible: number }>();
  return found !== null;
}

async function markIdleEndpoint(
  env: Env,
  account: EndpointAccount,
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
  ).bind(now, now, now, ...reclaimGuardBindings(account, row, tunnelId, reason, policy, now)).run();
  return result.meta.changes > 0;
}

function capacityAlert(
  requestId: string,
  account: EndpointAccount,
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
    hostSuffix: account.companionHostSuffix,
    resource,
    used,
    limit,
    usagePercent: Math.floor((used * 100) / limit),
    thresholdPercent: CAPACITY_ALERT_PERCENT,
    full: used >= limit,
  }));
}

/**
 * One bounded step of one account's tunnel scan: a single provider page, the
 * shared reclaim-mark budget, one zone record count, and one snapshot.
 * Successive runs walk the account's pages and wrap around.
 */
async function scanAccount(
  env: Env,
  config: ControlPlaneConfig,
  account: EndpointAccount,
  previous: AccountSnapshot,
  fetcher: CloudflareFetch,
  requestId: string,
  budget: { marks: number },
  now: number,
): Promise<{ snapshot: AccountSnapshot; summary: TunnelScanSummary } | null> {
  const hostSuffix = account.companionHostSuffix;
  const page = Math.min(Math.max(previous.scan_page ?? 1, 1), MAX_SCAN_PAGE);
  const api = new CloudflareAPI(account, fetcher);

  let listing: Awaited<ReturnType<CloudflareAPI["listTunnelPage"]>>;
  try {
    listing = await api.listTunnelPage(page, TUNNEL_SCAN_PAGE_SIZE);
  } catch (error) {
    console.error(JSON.stringify({
      message: "managed endpoint tunnel scan failed",
      requestId,
      hostSuffix,
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
      hostSuffix,
      errorCode: error instanceof CloudflareAPIError ? error.code : "endpoint_internal",
    }));
  }

  const managed = listing.tunnels.filter((tunnel) => (
    tunnel.managedConfig && MANAGED_TUNNEL_NAME.test(tunnel.name)
  ));
  // Only rows this account acts on (endpointAccountFor): a row whose
  // hostname is not one opaque label under the account's suffix is never
  // touched, so its tunnel counts as unmatched.
  const rows = new Map<string, ScanEndpointRow>();
  if (managed.length > 0) {
    const found = await env.DB.prepare(
      `SELECT installation_id, tunnel_name
         FROM installation_endpoints
        WHERE provider_account = ?
          AND ${opaqueHostnameSQL("hostname", "?")}
          AND tunnel_name IN (SELECT value FROM json_each(?))`,
    ).bind(
      account.accountId,
      account.companionHostSuffix,
      JSON.stringify(managed.map((tunnel) => tunnel.name)),
    ).all<ScanEndpointRow>();
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
      // No endpoint row of this account claims this name, so ownership cannot
      // be verified. Leave it for an operator rather than guessing.
      unmatched += 1;
      continue;
    }
    const reason = idleTunnelReason(tunnel.activity, now, policy);
    if (!reason) continue;
    idle[reason] += 1;
    if (config.capacity.reclaimMode !== "on") {
      if (await reclaimEligible(env, account, row, tunnel.id, reason, policy, now)) eligible += 1;
      continue;
    }
    if (budget.marks <= 0) continue;
    if (await markIdleEndpoint(env, account, row, tunnel.id, reason, policy, now)) {
      budget.marks -= 1;
      marked += 1;
      eligible += 1;
    }
  }

  // Dormant: an active installation's endpoint whose tunnel is gone (idle
  // reclaim or its owner's DELETE). Its hostname still belongs to this
  // account, so a returning owner needs a slot here.
  const counts = await env.DB.prepare(
    `SELECT COUNT(CASE WHEN e.status = 'deleting' AND e.reclaim_requested_at IS NOT NULL THEN 1 END)
              AS reclaim_pending,
            COUNT(CASE WHEN e.tunnel_id IS NULL AND e.last_reconciled_at IS NOT NULL
                        AND i.id IS NOT NULL AND i.revoked_at IS NULL THEN 1 END)
              AS dormant_endpoints
       FROM installation_endpoints e
       LEFT JOIN installations i ON i.id = e.installation_id
      WHERE e.provider_account = ?
        AND ${opaqueHostnameSQL("e.hostname", "?")}`,
  ).bind(account.accountId, account.companionHostSuffix).first<{ dormant_endpoints: number; reclaim_pending: number }>();
  const reclaimPending = counts?.reclaim_pending ?? 0;
  const dormantEndpoints = counts?.dormant_endpoints ?? 0;

  const lastPage = listing.returned < TUNNEL_SCAN_PAGE_SIZE
    || (listing.totalCount !== null && page * TUNNEL_SCAN_PAGE_SIZE >= listing.totalCount)
    || page >= MAX_SCAN_PAGE;
  const nextPage = lastPage ? 1 : page + 1;
  const tunnelCount = listing.totalCount
    ?? (page === 1 && listing.returned < TUNNEL_SCAN_PAGE_SIZE ? listing.returned : null);

  await env.DB.prepare(
    `INSERT INTO managed_endpoint_account_capacity
       (provider_account, scan_page, tunnel_count, dns_record_count, reclaim_pending,
        dormant_endpoints, checked_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_account) DO UPDATE SET
       scan_page = excluded.scan_page,
       tunnel_count = excluded.tunnel_count,
       dns_record_count = excluded.dns_record_count,
       reclaim_pending = excluded.reclaim_pending,
       dormant_endpoints = excluded.dormant_endpoints,
       checked_at = excluded.checked_at,
       updated_at = excluded.updated_at`,
  ).bind(account.accountId, nextPage, tunnelCount, dnsRecordCount, reclaimPending, dormantEndpoints, now, now).run();

  capacityAlert(requestId, account, "tunnels", tunnelCount, account.tunnelLimit);
  capacityAlert(requestId, account, "dns_records", dnsRecordCount, account.dnsRecordLimit);

  const summary: TunnelScanSummary = {
    dnsRecordCount,
    eligible,
    hostSuffix,
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
  return {
    snapshot: {
      ...previous,
      checked_at: now,
      dns_record_count: dnsRecordCount,
      dormant_endpoints: dormantEndpoints,
      reclaim_pending: reclaimPending,
      scan_page: nextPage,
      tunnel_count: tunnelCount,
    },
    summary,
  };
}

/**
 * One bounded scan step per configured account, in config order. A failure
 * in one account is logged and never stops the others.
 */
export async function scanTunnelCapacity(
  env: Env,
  config: ControlPlaneConfig,
  fetcher: CloudflareFetch,
  requestId: string,
  now = Date.now(),
): Promise<TunnelScanSummary[]> {
  const previous = await accountSnapshots(env, config);
  const current = new Map(previous);
  const summaries: TunnelScanSummary[] = [];
  const budget = { marks: RECLAIM_MARK_LIMIT };
  for (const account of config.endpointAccounts) {
    try {
      const scanned = await scanAccount(
        env,
        config,
        account,
        previous.get(account.accountId) ?? emptySnapshot(account.accountId),
        fetcher,
        requestId,
        budget,
        now,
      );
      if (!scanned) continue;
      current.set(account.accountId, scanned.snapshot);
      summaries.push(scanned.summary);
    } catch {
      console.error(JSON.stringify({
        message: "managed endpoint tunnel scan failed",
        requestId,
        hostSuffix: account.companionHostSuffix,
        errorCode: "endpoint_internal",
      }));
    }
  }
  await forgetCachedCapacity(config);
  if (config.endpointAccounts.length > 1) {
    const pool = poolHealth(config, current, now);
    if (pool.status === "high" || pool.status === "full") {
      // A full account stays full for good once it has filled; page on the
      // pool, which is what a new installation sees.
      console.error(JSON.stringify({
        message: "managed endpoint pool capacity high",
        alert: "managed_endpoint_pool_capacity",
        requestId,
        status: pool.status,
        accounts: pool.accounts.map((each) => ({
          hostSuffix: each.account.companionHostSuffix,
          newEndpoints: each.account.newEndpoints,
          status: each.status,
        })),
      }));
    }
  }
  return summaries;
}

/** Operator signals that need no provider call: ignored account config, and
 * endpoints no configured account acts on (`endpointAccountFor`): their
 * account is not, or no longer, configured, or their hostname is not one
 * opaque label under its suffix. Those endpoints refuse every action until
 * their account is configured as it was. */
export async function reportEndpointAccountProblems(
  env: Env,
  config: ControlPlaneConfig,
  requestId: string,
): Promise<void> {
  if (config.endpointAccountIssues.length > 0) {
    console.error(JSON.stringify({
      message: "managed endpoint account configuration ignored",
      alert: "managed_endpoint_account_config",
      requestId,
      issues: config.endpointAccountIssues,
    }));
  }
  const stranded = await env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM installation_endpoints e
      WHERE NOT ${ACTED_ON_ENDPOINT_SQL}
        AND (
          e.status != 'deleted'
          OR EXISTS (
            SELECT 1 FROM installations i
             WHERE i.id = e.installation_id AND i.revoked_at IS NULL
          )
        )`,
  ).bind(actedOnAccounts(config)).first<{ count: number }>();
  if ((stranded?.count ?? 0) > 0) {
    console.error(JSON.stringify({
      message: "managed endpoints in an unconfigured account",
      alert: "managed_endpoint_account_unconfigured",
      requestId,
      endpoints: stranded?.count,
    }));
  }
}

type CapacityStatus = "full" | "high" | "ok" | "unknown";

function usageStatus(used: number | null, limit: number): CapacityStatus {
  if (used === null) return "unknown";
  if (used >= limit) return "full";
  if (used * 100 >= limit * CAPACITY_ALERT_PERCENT) return "high";
  return "ok";
}

const STATUS_RANK: Record<Exclude<CapacityStatus, "unknown">, number> = { ok: 0, high: 1, full: 2 };

function knownStatus(statuses: CapacityStatus[], pick: "best" | "worst"): CapacityStatus {
  let chosen: CapacityStatus = "unknown";
  for (const status of statuses) {
    if (status === "unknown") continue;
    if (
      chosen === "unknown"
      || (pick === "worst" ? STATUS_RANK[status] > STATUS_RANK[chosen] : STATUS_RANK[status] < STATUS_RANK[chosen])
    ) {
      chosen = status;
    }
  }
  return chosen;
}

interface AccountHealth {
  account: EndpointAccount;
  rejected: boolean;
  snapshot: AccountSnapshot;
  stale: boolean;
  status: CapacityStatus;
}

function accountHealth(account: EndpointAccount, snapshot: AccountSnapshot, now: number): AccountHealth {
  const stale = !snapshotFresh(snapshot, now);
  const tunnelStatus = stale ? "unknown" : usageStatus(snapshot.tunnel_count, account.tunnelLimit);
  const dnsStatus = stale ? "unknown" : usageStatus(snapshot.dns_record_count, account.dnsRecordLimit);
  // A recent refusal is gating that account's new allocations.
  const rejected = rejectionActive(snapshot, now);
  return {
    account,
    rejected,
    snapshot,
    stale,
    status: rejected ? "full" : knownStatus([tunnelStatus, dnsStatus], "worst"),
  };
}

/** What a new installation sees: the best known status among the accounts
 * that take new endpoints (`open`; the primary always does). A new
 * installation runs the newest release, which meets every `minAppVersion`,
 * so a gated account counts: older releases are refused there by design
 * (README "Why minAppVersion"), and paging on that would page for as long as
 * older releases run. `accounts` is every account, for the report. */
function poolHealth(
  config: ControlPlaneConfig,
  snapshots: ReadonlyMap<string, AccountSnapshot>,
  now: number,
): { accounts: AccountHealth[]; open: AccountHealth[]; status: CapacityStatus } {
  const accounts = config.endpointAccounts.map((account) => accountHealth(
    account,
    snapshots.get(account.accountId) ?? emptySnapshot(account.accountId),
    now,
  ));
  const open = accounts.filter((each) => each.account.newEndpoints);
  return { accounts, open, status: knownStatus(open.map((each) => each.status), "best") };
}

function sumOrNull(values: Array<number | null>): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

/** Counts and timestamps only: safe for the unauthenticated health check.
 * With one account this is that account's snapshot, unchanged; with more the
 * top level is the pool a new installation sees (the accounts that take new
 * endpoints), plus one entry per account, named by its host suffix, never by
 * an account or zone ID. */
export async function capacityHealth(
  env: Env,
  config: ControlPlaneConfig,
  ctx: ExecutionContext,
  now = Date.now(),
): Promise<JSONValue> {
  const pool = poolHealth(config, await cachedSnapshots(env, config, ctx), now);
  const only = pool.accounts.length === 1 ? pool.accounts[0] : undefined;
  if (only) {
    return {
      status: only.status,
      checkedAt: only.snapshot.checked_at,
      tunnels: { used: only.snapshot.tunnel_count, limit: only.account.tunnelLimit },
      dnsRecords: { used: only.snapshot.dns_record_count, limit: only.account.dnsRecordLimit },
      providerRejectedAt: only.rejected ? only.snapshot.capacity_rejected_at : null,
      reclaim: { mode: config.capacity.reclaimMode, pending: only.snapshot.reclaim_pending },
    };
  }
  const { open } = pool;
  const known = (pick: (each: AccountHealth) => number | null) => sumOrNull(open.map(
    (each) => (each.stale ? null : pick(each)),
  ));
  const checkedAt = open.map((each) => each.snapshot.checked_at);
  const allRejected = open.every((each) => each.rejected);
  return {
    status: pool.status,
    checkedAt: checkedAt.includes(null) ? null : Math.min(...checkedAt.map(Number)),
    tunnels: {
      used: known((each) => each.snapshot.tunnel_count),
      limit: open.reduce((total, each) => total + each.account.tunnelLimit, 0),
    },
    dnsRecords: {
      used: known((each) => each.snapshot.dns_record_count),
      limit: open.reduce((total, each) => total + each.account.dnsRecordLimit, 0),
    },
    providerRejectedAt: allRejected
      ? Math.max(...open.map((each) => each.snapshot.capacity_rejected_at ?? 0))
      : null,
    reclaim: {
      mode: config.capacity.reclaimMode,
      pending: open.reduce((total, each) => total + each.snapshot.reclaim_pending, 0),
    },
    accounts: pool.accounts.map((each) => ({
      hostSuffix: each.account.companionHostSuffix,
      newEndpoints: each.account.newEndpoints,
      status: each.status,
      checkedAt: each.snapshot.checked_at,
      tunnels: { used: each.snapshot.tunnel_count, limit: each.account.tunnelLimit },
      dnsRecords: { used: each.snapshot.dns_record_count, limit: each.account.dnsRecordLimit },
      providerRejectedAt: each.rejected ? each.snapshot.capacity_rejected_at : null,
      reclaimPending: each.snapshot.reclaim_pending,
    })),
  };
}
