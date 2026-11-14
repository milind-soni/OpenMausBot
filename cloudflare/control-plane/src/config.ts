import { z } from "zod";

const MAX_ALLOWED_ORIGINS = 20;
const secretSchema = z.string().min(32);
const cloudflareTokenSchema = z.string().min(20).max(2_048).regex(/^\S+$/);
const cloudflareResourceIdSchema = z.string().regex(/^[0-9a-f]{32}$/i);
const emailSchema = z.email().max(254);
const originsSchema = z.string();

export type TunnelReclaimMode = "on" | "observe";

export interface CapacityConfig {
  /** Scheduled cleanup rows processed per cron run. */
  cleanupSweepLimit: number;
  /** Zone DNS record quota used for the usage alert. */
  dnsRecordLimit: number;
  /** A tunnel offline for at least this long (and an installation that has
   * been quiet as long) may be reclaimed. Never below one day. */
  offlineReclaimMs: number;
  /** A second offline period that is only counted, never acted on: how many
   * tunnels a pass would reclaim at it. Null: no preview. */
  reclaimPreviewMs: number | null;
  /** `observe` evaluates and logs reclaim candidates without marking any. */
  reclaimMode: TunnelReclaimMode;
  /** Account tunnel quota used for the usage alert. */
  tunnelLimit: number;
}

/** A Cloudflare account that holds managed endpoints: tunnels in the account,
 * proxied CNAMEs in one zone of it. An endpoint stays in the account it was
 * created in for its whole life, so an account's ID, zone, and suffix are
 * never edited once it holds endpoints. */
export interface EndpointAccount {
  /** Lowercase 32-character Cloudflare account ID. */
  accountId: string;
  apiToken: string;
  /** Hostnames are `c-<32 hex>.<suffix>`; the suffix is the zone apex. */
  companionHostSuffix: string;
  /** Zone DNS record quota: ranks accounts and drives the usage alert. */
  dnsRecordLimit: number;
  /** New endpoints go here only for installations reporting at least this
   * version (`x.y.z`), or for any installation when null. */
  minAppVersion: string | null;
  /** False keeps every endpoint the account holds but gives it no new ones,
   * and leaves it out of the pool /healthz describes. Always true for the
   * primary. */
  newEndpoints: boolean;
  /** Account tunnel quota: ranks accounts, tells a quota 429 from a rate
   * limit, and drives the usage alert. */
  tunnelLimit: number;
  zoneId: string;
}

export interface ControlPlaneConfig {
  authBaseURL: string;
  allowedOrigins: ReadonlySet<string>;
  capacity: CapacityConfig;
  /** The primary account, from CLOUDFLARE_ACCOUNT_ID and friends. */
  cloudflare: EndpointAccount;
  emailFrom: string;
  /** Every usable account, primary first, then CLOUDFLARE_ENDPOINT_ACCOUNTS
   * in order. */
  endpointAccounts: readonly EndpointAccount[];
  /** Redacted codes for CLOUDFLARE_ENDPOINT_ACCOUNTS entries that were
   * ignored (`entry_2_token`, ...). Never values. */
  endpointAccountIssues: readonly string[];
}

const DAY_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_TUNNEL_LIMIT = 1_000;
export const DEFAULT_DNS_RECORD_LIMIT = 1_000;
export const DEFAULT_OFFLINE_RECLAIM_DAYS = 21;
// One day is the floor: a computer shut down overnight must never lose its
// tunnel. Below three days a weekend away does; it gets the same address back
// when it returns, if its account still has room.
export const MIN_OFFLINE_RECLAIM_DAYS = 1;
// Each cleanup makes at most 14 Cloudflare API calls (an idle reclaim at most
// 12; a forced removal whose tunnel is still connected adds two connection
// cleanups and two deletes to the usual ten): twenty rows plus the two capacity
// reads stay under 290 calls per run, under the token's
// 1,200-per-five-minutes limit and Workers Paid's 10,000 subrequests. Use 3 on
// Workers Free, whose limit is 50 subrequests (3 x 14 + 2 + 2 Cache API
// deletes = 46).
export const DEFAULT_CLEANUP_SWEEP_LIMIT = 20;
export const MAX_CLEANUP_SWEEP_LIMIT = 50;
/** Each account adds two Cloudflare reads per cron run: on Workers Free, 3
 * cleanup rows x 14 calls + 3 x 2 + two Cache API deletes is the whole
 * 50-subrequest budget, and four accounts need the sweep limit at 2. */
export const MAX_ENDPOINT_ACCOUNTS = 4;

function boundedIntegerVar(
  value: unknown,
  label: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const text = typeof value === "number" ? String(value) : value;
  const parsed = typeof text === "string" && /^[0-9]{1,9}$/.test(text.trim()) ? Number(text.trim()) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    // A tuning value must never take sign-in and pairing down: use the default.
    console.error(JSON.stringify({ message: "invalid capacity setting; using the default", setting: label, minimum, maximum, fallback }));
    return fallback;
  }
  return parsed;
}

function reclaimMode(value: unknown): TunnelReclaimMode {
  // Unset or invalid: observe only. Reclaiming is switched on deliberately.
  if (value === "on" || value === "observe") return value;
  if (value !== undefined && value !== null && value !== "") {
    console.error(JSON.stringify({ message: "invalid OMB_TUNNEL_RECLAIM; observing only", allowed: ["on", "observe"] }));
  }
  return "observe";
}

/** Optional tuning variables, each with a safe default. */
export function readCapacityConfig(env: Partial<Record<string, unknown>>): CapacityConfig {
  return {
    cleanupSweepLimit: boundedIntegerVar(
      env.OMB_CLEANUP_SWEEP_LIMIT,
      "OMB_CLEANUP_SWEEP_LIMIT",
      DEFAULT_CLEANUP_SWEEP_LIMIT,
      1,
      MAX_CLEANUP_SWEEP_LIMIT,
    ),
    dnsRecordLimit: boundedIntegerVar(
      env.OMB_DNS_RECORD_LIMIT,
      "OMB_DNS_RECORD_LIMIT",
      DEFAULT_DNS_RECORD_LIMIT,
      1,
      10_000_000,
    ),
    offlineReclaimMs: boundedIntegerVar(
      env.OMB_TUNNEL_OFFLINE_RECLAIM_DAYS,
      "OMB_TUNNEL_OFFLINE_RECLAIM_DAYS",
      DEFAULT_OFFLINE_RECLAIM_DAYS,
      MIN_OFFLINE_RECLAIM_DAYS,
      365,
    ) * DAY_MS,
    reclaimMode: reclaimMode(env.OMB_TUNNEL_RECLAIM),
    reclaimPreviewMs: env.OMB_TUNNEL_RECLAIM_PREVIEW_DAYS === undefined || env.OMB_TUNNEL_RECLAIM_PREVIEW_DAYS === null
      || env.OMB_TUNNEL_RECLAIM_PREVIEW_DAYS === ""
      ? null
      : boundedIntegerVar(
        env.OMB_TUNNEL_RECLAIM_PREVIEW_DAYS,
        "OMB_TUNNEL_RECLAIM_PREVIEW_DAYS",
        0,
        MIN_OFFLINE_RECLAIM_DAYS,
        365,
      ) * DAY_MS || null,
    tunnelLimit: boundedIntegerVar(
      env.OMB_TUNNEL_LIMIT,
      "OMB_TUNNEL_LIMIT",
      DEFAULT_TUNNEL_LIMIT,
      1,
      10_000_000,
    ),
  };
}

function exactHTTPSOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS origin`);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error(`${label} must be an exact HTTPS origin`);
  }
  return url.origin;
}

function hostnameSuffix(value: string): string {
  // 34-byte opaque label plus the separating dot must remain within the
  // 253-byte DNS hostname limit.
  if (value !== value.toLowerCase() || value.length > 218 || value.endsWith(".")) {
    throw new Error("COMPANION_HOST_SUFFIX must be a lowercase DNS suffix");
  }
  const labels = value.split(".");
  if (
    labels.length < 2
    || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error("COMPANION_HOST_SUFFIX must be a valid DNS suffix");
  }
  return value;
}

// An extra account names the secret that holds its token. The name must look
// like a Cloudflare token's, so a typo can never send another secret (such as
// BETTER_AUTH_SECRET) to the Cloudflare API.
const TOKEN_SECRET_NAME = /^CLOUDFLARE_API_TOKEN(?:_[A-Z0-9]+)*$/;
const MIN_APP_VERSION = /^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$/;
const quotaSchema = z.number().int().min(1).max(10_000_000);

const endpointAccountSchema = z.strictObject({
  accountId: cloudflareResourceIdSchema,
  zoneId: cloudflareResourceIdSchema,
  companionHostSuffix: z.string().min(1).max(218),
  apiTokenSecret: z.string().max(128).regex(TOKEN_SECRET_NAME),
  tunnelLimit: quotaSchema.optional(),
  dnsRecordLimit: quotaSchema.optional(),
  minAppVersion: z.string().regex(MIN_APP_VERSION).optional(),
  newEndpoints: z.boolean().optional(),
});

/**
 * CLOUDFLARE_ENDPOINT_ACCOUNTS: a JSON array (a wrangler.jsonc JSON var, or the
 * same JSON as a string or a secret) of `{ accountId, zoneId,
 * companionHostSuffix, apiTokenSecret, tunnelLimit?, dnsRecordLimit?,
 * minAppVersion?, newEndpoints? }`. A bad entry never throws: it is dropped and
 * reported as a redacted issue code, and endpoints tied to it refuse to act.
 */
export function readEndpointAccounts(
  env: Partial<Record<string, unknown>>,
  primary: EndpointAccount,
): { accounts: EndpointAccount[]; issues: string[] } {
  const raw = env.CLOUDFLARE_ENDPOINT_ACCOUNTS;
  if (raw === undefined || raw === null || raw === "") return { accounts: [], issues: [] };
  let entries: unknown = raw;
  if (typeof raw === "string") {
    try {
      entries = JSON.parse(raw);
    } catch {
      return { accounts: [], issues: ["accounts_json"] };
    }
  }
  if (!Array.isArray(entries)) return { accounts: [], issues: ["accounts_json"] };

  const accounts: EndpointAccount[] = [];
  const issues: string[] = [];
  const used = {
    accountIds: new Set([primary.accountId]),
    suffixes: new Set([primary.companionHostSuffix]),
    zoneIds: new Set([primary.zoneId]),
  };
  for (const [index, entry] of entries.entries()) {
    const label = `entry_${index + 1}`;
    if (accounts.length >= MAX_ENDPOINT_ACCOUNTS - 1) {
      issues.push(`${label}_over_limit`);
      continue;
    }
    const parsed = endpointAccountSchema.safeParse(entry);
    if (!parsed.success) {
      issues.push(`${label}_shape`);
      continue;
    }
    let companionHostSuffix: string;
    try {
      companionHostSuffix = hostnameSuffix(parsed.data.companionHostSuffix);
    } catch {
      issues.push(`${label}_suffix`);
      continue;
    }
    const accountId = parsed.data.accountId.toLowerCase();
    const zoneId = parsed.data.zoneId.toLowerCase();
    if (
      used.accountIds.has(accountId)
      || used.zoneIds.has(zoneId)
      || used.suffixes.has(companionHostSuffix)
    ) {
      issues.push(`${label}_duplicate`);
      continue;
    }
    const apiToken = cloudflareTokenSchema.safeParse(env[parsed.data.apiTokenSecret]);
    if (!apiToken.success) {
      issues.push(`${label}_token`);
      continue;
    }
    used.accountIds.add(accountId);
    used.zoneIds.add(zoneId);
    used.suffixes.add(companionHostSuffix);
    accounts.push({
      accountId,
      apiToken: apiToken.data,
      companionHostSuffix,
      dnsRecordLimit: parsed.data.dnsRecordLimit ?? DEFAULT_DNS_RECORD_LIMIT,
      minAppVersion: parsed.data.minAppVersion ?? null,
      newEndpoints: parsed.data.newEndpoints ?? true,
      tunnelLimit: parsed.data.tunnelLimit ?? DEFAULT_TUNNEL_LIMIT,
      zoneId,
    });
  }
  return { accounts, issues };
}

export function readConfig(env: Env): ControlPlaneConfig {
  if (!secretSchema.safeParse(env.BETTER_AUTH_SECRET).success) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  }

  const emailFrom = emailSchema.safeParse(env.EMAIL_FROM);
  if (!emailFrom.success) throw new Error("EMAIL_FROM must be a valid email address");

  const authBaseURL = exactHTTPSOrigin(env.BETTER_AUTH_URL, "BETTER_AUTH_URL");
  const origins = originsSchema.safeParse(env.ALLOWED_ORIGINS);
  if (!origins.success) throw new Error("ALLOWED_ORIGINS must be a comma-separated string");
  const values = origins.data.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length > MAX_ALLOWED_ORIGINS) {
    throw new Error("ALLOWED_ORIGINS contains too many entries");
  }
  const allowedOrigins = new Set(values.map((value) => exactHTTPSOrigin(value, "ALLOWED_ORIGINS")));
  allowedOrigins.add(authBaseURL);

  if (!cloudflareResourceIdSchema.safeParse(env.CLOUDFLARE_ACCOUNT_ID).success) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character Cloudflare ID");
  }
  if (!cloudflareResourceIdSchema.safeParse(env.CLOUDFLARE_ZONE_ID).success) {
    throw new Error("CLOUDFLARE_ZONE_ID must be a 32-character Cloudflare ID");
  }
  if (!cloudflareTokenSchema.safeParse(env.CLOUDFLARE_API_TOKEN).success) {
    throw new Error("CLOUDFLARE_API_TOKEN is missing or invalid");
  }
  const hostSuffix = z.string().min(1).max(218).safeParse(env.COMPANION_HOST_SUFFIX);
  if (!hostSuffix.success) {
    throw new Error("COMPANION_HOST_SUFFIX must be a lowercase DNS suffix");
  }

  const vars = env as unknown as Partial<Record<string, unknown>>;
  const capacity = readCapacityConfig(vars);
  const primary: EndpointAccount = {
    accountId: env.CLOUDFLARE_ACCOUNT_ID.toLowerCase(),
    apiToken: env.CLOUDFLARE_API_TOKEN,
    companionHostSuffix: hostnameSuffix(hostSuffix.data),
    dnsRecordLimit: capacity.dnsRecordLimit,
    minAppVersion: null,
    newEndpoints: true,
    tunnelLimit: capacity.tunnelLimit,
    zoneId: env.CLOUDFLARE_ZONE_ID.toLowerCase(),
  };
  const extra = readEndpointAccounts(vars, primary);

  return {
    authBaseURL,
    allowedOrigins,
    capacity,
    cloudflare: primary,
    emailFrom: emailFrom.data,
    endpointAccounts: [primary, ...extra.accounts],
    endpointAccountIssues: extra.issues,
  };
}
