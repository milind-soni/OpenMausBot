// APNs accepts pushes for an App Store or TestFlight build only when signed with the publishing team's key; FCM only
// with a service account of the Firebase project the Android build was registered in.
import { z } from "zod";

import { errorResponse, HTTPError, json, readBoundedJSON } from "./http";
import { requireInstallation, requireInstallationAndRead, sha256 } from "./installations";
import {
  FCM_TIMEOUT,
  FCM_TTL,
  fcmAccessToken,
  fcmSendUrl,
  fcmTokenIsDead,
  forgetFcmAccessToken,
  readFcmConfig,
  readFcmError,
  type FcmConfig,
} from "./push-fcm";

export type PushPlatform = "apns" | "fcm";
/** What an APNs token is for: alerts, one Live Activity's updates, or starting a Live Activity (push-to-start). */
export type PushPurpose = "alert" | "activity" | "activity-start";

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
/** An FCM registration token: today `<instance id>:<token>`, about 160 characters; the format is Google's to change. */
const FCM_TOKEN = /^[A-Za-z0-9_:-]{64,4096}$/;
/** Either kind; the stored registration says which. */
const ANY_TOKEN = FCM_TOKEN;
/** APNs takes at most 64 bytes. The phone uses the same string as its own notification's identifier, so the push and
 * the notification the live stream would have posted replace each other instead of showing twice. */
const COLLAPSE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const ID = /^[\w-]{1,120}$/;
const KIND = /^[a-z][a-z-]{0,39}$/;
const PAIRING = /^[A-Za-z0-9_-]{8,64}$/;
const NEEDS_YOU = new Set(["approval", "question", "sign-in", "mention"]);
/** The phone app's notification categories (action buttons) and Android channels, by the ids the store apps created. */
const CATEGORY: Record<string, string> = { approval: "OPENMAUS_APPROVAL", question: "OPENMAUS_QUESTION" };
const CATEGORY_UPDATE = "OPENMAUS_UPDATE";
const CHANNEL_BLOCKING = "approval_question";
const CHANNEL_ROUTINES = "routine_failed";
const CHANNEL_MESSAGES = "bot_messages";
const BLOCKING_KINDS = new Set(["approval", "question", "sign-in"]);
const ROUTINE_KINDS = new Set(["routine-failed", "routine-deferred", "routine-blocked"]);

function oneLine(max: number) {
  return z.string().min(1).max(max * 4).refine((value) => {
    if (value.trim() !== value || [...value].length > max) return false;
    return !/[\p{Cc}\u2028\u2029]/u.test(value);
  });
}

export const registerSchema = z.union([
  z.strictObject({
    v: z.literal(1),
    platform: z.literal("apns").optional(),
    purpose: z.enum(["alert", "activity", "activity-start"]).optional(),
    token: z.string().regex(TOKEN),
    environment: z.enum(["production", "sandbox"]),
  }),
  z.strictObject({
    v: z.literal(1),
    platform: z.literal("fcm"),
    token: z.string().regex(FCM_TOKEN),
    environment: z.literal("production").optional(),
  }),
]);
export const unregisterSchema = z.strictObject({
  v: z.literal(1),
  platform: z.enum(["apns", "fcm"]).optional(),
  token: z.string().regex(ANY_TOKEN),
});
export const sendSchema = z.strictObject({
  v: z.literal(1),
  token: z.string().regex(ANY_TOKEN),
  pairing: z.string().regex(PAIRING).optional(),
  collapseId: z.string().regex(COLLAPSE_ID).optional(),
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

function ombPayload(request: PushSendRequest) {
  const notification = request.notification;
  return {
    v: 1,
    kind: notification.kind,
    botId: notification.botId,
    botName: notification.botName,
    threadId: notification.threadId,
    ...(notification.roomId && notification.roomName ? { roomId: notification.roomId, roomName: notification.roomName } : {}),
    ...(request.pairing ? { pairing: request.pairing } : {}),
  };
}

export function pushCategory(kind: string): string {
  return CATEGORY[kind] ?? CATEGORY_UPDATE;
}

export function pushChannel(kind: string): string {
  return BLOCKING_KINDS.has(kind) ? CHANNEL_BLOCKING : ROUTINE_KINDS.has(kind) ? CHANNEL_ROUTINES : CHANNEL_MESSAGES;
}

/** `body` repeats `omb` because expo-notifications (SDK 58) hands an app only a remote notification's `body` as its data. */
export function apnsPayload(request: PushSendRequest) {
  const notification = request.notification;
  const omb = ombPayload(request);
  return {
    aps: {
      alert: { title: notification.title },
      sound: "default",
      "thread-id": notification.threadId,
      category: pushCategory(notification.kind),
      "interruption-level": NEEDS_YOU.has(notification.kind) ? "time-sensitive" : "active",
    },
    omb,
    body: omb,
  };
}

/** A data-only message in the shape expo-notifications (SDK 58) presents itself on Android: `title`, `tag` (the
 * notification's identifier), `channelId`, `categoryId`, `threadIdentifier` and `body` (the app's data, as JSON). No
 * `message`: the notification has no text beyond its title. */
export function fcmPayload(request: PushSendRequest, token: string, collapseId: string) {
  const notification = request.notification;
  return {
    message: {
      token,
      data: {
        title: notification.title,
        tag: collapseId,
        channelId: pushChannel(notification.kind),
        categoryId: pushCategory(notification.kind),
        threadIdentifier: notification.threadId,
        body: JSON.stringify(ombPayload(request)),
      },
      android: { priority: "HIGH", ttl: FCM_TTL },
    },
  };
}

export async function pushCollapseId(request: PushSendRequest): Promise<string> {
  return request.collapseId ?? (await sha256(`${request.notification.kind}:${request.notification.threadId}`)).slice(0, 32);
}

export interface PushConfig {
  apns: ApnsConfig | null;
  fcm: FcmConfig | null;
}

export function readPushConfig(env: Env): PushConfig | null {
  const config = { apns: readApnsConfig(env), fcm: readFcmConfig(env) };
  return config.apns || config.fcm ? config : null;
}

export function unavailable(): never {
  throw new HTTPError(503, "push_unavailable");
}

export async function parse<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  return parsed.data;
}

function rateLimited(retryAfterSeconds: number): Response {
  const response = errorResponse(429, "rate_limited");
  response.headers.set("retry-after", String(retryAfterSeconds));
  return response;
}

/** Where a caller's push tokens and rate windows live: an installation's (the original tables), or a Cloud home's, which
 * the Admin relays for, keyed by its machine id (push-cloud-homes.ts). Table and column names are constants, never input. */
export interface PushStore {
  devices: "installation_push_devices" | "machine_push_devices";
  limits: "installation_action_rate_limits" | "machine_push_rate_limits";
  owner: "installation_id" | "machine_id";
}
export const INSTALLATION_PUSH_STORE: PushStore = { devices: "installation_push_devices", limits: "installation_action_rate_limits", owner: "installation_id" };
export const MACHINE_PUSH_STORE: PushStore = { devices: "machine_push_devices", limits: "machine_push_rate_limits", owner: "machine_id" };

/** One hourly window to take from: `owner` is the caller's id, or the fleet's row for a Cloud home's fleet limit. */
export interface PushLimit {
  owner: string;
  action: string;
  limit: number;
}

function limitStatement(env: Env, store: PushStore, ownerId: string, action: string, limit: number, now: number) {
  const cutoff = now - HOUR_MS;
  return env.DB.prepare(
    `INSERT INTO ${store.limits}
      (${store.owner}, action, window_started_at, attempts, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(${store.owner}, action) DO UPDATE SET
       window_started_at = CASE WHEN window_started_at <= ? THEN excluded.window_started_at ELSE window_started_at END,
       attempts = CASE WHEN window_started_at <= ? THEN 1 ELSE attempts + 1 END,
       updated_at = excluded.updated_at
     WHERE window_started_at <= ? OR attempts < ?`,
  ).bind(ownerId, action, now, now, cutoff, cutoff, cutoff, limit);
}

/** Takes one from every window, or from none: with several, all are read before any is taken, so a request refused by one
 * limit does not spend another. */
async function takeLimits(env: Env, store: PushStore, limits: PushLimit[], now: number): Promise<boolean> {
  if (limits.length > 1) {
    const full = await env.DB.prepare(
      `SELECT COUNT(*) AS full FROM ${store.limits}
       WHERE window_started_at > ? AND (${limits.map(() => `(${store.owner} = ? AND action = ? AND attempts >= ?)`).join(" OR ")})`,
    ).bind(now - HOUR_MS, ...limits.flatMap(({ owner, action, limit }) => [owner, action, limit]))
      .first<{ full: number }>();
    if (full?.full) return false;
  }
  const taken = await env.DB.batch(limits.map(({ owner, action, limit }) => limitStatement(env, store, owner, action, limit, now)));
  return !taken.some((result) => result.meta.changes === 0);
}

export async function registerPushDevice(request: Request, env: Env): Promise<Response> {
  const installation = await requireInstallation(request, env);
  return registerFor(request, env, INSTALLATION_PUSH_STORE, installation.installation_id, []);
}

/** Stores a device token for one owner, the caller already authenticated. `fleet`: more windows to take from (a Cloud
 * home's fleet-wide limit). */
export async function registerFor(request: Request, env: Env, store: PushStore, ownerId: string, fleet: PushLimit[]): Promise<Response> {
  const config = readPushConfig(env) ?? unavailable();
  const body = await parse(request, registerSchema);
  const platform: PushPlatform = body.platform ?? "apns";
  const environment: ApnsEnvironment = body.environment ?? "production";
  const purpose: PushPurpose = body.platform === "fcm" ? "alert" : body.purpose ?? "alert";
  if (platform === "fcm" && !config.fcm) unavailable();
  if (platform === "apns") {
    const apns = config.apns ?? unavailable();
    if (!apns.environments.has(environment)) throw new HTTPError(400, "push_environment_not_allowed");
  }
  const now = Date.now();
  if (!await takeLimits(env, store, [{ owner: ownerId, action: "push_register", limit: PUSH_REGISTER_LIMIT }, ...fleet], now)) return rateLimited(60);
  const tokenHash = await sha256(body.token);
  const [updated, inserted] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE ${store.devices} SET platform = ?, environment = ?, purpose = ?, updated_at = ?
        WHERE ${store.owner} = ? AND token_hash = ?`,
    ).bind(platform, environment, purpose, now, ownerId, tokenHash),
    env.DB.prepare(
      `INSERT INTO ${store.devices}
        (${store.owner}, token_hash, platform, token, environment, purpose, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM ${store.devices} WHERE ${store.owner} = ?) < ?
       ON CONFLICT(${store.owner}, token_hash) DO NOTHING`,
    ).bind(ownerId, tokenHash, platform, body.token, environment, purpose, now, now, ownerId, PUSH_DEVICE_LIMIT),
  ]);
  if (updated?.meta.changes === 0 && inserted?.meta.changes === 0) throw new HTTPError(409, "push_device_limit");
  return json({ registered: true });
}

export async function unregisterPushDevice(request: Request, env: Env): Promise<Response> {
  const installation = await requireInstallation(request, env);
  return unregisterFor(request, env, INSTALLATION_PUSH_STORE, installation.installation_id);
}

export async function unregisterFor(request: Request, env: Env, store: PushStore, ownerId: string): Promise<Response> {
  const body = await parse(request, unregisterSchema);
  await env.DB.prepare(`DELETE FROM ${store.devices} WHERE ${store.owner} = ? AND token_hash = ?`)
    .bind(ownerId, await sha256(body.token))
    .run();
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

export interface DeviceRow {
  token: string;
  platform: PushPlatform;
  environment: ApnsEnvironment;
  purpose: PushPurpose;
}

/** What one provider request is: APNs headers and body for a token, or an FCM message. */
export type PlannedDelivery =
  | { kind: "apns"; config: ApnsConfig; pushType: "alert" | "liveactivity"; priority: 5 | 10; expiresInSeconds: number; collapseId?: string; payload: unknown }
  | { kind: "fcm"; config: FcmConfig; payload: unknown };

/** An alert to an `alert` token: APNs `alert` or an FCM data message. */
export async function planAlert(body: PushSendRequest, row: DeviceRow, config: PushConfig): Promise<PlannedDelivery | Response> {
  if (row.purpose !== "alert") return errorResponse(404, "push_device_unknown");
  const collapseId = await pushCollapseId(body);
  if (row.platform === "apns" && config.apns) {
    return { kind: "apns", config: config.apns, pushType: "alert", priority: 10, expiresInSeconds: APNS_EXPIRATION_SECONDS, collapseId, payload: apnsPayload(body) };
  }
  if (row.platform === "fcm" && config.fcm) return { kind: "fcm", config: config.fcm, payload: fcmPayload(body, body.token, collapseId) };
  return errorResponse(503, "push_unavailable");
}

export async function sendPush(request: Request, env: Env, pushFetch: typeof fetch, requestId: string): Promise<Response> {
  return sendToRegistered(request, env, pushFetch, requestId, sendSchema, planAlert);
}

type Plan<T> = (body: T, row: DeviceRow, config: PushConfig, now: number) => Promise<PlannedDelivery | Response>;

/** Who is sending: authenticates (an optional read of its own device row riding along) and names its windows. */
export interface PushSender {
  store: PushStore;
  authenticate(read: ((ownerId: string) => D1PreparedStatement) | null): Promise<{ ownerId: string; row: DeviceRow | null }>;
  /** More windows than the owner's own two (a Cloud home's fleet-wide limit). */
  fleet: PushLimit[];
}

/**
 * The shared half of every send: parse, authenticate (the device read rides in the authentication's own D1 batch),
 * check the token is this installation's, take from both rate windows, ask the provider, and map its answer.
 */
export async function sendToRegistered<T extends { token: string }>(
  request: Request,
  env: Env,
  pushFetch: typeof fetch,
  requestId: string,
  schema: z.ZodType<T>,
  plan: Plan<T>,
): Promise<Response> {
  return sendAs(request, env, pushFetch, requestId, schema, plan, {
    store: INSTALLATION_PUSH_STORE,
    fleet: [],
    authenticate: async (read) => {
      const { installation, row } = await requireInstallationAndRead<DeviceRow>(request, env, read);
      return { ownerId: installation.installation_id, row };
    },
  });
}

/** `sendToRegistered` for any sender: an installation, or a Cloud home through the Admin. */
export async function sendAs<T extends { token: string }>(
  request: Request,
  env: Env,
  pushFetch: typeof fetch,
  requestId: string,
  schema: z.ZodType<T>,
  plan: Plan<T>,
  sender: PushSender,
): Promise<Response> {
  const { store } = sender;
  let body: T | null = null;
  let parseError: HTTPError | null = null;
  try {
    body = await parse(request, schema);
  } catch (error) {
    if (!(error instanceof HTTPError)) throw error;
    parseError = error;
  }
  const tokenHash = body ? await sha256(body.token) : "";
  const { ownerId, row } = await sender.authenticate(body
    ? (id) => env.DB.prepare(
      `SELECT token, platform, environment, purpose FROM ${store.devices} WHERE ${store.owner} = ? AND token_hash = ?`,
    ).bind(id, tokenHash)
    : null);
  const config = readPushConfig(env) ?? unavailable();
  if (parseError || !body) throw parseError ?? new HTTPError(400, "invalid_request");
  // Only a token this installation registered, so a relay credential cannot be pointed at somebody else's phone.
  if (!row || row.token !== body.token) return errorResponse(404, "push_device_unknown");

  const now = Date.now();
  const planned = await plan(body, row, config, now);
  if (planned instanceof Response) return planned;
  const limits = [
    { owner: ownerId, action: "push_send", limit: PUSH_SEND_LIMIT },
    { owner: ownerId, action: `push_send:${tokenHash.slice(0, 32)}`, limit: PUSH_DEVICE_SEND_LIMIT },
    ...sender.fleet,
  ];
  if (!await takeLimits(env, store, limits, now)) return rateLimited(60);

  const outcome = planned.kind === "apns"
    ? await deliverApns(planned, row.environment, body.token, pushFetch, now)
    : await deliverFcm(planned.config, JSON.stringify(planned.payload), pushFetch, now);
  if (outcome.kind === "sent") {
    await env.DB.prepare(`UPDATE ${store.devices} SET last_sent_at = ? WHERE ${store.owner} = ? AND token_hash = ?`)
      .bind(now, ownerId, tokenHash)
      .run();
    return json({ sent: true }, 202);
  }
  if (outcome.kind === "dead") {
    // APNs judges a token per environment and topic; a 410's timestamp spares registrations made after it. FCM judges
    // a token for its one project. Dead for every caller that registered it: the sender's table first, then the other
    // (which may not exist yet on a database without migration 0019, so its failure is ignored).
    const invalidSince = Math.min(outcome.invalidSince ?? now, now);
    await forgetDeadToken(env, store, row, tokenHash, invalidSince);
    const other = store === MACHINE_PUSH_STORE ? INSTALLATION_PUSH_STORE : MACHINE_PUSH_STORE;
    await forgetDeadToken(env, other, row, tokenHash, invalidSince).catch(() => undefined);
    return errorResponse(410, "push_device_unregistered");
  }
  console.error(JSON.stringify({ message: `${row.platform} push failed`, requestId, status: outcome.status, reason: outcome.reason }));
  if (outcome.kind === "throttled") return rateLimited(60);
  if (outcome.kind === "credentials") return errorResponse(503, "push_unavailable");
  return errorResponse(502, "push_failed");
}

function forgetDeadToken(env: Env, store: PushStore, row: DeviceRow, tokenHash: string, invalidSince: number) {
  return (row.platform === "fcm"
    ? env.DB.prepare(`DELETE FROM ${store.devices} WHERE token_hash = ? AND platform = 'fcm'`).bind(tokenHash)
    : env.DB.prepare(`DELETE FROM ${store.devices} WHERE token_hash = ? AND platform = 'apns' AND environment = ? AND updated_at <= ?`)
      .bind(tokenHash, row.environment, invalidSince)
  ).run();
}

type Delivery =
  | { kind: "sent" }
  | { kind: "dead"; invalidSince?: number }
  | { kind: "throttled" | "credentials" | "failed"; status: number; reason: string };

const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);
const PROVIDER_TOKEN_REASONS = new Set(["ExpiredProviderToken", "InvalidProviderToken", "MissingProviderToken"]);

async function deliverApns(
  planned: Extract<PlannedDelivery, { kind: "apns" }>,
  environment: ApnsEnvironment,
  token: string,
  apnsFetch: typeof fetch,
  now: number,
): Promise<Delivery> {
  const { config } = planned;
  const payload = JSON.stringify(planned.payload);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let providerToken: string;
    try {
      providerToken = await apnsProviderToken(config, now);
    } catch {
      return { kind: "credentials", status: 0, reason: "invalid signing key" };
    }
    let response: Response;
    try {
      response = await apnsFetch(`${APNS_HOSTS[environment]}/3/device/${token}`, {
        method: "POST",
        headers: {
          authorization: `bearer ${providerToken}`,
          // A Live Activity push goes to the app's topic with Apple's fixed suffix.
          "apns-topic": planned.pushType === "liveactivity" ? `${config.bundleId}.push-type.liveactivity` : config.bundleId,
          "apns-push-type": planned.pushType,
          "apns-priority": String(planned.priority),
          "apns-expiration": String(Math.floor(now / 1_000) + planned.expiresInSeconds),
          ...(planned.collapseId ? { "apns-collapse-id": planned.collapseId } : {}),
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

async function deliverFcm(config: FcmConfig, payload: string, pushFetch: typeof fetch, now: number): Promise<Delivery> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const access = await fcmAccessToken(config, pushFetch, now);
    if (access.kind !== "ok") return access;
    let response: Response;
    try {
      response = await pushFetch(fcmSendUrl(config), {
        method: "POST",
        headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json" },
        body: payload,
        redirect: "manual",
        signal: AbortSignal.timeout(FCM_TIMEOUT),
      });
    } catch {
      return { kind: "failed", status: 0, reason: "unreachable" };
    }
    if (response.status === 200) return { kind: "sent" };
    const error = await readFcmError(response);
    if (fcmTokenIsDead(error)) return { kind: "dead" };
    if (response.status === 401 && attempt === 0) {
      forgetFcmAccessToken();
      continue;
    }
    if (response.status === 401 || response.status === 403) return { kind: "credentials", status: response.status, reason: error.errorCode };
    if (response.status === 429) return { kind: "throttled", status: 429, reason: error.errorCode };
    return { kind: "failed", status: response.status, reason: error.errorCode };
  }
  return { kind: "credentials", status: 401, reason: "access token refused twice" };
}
