import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

type Identity = { email: string; method: "login" } | undefined;
const identities = new Map<string, { fingerprint: string; expires: number; result: Promise<Identity> }>();

/** The pinned runtime's file stores refresh credentials, not the account email; the native CLI's stores an access token
 * and no OAuth client, so it is read only while that token is fresh (the CLI refreshes it itself). Resolve display
 * identity through Google only; never expose or rewrite tokens. */
export async function antigravityAccount(tokenPath: string): Promise<Identity> {
  try {
    const info = await stat(tokenPath);
    if (!info.isFile() || info.size > 1024 * 1024) return undefined;
    const raw = await readFile(tokenPath, "utf8");
    const fingerprint = createHash("sha256").update(raw).digest("hex");
    const cached = identities.get(tokenPath);
    if (cached?.fingerprint === fingerprint && cached.expires > Date.now()) return cached.result;
    const credentials = JSON.parse(raw);
    const cliAccess = antigravityCliAccessToken(credentials);
    if (!cliAccess && (!credentials || !["client_id", "client_secret", "refresh_token"].every((key) => typeof credentials[key] === "string" && credentials[key].length > 0))) return undefined;
    const entry = { fingerprint, expires: Date.now() + 60_000, result: Promise.resolve<Identity>(undefined) };
    entry.result = lookup(cliAccess ? { accessToken: cliAccess.accessToken } : credentials).then((account) => {
      if (account) entry.expires = Date.now() + 60 * 60_000;
      return account;
    });
    if (identities.size >= 128) identities.delete(identities.keys().next().value!);
    identities.set(tokenPath, entry);
    return entry.result;
  } catch {
    identities.delete(tokenPath);
    return undefined;
  }
}

export interface AntigravityStoredSignIn { client_id: string; client_secret: string; refresh_token: string }

/** The access token in the native CLI's sign-in file (`{"token":{"access_token","expiry",…}}`) while it has more than a
 * minute left; null for any other file or a stale token. */
export function antigravityCliAccessToken(file: unknown, now = Date.now()): { accessToken: string; expiresAt: number } | null {
  const token = (file as { token?: { access_token?: unknown; expiry?: unknown } } | null)?.token;
  if (!token || typeof token.access_token !== "string" || !token.access_token || typeof token.expiry !== "string") return null;
  const expiresAt = Date.parse(token.expiry);
  return Number.isFinite(expiresAt) && expiresAt > now + 60_000 ? { accessToken: token.access_token, expiresAt } : null;
}
type AccessFetch = (url: string, init: { method?: "POST"; headers?: Record<string, string>; body?: string | URLSearchParams; redirect: "error" | "manual"; signal: AbortSignal }) => Promise<Pick<Response, "ok" | "json">>;

/** A short-lived access token for the stored sign-in, from Google only. The token stays in memory: it is never logged,
 * written or returned to a client. Undefined when Google refuses or cannot be reached. */
export async function refreshAntigravityAccess(
  credentials: AntigravityStoredSignIn,
  signal: AbortSignal,
  fetchImpl: AccessFetch = fetch,
  redirect: "error" | "manual" = "error",
): Promise<{ accessToken: string; expiresInSeconds: number | null } | undefined> {
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST", redirect, signal,
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: credentials.client_id,
      client_secret: credentials.client_secret, refresh_token: credentials.refresh_token }),
  });
  if (!response.ok) return undefined;
  const token = await response.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof token.access_token !== "string" || !token.access_token) return undefined;
  return { accessToken: token.access_token, expiresInSeconds: typeof token.expires_in === "number" && token.expires_in > 0 ? token.expires_in : null };
}

async function lookup(credentials: AntigravityStoredSignIn | { accessToken: string }): Promise<Identity> {
  try {
    const signal = AbortSignal.timeout(3_000);
    const access = "accessToken" in credentials ? credentials : await refreshAntigravityAccess(credentials, signal);
    if (!access) return undefined;
    const identity = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${access.accessToken}` }, redirect: "error", signal,
    });
    if (!identity.ok) return undefined;
    const user = await identity.json() as { email?: unknown };
    if (typeof user.email !== "string" || user.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) return undefined;
    return { email: user.email, method: "login" };
  } catch {
    // Identity lookup failure must not mark a working engine as signed out.
    return undefined;
  }
}
