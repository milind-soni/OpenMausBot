// Which Cloudflare account an endpoint lives in. Pure rules, no I/O. A row keeps
// its account for life; only a new row chooses, and only a row that never
// handed out an address may move.
import type { ControlPlaneConfig, EndpointAccount } from "./config";

/** After Cloudflare refuses an account a new tunnel or DNS record (its
 * quota) or, with several accounts, refuses its token, the account takes no
 * new tunnels for this long (unless cleanup frees one of its resources
 * first). */
export const CAPACITY_GATE_MS = 10 * 60 * 1_000;
/** An account whose last capacity scan is older than this is not known. */
export const SNAPSHOT_STALE_MS = 30 * 60 * 1_000;

/** One account's row of `managed_endpoint_account_capacity`. A missing row
 * reads as an empty snapshot. */
export interface AccountSnapshot {
  capacity_rejected_at: number | null;
  capacity_rejected_code: string | null;
  checked_at: number | null;
  dns_record_count: number | null;
  /** Endpoints of active installations whose tunnel is gone (reclaimed or
   * deleted), for operators. They hold no tunnel or record, so they take no
   * room: a returning owner competes for this account's free slots. */
  dormant_endpoints: number;
  provider_account: string;
  reclaim_pending: number;
  scan_page: number;
  tunnel_count: number | null;
}

export type AccountSnapshots = ReadonlyMap<string, AccountSnapshot>;

export function emptySnapshot(accountId: string): AccountSnapshot {
  return {
    capacity_rejected_at: null,
    capacity_rejected_code: null,
    checked_at: null,
    dns_record_count: null,
    dormant_endpoints: 0,
    provider_account: accountId,
    reclaim_pending: 0,
    scan_page: 1,
    tunnel_count: null,
  };
}

const OPAQUE_LABEL = /^c-[0-9a-f]{32}$/;

/** The configured account that holds this row, or null when its account is
 * not configured (or was dropped as invalid), or its hostname is not exactly
 * one opaque label under that account's suffix. Such a row refuses to act
 * rather than touch an account or zone it does not belong to. The same rule
 * in SQL is `opaqueHostnameSQL` and `ACTED_ON_ENDPOINT_SQL`. */
export function endpointAccountFor(
  config: ControlPlaneConfig,
  row: { hostname: string; provider_account: string },
): EndpointAccount | null {
  const account = config.endpointAccounts.find((each) => each.accountId === row.provider_account);
  if (!account) return null;
  const suffix = `.${account.companionHostSuffix}`;
  if (!row.hostname.endsWith(suffix)) return null;
  return OPAQUE_LABEL.test(row.hostname.slice(0, -suffix.length)) ? account : null;
}

/** `endpointAccountFor`'s hostname rule in SQL for the column `hostname` and
 * the suffix expression `suffix`: `c-`, 32 lowercase hex digits, a dot, then
 * exactly the suffix. (D1 caps GLOB and LIKE patterns at 50 bytes, too short
 * for 32 character classes.) */
export function opaqueHostnameSQL(hostname: string, suffix: string): string {
  return `(substr(${hostname}, 1, 2) = 'c-'
             AND ltrim(substr(${hostname}, 3, 32), '0123456789abcdef') = ''
             AND substr(${hostname}, 35) = '.' || ${suffix})`;
}

/** `endpointAccountFor` over every account in SQL, for an endpoint row aliased
 * `e`; bind `actedOnAccounts(config)` to its one parameter. Row-picking queries
 * use it so they agree with the actions themselves. */
export const ACTED_ON_ENDPOINT_SQL = `EXISTS (
          SELECT 1 FROM json_each(?) AS account
           WHERE json_extract(account.value, '$.id') = e.provider_account
             AND ${opaqueHostnameSQL("e.hostname", "json_extract(account.value, '$.suffix')")}
        )`;

export function actedOnAccounts(config: ControlPlaneConfig): string {
  return JSON.stringify(config.endpointAccounts.map((account) => ({
    id: account.accountId,
    suffix: account.companionHostSuffix,
  })));
}

/** A row that never finished provisioning and holds no provider resource. It
 * never returned a connector token, so nothing knows its hostname yet and it
 * may move to another account under a new one. */
export function neverReady(row: {
  dns_record_id: string | null;
  last_reconciled_at: number | null;
  tunnel_id: string | null;
}): boolean {
  return row.tunnel_id === null && row.dns_record_id === null && row.last_reconciled_at === null;
}

const RELEASE = /^([0-9]{1,9})\.([0-9]{1,9})\.([0-9]{1,9})(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** True when `version` (as an app reports it, `0.1.103`) is at least
 * `minimum` (`x.y.z`). A prerelease of the minimum is lower than it; a
 * missing, `unknown`, or unparseable version never qualifies. */
export function appVersionAtLeast(version: string | null | undefined, minimum: string): boolean {
  const have = RELEASE.exec(version ?? "");
  const need = RELEASE.exec(minimum);
  if (!have || !need) return false;
  for (let part = 1; part <= 3; part += 1) {
    const difference = Number(have[part]) - Number(need[part]);
    if (difference !== 0) return difference > 0;
  }
  return have[4] === undefined || need[4] !== undefined;
}

export function rejectionActive(snapshot: AccountSnapshot | null | undefined, now: number): boolean {
  const rejectedAt = snapshot?.capacity_rejected_at ?? null;
  return rejectedAt !== null && rejectedAt > now - CAPACITY_GATE_MS && rejectedAt <= now;
}

export function snapshotFresh(snapshot: AccountSnapshot | null | undefined, now: number): boolean {
  const checkedAt = snapshot?.checked_at ?? null;
  return checkedAt !== null && checkedAt >= now - SNAPSHOT_STALE_MS;
}

/** New endpoints the account can still hold by its last scan: free tunnels or
 * free DNS records, whichever is fewer, and never below zero. An unknown DNS
 * count drops that term; an unknown tunnel count makes the room unknown
 * (null) unless the records already show the zone full. */
export function accountRoom(account: EndpointAccount, snapshot: AccountSnapshot | null | undefined): number | null {
  if (!snapshot) return null;
  const records = snapshot.dns_record_count === null ? null : account.dnsRecordLimit - snapshot.dns_record_count;
  if (snapshot.tunnel_count === null) return records !== null && records <= 0 ? 0 : null;
  const tunnels = account.tunnelLimit - snapshot.tunnel_count;
  return Math.max(Math.min(tunnels, records ?? tunnels), 0);
}

/** Its last scan, still fresh, left no free tunnel or no free DNS record. */
export function scannedFull(account: EndpointAccount, snapshot: AccountSnapshot | null | undefined, now: number): boolean {
  return snapshotFresh(snapshot, now) && accountRoom(account, snapshot) === 0;
}

function eligible(
  account: EndpointAccount,
  snapshot: AccountSnapshot | undefined,
  appVersion: string | null,
  now: number,
): boolean {
  return account.newEndpoints
    && (account.minAppVersion === null || appVersionAtLeast(appVersion, account.minAppVersion))
    && !rejectionActive(snapshot, now)
    // A new or broken account takes nothing before its first good scan.
    && snapshotFresh(snapshot, now);
}

/** The eligible account with the most room (unknown room ranks after any
 * known room, ties go to config order), or null when every eligible account
 * is full. */
function bestAccount(
  accounts: readonly EndpointAccount[],
  snapshots: AccountSnapshots,
  appVersion: string | null,
  now: number,
): EndpointAccount | null {
  let best: EndpointAccount | null = null;
  let bestRoom: number | null = null;
  for (const account of accounts) {
    const snapshot = snapshots.get(account.accountId);
    if (!eligible(account, snapshot, appVersion, now)) continue;
    const room = accountRoom(account, snapshot);
    if (room === 0) continue;
    if (best === null || (room !== null && (bestRoom === null || room > bestRoom))) {
      best = account;
      bestRoom = room;
    }
  }
  return best;
}

/** Where a new endpoint row is created. When no eligible account has room
 * this is the primary, which is exactly the single-account behaviour: it is
 * tried, or answered by its own refusal gate. Room never refuses on its own;
 * only Cloudflare does. */
export function chooseNewEndpointAccount(
  config: ControlPlaneConfig,
  snapshots: AccountSnapshots,
  appVersion: string | null,
  now: number,
): EndpointAccount {
  if (config.endpointAccounts.length === 1) return config.cloudflare;
  return bestAccount(config.endpointAccounts, snapshots, appVersion, now) ?? config.cloudflare;
}

/** Where a never-provisioned row may move when `from` refuses it or is full:
 * the best other eligible account with room, or null (no fallback). */
export function relocationTarget(
  config: ControlPlaneConfig,
  snapshots: AccountSnapshots,
  appVersion: string | null,
  from: EndpointAccount,
  now: number,
): EndpointAccount | null {
  const others = config.endpointAccounts.filter((account) => account.accountId !== from.accountId);
  return bestAccount(others, snapshots, appVersion, now);
}
