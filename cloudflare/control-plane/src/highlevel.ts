// HighLevel OAuth relay: the app's client secret lives here only. A desktop or
// Cloud home starts a flow, the person signs in at HighLevel in a browser,
// HighLevel redirects to this Worker, and the harness collects the tokens once.
// D1 holds, per flow, a hash derived from the random state, the token payload
// encrypted under a second key derived from the same state, and timestamps:
// never the state, never a plaintext token.
import { z } from "zod";

import { errorResponse, HTTPError, json, readBoundedJSON } from "./http";

export const HIGHLEVEL_AUTHORIZE_URL = "https://marketplace.leadconnectorhq.com/v2/oauth/chooselocation";
export const HIGHLEVEL_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
export const HIGHLEVEL_CALLBACK_PATH = "/v1/highlevel/callback";

/** A flow that was started but never claimed is forgotten after this long. */
export const HIGHLEVEL_FLOW_TTL_MS = 10 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const LIMIT_RETENTION_MS = 24 * HOUR_MS;
const HIGHLEVEL_TIMEOUT_MS = 10_000;
/** Per IP per hour. A harness polls `claim` every 2 s for up to 10 minutes
 * (300 polls per flow); Cloud homes may share an egress address. */
export const HIGHLEVEL_START_LIMIT = 60;
export const HIGHLEVEL_CALLBACK_LIMIT = 60;
export const HIGHLEVEL_CLAIM_LIMIT = 3_000;
export const HIGHLEVEL_REFRESH_LIMIT = 600;

const STATE_BYTES = 32;
/** 32 random bytes, base64url without padding. */
const STATE = /^[A-Za-z0-9_-]{43}$/;
/** HighLevel's authorization codes are opaque; accept any single token of
 * printable ASCII. The value is sent to HighLevel once and never kept. */
const CODE = /^[\x21-\x7e]{1,1024}$/;
const REFRESH_TOKEN = /^[\x21-\x7e]{1,8192}$/;
const CLIENT_ID = /^[\x21-\x7e]{1,256}$/;
const SCOPES = /^[A-Za-z0-9_./-]+(?: [A-Za-z0-9_./-]+)*$/;
const HKDF_SALT = "openmausbot-highlevel-relay-v1";
const encoder = new TextEncoder();

export interface HighLevelConfig {
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  scopes: string;
}

const startSchema = z.strictObject({ kind: z.literal("location") });
const claimSchema = z.strictObject({ state: z.string().regex(STATE) });
const refreshSchema = z.strictObject({ refreshToken: z.string().regex(REFRESH_TOKEN) });

const tokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().finite().nonnegative(),
  scope: z.string().optional(),
  locationId: z.string().optional(),
  companyId: z.string().optional(),
  userId: z.string().optional(),
});

/** What the harness receives from `claim` and `refresh`, and what a flow row
 * holds encrypted between the callback and the claim. */
const tokenPayloadSchema = z.strictObject({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number(),
  scope: z.string(),
  locationId: z.string(),
  companyId: z.string(),
  userId: z.string(),
});
export type HighLevelTokenPayload = z.infer<typeof tokenPayloadSchema>;

export function readHighLevelConfig(env: Env): HighLevelConfig | null {
  const vars = env as unknown as Partial<Record<string, unknown>>;
  const clientId = vars.HIGHLEVEL_CLIENT_ID;
  const clientSecret = vars.HIGHLEVEL_CLIENT_SECRET;
  const redirectUrl = vars.HIGHLEVEL_REDIRECT_URL;
  const scopes = vars.HIGHLEVEL_SCOPES;
  if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) return null;
  if (typeof clientSecret !== "string" || clientSecret.length < 8 || clientSecret.length > 1_024 || /\s/.test(clientSecret)) return null;
  if (typeof redirectUrl !== "string") return null;
  let redirect: URL;
  try {
    redirect = new URL(redirectUrl);
  } catch {
    return null;
  }
  if (redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.search || redirect.hash) return null;
  if (typeof scopes !== "string" || scopes.length > 2_048 || !SCOPES.test(scopes)) return null;
  return { clientId, clientSecret, redirectUrl: redirect.href, scopes };
}

export function highLevelAuthorizationUrl(config: HighLevelConfig, state: string): string {
  // Built by hand so the scope separator is `%20`, as in HighLevel's examples,
  // not the `+` URLSearchParams would produce.
  const query = [
    ["response_type", "code"],
    ["redirect_uri", config.redirectUrl],
    ["client_id", config.clientId],
    ["scope", config.scopes],
    ["state", state],
  ].map(([name, value]) => `${name}=${encodeURIComponent(value!)}`).join("&");
  return `${HIGHLEVEL_AUTHORIZE_URL}?${query}`;
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The one spelling newState makes. The last character's two spare bits carry nothing, so "…A", "…B", "…C" and "…D"
 * decode to the same bytes: only the canonical one may open a flow. */
function canonicalState(state: string): boolean {
  return STATE.test(state) && base64url(fromBase64url(state)) === state;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function newState(): string {
  const bytes = new Uint8Array(STATE_BYTES);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function hkdfMaterial(state: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64url(state), "HKDF", false, ["deriveBits", "deriveKey"]);
}

function hkdfParams(info: string): HkdfParams {
  return { name: "HKDF", hash: "SHA-256", salt: encoder.encode(HKDF_SALT), info: encoder.encode(info) };
}

/** The row key: a state is never stored, only this derivation of it. */
export async function flowLookup(state: string): Promise<string> {
  return hex(await crypto.subtle.deriveBits(hkdfParams("lookup"), await hkdfMaterial(state), 256));
}

async function wrapKey(state: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(hkdfParams("wrap"), await hkdfMaterial(state), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function seal(state: string, payload: HighLevelTokenPayload): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await wrapKey(state), encoder.encode(JSON.stringify(payload)));
  const out = new Uint8Array(iv.byteLength + sealed.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(sealed), iv.byteLength);
  return base64url(out);
}

async function open(state: string, ciphertext: string): Promise<HighLevelTokenPayload | null> {
  try {
    const bytes = fromBase64url(ciphertext);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await wrapKey(state), bytes.slice(12));
    const parsed = tokenPayloadSchema.safeParse(JSON.parse(new TextDecoder().decode(plain)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function unavailable(): never {
  throw new HTTPError(503, "highlevel_unavailable");
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

async function clientKey(request: Request, env: Env): Promise<string> {
  // Cloudflare sets cf-connecting-ip on every request that reaches a Worker.
  const address = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.BETTER_AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(address)));
}

/** The installation limiter's shape (`installation_action_rate_limits`), keyed
 * by a keyed hash of the caller's address because these routes carry no
 * credential. Resolves to a 429 when the hour's budget is spent. */
async function takeLimit(request: Request, env: Env, action: string, limit: number, now: number): Promise<Response | null> {
  const key = await clientKey(request, env);
  const cutoff = now - HOUR_MS;
  const [taken] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO highlevel_ip_rate_limits
        (ip_key, action, window_started_at, attempts, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(ip_key, action) DO UPDATE SET
         window_started_at = CASE WHEN window_started_at <= ? THEN excluded.window_started_at ELSE window_started_at END,
         attempts = CASE WHEN window_started_at <= ? THEN 1 ELSE attempts + 1 END,
         updated_at = excluded.updated_at
       WHERE window_started_at <= ? OR attempts < ?`,
    ).bind(key, action, now, now, cutoff, cutoff, cutoff, limit),
    env.DB.prepare("DELETE FROM highlevel_ip_rate_limits WHERE updated_at < ?").bind(now - LIMIT_RETENTION_MS),
  ]);
  return taken?.meta.changes === 0 ? rateLimited(60) : null;
}

export async function startHighLevelFlow(request: Request, env: Env): Promise<Response> {
  const config = readHighLevelConfig(env) ?? unavailable();
  await parse(request, startSchema);
  const now = Date.now();
  const limited = await takeLimit(request, env, "start", HIGHLEVEL_START_LIMIT, now);
  if (limited) return limited;
  const state = newState();
  await env.DB.prepare("INSERT INTO highlevel_flows (lookup, ciphertext, created_at) VALUES (?, NULL, ?)")
    .bind(await flowLookup(state), now)
    .run();
  return json({ state, authorizationUrl: highLevelAuthorizationUrl(config, state), expiresAt: now + HIGHLEVEL_FLOW_TTL_MS });
}

type Exchange =
  | { kind: "ok"; payload: HighLevelTokenPayload }
  | { kind: "rejected" | "failed"; status: number };

/** One `POST /oauth/token`. Only the status comes back from a failure. */
async function exchange(
  config: HighLevelConfig,
  grant: Record<string, string>,
  highLevelFetch: typeof fetch,
): Promise<Exchange> {
  const form = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    user_type: "Location",
    redirect_uri: config.redirectUrl,
    ...grant,
  });
  let response: Response;
  try {
    response = await highLevelFetch(HIGHLEVEL_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(HIGHLEVEL_TIMEOUT_MS),
    });
  } catch {
    return { kind: "failed", status: 0 };
  }
  if (response.status >= 400 && response.status < 500) return { kind: "rejected", status: response.status };
  if (response.status !== 200) return { kind: "failed", status: response.status };
  const answer = tokenResponseSchema.safeParse(await response.json().catch(() => null));
  if (!answer.success) return { kind: "failed", status: 200 };
  return {
    kind: "ok",
    payload: {
      accessToken: answer.data.access_token,
      refreshToken: answer.data.refresh_token,
      expiresIn: answer.data.expires_in,
      scope: answer.data.scope ?? "",
      locationId: answer.data.locationId ?? "",
      companyId: answer.data.companyId ?? "",
      userId: answer.data.userId ?? "",
    },
  };
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
} as const;

/** Fixed copy only: nothing from the request reaches the page. */
function page(title: string, text: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:17px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1b1b1b;background:#f6f6f6}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.35rem;margin:0 0 .5rem}p{margin:0;color:#4a4a4a}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>
`;
  return new Response(html, { status, headers: PAGE_HEADERS });
}

const PAGES = {
  connected: () => page("Connected", "Close this tab and go back to OpenMausBot."),
  cancelled: () => page("Connection cancelled", "Go back to OpenMausBot and try again when you are ready."),
  expired: () => page("Connection expired", "This link is no longer valid. Go back to OpenMausBot and try again.", 400),
  failed: () => page("Connection failed", "Go back to OpenMausBot and try again.", 502),
  unavailable: () => page("Connection failed", "Go back to OpenMausBot and try again.", 503),
};

interface FlowRow {
  lookup: string;
  ciphertext: string | null;
  created_at: number;
  claimed_at: number | null;
}

async function flowRow(env: Env, lookup: string): Promise<FlowRow | null> {
  return env.DB.prepare("SELECT lookup, ciphertext, created_at, claimed_at FROM highlevel_flows WHERE lookup = ?")
    .bind(lookup)
    .first<FlowRow>();
}

function expired(row: FlowRow, now: number): boolean {
  return row.created_at + HIGHLEVEL_FLOW_TTL_MS <= now;
}

/** Marks the flow as taken by this callback at `now`, or false when another callback, a claim or the TTL got there first. */
async function takeForCallback(env: Env, lookup: string, now: number): Promise<boolean> {
  const taken = await env.DB.prepare(
    `UPDATE highlevel_flows SET callback_at = ?1
     WHERE lookup = ?2 AND callback_at IS NULL AND ciphertext IS NULL AND claimed_at IS NULL AND created_at > ?3`,
  ).bind(now, lookup, now - HIGHLEVEL_FLOW_TTL_MS).run();
  return taken.meta.changes === 1;
}

function endTakenFlow(env: Env, lookup: string, now: number) {
  return env.DB.prepare("DELETE FROM highlevel_flows WHERE lookup = ? AND callback_at = ?").bind(lookup, now).run();
}

/** HighLevel sends the person's browser here: a top-level GET with no Origin
 * header and no credential. Every answer is a fixed page; query values are
 * never echoed or logged. */
export async function highLevelCallback(
  request: Request,
  env: Env,
  highLevelFetch: typeof fetch,
  requestId: string,
): Promise<Response> {
  const config = readHighLevelConfig(env);
  if (!config) return PAGES.unavailable();
  const now = Date.now();
  const limited = await takeLimit(request, env, "callback", HIGHLEVEL_CALLBACK_LIMIT, now);
  if (limited) return limited;
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  if (!canonicalState(state)) return PAGES.expired();
  const lookup = await flowLookup(state);
  const row = await flowRow(env, lookup);
  if (!row || row.claimed_at !== null || row.ciphertext !== null || expired(row, now)) return PAGES.expired();

  if (url.searchParams.has("error")) {
    // The person declined, or HighLevel refused before issuing a code. The
    // flow ends here: a claim finds nothing and the harness times out cleanly.
    if (!(await takeForCallback(env, lookup, now))) return PAGES.expired();
    await endTakenFlow(env, lookup, now);
    console.log(JSON.stringify({ message: "highlevel flow cancelled", requestId }));
    return PAGES.cancelled();
  }
  const code = url.searchParams.get("code") ?? "";
  if (!CODE.test(code)) return PAGES.failed();

  if (!(await takeForCallback(env, lookup, now))) return PAGES.expired();
  const outcome = await exchange(config, { grant_type: "authorization_code", code }, highLevelFetch);
  if (outcome.kind !== "ok") {
    // The code is single-use: nothing to retry with, so the flow ends.
    await endTakenFlow(env, lookup, now);
    console.error(JSON.stringify({ message: "highlevel exchange failed", requestId, status: outcome.status, errorCode: "highlevel_exchange_failed" }));
    return PAGES.failed();
  }
  const stored = await env.DB.prepare(
    `UPDATE highlevel_flows SET ciphertext = ?
     WHERE lookup = ? AND callback_at = ? AND ciphertext IS NULL AND claimed_at IS NULL AND created_at > ?`,
  ).bind(await seal(state, outcome.payload), lookup, now, now - HIGHLEVEL_FLOW_TTL_MS).run();
  if (stored.meta.changes === 0) return PAGES.expired();
  console.log(JSON.stringify({ message: "highlevel flow connected", requestId }));
  return PAGES.connected();
}

export async function claimHighLevelFlow(request: Request, env: Env): Promise<Response> {
  if (!readHighLevelConfig(env)) unavailable();
  const body = await parse(request, claimSchema);
  const now = Date.now();
  const limited = await takeLimit(request, env, "claim", HIGHLEVEL_CLAIM_LIMIT, now);
  if (limited) return limited;
  if (!canonicalState(body.state)) return errorResponse(404, "highlevel_unknown_state");
  const lookup = await flowLookup(body.state);
  const row = await flowRow(env, lookup);
  if (!row || expired(row, now)) return errorResponse(404, "highlevel_unknown_state");
  if (row.claimed_at !== null) return errorResponse(410, "highlevel_claimed");
  if (row.ciphertext === null) return errorResponse(404, "highlevel_unknown_state");
  // The payload leaves D1 the moment it is handed out; the row keeps only the
  // claimed mark until the sweep, so a second claim is told 410, not 404.
  const taken = await env.DB.prepare(
    "UPDATE highlevel_flows SET ciphertext = NULL, claimed_at = ? WHERE lookup = ? AND claimed_at IS NULL AND ciphertext IS NOT NULL",
  ).bind(now, lookup).run();
  if (taken.meta.changes === 0) return errorResponse(410, "highlevel_claimed");
  const payload = await open(body.state, row.ciphertext);
  if (!payload) throw new HTTPError(500, "internal_error");
  return json(payload);
}

export async function refreshHighLevelToken(
  request: Request,
  env: Env,
  highLevelFetch: typeof fetch,
  requestId: string,
): Promise<Response> {
  const config = readHighLevelConfig(env) ?? unavailable();
  const body = await parse(request, refreshSchema);
  const now = Date.now();
  const limited = await takeLimit(request, env, "refresh", HIGHLEVEL_REFRESH_LIMIT, now);
  if (limited) return limited;
  const outcome = await exchange(config, { grant_type: "refresh_token", refresh_token: body.refreshToken }, highLevelFetch);
  if (outcome.kind === "ok") return json(outcome.payload);
  if (outcome.kind === "rejected") {
    console.log(JSON.stringify({ message: "highlevel refresh rejected", requestId, status: outcome.status }));
    return errorResponse(401, "highlevel_refresh_rejected");
  }
  console.error(JSON.stringify({ message: "highlevel refresh failed", requestId, status: outcome.status, errorCode: "highlevel_refresh_failed" }));
  return errorResponse(502, "highlevel_refresh_failed");
}

/** Cron: forget flows older than the TTL, claimed or not, and stale limiter rows. */
export async function sweepHighLevelFlows(env: Env, requestId: string, now = Date.now()): Promise<number> {
  const [flows] = await env.DB.batch([
    env.DB.prepare("DELETE FROM highlevel_flows WHERE created_at <= ?").bind(now - HIGHLEVEL_FLOW_TTL_MS),
    env.DB.prepare("DELETE FROM highlevel_ip_rate_limits WHERE updated_at < ?").bind(now - LIMIT_RETENTION_MS),
  ]);
  const deleted = flows?.meta.changes ?? 0;
  if (deleted > 0) console.log(JSON.stringify({ message: "highlevel flow sweep", requestId, deleted }));
  return deleted;
}
