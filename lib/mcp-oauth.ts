import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { OAuthClientMetadataSchema } from "@modelcontextprotocol/core";
import { originUrl } from "./integration-bridge";
import { store } from "./server-store";

// OAuth 2.1 authorization server for the MCP endpoint: dynamic client registration and client ID metadata documents
// (public clients only), authorization code + PKCE S256, rotating refresh tokens with reuse detection, RFC 7009
// revocation. This module generates codes and tokens and sends Convex only their SHA-256 hashes (convex/mcpOAuth.ts).
// Each grant's Convex connector token is sealed by Convex; revoking a grant revokes that connector grant in the same
// transaction, so Settings > Agents never shows a grant OAuth no longer honours. A Convex cron revokes abandoned consents.

const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const mcpResource = () => `${originUrl()}/api/mcp`;
/** Linear-style read-only endpoint: the same server with only the read tools. Its tokens never carry origin:write. */
export const mcpReadonlyResource = () => `${originUrl()}/api/mcp/readonly`;
export const mcpResourceMetadata = (resource = mcpResource()) => `${originUrl()}/.well-known/oauth-protected-resource${new URL(resource).pathname}`;
export const mcpScopes = ["origin:read", "origin:write"];
export const oauthHeaders = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
const ACCESS_TTL = 3600000;
const CODE_TTL = 5 * 60000;
export type OAuthRequest = { clientId: string; name: string; redirect: string; challenge: string; state: string; resource: string; scope: string };
type Minted = { scope: string; accessExpiresAt: number } | { error: string; description?: string };

/** RFC 9728 metadata for one MCP endpoint. */
export function protectedResourceMetadata(resource = mcpResource()) {
  const readonly = resource === mcpReadonlyResource();
  return {
    resource, authorization_servers: [originUrl()], scopes_supported: readonly ? ["origin:read"] : mcpScopes,
    bearer_methods_supported: ["header"], resource_name: readonly ? "Origin (read only)" : "Origin",
  };
}

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
/** RFC 8707: the resource a request names, or the main endpoint when it names none. Unknown resources are refused. */
export function requestedResource(value: string | null) {
  // Clients should send the resource; accept its absence and a trailing slash.
  if (!value) return mcpResource();
  const resource = value.replace(/\/$/, "");
  if (resource === mcpResource() || resource === mcpReadonlyResource()) return resource;
  throw new OAuthError("invalid_target", "Unknown resource");
}
export function parseScope(value: string | null) {
  const scopes = [...new Set((value || mcpScopes.join(" ")).split(" ").filter(Boolean))];
  if (scopes.some(s => !mcpScopes.includes(s))) throw new OAuthError("invalid_scope", "Unsupported scope");
  return [...new Set(["origin:read", ...scopes])].join(" ");
}

/** Auth methods a registration may ask for. All are registered as public clients; see registerMcpClient. */
const PUBLIC_COMPATIBLE = new Set(["none", "client_secret_post", "client_secret_basic"]);

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
  // Every client is public: PKCE protects the code. A client that asks for client_secret_post or _basic is registered
  // as public instead (RFC 7591 section 3.2.1 lets the server replace requested values) and the response says so;
  // the token endpoint ignores a secret it never issued. Key-based methods cannot be honoured and are refused.
  if (data.token_endpoint_auth_method && !PUBLIC_COMPATIBLE.has(data.token_endpoint_auth_method)) throw new InvalidClientMetadata("invalid_client_metadata", "Only public clients are supported (token_endpoint_auth_method: none)");
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
  return Boolean(id) && !isMetadataDocumentClientId(id) && Boolean(await store("mcp.client", { clientId: id }));
}

// Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document, MCP 2025-11-25): the client_id is an
// HTTPS URL serving the client's metadata. Claude.ai ("Claude's published identity") and ChatGPT prefer this to
// registration. The document is fetched for each authorization request, never cached, and only from public hosts.

const METADATA_DOCUMENT_LIMIT = 5120;
const METADATA_DOCUMENT_TIMEOUT = 5000;
export const isMetadataDocumentClientId = (value: string) => /^https:\/\/[^/?#]+\/[^?#]+$/.test(value);

function privateAddress(address: string) {
  const v4 = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32)
      || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = address.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^(fc|fd|fe[89ab]|ff)/.test(v6);
}

/** Resolves the host and refuses loopback, private and link-local addresses, so a client_id cannot reach into the network. */
async function publicHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return !privateAddress(host);
  if (host === "localhost" || /\.(localhost|local|internal)$/.test(host)) return false;
  try { const addresses = await lookup(host, { all: true }); return addresses.length > 0 && addresses.every(entry => !privateAddress(entry.address)); }
  catch { return false; }
}

type MetadataFetch = (url: string, init: RequestInit) => Promise<Response>;
const network = { fetch: ((url, init) => fetch(url, init)) as MetadataFetch, publicHost };
/** Tests replace the network; null restores it. */
export function setMetadataDocumentNetwork(fetcher: MetadataFetch | null, hostCheck?: (hostname: string) => Promise<boolean>) {
  network.fetch = fetcher ?? ((url, init) => fetch(url, init));
  network.publicHost = hostCheck ?? publicHost;
}

/** The client behind an HTTPS client_id's metadata document, or null when the document cannot be used. */
export async function metadataDocumentClient(clientId: string): Promise<{ name: string; redirects: string[] } | null> {
  let url: URL;
  try { url = new URL(clientId); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.pathname === "/" || (url.port && url.port !== "443")) return null;
  if (!await network.publicHost(url.hostname)) return null;
  let body: unknown;
  try {
    const response = await network.fetch(url.toString(), { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(METADATA_DOCUMENT_TIMEOUT), cache: "no-store" });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > METADATA_DOCUMENT_LIMIT) return null;
    body = JSON.parse(text);
  } catch { return null; }
  const parsed = OAuthClientMetadataSchema.safeParse(body);
  // The document must name itself, or anyone could serve a copy of another client's metadata.
  if (!parsed.success || (body as { client_id?: unknown }).client_id !== clientId) return null;
  const redirects = parsed.data.redirect_uris.filter(uri => uri.length <= 2000 && validRedirect(uri)).slice(0, 10);
  if (!redirects.length) return null;
  return { name: (parsed.data.client_name || url.hostname).slice(0, 100), redirects };
}

/** Client and redirect URI checks. Errors here must not redirect (the redirect URI is not trusted yet). */
export async function validateMcpClient(params: URLSearchParams) {
  const clientId = params.get("client_id") || "";
  const redirect = params.get("redirect_uri") || "";
  let client: { name: string; redirects: string[] } | null = null;
  if (isMetadataDocumentClientId(clientId)) client = await metadataDocumentClient(clientId);
  else if (clientId) {
    const row = await store<{ name: string; redirects: string } | null>("mcp.client", { clientId });
    client = row ? { name: row.name, redirects: JSON.parse(row.redirects) as string[] } : null;
  }
  if (!client || !client.redirects.some(uri => redirectMatches(uri, redirect))) throw new OAuthError("invalid_client", "Unknown client or redirect URI");
  return { clientId, name: client.name, redirect };
}
export async function validateMcpAuthorization(params: URLSearchParams): Promise<OAuthRequest> {
  const { clientId, name, redirect } = await validateMcpClient(params);
  const state = params.get("state") || "";
  if (state.length > 2000) throw new OAuthError("invalid_request", "State too long");
  if (params.get("response_type") !== "code") throw new OAuthError("unsupported_response_type", "Use response_type=code");
  const challenge = params.get("code_challenge") || "";
  if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new OAuthError("invalid_request", "PKCE with S256 is required");
  const resource = requestedResource(params.get("resource"));
  // The read-only endpoint never grants writes, whatever scope the client asked for.
  const scope = resource === mcpReadonlyResource() ? "origin:read" : parseScope(params.get("scope"));
  return { clientId, name, redirect, challenge, state, scope, resource };
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

/**
 * The client_id of a token or revocation request: the form field, or the user part of HTTP Basic credentials, for
 * clients that registered asking for client_secret_basic. Their secret is ignored: every client is public.
 */
export function requestClientId(params: URLSearchParams, authorization: string | null = null) {
  const own = params.get("client_id");
  if (own) return own;
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(authorization || "")?.[1];
  if (!basic) return "";
  const decoded = Buffer.from(basic, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return "";
  try { return decodeURIComponent(decoded.slice(0, separator).replace(/\+/g, " ")); } catch { return ""; }
}

/** Token endpoint: authorization_code or refresh_token. Throws OAuthError; revocations Convex made still commit. */
export async function exchangeMcpToken(params: URLSearchParams, authorization: string | null = null) {
  const clientId = requestClientId(params, authorization);
  // Metadata-document clients have no registration row; Convex binds every code and refresh token to its client_id.
  if (!isMetadataDocumentClientId(clientId) && !await mcpClientExists(clientId)) throw new OAuthError("invalid_client");
  try { requestedResource(params.get("resource")); } catch { throw new OAuthError("invalid_target"); }
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
/** The grant behind an access token. The read-only endpoint also takes tokens issued for the main one, read only; never the reverse. */
export async function resolveMcpToken(access: string, resource = mcpResource()) {
  const readonly = resource === mcpReadonlyResource();
  for (const candidate of access ? readonly ? [mcpReadonlyResource(), mcpResource()] : [mcpResource()] : []) {
    const grant = await store<{ grantId: string; write: boolean; connectorToken: string } | null>("mcp.resolve", { accessHash: hash(access), resource: candidate });
    if (grant) return readonly ? { ...grant, write: false } : grant;
  }
  throw new OAuthError("invalid_token");
}
/** Revokes the whole grant behind an access or refresh token, with its Convex connector grant. Unknown tokens are ignored. */
export async function revokeMcpToken(value: string, clientId: string) {
  return value ? store<boolean>("mcp.revoke", { tokenHash: hash(value), clientId }) : false;
}
