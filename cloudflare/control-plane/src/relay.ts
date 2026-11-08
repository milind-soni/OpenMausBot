// MausBot Relay host tokens: `POST /v1/installations/self/relay-token`. The relay checks them offline with the public
// key only, so this Worker's secret is the one thing that can let a computer onto the relay. Wire format: the
// companion's e2e README, section 9 ("Relay token" and "Control plane endpoint").
import { z } from "zod";

import { errorResponse, HTTPError, json, readBoundedJSON } from "./http";
import { requireInstallation } from "./installations";

const HOUR_MS = 60 * 60 * 1_000;
export const RELAY_TOKEN_TTL_S = 12 * 60 * 60;
export const RELAY_REFRESH_AFTER_S = 60 * 60;
export const RELAY_TOKEN_LIMIT = 60;
const ADOPTION_WINDOW_MS = 30 * 24 * HOUR_MS;
const RELAY_HOST = /^relay[1-9][0-9]?\.openmausbot\.com$/;
const KID = /^k[0-9]{1,3}$/;
const VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$/;
const UUIDISH = /^[0-9a-f-]{36}$/;
const AMERICAS = new Set(["NA", "SA"]);

const requestSchema = z.strictObject({
  appVersion: z.string().regex(VERSION),
  devices: z.strictObject({
    e2e: z.number().int().min(0).max(100),
    legacy: z.number().int().min(0).max(100),
  }),
});

export interface RelaySettings {
  kid: string;
  signingKey: CryptoKey;
  /** Every node, in no particular order. */
  nodes: readonly string[];
  /** Nodes ranked first for a computer in the Americas. */
  americasNodes: ReadonlySet<string>;
  rolloutPercent: number;
  allowInstallations: ReadonlySet<string>;
}

const b64u = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function fromB64u(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return b64u(bytes) === text ? bytes : null;
  } catch {
    return null;
  }
}

const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));

/** WebCrypto takes an Ed25519 private key only as PKCS#8: the RFC 8410 prefix, then the 32-byte seed. */
export async function importSigningSeed(seed: Uint8Array): Promise<CryptoKey> {
  if (seed.length !== 32) throw new Error("an Ed25519 seed is 32 bytes");
  const der = new Uint8Array(48);
  der.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
  der.set(seed, 16);
  return crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
}

const listVar = (value: unknown): string[] =>
  typeof value === "string" ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];

let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

/** Null while the relay is off: no signing secret, no nodes, or the kill switch. Never throws on a bad value. */
export async function readRelaySettings(env: Env): Promise<RelaySettings | null> {
  const vars = env as unknown as Partial<Record<string, unknown>>;
  if (vars.RELAY_DISABLED === "1") return null;
  const secret = vars.RELAY_TOKEN_SIGNING_KEY;
  const kid = typeof vars.RELAY_TOKEN_KID === "string" ? vars.RELAY_TOKEN_KID : "k1";
  const nodes = listVar(vars.RELAY_NODES);
  const seed = typeof secret === "string" ? fromB64u(secret.trim()) : null;
  if (!seed || seed.length !== 32 || !KID.test(kid) || nodes.length === 0 || nodes.length > 4) return null;
  if (!nodes.every((node) => RELAY_HOST.test(node))) return null;
  const percent = Number(vars.RELAY_ROLLOUT_PERCENT ?? "0");
  let cached = cachedKey;
  if (!cached || cached.secret !== secret) {
    cached = { secret: secret as string, key: importSigningSeed(seed) };
    cachedKey = cached;
  }
  return {
    kid,
    signingKey: await cached.key,
    nodes,
    americasNodes: new Set(listVar(vars.RELAY_NODES_AMERICAS).filter((node) => nodes.includes(node))),
    rolloutPercent: Number.isInteger(percent) && percent >= 0 && percent <= 100 ? percent : 0,
    allowInstallations: new Set(listVar(vars.RELAY_ALLOW_INSTALLATIONS).filter((id) => UUIDISH.test(id))),
  };
}

/** Rendezvous order: highest `SHA256(hostId ‖ node)[0:8]` first, so each computer prefers one node and load splits
 * evenly. A node marked for the Americas goes first for a computer there. */
export async function orderNodes(hostId: Uint8Array, settings: Pick<RelaySettings, "nodes" | "americasNodes">, continent: string | null): Promise<string[]> {
  const scored = await Promise.all(settings.nodes.map(async (node) => {
    const digest = await sha256(new Uint8Array([...hostId, ...new TextEncoder().encode(node)]));
    return { node, score: new DataView(digest.buffer).getBigUint64(0) };
  }));
  const americas = continent !== null && AMERICAS.has(continent);
  return scored
    .sort((a, b) => {
      const regional = Number(americas && settings.americasNodes.has(b.node)) - Number(americas && settings.americasNodes.has(a.node));
      return regional || (a.score === b.score ? 0 : a.score > b.score ? -1 : 1);
    })
    .map((entry) => entry.node);
}

/** The percentage bucket of a host: stable, so a computer stays in or out as the rollout grows. */
export async function rolloutBucket(hostId: Uint8Array): Promise<number> {
  const digest = await sha256(hostId);
  return new DataView(digest.buffer).getUint16(0) % 100;
}

/** Field order is part of the format: the signature covers exactly these bytes. */
export async function mintRelayToken(
  claims: { kid: string; hid: string; iid: string; iat: number; exp: number },
  signingKey: CryptoKey,
): Promise<string> {
  const payload = JSON.stringify({ v: 1, kid: claims.kid, hid: claims.hid, iid: claims.iid, iat: claims.iat, exp: claims.exp });
  const body = b64u(new TextEncoder().encode(payload));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, signingKey, new TextEncoder().encode(body)));
  return `${body}.${b64u(signature)}`;
}

function limitStatement(env: Env, installationId: string, now: number) {
  const cutoff = now - HOUR_MS;
  return env.DB.prepare(
    `INSERT INTO installation_action_rate_limits
      (installation_id, action, window_started_at, attempts, updated_at)
     VALUES (?, 'relay_token', ?, 1, ?)
     ON CONFLICT(installation_id, action) DO UPDATE SET
       window_started_at = CASE WHEN window_started_at <= ? THEN excluded.window_started_at ELSE window_started_at END,
       attempts = CASE WHEN window_started_at <= ? THEN 1 ELSE attempts + 1 END,
       updated_at = excluded.updated_at
     WHERE window_started_at <= ? OR attempts < ?`,
  ).bind(installationId, now, now, cutoff, cutoff, cutoff, RELAY_TOKEN_LIMIT);
}

interface RelayRow {
  relay_host_id: string | null;
  relay_blocked_at: number | null;
}

/** Made once per installation; the unique index settles a race between two first requests. */
async function hostIdFor(env: Env, installationId: string): Promise<{ hostId: string; blocked: boolean }> {
  const read = () => env.DB.prepare("SELECT relay_host_id, relay_blocked_at FROM installations WHERE id = ?").bind(installationId).first<RelayRow>();
  let row = await read();
  if (row && !row.relay_host_id) {
    await env.DB.prepare("UPDATE installations SET relay_host_id = ? WHERE id = ? AND relay_host_id IS NULL")
      .bind(b64u(crypto.getRandomValues(new Uint8Array(16))), installationId)
      .run();
    row = await read();
  }
  if (!row?.relay_host_id) throw new HTTPError(500, "internal_error");
  return { hostId: row.relay_host_id, blocked: row.relay_blocked_at !== null };
}

const unavailable = () => errorResponse(503, "relay_unavailable");

let schemaWarned = false;
/** A Worker deployed before migration 0012 must keep pairing and health working: the relay just stays off. */
function relaySchemaMissing(): Response {
  if (!schemaWarned) {
    schemaWarned = true;
    console.error(JSON.stringify({ message: "relay tables missing; apply migration 0012", errorCode: "relay_schema" }));
  }
  return unavailable();
}

const DAY_MS = 24 * HOUR_MS;
let dailyWarned = false;

export type RelayDailyKind = "seen" | "token" | "e2e" | "new";

interface RelayUse {
  installationId: string;
  appVersion: string;
  e2e: number;
  legacy: number;
  continent: string | null;
  /** A token is minted for this request. */
  token: boolean;
  now: number;
}

/**
 * Records a request in `relay_adoption` and, once per installation per UTC day and kind, adds 1 to `relay_daily`: `seen`
 * (asked), `token` (got one), `e2e` (reported end-to-end phones), `new` (asked for the first time). Each count runs before
 * the row is written, in one batch, so it reads the row as the previous request left it. Without migration 0014 the
 * daily counts are skipped and only the adoption row is written, as before. False when neither could be written.
 */
async function recordUse(env: Env, use: RelayUse): Promise<boolean> {
  const day = new Date(use.now).toISOString().slice(0, 10);
  const dayStart = use.now - (use.now % DAY_MS);
  /** `since`: the column that says the installation was already counted today; none for `new` (any row at all). */
  const bump = (kind: RelayDailyKind, since?: "updated_at" | "token_at" | "e2e_at") =>
    env.DB.prepare(
      `INSERT INTO relay_daily (day, kind, installs)
       SELECT ?1, ?2, 1 WHERE NOT EXISTS (SELECT 1 FROM relay_adoption WHERE installation_id = ?3${since ? ` AND ${since} >= ?4` : ""})
       ON CONFLICT (day, kind) DO UPDATE SET installs = installs + 1`,
    ).bind(day, kind, use.installationId, ...(since ? [dayStart] : []));
  const write = env.DB.prepare(
    `INSERT INTO relay_adoption
       (installation_id, app_version, e2e_devices, legacy_devices, continent, updated_at, first_seen_at, token_at, e2e_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)
     ON CONFLICT(installation_id) DO UPDATE SET
       app_version = excluded.app_version, e2e_devices = excluded.e2e_devices,
       legacy_devices = excluded.legacy_devices, continent = excluded.continent, updated_at = excluded.updated_at,
       first_seen_at = COALESCE(first_seen_at, excluded.first_seen_at),
       token_at = COALESCE(excluded.token_at, token_at), e2e_at = COALESCE(excluded.e2e_at, e2e_at)`,
  ).bind(use.installationId, use.appVersion, use.e2e, use.legacy, use.continent, use.now,
    use.token ? use.now : null, use.e2e > 0 ? use.now : null);
  const statements = [
    bump("new"),
    bump("seen", "updated_at"),
    ...(use.token ? [bump("token", "token_at")] : []),
    ...(use.e2e > 0 ? [bump("e2e", "e2e_at")] : []),
    write,
  ];
  if (await env.DB.batch(statements).then(() => true, () => false)) return true;
  if (!dailyWarned) {
    dailyWarned = true;
    console.error(JSON.stringify({ message: "relay daily counts not written; apply migration 0014", errorCode: "relay_daily_schema" }));
  }
  return env.DB.prepare(
    `INSERT INTO relay_adoption (installation_id, app_version, e2e_devices, legacy_devices, continent, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(installation_id) DO UPDATE SET
       app_version = excluded.app_version, e2e_devices = excluded.e2e_devices,
       legacy_devices = excluded.legacy_devices, continent = excluded.continent, updated_at = excluded.updated_at`,
  ).bind(use.installationId, use.appVersion, use.e2e, use.legacy, use.continent, use.now).run().then(() => true, () => false);
}

export async function issueRelayToken(request: Request, env: Env): Promise<Response> {
  const installation = await requireInstallation(request, env);
  const parsed = requestSchema.safeParse(await readBoundedJSON(request).catch(() => null));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const now = Date.now();
  const [limited] = await env.DB.batch([limitStatement(env, installation.installation_id, now)]);
  if (limited?.meta.changes === 0) {
    const response = errorResponse(429, "rate_limited");
    response.headers.set("retry-after", "60");
    return response;
  }
  const settings = await readRelaySettings(env);
  if (!settings) return unavailable();
  let host: { hostId: string; blocked: boolean };
  try {
    host = await hostIdFor(env, installation.installation_id);
  } catch (error) {
    if (error instanceof HTTPError) throw error;
    return relaySchemaMissing();
  }
  const { hostId, blocked } = host;
  const continent = (request as Request & { cf?: { continent?: unknown } }).cf?.continent;
  const region = typeof continent === "string" && /^[A-Z]{2}$/.test(continent) ? continent : null;
  const hostBytes = fromB64u(hostId) as Uint8Array;
  const included = !blocked && (settings.allowInstallations.has(installation.installation_id)
    || (await rolloutBucket(hostBytes)) < settings.rolloutPercent);
  // Counted for every relay-capable desktop, in the rollout or not: the tunnel path retires on these numbers.
  const counted = await recordUse(env, {
    installationId: installation.installation_id,
    appVersion: parsed.data.appVersion,
    e2e: parsed.data.devices.e2e,
    legacy: parsed.data.devices.legacy,
    continent: region,
    token: included,
    now,
  });
  if (!counted) return relaySchemaMissing();
  if (!included) return unavailable();
  const iat = Math.floor(now / 1000);
  const token = await mintRelayToken({ kid: settings.kid, hid: hostId, iid: installation.installation_id, iat, exp: iat + RELAY_TOKEN_TTL_S }, settings.signingKey);
  return json({
    token,
    hostId,
    nodes: await orderNodes(hostBytes, settings, region),
    expiresAt: (iat + RELAY_TOKEN_TTL_S) * 1000,
    refreshAfter: (iat + RELAY_REFRESH_AFTER_S) * 1000,
  });
}

const ADOPTION_MEMO_MS = 5 * 60 * 1_000;

export type RelayAdoption = {
  e2eDevices: number;
  legacyDevices: number;
  installs: number;
};

let adoptionMemo: { at: number; value: RelayAdoption | null } | null = null;

/** Test-only. */
export function forgetRelayAdoption(): void {
  adoptionMemo = null;
}

/** Sums only, for /healthz: how far the encrypted connection has replaced the tunnel. Read at most every five
 * minutes per isolate, since desktops call /healthz often; a failed read (no migration 0012 yet) is remembered too,
 * as null, and /healthz leaves the field out. */
export async function relayAdoption(env: Env, now = Date.now()): Promise<RelayAdoption | null> {
  if (adoptionMemo && now - adoptionMemo.at < ADOPTION_MEMO_MS) return adoptionMemo.value;
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(e2e_devices), 0) AS e2e, COALESCE(SUM(legacy_devices), 0) AS legacy, COUNT(*) AS installs
       FROM relay_adoption WHERE updated_at > ?`,
  ).bind(now - ADOPTION_WINDOW_MS).first<{ e2e: number; legacy: number; installs: number }>().then((found) => found, () => undefined);
  const value = row === undefined ? null : { e2eDevices: row?.e2e ?? 0, legacyDevices: row?.legacy ?? 0, installs: row?.installs ?? 0 };
  adoptionMemo = { at: now, value };
  return value;
}
