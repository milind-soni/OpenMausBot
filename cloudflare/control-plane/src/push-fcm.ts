// Firebase Cloud Messaging, HTTP v1: the Android half of the phone push relay.
import { sha256 } from "./installations";

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  /** The service account's RSA key as PEM (PKCS #8). */
  privateKey: string;
}

/** Fixed, never the `token_uri` from the service-account file, so a pasted file cannot point the Worker elsewhere. */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const FCM_HOST = "https://fcm.googleapis.com";
export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/** Google issues an access token for an hour; it is renewed five minutes early. */
const ACCESS_TOKEN_MARGIN_MS = 5 * 60 * 1_000;
const ASSERTION_LIFETIME_SECONDS = 60 * 60;
const FCM_TIMEOUT_MS = 10_000;
export const FCM_TTL = "86400s";

const PROJECT_ID = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
const CLIENT_EMAIL = /^[A-Za-z0-9._%+-]{1,128}@[A-Za-z0-9.-]{1,128}\.iam\.gserviceaccount\.com$/;
const PEM = /^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----$/;

/** `FCM_SERVICE_ACCOUNT`: the service-account JSON file Firebase gives, whole. */
export function readFcmConfig(env: Env): FcmConfig | null {
  const raw = (env as unknown as Partial<Record<string, unknown>>).FCM_SERVICE_ACCOUNT;
  if (typeof raw !== "string" || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const file = parsed as Record<string, unknown>;
  const { project_id: projectId, client_email: clientEmail, private_key: rawKey } = file;
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) return null;
  if (typeof clientEmail !== "string" || !CLIENT_EMAIL.test(clientEmail)) return null;
  if (typeof rawKey !== "string") return null;
  const privateKey = rawKey.replace(/\\n/g, "\n").trim();
  if (!PEM.test(privateKey)) return null;
  return { projectId, clientEmail, privateKey };
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

interface CachedAccess {
  fingerprint: string;
  expiresAt: number;
  token: string;
}
let cachedAccess: CachedAccess | null = null;

export function forgetFcmAccessToken(): void {
  cachedAccess = null;
}

/** RS256 per RFC 7518 §3.3, the OAuth 2.0 JWT bearer grant (RFC 7523) Google's service accounts use. */
export async function fcmAssertion(config: FcmConfig, now: number): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(config.privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const encoder = new TextEncoder();
  const iat = Math.floor(now / 1_000);
  const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64url(encoder.encode(JSON.stringify({
    iss: config.clientEmail,
    scope: FCM_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat,
    exp: iat + ASSERTION_LIFETIME_SECONDS,
  })));
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, encoder.encode(`${header}.${claims}`));
  return `${header}.${claims}.${base64url(signature)}`;
}

export type FcmAccess = { kind: "ok"; token: string } | { kind: "credentials" | "failed"; status: number; reason: string };

export async function fcmAccessToken(config: FcmConfig, pushFetch: typeof fetch, now: number): Promise<FcmAccess> {
  const fingerprint = `${config.projectId}:${config.clientEmail}:${await sha256(config.privateKey)}`;
  if (cachedAccess && cachedAccess.fingerprint === fingerprint && cachedAccess.expiresAt - ACCESS_TOKEN_MARGIN_MS > now) {
    return { kind: "ok", token: cachedAccess.token };
  }
  let assertion: string;
  try {
    assertion = await fcmAssertion(config, now);
  } catch {
    return { kind: "credentials", status: 0, reason: "invalid signing key" };
  }
  let response: Response;
  try {
    response = await pushFetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
    });
  } catch {
    return { kind: "failed", status: 0, reason: "unreachable" };
  }
  const answer = await response.json<{ access_token?: unknown; expires_in?: unknown; error?: unknown }>().catch(() => null);
  if (response.status === 200 && typeof answer?.access_token === "string" && answer.access_token) {
    const lifetime = typeof answer.expires_in === "number" && Number.isFinite(answer.expires_in) ? answer.expires_in : 3_600;
    cachedAccess = { fingerprint, expiresAt: now + lifetime * 1_000, token: answer.access_token };
    return { kind: "ok", token: answer.access_token };
  }
  const reason = typeof answer?.error === "string" ? answer.error.slice(0, 64) : "";
  // invalid_grant / unauthorized_client: the key was revoked or the file is wrong.
  if (response.status === 400 || response.status === 401 || response.status === 403) return { kind: "credentials", status: response.status, reason };
  return { kind: "failed", status: response.status, reason };
}

export interface FcmError {
  status: number;
  errorCode: string;
  message: string;
}

export async function readFcmError(response: Response): Promise<FcmError> {
  const answer = await response.json<{ error?: { message?: unknown; status?: unknown; details?: unknown } }>().catch(() => null);
  const error = answer?.error;
  const details = Array.isArray(error?.details) ? error.details : [];
  const fcmDetail = details.find((detail): detail is { errorCode: string } =>
    Boolean(detail) && typeof detail === "object" && typeof (detail as { errorCode?: unknown }).errorCode === "string");
  const errorCode = fcmDetail?.errorCode ?? (typeof error?.status === "string" ? error.status : "");
  const message = typeof error?.message === "string" ? error.message : "";
  return { status: response.status, errorCode: errorCode.slice(0, 64), message: message.slice(0, 200) };
}

/** UNREGISTERED: the app was removed or the token expired. SENDER_ID_MISMATCH: a token of another Firebase project. */
export function fcmTokenIsDead(error: FcmError): boolean {
  if (error.errorCode === "UNREGISTERED" || error.errorCode === "SENDER_ID_MISMATCH") return true;
  return error.status === 400 && error.errorCode === "INVALID_ARGUMENT" && /registration token/i.test(error.message);
}

export function fcmSendUrl(config: FcmConfig): string {
  return `${FCM_HOST}/v1/projects/${config.projectId}/messages:send`;
}

export const FCM_TIMEOUT = FCM_TIMEOUT_MS;
