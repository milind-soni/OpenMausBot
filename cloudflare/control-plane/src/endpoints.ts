import { z } from "zod";

import {
  CloudflareAPI,
  CloudflareAPIError,
  type CloudflareDNSRecord,
  type CloudflareFetch,
  type CloudflareTunnel,
} from "./cloudflare-api";
import type { ControlPlaneConfig, EndpointAccount } from "./config";
import {
  ACTED_ON_ENDPOINT_SQL,
  actedOnAccounts,
  chooseNewEndpointAccount,
  endpointAccountFor,
  neverReady,
  rejectionActive,
  relocationTarget,
  snapshotFresh,
  type AccountSnapshot,
} from "./endpoint-accounts";
import { errorResponse, HTTPError, json, readOptionalBoundedJSON } from "./http";
import {
  printableVersion,
  recordReportedAppVersion,
  requireInstallation,
  requireInstallationAndRead,
} from "./installations";
import { idleTunnelReason } from "./tunnel-activity";
import {
  accountSnapshots,
  CAPACITY_RETRY_AFTER_SECONDS,
  idlePolicy,
  isCapacityErrorCode,
  recordAccountRefusal,
  releaseCleanedCapacity,
  type AccountCleanup,
} from "./tunnel-capacity";

type EndpointStatus = "pending" | "provisioning" | "ready" | "deleting" | "deleted" | "error";

interface EndpointRow {
  installation_id: string;
  /** The Cloudflare account that holds this endpoint, for life. */
  provider_account: string;
  hostname: string;
  tunnel_name: string;
  tunnel_id: string | null;
  dns_record_id: string | null;
  status: EndpointStatus;
  generation: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  last_reconciled_at: number | null;
  delete_requested_at: number | null;
  last_error_code: string | null;
  cleanup_attempts: number;
  last_cleanup_attempt_at: number | null;
  reclaim_requested_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ClaimedEndpoint {
  leaseOwner: string;
  row: EndpointRow;
}

const LEASE_MS = 60_000;
const ENDPOINT_ACTION_WINDOW_MS = 60 * 60 * 1_000;
const ENDPOINT_RECONCILE_LIMIT = 20;
const ENDPOINT_DELETE_LIMIT = 30;
// A cleanup can make at most ten external Cloudflare API calls when it must
// rediscover both provider IDs. The per-run row count is configuration
// (OMB_CLEANUP_SWEEP_LIMIT, see config.ts); rows run at most five at a time so
// they stay inside the Workers limit of six connections awaiting headers.
const CLEANUP_CONCURRENCY = 5;
const CLEANUP_BACKOFF_1_MS = 5 * 60 * 1_000;
const CLEANUP_BACKOFF_2_MS = 15 * 60 * 1_000;
const CLEANUP_BACKOFF_3_MS = 60 * 60 * 1_000;
const CLEANUP_BACKOFF_4_MS = 6 * 60 * 60 * 1_000;
const CLEANUP_BACKOFF_MAX_MS = 24 * 60 * 60 * 1_000;
const MANUAL_CLEANUP_THRESHOLD_MS = 24 * 60 * 60 * 1_000;
/** Cloudflare blocks a rate-limited API token for up to five minutes. */
const RATE_LIMIT_RETRY_AFTER_DEFAULT_SECONDS = 60;
const RATE_LIMIT_RETRY_AFTER_MIN_SECONDS = 30;
const RATE_LIMIT_RETRY_AFTER_MAX_SECONDS = 300;

/** Codes Cloudflare uses to refuse an account a new tunnel. */
const TUNNEL_QUOTA_CODES: ReadonlySet<string> = new Set(["cf_api_1045", "cf_tunnel_quota"]);

class EndpointOperationError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryAfterSeconds: number | null = null,
    /** The ID of the account the operation was acting in when it failed (an
     * ID, never the account: the account carries its API token). */
    public readonly accountId: string | null = null,
    /** Cloudflare refused that account's token (see `tokenRefused`). */
    public readonly tokenRefused = false,
  ) {
    super(code);
    this.name = "EndpointOperationError";
  }
}

function errorCode(error: unknown): string {
  if (error instanceof CloudflareAPIError || error instanceof EndpointOperationError) return error.code;
  return "endpoint_internal";
}

/** Cloudflare answered 401 or 403: the account's token is invalid, revoked,
 * or lacks a permission (Tunnel or DNS Edit). That holds for every request in
 * the account until an operator fixes the token, not for this one alone. */
function tokenRefused(error: unknown): boolean {
  if (error instanceof EndpointOperationError) return error.tokenRefused;
  return error instanceof CloudflareAPIError && (error.status === 401 || error.status === 403);
}

/** Only an operator can fix a refused token. A stable `alert` field gives
 * Workers Logs a single filter; the host suffix names the account. */
function tokenRefusedAlert(requestId: string, account: EndpointAccount, code: string): void {
  console.error(JSON.stringify({
    message: "managed endpoint account token refused",
    alert: "managed_endpoint_account_refused",
    requestId,
    hostSuffix: account.companionHostSuffix,
    errorCode: code,
  }));
}

function retryAfterSeconds(error: unknown): number | null {
  if (error instanceof CloudflareAPIError || error instanceof EndpointOperationError) {
    return error.retryAfterSeconds;
  }
  return null;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function endpointJSON(row: EndpointRow) {
  return {
    url: `https://${row.hostname}`,
    hostname: row.hostname,
    status: row.status,
    generation: row.generation,
    updatedAt: row.updated_at,
    lastReconciledAt: row.last_reconciled_at,
    lastErrorCode: row.last_error_code,
  };
}

function endpointRowStatement(env: Env, installationId: string): D1PreparedStatement {
  return env.DB.prepare(
    `SELECT installation_id, provider_account, hostname, tunnel_name, tunnel_id, dns_record_id,
            status, generation, lease_owner, lease_expires_at,
            last_reconciled_at, delete_requested_at, last_error_code,
            cleanup_attempts, last_cleanup_attempt_at, reclaim_requested_at,
            created_at, updated_at
       FROM installation_endpoints
      WHERE installation_id = ?`,
  ).bind(installationId);
}

async function endpointRow(env: Env, installationId: string): Promise<EndpointRow | null> {
  return endpointRowStatement(env, installationId).first<EndpointRow>();
}

async function ensureEndpointRow(
  env: Env,
  installationId: string,
  account: EndpointAccount,
): Promise<EndpointRow> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const opaque = randomHex(16);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO installation_endpoints
        (installation_id, provider_account, hostname, tunnel_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(
      installationId,
      account.accountId,
      `c-${opaque}.${account.companionHostSuffix}`,
      `omb-c-${opaque}`,
      now,
      now,
    ).run();
    const row = await endpointRow(env, installationId);
    if (row) return row;
  }
  throw new EndpointOperationError("endpoint_reservation_failed");
}

/** What provisioning needs to know about the accounts, read from D1 at most
 * once per request and only when a decision needs it. A failed read decides
 * as if nothing were known: the primary, no move, no gate. */
interface Allocation {
  /** The version the app reported now, else the one it registered with. */
  appVersion: string | null;
  snapshots(): Promise<ReadonlyMap<string, AccountSnapshot>>;
}

function allocationFor(env: Env, config: ControlPlaneConfig, appVersion: string | null): Allocation {
  let loaded: Promise<ReadonlyMap<string, AccountSnapshot>> | null = null;
  return {
    appVersion,
    snapshots: () => (loaded ??= accountSnapshots(env, config).catch(() => new Map())),
  };
}

async function newEndpointAccount(config: ControlPlaneConfig, allocation: Allocation): Promise<EndpointAccount> {
  // One account: no choice, and no D1 read.
  if (config.endpointAccounts.length === 1) return config.cloudflare;
  return chooseNewEndpointAccount(config, await allocation.snapshots(), allocation.appVersion, Date.now());
}

async function relocationFor(
  config: ControlPlaneConfig,
  allocation: Allocation,
  from: EndpointAccount,
): Promise<EndpointAccount | null> {
  if (config.endpointAccounts.length === 1) return null;
  return relocationTarget(config, await allocation.snapshots(), allocation.appVersion, from, Date.now());
}

async function refusingNewTunnels(allocation: Allocation, account: EndpointAccount): Promise<boolean> {
  return rejectionActive((await allocation.snapshots()).get(account.accountId), Date.now());
}

const provisionRequestSchema = z.strictObject({ appVersion: printableVersion.optional() });

/** POST may carry `{ "appVersion": "0.1.103" }`; older apps send no body. */
async function reportedAppVersion(request: Request): Promise<string | null> {
  const body = await readOptionalBoundedJSON(request);
  if (body === undefined) return null;
  const parsed = provisionRequestSchema.safeParse(body);
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  return parsed.data.appVersion ?? null;
}

async function enforceEndpointRateLimit(
  env: Env,
  installationId: string,
  action: "delete_endpoint" | "reconcile_endpoint",
): Promise<void> {
  const now = Date.now();
  const cutoff = now - ENDPOINT_ACTION_WINDOW_MS;
  const limit = action === "reconcile_endpoint" ? ENDPOINT_RECONCILE_LIMIT : ENDPOINT_DELETE_LIMIT;
  const result = await env.DB.prepare(
    `INSERT INTO installation_action_rate_limits
      (installation_id, action, window_started_at, attempts, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(installation_id, action) DO UPDATE SET
       window_started_at = CASE
         WHEN window_started_at <= ? THEN excluded.window_started_at
         ELSE window_started_at
       END,
       attempts = CASE
         WHEN window_started_at <= ? THEN 1
         ELSE attempts + 1
       END,
       updated_at = excluded.updated_at
     WHERE window_started_at <= ? OR attempts < ?`,
  ).bind(installationId, action, now, now, cutoff, cutoff, cutoff, limit).run();
  if (result.meta.changes === 0) throw new HTTPError(429, "rate_limited");
}

async function claimEndpoint(
  env: Env,
  row: EndpointRow,
  nextStatus: "deleting" | "provisioning",
  { keepReclaim = false }: { keepReclaim?: boolean } = {},
): Promise<ClaimedEndpoint | null> {
  const now = Date.now();
  const leaseOwner = crypto.randomUUID();
  // An owner-requested deletion is final. An idle reclaim is not: a returning
  // installation may take its row back by provisioning before the sweep has
  // removed anything.
  const deletingGuard = nextStatus === "provisioning"
    ? "AND (status != 'deleting' OR reclaim_requested_at IS NOT NULL)"
    // The sweep's claim: only a row still marked for deletion, or one whose
    // installation was revoked or removed. A row its owner took back (by
    // provisioning again) after the sweep chose it is left alone.
    : keepReclaim
      ? `AND (status = 'deleting' OR NOT EXISTS (
           SELECT 1 FROM installations i
            WHERE i.id = installation_endpoints.installation_id
              AND i.revoked_at IS NULL
         ))`
      : "";
  const result = await env.DB.prepare(
    `UPDATE installation_endpoints
        SET status = ?, generation = generation + 1,
            lease_owner = ?, lease_expires_at = ?, updated_at = ?,
            delete_requested_at = CASE WHEN ? = 'deleting' THEN COALESCE(delete_requested_at, ?) ELSE NULL END,
            cleanup_attempts = CASE WHEN ? = 'deleting' THEN cleanup_attempts + 1 ELSE 0 END,
            last_cleanup_attempt_at = CASE WHEN ? = 'deleting' THEN ? ELSE NULL END,
            last_error_code = NULL,
            reclaim_requested_at = CASE
              WHEN ? = 'deleting' AND ? = 1 AND EXISTS (
                SELECT 1 FROM installations i
                 WHERE i.id = installation_endpoints.installation_id
                   AND i.revoked_at IS NULL
              ) THEN reclaim_requested_at
              ELSE NULL
            END
      WHERE installation_id = ?
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ${deletingGuard}`,
  ).bind(
    nextStatus,
    leaseOwner,
    now + LEASE_MS,
    now,
    nextStatus,
    now,
    nextStatus,
    nextStatus,
    now,
    nextStatus,
    keepReclaim ? 1 : 0,
    row.installation_id,
    now,
  ).run();
  if (result.meta.changes === 0) return null;
  const claimed = await endpointRow(env, row.installation_id);
  if (!claimed || claimed.lease_owner !== leaseOwner) {
    throw new EndpointOperationError("lease_lost");
  }
  return { leaseOwner, row: claimed };
}

async function updateClaimedResources(
  env: Env,
  claim: ClaimedEndpoint,
  tunnelId: string | null,
  dnsRecordId: string | null,
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE installation_endpoints
        SET tunnel_id = ?, dns_record_id = ?, updated_at = ?
      WHERE installation_id = ? AND generation = ? AND lease_owner = ?`,
  ).bind(
    tunnelId,
    dnsRecordId,
    Date.now(),
    claim.row.installation_id,
    claim.row.generation,
    claim.leaseOwner,
  ).run();
  if (result.meta.changes === 0) throw new EndpointOperationError("lease_lost");
  claim.row.tunnel_id = tunnelId;
  claim.row.dns_record_id = dnsRecordId;
}

async function renewClaim(env: Env, claim: ClaimedEndpoint): Promise<void> {
  const now = Date.now();
  const leaseExpiresAt = now + LEASE_MS;
  const result = await env.DB.prepare(
    `UPDATE installation_endpoints
        SET lease_expires_at = ?, updated_at = ?
      WHERE installation_id = ? AND generation = ? AND lease_owner = ?
        AND lease_expires_at > ?`,
  ).bind(
    leaseExpiresAt,
    now,
    claim.row.installation_id,
    claim.row.generation,
    claim.leaseOwner,
    now,
  ).run();
  if (result.meta.changes === 0) throw new EndpointOperationError("lease_lost");
  claim.row.lease_expires_at = leaseExpiresAt;
}

async function withClaimLease<T>(
  env: Env,
  claim: ClaimedEndpoint,
  operation: () => Promise<T>,
): Promise<T> {
  await renewClaim(env, claim);
  return operation();
}

function expectedTunnelTarget(tunnelId: string): string {
  return `${tunnelId}.cfargotunnel.com`;
}

function assertTunnelIdentity(
  claim: ClaimedEndpoint,
  tunnelId: string,
  tunnel: { id: string; name: string },
): void {
  if (tunnel.id !== tunnelId || tunnel.name !== claim.row.tunnel_name) {
    throw new EndpointOperationError("tunnel_identity_conflict");
  }
}

function assertDNSIdentity(
  claim: ClaimedEndpoint,
  tunnelId: string,
  dnsRecordId: string,
  record: { content: string; id: string; name: string; proxied: boolean; type: string },
): void {
  if (
    record.id !== dnsRecordId
    || record.name.toLowerCase() !== claim.row.hostname
    || record.type !== "CNAME"
    || record.content.toLowerCase() !== expectedTunnelTarget(tunnelId)
    || !record.proxied
  ) {
    throw new EndpointOperationError("dns_record_identity_conflict");
  }
}

async function finishClaim(
  env: Env,
  claim: ClaimedEndpoint,
  status: "deleted" | "ready",
): Promise<EndpointRow> {
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE installation_endpoints
        SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
            last_reconciled_at = ?, last_error_code = NULL, updated_at = ?
      WHERE installation_id = ? AND generation = ? AND lease_owner = ?`,
  ).bind(status, now, now, claim.row.installation_id, claim.row.generation, claim.leaseOwner).run();
  if (result.meta.changes === 0) throw new EndpointOperationError("lease_lost");
  const row = await endpointRow(env, claim.row.installation_id);
  if (!row) throw new EndpointOperationError("endpoint_state_missing");
  return row;
}

async function failClaim(
  env: Env,
  claim: ClaimedEndpoint,
  code: string,
  preserveDeleting: boolean,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE installation_endpoints
        SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = ?, updated_at = ?
      WHERE installation_id = ? AND generation = ? AND lease_owner = ?`,
  ).bind(
    preserveDeleting ? "deleting" : "error",
    code.slice(0, 64),
    Date.now(),
    claim.row.installation_id,
    claim.row.generation,
    claim.leaseOwner,
  ).run();
}

/** Undo an idle reclaim whose tunnel came back. Resources that are still
 * intact return to 'ready'; if the DNS record was already removed the row
 * becomes a retryable 'error' that the next provisioning call repairs. */
async function cancelReclaim(env: Env, claim: ClaimedEndpoint): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE installation_endpoints
        SET status = CASE
              WHEN tunnel_id IS NOT NULL AND dns_record_id IS NOT NULL THEN 'ready'
              ELSE 'error'
            END,
            last_error_code = CASE
              WHEN tunnel_id IS NOT NULL AND dns_record_id IS NOT NULL THEN NULL
              ELSE 'reclaim_cancelled'
            END,
            reclaim_requested_at = NULL, delete_requested_at = NULL,
            cleanup_attempts = 0, last_cleanup_attempt_at = NULL,
            lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE installation_id = ? AND generation = ? AND lease_owner = ?`,
  ).bind(Date.now(), claim.row.installation_id, claim.row.generation, claim.leaseOwner).run();
  if (result.meta.changes === 0) throw new EndpointOperationError("lease_lost");
}

/** Re-evaluated with fresh provider state before each destructive call of an
 * idle reclaim. A revoked or vanished owner no longer protects its tunnel. */
async function reclaimStillAllowed(
  env: Env,
  config: ControlPlaneConfig,
  claim: ClaimedEndpoint,
  tunnel: CloudflareTunnel,
): Promise<boolean> {
  const installation = await env.DB.prepare(
    `SELECT revoked_at, last_seen_at FROM installations WHERE id = ?`,
  ).bind(claim.row.installation_id).first<{ last_seen_at: number | null; revoked_at: number | null }>();
  if (!installation || installation.revoked_at !== null) return true;
  if (
    installation.last_seen_at !== null
    && installation.last_seen_at > (claim.row.reclaim_requested_at ?? 0)
  ) {
    return false;
  }
  return idleTunnelReason(tunnel.activity, Date.now(), idlePolicy(config)) !== null;
}

function busyResponse(): Response {
  const response = errorResponse(409, "endpoint_busy");
  const headers = new Headers(response.headers);
  headers.set("retry-after", "2");
  return new Response(response.body, { status: response.status, headers });
}

/** Cloudflare's API limit is shared by every request this Worker makes, and
 * a 429 can block it for minutes. Tell the desktop how long to wait instead
 * of the generic `endpoint_unavailable`: honor Cloudflare's own Retry-After
 * when it sent one, bounded so a retry is neither immediate nor indefinite. */
function rateLimitedResponse(providerRetryAfterSeconds: number | null): Response {
  const seconds = Math.min(
    RATE_LIMIT_RETRY_AFTER_MAX_SECONDS,
    Math.max(
      RATE_LIMIT_RETRY_AFTER_MIN_SECONDS,
      providerRetryAfterSeconds ?? RATE_LIMIT_RETRY_AFTER_DEFAULT_SECONDS,
    ),
  );
  const response = errorResponse(503, "endpoint_rate_limited");
  const headers = new Headers(response.headers);
  headers.set("retry-after", String(seconds));
  return new Response(response.body, { status: response.status, headers });
}

/** The provider's tunnel or DNS record quota is exhausted. This is distinct
 * from `endpoint_unavailable` so the desktop can say so and retry later. */
function capacityResponse(): Response {
  const response = errorResponse(503, "endpoint_capacity");
  const headers = new Headers(response.headers);
  headers.set("retry-after", String(CAPACITY_RETRY_AFTER_SECONDS));
  return new Response(response.body, { status: response.status, headers });
}

async function reconcileDNSWriteResult(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  tunnelId: string,
  expectedRecordId: string | null,
): Promise<CloudflareDNSRecord | null> {
  const records = await withClaimLease(
    env,
    claim,
    () => api.listDNSRecords(claim.row.hostname),
  );
  if (records.length > 1) throw new EndpointOperationError("dns_record_conflict");
  const record = records[0];
  if (!record) return null;
  if (expectedRecordId && record.id !== expectedRecordId) {
    throw new EndpointOperationError("dns_record_conflict");
  }
  if (
    record.name.toLowerCase() !== claim.row.hostname
    || record.type !== "CNAME"
    || record.content.toLowerCase() !== expectedTunnelTarget(tunnelId)
    || !record.proxied
  ) {
    throw new EndpointOperationError("dns_record_conflict");
  }
  return record;
}

async function verifiedTunnelForCleanup(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  tunnelId: string,
): Promise<CloudflareTunnel | null> {
  const tunnel = await withClaimLease(env, claim, () => api.getTunnel(tunnelId));
  const named = await withClaimLease(
    env,
    claim,
    () => api.listTunnels(claim.row.tunnel_name),
  );
  if (named.length > 1) throw new EndpointOperationError("tunnel_identity_conflict");
  if (!tunnel) {
    if (named.length !== 0) throw new EndpointOperationError("tunnel_identity_conflict");
    return null;
  }
  assertTunnelIdentity(claim, tunnelId, tunnel);
  if (named.length !== 1 || named[0]?.id !== tunnelId) {
    throw new EndpointOperationError("tunnel_identity_conflict");
  }
  return tunnel;
}

async function verifiedDNSForCleanup(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  tunnelId: string,
  dnsRecordId: string,
): Promise<CloudflareDNSRecord | null> {
  const record = await withClaimLease(env, claim, () => api.getDNSRecord(dnsRecordId));
  const named = await withClaimLease(
    env,
    claim,
    () => api.listDNSRecords(claim.row.hostname),
  );
  if (named.length > 1) throw new EndpointOperationError("dns_record_identity_conflict");
  if (!record) {
    if (named.length !== 0) throw new EndpointOperationError("dns_record_identity_conflict");
    return null;
  }
  assertDNSIdentity(claim, tunnelId, dnsRecordId, record);
  if (named.length !== 1 || named[0]?.id !== dnsRecordId) {
    throw new EndpointOperationError("dns_record_identity_conflict");
  }
  return record;
}

async function rollbackCreatedResources(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  state: {
    createdDNSRecord: boolean;
    createdTunnel: boolean;
    dnsMayReferenceTunnel: boolean;
    dnsRecordId: string | null;
    tunnelId: string | null;
  },
): Promise<{ dnsRecordId: string | null; tunnelId: string | null }> {
  let { dnsRecordId, tunnelId } = state;
  if (!state.createdDNSRecord && !state.createdTunnel) return { dnsRecordId, tunnelId };
  if (tunnelId) await verifiedTunnelForCleanup(env, claim, api, tunnelId);

  if (state.createdDNSRecord && dnsRecordId && tunnelId) {
    const record = await verifiedDNSForCleanup(env, claim, api, tunnelId, dnsRecordId);
    if (record) {
      await renewClaim(env, claim);
      await api.deleteDNSRecord(dnsRecordId);
    }
    dnsRecordId = null;
    await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
  }

  if (
    state.createdTunnel
    && tunnelId
    && (!state.dnsMayReferenceTunnel || (state.createdDNSRecord && !dnsRecordId))
  ) {
    // Re-fetch immediately before the destructive request. The stable name is
    // our provider-side identity fence; a renamed/repurposed tunnel is retained.
    const tunnel = await verifiedTunnelForCleanup(env, claim, api, tunnelId);
    if (tunnel) {
      await renewClaim(env, claim);
      await api.deleteTunnel(tunnelId);
    }
    tunnelId = null;
    await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
  }

  return { dnsRecordId, tunnelId };
}

/** Cloudflare answers tunnel creation with 429 both for its API rate limit
 * and, at an account's tunnel quota, instead of error 1045. Nothing was
 * created either way. Tell them apart by the account's tunnel count (or, when
 * the count cannot be read, its last scan less the tunnels scheduled cleanup
 * deleted since: see releaseCleanedCapacity): at or over the account's limit
 * it is the quota (`cf_tunnel_quota`, a capacity refusal); otherwise it stays
 * a rate limit. */
async function classifyCreate429(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  account: EndpointAccount,
  allocation: Allocation,
  rateLimited: CloudflareAPIError,
): Promise<Error> {
  let count: number | null = null;
  try {
    count = await withClaimLease(env, claim, () => api.countTunnels());
  } catch (error) {
    // A lost lease stops the request; a failed read falls back to the scan.
    if (error instanceof EndpointOperationError) throw error;
  }
  if (count === null) {
    const snapshot = (await allocation.snapshots()).get(account.accountId);
    if (snapshotFresh(snapshot, Date.now())) count = snapshot?.tunnel_count ?? null;
  }
  return count !== null && count >= account.tunnelLimit
    ? new EndpointOperationError("cf_tunnel_quota")
    : rateLimited;
}

/** The row's tunnel in its account: adopted by its stable name, or created. */
async function acquireTunnel(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  account: EndpointAccount,
  allocation: Allocation,
): Promise<{ created: boolean; tunnelId: string }> {
  const tunnels = await withClaimLease(
    env,
    claim,
    () => api.listTunnels(claim.row.tunnel_name),
  );
  if (tunnels.length > 1) throw new EndpointOperationError("tunnel_name_conflict");
  const existing = tunnels[0];
  if (existing) {
    if (claim.row.tunnel_id && claim.row.tunnel_id !== existing.id) {
      throw new EndpointOperationError("tunnel_id_conflict");
    }
    return { created: false, tunnelId: existing.id };
  }
  try {
    const tunnel = await withClaimLease(
      env,
      claim,
      () => api.createTunnel(claim.row.tunnel_name),
    );
    return { created: true, tunnelId: tunnel.id };
  } catch (createError) {
    if (createError instanceof CloudflareAPIError && createError.code === "cf_rate_limited") {
      throw await classifyCreate429(env, claim, api, account, allocation, createError);
    }
    // A timeout/network failure can arrive after Cloudflare committed the
    // POST. Reconcile by the stable opaque name instead of creating a
    // duplicate tunnel on the next request.
    let created: CloudflareTunnel[];
    try {
      created = await withClaimLease(
        env,
        claim,
        () => api.listTunnels(claim.row.tunnel_name),
      );
    } catch {
      throw createError;
    }
    if (created.length > 1) throw new EndpointOperationError("tunnel_name_conflict");
    const adopted = created[0];
    if (!adopted) throw createError;
    return { created: false, tunnelId: adopted.id };
  }
}

/** Moves a never-provisioned row to `target` under a new opaque hostname and
 * tunnel name. Returns false, leaving the row where it is, when its current
 * account already holds a tunnel or DNS record under its names: an
 * interrupted earlier request committed there, and the row adopts it. */
async function relocateClaim(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  from: EndpointAccount,
  target: EndpointAccount,
  requestId: string,
): Promise<boolean> {
  if (!neverReady(claim.row) || target.accountId === from.accountId) return false;
  const tunnels = await withClaimLease(env, claim, () => api.listTunnels(claim.row.tunnel_name));
  if (tunnels.length > 0) return false;
  const records = await withClaimLease(env, claim, () => api.listDNSRecords(claim.row.hostname));
  if (records.length > 0) return false;

  const opaque = randomHex(16);
  const hostname = `c-${opaque}.${target.companionHostSuffix}`;
  const tunnelName = `omb-c-${opaque}`;
  const result = await env.DB.prepare(
    `UPDATE installation_endpoints
        SET provider_account = ?, hostname = ?, tunnel_name = ?, updated_at = ?
      WHERE installation_id = ? AND generation = ? AND lease_owner = ?
        AND tunnel_id IS NULL AND dns_record_id IS NULL AND last_reconciled_at IS NULL`,
  ).bind(
    target.accountId,
    hostname,
    tunnelName,
    Date.now(),
    claim.row.installation_id,
    claim.row.generation,
    claim.leaseOwner,
  ).run();
  if (result.meta.changes === 0) throw new EndpointOperationError("lease_lost");
  claim.row.provider_account = target.accountId;
  claim.row.hostname = hostname;
  claim.row.tunnel_name = tunnelName;
  console.log(JSON.stringify({
    message: "managed endpoint relocated",
    requestId,
    from: from.companionHostSuffix,
    to: target.companionHostSuffix,
  }));
  return true;
}

async function reconcileClaim(
  env: Env,
  config: ControlPlaneConfig,
  claim: ClaimedEndpoint,
  fetcher: CloudflareFetch,
  allocation: Allocation,
  requestId: string,
): Promise<{ connectorToken: string; row: EndpointRow }> {
  const own = endpointAccountFor(config, claim.row);
  if (!own) {
    await failClaim(env, claim, "endpoint_account_unavailable", false).catch(() => undefined);
    throw new EndpointOperationError("endpoint_account_unavailable");
  }
  let account = own;
  let api = new CloudflareAPI(account, fetcher);
  let tunnelId = claim.row.tunnel_id;
  let dnsRecordId = claim.row.dns_record_id;
  let createdTunnel = false;
  let createdDNSRecord = false;
  let dnsMayReferenceTunnel = false;

  try {
    // A row that never handed out an address does not wait for its account:
    // it moves, at most once per request, to an account that takes new
    // tunnels. Every other row stays where it is for life.
    let moved = false;
    if (neverReady(claim.row) && await refusingNewTunnels(allocation, account)) {
      const target = await relocationFor(config, allocation, account);
      if (target && await relocateClaim(env, claim, api, account, target, requestId)) {
        account = target;
        api = new CloudflareAPI(target, fetcher);
        moved = true;
      }
    }

    let acquired: { created: boolean; tunnelId: string };
    try {
      acquired = await acquireTunnel(env, claim, api, account, allocation);
    } catch (refusal) {
      const code = errorCode(refusal);
      // Cloudflare refused the account, not this request: it is out of
      // tunnels, or its token is refused. Either holds for every request
      // there.
      const accountRefused = TUNNEL_QUOTA_CODES.has(code) || tokenRefused(refusal);
      const target = !moved && accountRefused && neverReady(claim.row)
        ? await relocationFor(config, allocation, account)
        : null;
      if (!target) throw refusal;
      // Close the account to every other request before leaving it.
      await recordAccountRefusal(env, config, account, code).catch(() => undefined);
      if (!(await relocateClaim(env, claim, api, account, target, requestId))) throw refusal;
      // This row found a working account; the refused token still needs an
      // operator.
      if (tokenRefused(refusal)) tokenRefusedAlert(requestId, account, code);
      account = target;
      api = new CloudflareAPI(target, fetcher);
      acquired = await acquireTunnel(env, claim, api, account, allocation);
    }
    tunnelId = acquired.tunnelId;
    createdTunnel = acquired.created;
    const activeTunnelId = tunnelId;
    await updateClaimedResources(env, claim, activeTunnelId, dnsRecordId);
    await withClaimLease(
      env,
      claim,
      () => api.configureTunnel(activeTunnelId, claim.row.hostname),
    );

    const target = expectedTunnelTarget(activeTunnelId);
    const records = await withClaimLease(
      env,
      claim,
      () => api.listDNSRecords(claim.row.hostname),
    );
    if (records.length > 1) throw new EndpointOperationError("dns_record_conflict");
    const existing = records[0];
    if (existing) {
      if (existing.content.toLowerCase() !== target && existing.id !== dnsRecordId) {
        throw new EndpointOperationError("dns_record_conflict");
      }
      dnsMayReferenceTunnel = existing.content.toLowerCase() === target;
      let record = existing;
      if (!existing.proxied || existing.content.toLowerCase() !== target) {
        dnsMayReferenceTunnel = true;
        try {
          record = await withClaimLease(
            env,
            claim,
            () => api.updateDNSRecord(existing.id, claim.row.hostname, activeTunnelId),
          );
        } catch (writeError) {
          try {
            const reconciled = await reconcileDNSWriteResult(
              env,
              claim,
              api,
              activeTunnelId,
              existing.id,
            );
            if (!reconciled) throw writeError;
            record = reconciled;
          } catch (reconcileError) {
            if (reconcileError instanceof EndpointOperationError) throw reconcileError;
            throw writeError;
          }
        }
      }
      dnsRecordId = record.id;
    } else {
      dnsMayReferenceTunnel = true;
      try {
        const record = await withClaimLease(
          env,
          claim,
          () => api.createDNSRecord(claim.row.hostname, activeTunnelId),
        );
        dnsRecordId = record.id;
        createdDNSRecord = true;
      } catch (writeError) {
        try {
          const reconciled = await reconcileDNSWriteResult(
            env,
            claim,
            api,
            activeTunnelId,
            null,
          );
          if (!reconciled) {
            dnsMayReferenceTunnel = false;
            throw writeError;
          }
          // The write may have committed, but its response did not prove that
          // this request created the record. Adopt and retain it on later
          // failures instead of destructively guessing.
          dnsRecordId = reconciled.id;
        } catch (reconcileError) {
          if (reconcileError instanceof EndpointOperationError) throw reconcileError;
          throw writeError;
        }
      }
    }
    await updateClaimedResources(env, claim, activeTunnelId, dnsRecordId);

    const connectorToken = await withClaimLease(
      env,
      claim,
      () => api.getConnectorToken(activeTunnelId),
    );
    const row = await finishClaim(env, claim, "ready");
    return { connectorToken, row };
  } catch (error) {
    let failure: unknown = error;

    try {
      const rolledBack = await rollbackCreatedResources(env, claim, api, {
        createdDNSRecord,
        createdTunnel,
        dnsMayReferenceTunnel,
        dnsRecordId,
        tunnelId,
      });
      dnsRecordId = rolledBack.dnsRecordId;
      tunnelId = rolledBack.tunnelId;
    } catch (rollbackError) {
      // A stale request must stop immediately: it no longer owns either the
      // D1 generation or the provider resources that a successor may adopt.
      failure = rollbackError;
    }
    const operationCode = errorCode(failure);
    try {
      await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
      await failClaim(env, claim, operationCode, false);
    } catch {
      // The original redacted failure is the useful client-facing result.
    }
    throw new EndpointOperationError(
      operationCode,
      retryAfterSeconds(failure),
      account.accountId,
      tokenRefused(failure),
    );
  }
}

type DeleteOutcome = "cancelled" | "deleted";

/** Provider resources a cleanup deleted, whatever its outcome. */
interface FreedResources {
  dnsRecords: number;
  tunnels: number;
}

async function deleteClaim(
  env: Env,
  config: ControlPlaneConfig,
  claim: ClaimedEndpoint,
  fetcher: CloudflareFetch,
  freed: FreedResources = { dnsRecords: 0, tunnels: 0 },
): Promise<DeleteOutcome> {
  let tunnelId = claim.row.tunnel_id;
  let dnsRecordId = claim.row.dns_record_id;
  const idleReclaim = claim.row.reclaim_requested_at !== null;

  try {
    // Always the endpoint's own account. Without it nothing is deleted: the
    // row keeps its IDs for when the account is configured again.
    const account = endpointAccountFor(config, claim.row);
    if (!account) throw new EndpointOperationError("endpoint_account_unavailable");
    const api = new CloudflareAPI(account, fetcher);
    if (!tunnelId) {
      const tunnels = await withClaimLease(
        env,
        claim,
        () => api.listTunnels(claim.row.tunnel_name),
      );
      if (tunnels.length > 1) throw new EndpointOperationError("tunnel_name_conflict");
      tunnelId = tunnels[0]?.id ?? null;
      if (tunnelId) await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
    }
    if (!dnsRecordId) {
      const records = await withClaimLease(
        env,
        claim,
        () => api.listDNSRecords(claim.row.hostname),
      );
      if (records.length > 1) throw new EndpointOperationError("dns_record_conflict");
      const record = records[0];
      if (record) {
        if (
          !tunnelId
          || record.type !== "CNAME"
          || record.content.toLowerCase() !== expectedTunnelTarget(tunnelId)
          || !record.proxied
        ) {
          throw new EndpointOperationError("dns_record_conflict");
        }
        dnsRecordId = record.id;
        await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
      }
    }

    // Validate the complete resource set before the first delete. Persisted
    // provider IDs are only hints: the hostname/CNAME and stable tunnel name
    // must still agree, otherwise cleanup retains metadata for an operator.
    if (tunnelId) {
      const tunnel = await verifiedTunnelForCleanup(env, claim, api, tunnelId);
      // An idle reclaim never removes anything from a tunnel that has
      // reconnected, or whose installation checked in, since it was marked.
      if (idleReclaim && tunnel && !(await reclaimStillAllowed(env, config, claim, tunnel))) {
        await cancelReclaim(env, claim);
        return "cancelled";
      }
    }
    const dnsRecord = dnsRecordId && tunnelId
      ? await verifiedDNSForCleanup(env, claim, api, tunnelId, dnsRecordId)
      : null;
    if (dnsRecordId && !tunnelId) {
      throw new EndpointOperationError("dns_record_identity_conflict");
    }

    if (dnsRecordId) {
      if (dnsRecord) {
        // Check again right before the first destructive call: the tunnel may
        // have reconnected while the DNS record was being verified.
        if (idleReclaim && tunnelId) {
          const current = await verifiedTunnelForCleanup(env, claim, api, tunnelId);
          if (current && !(await reclaimStillAllowed(env, config, claim, current))) {
            await cancelReclaim(env, claim);
            return "cancelled";
          }
        }
        await renewClaim(env, claim);
        await api.deleteDNSRecord(dnsRecordId);
        freed.dnsRecords += 1;
      }
      dnsRecordId = null;
      await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
    }
    if (tunnelId) {
      const tunnel = await verifiedTunnelForCleanup(env, claim, api, tunnelId);
      if (tunnel) {
        if (idleReclaim && !(await reclaimStillAllowed(env, config, claim, tunnel))) {
          await cancelReclaim(env, claim);
          return "cancelled";
        }
        await renewClaim(env, claim);
        await api.deleteTunnel(tunnelId);
        freed.tunnels += 1;
      }
      tunnelId = null;
      await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
    }
    await finishClaim(env, claim, "deleted");
    return "deleted";
  } catch (error) {
    const operationCode = errorCode(error);
    try {
      await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
      await failClaim(env, claim, operationCode, true);
    } catch {
      // Keep the original redacted error code.
    }
    throw new EndpointOperationError(operationCode);
  }
}

export async function getManagedEndpoint(request: Request, env: Env): Promise<Response> {
  const { row } = await requireInstallationAndRead<EndpointRow>(
    request,
    env,
    (installationId) => endpointRowStatement(env, installationId),
  );
  if (!row || row.status === "deleted") return json({ endpoint: null });
  return json({ endpoint: endpointJSON(row) });
}

export async function provisionManagedEndpoint(
  request: Request,
  env: Env,
  config: ControlPlaneConfig,
  fetcher: CloudflareFetch,
  requestId: string,
): Promise<Response> {
  const installation = await requireInstallation(request, env);
  await enforceEndpointRateLimit(env, installation.installation_id, "reconcile_endpoint");
  const reportedVersion = await reportedAppVersion(request);
  if (reportedVersion !== null && reportedVersion !== installation.app_version) {
    await recordReportedAppVersion(env, installation.installation_id, reportedVersion);
  }
  const allocation = allocationFor(env, config, reportedVersion ?? installation.app_version);
  // Only a new row chooses its account; an existing one keeps its own.
  const row = await endpointRow(env, installation.installation_id)
    ?? await ensureEndpointRow(env, installation.installation_id, await newEndpointAccount(config, allocation));
  const account = endpointAccountFor(config, row);
  if (!account) {
    // Its account is not configured (or its config was rejected): touching
    // any other account could orphan or duplicate the endpoint.
    console.error(JSON.stringify({
      message: "managed endpoint reconcile failed",
      requestId,
      errorCode: "endpoint_account_unavailable",
      capacity: false,
    }));
    throw new HTTPError(502, "endpoint_unavailable");
  }
  if (
    row.tunnel_id === null
    && await refusingNewTunnels(allocation, account)
    && !(neverReady(row) && await relocationFor(config, allocation, account))
  ) {
    // Cloudflare refused this account a new tunnel or DNS record, or its
    // token, moments ago, and the row cannot move. Answer locally instead of
    // spending the shared API budget on a sure failure, with the answer that
    // refusal got.
    const refusal = (await allocation.snapshots()).get(account.accountId)?.capacity_rejected_code ?? null;
    const capacity = refusal === null || isCapacityErrorCode(refusal);
    console.log(JSON.stringify({
      message: "managed endpoint allocation deferred",
      requestId,
      errorCode: capacity ? "endpoint_capacity" : "endpoint_unavailable",
      hostSuffix: account.companionHostSuffix,
    }));
    if (capacity) return capacityResponse();
    throw new HTTPError(502, "endpoint_unavailable");
  }
  const claim = await claimEndpoint(env, row, "provisioning");
  if (!claim) return busyResponse();

  try {
    const result = await reconcileClaim(env, config, claim, fetcher, allocation, requestId);
    return json({ endpoint: endpointJSON(result.row), connectorToken: result.connectorToken });
  } catch (error) {
    const code = errorCode(error);
    const capacity = isCapacityErrorCode(code);
    const refused = tokenRefused(error);
    const failedInId = error instanceof EndpointOperationError ? error.accountId : null;
    const failedIn = config.endpointAccounts.find((each) => each.accountId === failedInId) ?? account;
    console.error(JSON.stringify({
      message: "managed endpoint reconcile failed",
      requestId,
      errorCode: code,
      capacity,
      hostSuffix: failedIn.companionHostSuffix,
    }));
    if (refused) tokenRefusedAlert(requestId, failedIn, code);
    // A refused token closes the account like a quota, but only where
    // another account can take its new endpoints; with one account nothing
    // changes but the alert.
    if (capacity || (refused && config.endpointAccounts.length > 1)) {
      await recordAccountRefusal(env, config, failedIn, code).catch(() => undefined);
    }
    if (capacity) return capacityResponse();
    if (code === "cf_rate_limited") return rateLimitedResponse(retryAfterSeconds(error));
    throw new HTTPError(502, "endpoint_unavailable");
  }
}

export async function deleteManagedEndpoint(
  request: Request,
  env: Env,
  config: ControlPlaneConfig,
  fetcher: CloudflareFetch,
  requestId: string,
): Promise<Response> {
  const installation = await requireInstallation(request, env);
  const row = await endpointRow(env, installation.installation_id);
  if (!row || row.status === "deleted") {
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
  await enforceEndpointRateLimit(env, installation.installation_id, "delete_endpoint");
  const claim = await claimEndpoint(env, row, "deleting");
  if (!claim) return busyResponse();

  try {
    await deleteClaim(env, config, claim, fetcher);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error(JSON.stringify({
      message: "managed endpoint cleanup pending",
      requestId,
      errorCode: errorCode(error),
    }));
    throw new HTTPError(503, "endpoint_cleanup_pending");
  }
}

interface CleanupOutcome {
  errorCode?: string;
  /** What it deleted at Cloudflare, even when it then failed. */
  freed?: FreedResources;
  result: DeleteOutcome | "failed" | "skipped";
}

/** One sweep step for one installation. Exported for the race test. */
export async function cleanupEndpointRow(
  env: Env,
  config: ControlPlaneConfig,
  installationId: string,
  fetcher: CloudflareFetch,
  requestId: string,
  keepReclaim: boolean,
): Promise<CleanupOutcome> {
  const row = await endpointRow(env, installationId);
  if (!row || row.status === "deleted") return { result: "skipped" };
  const claim = await claimEndpoint(env, row, "deleting", { keepReclaim });
  if (!claim) return { result: "skipped" };
  const freed: FreedResources = { dnsRecords: 0, tunnels: 0 };
  try {
    return { freed, result: await deleteClaim(env, config, claim, fetcher, freed) };
  } catch (error) {
    const code = errorCode(error);
    console.error(JSON.stringify({
      message: "revoked installation endpoint cleanup pending",
      requestId,
      errorCode: code,
    }));
    return { errorCode: code, freed, result: "failed" };
  }
}

/** Owner-initiated cleanup (installation revocation). It never honours an
 * idle-reclaim cancellation: revocation always removes the endpoint. */
export async function cleanupEndpointForInstallation(
  env: Env,
  config: ControlPlaneConfig,
  installationId: string,
  fetcher: CloudflareFetch,
  requestId: string,
): Promise<void> {
  await cleanupEndpointRow(env, config, installationId, fetcher, requestId, false);
}

export interface CleanupSweepSummary {
  cancelled: number;
  candidates: number;
  deleted: number;
  failed: number;
  rateLimited: boolean;
}

export async function sweepManagedEndpointCleanup(
  env: Env,
  config: ControlPlaneConfig,
  fetcher: CloudflareFetch,
  requestId: string,
): Promise<CleanupSweepSummary> {
  const now = Date.now();
  // Rows no configured account acts on (endpointAccountFor) cannot be
  // cleaned and must not crowd the LIMIT; the cron reports how many there
  // are.
  const candidates = await env.DB.prepare(
    `SELECT e.installation_id, e.provider_account, e.cleanup_attempts, e.delete_requested_at,
            e.last_error_code
       FROM installation_endpoints e
       LEFT JOIN installations i ON i.id = e.installation_id
      WHERE e.status != 'deleted'
        AND ${ACTED_ON_ENDPOINT_SQL}
        AND (
          e.status = 'deleting'
          OR i.revoked_at IS NOT NULL
          OR i.id IS NULL
        )
        AND (e.lease_expires_at IS NULL OR e.lease_expires_at <= ?)
        AND (
          e.cleanup_attempts = 0
          OR e.last_cleanup_attempt_at IS NULL
          OR e.last_cleanup_attempt_at <= CASE
            WHEN e.cleanup_attempts = 1 THEN ?
            WHEN e.cleanup_attempts = 2 THEN ?
            WHEN e.cleanup_attempts = 3 THEN ?
            WHEN e.cleanup_attempts = 4 THEN ?
            ELSE ?
          END
        )
      ORDER BY COALESCE(e.delete_requested_at, e.last_cleanup_attempt_at, e.updated_at) ASC,
               e.installation_id ASC
      LIMIT ?`,
  ).bind(
    actedOnAccounts(config),
    now,
    now - CLEANUP_BACKOFF_1_MS,
    now - CLEANUP_BACKOFF_2_MS,
    now - CLEANUP_BACKOFF_3_MS,
    now - CLEANUP_BACKOFF_4_MS,
    now - CLEANUP_BACKOFF_MAX_MS,
    config.capacity.cleanupSweepLimit,
  ).all<{
    cleanup_attempts: number;
    delete_requested_at: number | null;
    installation_id: string;
    last_error_code: string | null;
    provider_account: string;
  }>();

  const staleCandidates = candidates.results.filter((candidate) => (
    candidate.delete_requested_at !== null
    && candidate.delete_requested_at <= now - MANUAL_CLEANUP_THRESHOLD_MS
  ));
  if (staleCandidates.length > 0) {
    console.error(JSON.stringify({
      message: "managed endpoint cleanup requires operator attention",
      requestId,
      staleCandidateCount: staleCandidates.length,
      maxCleanupAttempts: Math.max(...staleCandidates.map((candidate) => candidate.cleanup_attempts)),
      errorCodes: [...new Set(staleCandidates.map((candidate) => (
        candidate.last_error_code ?? "endpoint_cleanup_pending"
      )))].sort(),
    }));
  }

  const summary: CleanupSweepSummary = {
    cancelled: 0,
    candidates: candidates.results.length,
    deleted: 0,
    failed: 0,
    rateLimited: false,
  };
  // Accounts whose API answered 429 this run, and what cleanup did in each
  // account.
  const rateLimited = new Set<string>();
  const cleaned = new Map<string, AccountCleanup>();
  const tally = (account: string, deleted: boolean, freed: FreedResources | undefined) => {
    if (!deleted && !freed?.tunnels && !freed?.dnsRecords) return;
    const each = cleaned.get(account) ?? { deleted: false, dnsRecords: 0, tunnels: 0 };
    each.deleted ||= deleted;
    each.dnsRecords += freed?.dnsRecords ?? 0;
    each.tunnels += freed?.tunnels ?? 0;
    cleaned.set(account, each);
  };
  let next = 0;
  const worker = async () => {
    while (next < candidates.results.length) {
      const candidate = candidates.results[next];
      next += 1;
      if (!candidate) break;
      // The API limit is shared with every desktop's provisioning call in
      // that account. Stop starting its rows this run once Cloudflare pushes
      // back; other accounts carry on.
      if (rateLimited.has(candidate.provider_account)) continue;
      try {
        const outcome = await cleanupEndpointRow(
          env,
          config,
          candidate.installation_id,
          fetcher,
          requestId,
          true,
        );
        tally(candidate.provider_account, outcome.result === "deleted", outcome.freed);
        if (outcome.result === "deleted") summary.deleted += 1;
        else if (outcome.result === "cancelled") summary.cancelled += 1;
        else if (outcome.result === "failed") summary.failed += 1;
        if (outcome.errorCode === "cf_rate_limited") {
          rateLimited.add(candidate.provider_account);
          summary.rateLimited = true;
        }
      } catch {
        summary.failed += 1;
        console.error(JSON.stringify({
          message: "managed endpoint cleanup candidate failed",
          requestId,
          errorCode: "endpoint_internal",
        }));
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(CLEANUP_CONCURRENCY, candidates.results.length) },
    worker,
  ));

  await releaseCleanedCapacity(env, config, cleaned).catch(() => undefined);
  if (summary.candidates > 0) {
    console.log(JSON.stringify({
      message: "managed endpoint cleanup sweep",
      requestId,
      ...summary,
    }));
  }
  return summary;
}
