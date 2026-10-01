// Find where a URL MCP server wants its users to sign in. MCP servers that
// require OAuth answer 401 and point at their protected-resource metadata
// (RFC 9728), which names an authorization server whose own metadata
// (RFC 8414, or OpenID discovery) lists the endpoints a client needs.
// Nothing here follows a redirect or accepts a plain-http endpoint off
// this machine: a token endpoint is where a sign-in code is spent.

export interface McpAuthMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  scopes?: string[];
  /** RFC 8414 `token_endpoint_auth_methods_supported`; absent means
   * client_secret_basic for a client that has a secret. */
  tokenEndpointAuthMethods?: string[];
  /** The MCP URL, sent as the RFC 8707 `resource` so tokens are audience-bound. */
  resource: string;
}

const FETCH_TIMEOUT_MS = 5_000;
const MAX_METADATA_BYTES = 65_536;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** https anywhere; http only to this machine (local test servers). */
export function isAllowedAuthUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/** The `resource_metadata` parameter of a `WWW-Authenticate: Bearer …` challenge. */
export function resourceMetadataUrl(wwwAuthenticate: string | null): string | null {
  if (!wwwAuthenticate) return null;
  const match = /resource_metadata\s*=\s*(?:"([^"]*)"|([^\s,]+))/i.exec(wwwAuthenticate);
  const value = match?.[1] ?? match?.[2];
  return value || null;
}

interface DiscoverOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

async function getJson(url: string, options: DiscoverOptions): Promise<Record<string, unknown> | null> {
  if (!isAllowedAuthUrl(url)) return null;
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const response = await (options.fetch ?? fetch)(url, { headers: { accept: "application/json" }, redirect: "error", signal });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    const text = await response.text();
    if (text.length > MAX_METADATA_BYTES) return null;
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value as string[] : undefined;
}

async function protectedResource(mcpUrl: URL, hint: string | null, options: DiscoverOptions) {
  const path = mcpUrl.pathname === "/" ? "" : mcpUrl.pathname;
  const candidates = [
    ...(hint ? [hint] : []),
    `${mcpUrl.origin}/.well-known/oauth-protected-resource${path}`,
    `${mcpUrl.origin}/.well-known/oauth-protected-resource`,
  ];
  for (const candidate of new Set(candidates)) {
    const document = await getJson(candidate, options);
    if (document) return document;
  }
  return null;
}

async function authorizationServer(issuer: string, options: DiscoverOptions) {
  const base = issuer.replace(/\/+$/, "");
  const url = new URL(base);
  const suffix = url.pathname === "/" ? "" : url.pathname;
  const candidates = [
    `${url.origin}/.well-known/oauth-authorization-server${suffix}`,
    `${url.origin}/.well-known/openid-configuration${suffix}`,
    ...(suffix ? [`${base}/.well-known/openid-configuration`] : []),
  ];
  for (const candidate of candidates) {
    const document = await getJson(candidate, options);
    if (document) return document;
  }
  return null;
}

/** The sign-in endpoints for an MCP server, or null when it does not
 * describe a usable OAuth sign-in (no metadata, no PKCE S256, or an
 * endpoint that is not https). */
export async function discoverMcpAuth(
  mcpUrl: string,
  wwwAuthenticate: string | null,
  options: DiscoverOptions = {},
): Promise<McpAuthMetadata | null> {
  let target: URL;
  try {
    target = new URL(mcpUrl);
  } catch {
    return null;
  }
  const resource = await protectedResource(target, resourceMetadataUrl(wwwAuthenticate), options);
  const servers = stringList(resource?.authorization_servers);
  const issuer = servers?.[0] ?? target.origin;
  if (!isAllowedAuthUrl(issuer)) return null;
  const metadata = await authorizationServer(issuer, options);
  if (!metadata) return null;

  const authorizationEndpoint = metadata.authorization_endpoint;
  const tokenEndpoint = metadata.token_endpoint;
  if (typeof authorizationEndpoint !== "string" || !isAllowedAuthUrl(authorizationEndpoint)) return null;
  if (typeof tokenEndpoint !== "string" || !isAllowedAuthUrl(tokenEndpoint)) return null;
  if (!stringList(metadata.code_challenge_methods_supported)?.includes("S256")) return null;

  // RFC 8414 §3.3: the metadata must be for the issuer it was fetched for.
  if (typeof metadata.issuer === "string" && metadata.issuer.replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")) return null;
  const optionalEndpoint = (value: unknown) => typeof value === "string" && isAllowedAuthUrl(value) ? value : undefined;
  const registrationEndpoint = optionalEndpoint(metadata.registration_endpoint);
  const revocationEndpoint = optionalEndpoint(metadata.revocation_endpoint);
  const scopes = stringList(resource?.scopes_supported);
  const tokenEndpointAuthMethods = stringList(metadata.token_endpoint_auth_methods_supported);
  target.hash = "";
  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    ...(registrationEndpoint ? { registrationEndpoint } : {}),
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
    ...(scopes?.length ? { scopes } : {}),
    ...(tokenEndpointAuthMethods?.length ? { tokenEndpointAuthMethods } : {}),
    resource: target.toString(),
  };
}
