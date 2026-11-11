import { createHash, randomBytes } from "node:crypto";
import { OAuthClientMetadataSchema } from "@modelcontextprotocol/core";
import { originUrl } from "./integration-bridge";
import { store } from "./server-store";

// OAuth 2.1 authorization server for the MCP endpoint: dynamic client registration (public clients only),
// authorization code + PKCE S256, rotating refresh tokens with reuse detection, RFC 7009 revocation.
// This module generates codes and tokens and sends Convex only their SHA-256 hashes (convex/mcpOAuth.ts). Each grant's
// Convex connector token is sealed by Convex; revoking a grant revokes that connector grant in the same transaction,
// so Settings > Agents never shows a grant OAuth no longer honours. A Convex cron revokes abandoned consents.

const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const mcpResource = () => `${originUrl()}/api/mcp`;
export const mcpResourceMetadata = () => `${originUrl()}/.well-known/oauth-protected-resource/api/mcp`;
export const mcpScopes = ["origin:read", "origin:write"];
export const oauthHeaders = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
const ACCESS_TTL = 3600000;
const CODE_TTL = 5 * 60000;
export type OAuthRequest = { clientId: string; name: string; redirect: string; challenge: string; state: string; resource: string; scope: string };
type Minted = { scope: string; accessExpiresAt: number } | { error: string; description?: string };

export class OAuthError extends Error {
  constructor(readonly code: string, description?: string) { super(description || code); }
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
function isLoopback(url: URL) { return url.protocol === "http:" && LOOPBACK.has(url.hostname); }
export function validRedirect(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  // HTTPS, or an http loopback callback for CLI and desktop clients (RFC 8252 section 7.3).
  return !url.hash && !url.username && !url.password && (url.protocol === "https:" || isLoopback(url));
}
/** Exact match, except that loopback callbacks may use any port (RFC 8252 section 7.3). */
export function redirectMatches(registered: string, requested: string) {
  if (registered === requested) return true;
  let a: URL, b: URL;
  try { a = new URL(registered); b = new URL(requested); } catch { return false; }
  if (!isLoopback(a) || !isLoopback(b) || b.hash || b.username || b.password) return false;
  return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}
function resourceMatches(value: string | null) {
  // RFC 8707: clients should send the resource; accept its absence and a trailing slash.
  return !value || value.replace(/\/$/, "") === mcpResource();
}
export function parseScope(value: string | null) {
  const scopes = [...new Set((value || mcpScopes.join(" ")).split(" ").filter(Boolean))];
  if (scopes.some(s => !mcpScopes.includes(s))) throw new OAuthError("invalid_scope", "Unsupported scope");
  return [...new Set(["origin:read", ...scopes])].join(" ");
}

export class InvalidClientMetadata extends Error {
  constructor(readonly code: "invalid_redirect_uri" | "invalid_client_metadata", description: string) { super(description); }
}
export class RegistrationLimited extends Error {}

/**
 * RFC 7591 registration. An identical registration (same name and redirect URIs) returns the existing client and
 * keeps it alive; only a new client counts against `limit` (a rate-limit key and budget per minute).
 */
export async function registerMcpClient(input: unknown, limit: { key: string; maximum: number }) {
  const parsed = OAuthClientMetadataSchema.safeParse(input);
  if (!parsed.success) throw new InvalidClientMetadata("invalid_client_metadata", "Invalid client metadata");
  const data = parsed.data;
  if (data.token_endpoint_auth_method && data.token_endpoint_auth_method !== "none") throw new InvalidClientMetadata("invalid_client_metadata", "Only public clients are supported (token_endpoint_auth_method: none)");
  if (!data.redirect_uris.length || data.redirect_uris.length > 10 || data.redirect_uris.some(uri => uri.length > 2000 || !validRedirect(uri))) throw new InvalidClientMetadata("invalid_redirect_uri", "Use HTTPS or loopback redirect URIs");
  if (data.grant_types?.some(value => !["authorization_code", "refresh_token"].includes(value)) || data.response_types?.some(value => value !== "code")) throw new InvalidClientMetadata("invalid_client_metadata", "Only authorization_code and refresh_token are supported");
  const name = (data.client_name || new URL(data.redirect_uris[0]).hostname).slice(0, 100);
  const result = await store<{ clientId: string; createdAt: number } | { error: "rate_limited" }>("mcp.registerClient", {
    candidateId: token(), name, redirects: JSON.stringify(data.redirect_uris), limitKey: limit.key, limitMaximum: limit.maximum,
  });
  if ("error" in result) throw new RegistrationLimited();
  return { client_id: result.clientId, client_id_issued_at: Math.floor(result.createdAt / 1000), client_name: name, redirect_uris: data.redirect_uris,
    token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: mcpScopes.join(" ") };
}
export async function mcpClientExists(id: string) {
  return Boolean(id) && Boolean(await store("mcp.client", { clientId: id }));
}

/** Client and redirect URI checks. Errors here must not redirect (the redirect URI is not trusted yet). */
export async function validateMcpClient(params: URLSearchParams) {
  const clientId = params.get("client_id") || "";
  const client = clientId ? await store<{ name: string; redirects: string } | null>("mcp.client", { clientId }) : null;
  const redirect = params.get("redirect_uri") || "";
  if (!client || !(JSON.parse(client.redirects) as string[]).some(uri => redirectMatches(uri, redirect))) throw new OAuthError("invalid_client", "Unknown client or redirect URI");
  return { clientId, name: client.name, redirect };
}
export async function validateMcpAuthorization(params: URLSearchParams): Promise<OAuthRequest> {
  const { clientId, name, redirect } = await validateMcpClient(params);
  const state = params.get("state") || "";
  if (state.length > 2000) throw new OAuthError("invalid_request", "State too long");
  if (params.get("response_type") !== "code") throw new OAuthError("unsupported_response_type", "Use response_type=code");
  const challenge = params.get("code_challenge") || "";
  if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new OAuthError("invalid_request", "PKCE with S256 is required");
  if (!resourceMatches(params.get("resource"))) throw new OAuthError("invalid_target", "Unknown resource");
  return { clientId, name, redirect, challenge, state, scope: parseScope(params.get("scope")), resource: mcpResource() };
}
export function authorizationError(request: Pick<OAuthRequest, "redirect" | "state">, error: string) {
  const target = new URL(request.redirect); target.searchParams.set("error", error); target.searchParams.set("iss", originUrl());
  if (request.state) target.searchParams.set("state", request.state);
  return target.toString();
}
export async function issueMcpCode(request: OAuthRequest, connectorToken: string, expires: number, write: boolean) {
  const grantId = token(), code = token();
  await store("mcp.issueCode", {
    grantId, clientId: request.clientId, connectorToken, scope: write ? "origin:read origin:write" : "origin:read", resource: request.resource, expiresAt: expires,
    codeHash: hash(code), redirect: request.redirect, challenge: request.challenge, codeExpiresAt: Date.now() + CODE_TTL,
  });
  const url = new URL(request.redirect); url.searchParams.set("code", code); url.searchParams.set("iss", originUrl());
  if (request.state) url.searchParams.set("state", request.state);
  return url.toString();
}

/** Token endpoint: authorization_code or refresh_token. Throws OAuthError; revocations Convex made still commit. */
export async function exchangeMcpToken(params: URLSearchParams) {
  const clientId = params.get("client_id") || "";
  if (!await mcpClientExists(clientId)) throw new OAuthError("invalid_client");
  if (!resourceMatches(params.get("resource"))) throw new OAuthError("invalid_target");
  const grantType = params.get("grant_type");
  if (grantType !== "authorization_code" && grantType !== "refresh_token") throw new OAuthError("unsupported_grant_type");
  const access = token(), refresh = token();
  const minted = { accessHash: hash(access), refreshHash: hash(refresh), accessTtl: ACCESS_TTL };
  let outcome: Minted;
  if (grantType === "authorization_code") {
    const verifier = params.get("code_verifier") || "";
    const verifierChallenge = /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ? createHash("sha256").update(verifier).digest("base64url") : "";
    outcome = await store<Minted>("mcp.exchangeCode", { clientId, codeHash: hash(params.get("code") || ""), redirect: params.get("redirect_uri") || "", verifierChallenge, ...minted });
  } else {
    // An unsupported scope fails before the refresh token is consumed.
    const requestedScope = params.has("scope") ? parseScope(params.get("scope")) : null;
    outcome = await store<Minted>("mcp.exchangeRefresh", { clientId, presentedHash: hash(params.get("refresh_token") || ""), requestedScope, ...minted });
  }
  if ("error" in outcome) throw new OAuthError(outcome.error, outcome.description);
  return { access_token: access, token_type: "Bearer", expires_in: Math.max(1, Math.floor((outcome.accessExpiresAt - Date.now()) / 1000)), refresh_token: refresh, scope: outcome.scope };
}
export async function resolveMcpToken(access: string) {
  const grant = access ? await store<{ grantId: string; write: boolean; connectorToken: string } | null>("mcp.resolve", { accessHash: hash(access), resource: mcpResource() }) : null;
  if (!grant) throw new OAuthError("invalid_token");
  return grant;
}
/** Revokes the whole grant behind an access or refresh token, with its Convex connector grant. Unknown tokens are ignored. */
export async function revokeMcpToken(value: string, clientId: string) {
  return value ? store<boolean>("mcp.revoke", { tokenHash: hash(value), clientId }) : false;
}
