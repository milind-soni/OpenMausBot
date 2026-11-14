// APNs accepts pushes for an App Store or TestFlight build only when signed with the publishing team's key.
import { z } from "zod";

import { errorResponse, HTTPError, json, readBoundedJSON } from "./http";
import { requireInstallation, requireInstallationAndRead, sha256 } from "./installations";

export type ApnsEnvironment = "production" | "sandbox";

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** The .p8 key as PEM (PKCS #8). */
  privateKey: string;
  /** The app's bundle id: the APNs topic. */
  bundleId: string;
  environments: ReadonlySet<ApnsEnvironment>;
}

export const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

export const PUSH_DEVICE_LIMIT = 50;
const HOUR_MS = 60 * 60 * 1_000;
export const PUSH_SEND_LIMIT = 600;
export const PUSH_DEVICE_SEND_LIMIT = 60;
export const PUSH_REGISTER_LIMIT = 120;
const APNS_EXPIRATION_SECONDS = 24 * 60 * 60;
/** APNs wants a provider token refreshed no more than every 20 and at least every 60 minutes. */
export const APNS_TOKEN_WINDOW_MS = 50 * 60 * 1_000;
const APNS_TIMEOUT_MS = 10_000;

const KEY_OR_TEAM_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const TOKEN = /^[0-9a-f]{64,200}$/;
const ID = /^[\w-]{1,120}$/;
const KIND = /^[a-z][a-z-]{0,39}$/;
const PAIRING = /^[A-Za-z0-9_-]{8,64}$/;
const NEEDS_YOU = new Set(["approval", "question", "sign-in", "mention"]);

function oneLine(max: number) {
  return z.string().min(1).max(max * 4).refine((value) => {
    if (value.trim() !== value || [...value].length > max) return false;
    return !/[\p{Cc}\u2028\u2029]/u.test(value);
  });
}

const registerSchema = z.strictObject({
  v: z.literal(1),
  token: z.string().regex(TOKEN),
  environment: z.enum(["production", "sandbox"]),
});
const unregisterSchema = z.strictObject({
  v: z.literal(1),
  token: z.string().regex(TOKEN),
});
const sendSchema = z.strictObject({
  v: z.literal(1),
  token: z.string().regex(TOKEN),
  pairing: z.string().regex(PAIRING).optional(),
  notification: z.strictObject({
    kind: z.string().regex(KIND),
    title: oneLine(200),
    botId: z.string().regex(ID),
    botName: oneLine(80),
    threadId: z.string().regex(ID),
    roomId: z.string().regex(ID).optional(),
    roomName: oneLine(80).optional(),
  }),
});
export type PushSendRequest = z.infer<typeof sendSchema>;

export function readApnsConfig(env: Env): ApnsConfig | null {
  const vars = env as unknown as Partial<Record<string, unknown>>;
  const keyId = vars.APNS_KEY_ID;
  const teamId = vars.APNS_TEAM_ID;
  const bundleId = vars.APNS_BUNDLE_ID;
  const rawKey = vars.APNS_PRIVATE_KEY;
  if (typeof keyId !== "string" || !KEY_OR_TEAM_ID.test(keyId)) return null;
  if (typeof teamId !== "string" || !KEY_OR_TEAM_ID.test(teamId)) return null;
  if (typeof bundleId !== "string" || bundleId.length > 155 || !BUNDLE_ID.test(bundleId)) return null;
  if (typeof rawKey !== "string") return null;
  // `wrangler secret put` from a file keeps the newlines; a pasted value may carry them escaped.
  const privateKey = rawKey.replace(/\\n/g, "\n").trim();
  if (!/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----$/.test(privateKey)) return null;
  const listed = typeof vars.APNS_ENVIRONMENTS === "string" && vars.APNS_ENVIRONMENTS.trim()
    ? vars.APNS_ENVIRONMENTS.split(",").map((value) => value.trim())
    : ["production"];
  if (!listed.every((value) => value === "production" || value === "sandbox")) return null;
  return { keyId, teamId, privateKey, bundleId, environments: new Set(listed as ApnsEnvironment[]) };
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function pemBytes(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----(?:BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

interface CachedToken {
  fingerprint: string;
  window: number;
  jwt: string;
}
let cachedToken: CachedToken | null = null;

export function forgetApnsToken(): void {
  cachedToken = null;
}

/** ES256 per RFC 7518 §3.4 is the raw r‖s signature WebCrypto returns. */
export async function apnsProviderToken(config: ApnsConfig, now = Date.now()): Promise<string> {
  const window = Math.floor(now / APNS_TOKEN_WINDOW_MS);
  const fingerprint = `${config.teamId}:${config.keyId}:${await sha256(config.privateKey)}`;
  if (cachedToken && cachedToken.fingerprint === fingerprint && cachedToken.window === window) return cachedToken.jwt;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBytes(config.privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const encoder = new TextEncoder();
  const header = base64url(encoder.encode(JSON.stringify({ alg: "ES256", kid: config.keyId })));
  const claims = base64url(encoder.encode(JSON.stringify({ iss: config.teamId, iat: Math.floor((window * APNS_TOKEN_WINDOW_MS) / 1_000) })));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${claims}`));
  const jwt = `${header}.${claims}.${base64url(signature)}`;
  cachedToken = { fingerprint, window, jwt };
  return jwt;
}

export function apnsPayload(request: PushSendRequest) {
  const notification = request.notification;
  return {
    aps: {
      alert: { title: notification.title },
      sound: "default",
      "thread-id": notification.threadId,
      "interruption-level": NEEDS_YOU.has(notification.kind) ? "time-sensitive" : "active",
    },
    omb: {
      v: 1,
      kind: notification.kind,
      botId: notification.botId,
      botName: notification.botName,
      threadId: notification.threadId,
      ...(notification.roomId && notification.roomName ? { roomId: notification.roomId, roomName: notification.roomName } : {}),
      ...(request.pairing ? { pairing: request.pairing } : {}),
    },
  };
}

function unavailable(): never {
  throw new HTTPError(503, "push_unavailable");
}

async function parse<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  return parsed.data;
}

function rateLimited(retryAfterSeconds: number): Response {
  const response = errorResponse(429, "rate_limited");
  response.headers.set("retry-after", String(retryAfterSeconds));
  return response;
}

function limitStatement(env: Env, installationId: string, action: string, limit: number, now: number) {
  const cutoff = now - HOUR_MS;
  return env.DB.prepare(
    `INSERT INTO installation_action_rate_limits
      (installation_id, action, window_started_at, attempts, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(installation_id, action) DO UPDATE SET
       window_started_at = CASE WHEN window_started_at <= ? THEN excluded.window_started_at ELSE window_started_at END,
       attempts = CASE WHEN window_started_at <= ? THEN 1 ELSE attempts + 1 END,
       updated_at = excluded.updated_at
     WHERE window_started_at <= ? OR attempts < ?`,
  ).bind(installationId, action, now, now, cutoff, cutoff, cutoff, limit);
}

export async function registerPushDevice(request: Request, env: Env): Promise<Response> {
  const installation = await requireInstallation(request, env);
  const config = readApnsConfig(env) ?? unavailable();
  const body = await parse(request, registerSchema);
  if (!config.environments.has(body.environment)) throw new HTTPError(400, "push_environment_not_allowed");
  const now = Date.now();
  const [limited] = await env.DB.batch([limitStatement(env, installation.installation_id, "push_register", PUSH_REGISTER_LIMIT, now)]);
  if (limited?.meta.changes === 0) return rateLimited(60);
  const tokenHash = await sha256(body.token);
  const [updated, inserted] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE installation_push_devices SET environment = ?, updated_at = ?
        WHERE installation_id = ? AND token_hash = ?`,
    ).bind(body.environment, now, installation.installation_id, tokenHash),
    env.DB.prepare(
      `INSERT INTO installation_push_devices
        (installation_id, token_hash, token, environment, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM installation_push_devices WHERE installation_id = ?) < ?
       ON CONFLICT(installation_id, token_hash) DO NOTHING`,
    ).bind(installation.installation_id, tokenHash, body.token, body.environment, now, now, installation.installation_id, PUSH_DEVICE_LIMIT),
  ]);
  if (updated?.meta.changes === 0 && inserted?.meta.changes === 0) throw new HTTPError(409, "push_device_limit");
  return json({ registered: true });
}

export async function unregisterPushDevice(request: Request, env: Env): Promise<Response> {
  const installation = await requireInstallation(request, env);
  const body = await parse(request, unregisterSchema);
  await env.DB.prepare("DELETE FROM installation_push_devices WHERE installation_id = ? AND token_hash = ?")
    .bind(installation.installation_id, await sha256(body.token))
    .run();
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

interface DeviceRow {
  token: string;
  environment: ApnsEnvironment;
}

export async function sendPush(
  request: Request,
  env: Env,
  apnsFetch: typeof fetch,
  requestId: string,
): Promise<Response> {
  // Parse before authenticating so the device read rides in the authentication's own D1 batch.
  let body: PushSendRequest | null = null;
  let parseError: HTTPError | null = null;
  try {
    body = await parse(request, sendSchema);
  } catch (error) {
    if (!(error instanceof HTTPError)) throw error;
    parseError = error;
  }
  const tokenHash = body ? await sha256(body.token) : "";
  const { installation, row } = await requireInstallationAndRead<DeviceRow>(request, env, body
    ? (installationId) => env.DB.prepare(
      "SELECT token, environment FROM installation_push_devices WHERE installation_id = ? AND token_hash = ?",
    ).bind(installationId, tokenHash)
    : null);
  const config = readApnsConfig(env) ?? unavailable();
  if (parseError || !body) throw parseError ?? new HTTPError(400, "invalid_request");
  // Only a token this installation registered, so a relay credential cannot be pointed at somebody else's phone.
  if (!row || row.token !== body.token) return errorResponse(404, "push_device_unknown");

  const now = Date.now();
  // Read both windows before taking from either, so a send refused by one limit does not spend the other.
  const limits = [
    { action: "push_send", limit: PUSH_SEND_LIMIT },
    { action: `push_send:${tokenHash.slice(0, 32)}`, limit: PUSH_DEVICE_SEND_LIMIT },
  ];
  const full = await env.DB.prepare(
    `SELECT COUNT(*) AS full FROM installation_action_rate_limits
     WHERE installation_id = ? AND window_started_at > ? AND ((action = ? AND attempts >= ?) OR (action = ? AND attempts >= ?))`,
  ).bind(installation.installation_id, now - HOUR_MS, limits[0]!.action, limits[0]!.limit, limits[1]!.action, limits[1]!.limit)
    .first<{ full: number }>();
  if (full?.full) return rateLimited(60);
  const taken = await env.DB.batch(limits.map(({ action, limit }) => limitStatement(env, installation.installation_id, action, limit, now)));
  if (taken.some((result) => result.meta.changes === 0)) return rateLimited(60);

  const outcome = await deliver(config, row.environment, body, apnsFetch, now);
  if (outcome.kind === "sent") {
    await env.DB.prepare("UPDATE installation_push_devices SET last_sent_at = ? WHERE installation_id = ? AND token_hash = ?")
      .bind(now, installation.installation_id, tokenHash)
      .run();
    return json({ sent: true }, 202);
  }
  if (outcome.kind === "dead") {
    // APNs judges a token per environment and topic; a 410's timestamp spares registrations made after it.
    await env.DB.prepare("DELETE FROM installation_push_devices WHERE token_hash = ? AND environment = ? AND updated_at <= ?")
      .bind(tokenHash, row.environment, Math.min(outcome.invalidSince ?? now, now))
      .run();
    return errorResponse(410, "push_device_unregistered");
  }
  console.error(JSON.stringify({ message: "apns push failed", requestId, status: outcome.status, reason: outcome.reason }));
  if (outcome.kind === "throttled") return rateLimited(60);
  if (outcome.kind === "credentials") return errorResponse(503, "push_unavailable");
  return errorResponse(502, "push_failed");
}

type Delivery =
  | { kind: "sent" }
  | { kind: "dead"; invalidSince?: number }
  | { kind: "throttled" | "credentials" | "failed"; status: number; reason: string };

const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);
const PROVIDER_TOKEN_REASONS = new Set(["ExpiredProviderToken", "InvalidProviderToken", "MissingProviderToken"]);

async function deliver(
  config: ApnsConfig,
  environment: ApnsEnvironment,
  request: PushSendRequest,
  apnsFetch: typeof fetch,
  now: number,
): Promise<Delivery> {
  const payload = JSON.stringify(apnsPayload(request));
  // Repeats for one kind in one conversation replace each other on the lock screen.
  const collapseId = (await sha256(`${request.notification.kind}:${request.notification.threadId}`)).slice(0, 32);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let providerToken: string;
    try {
      providerToken = await apnsProviderToken(config, now);
    } catch {
      return { kind: "credentials", status: 0, reason: "invalid signing key" };
    }
    let response: Response;
    try {
      response = await apnsFetch(`${APNS_HOSTS[environment]}/3/device/${request.token}`, {
        method: "POST",
        headers: {
          authorization: `bearer ${providerToken}`,
          "apns-topic": config.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(Math.floor(now / 1_000) + APNS_EXPIRATION_SECONDS),
          "apns-collapse-id": collapseId,
          "content-type": "application/json",
        },
        body: payload,
        redirect: "manual",
        signal: AbortSignal.timeout(APNS_TIMEOUT_MS),
      });
    } catch {
      return { kind: "failed", status: 0, reason: "unreachable" };
    }
    if (response.status === 200) return { kind: "sent" };
    const answer = await response.json<{ reason?: unknown; timestamp?: unknown }>().catch(() => null);
    const reason = typeof answer?.reason === "string" ? answer.reason.slice(0, 64) : "";
    if (response.status === 410) {
      const invalidSince = typeof answer?.timestamp === "number" && Number.isFinite(answer.timestamp) ? answer.timestamp : undefined;
      return { kind: "dead", invalidSince };
    }
    if (DEAD_TOKEN_REASONS.has(reason)) return { kind: "dead" };
    if (response.status === 403 && PROVIDER_TOKEN_REASONS.has(reason) && attempt === 0) {
      forgetApnsToken();
      continue;
    }
    if (response.status === 403) return { kind: "credentials", status: 403, reason };
    if (response.status === 429) return { kind: "throttled", status: 429, reason };
    return { kind: "failed", status: response.status, reason };
  }
  return { kind: "credentials", status: 403, reason: "provider token refused twice" };
}
