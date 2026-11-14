// Never follows a redirect or accepts a plain-http endpoint off this machine: a token endpoint is where a sign-in code is spent.
import { isIP } from "node:net";

import { isPublicDomainAddress } from "./custom-domain.ts";

export interface McpAuthMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  scopes?: string[];
  /** RFC 8414 `token_endpoint_auth_methods_supported`; absent means client_secret_basic. */
  tokenEndpointAuthMethods?: string[];
  /** The MCP URL, sent as the RFC 8707 `resource` so tokens are audience-bound. */
  resource: string;
  /** How the authorization server was found. `protected-resource`: an RFC 9728 document (the 401's `resource_metadata`
   * hint, or a well-known address for this URL or its origin) named it. `origin`: none did, and the MCP server's own
   * origin was assumed to be the issuer, as MCP 2025-03-26 clients do. */
  source: "protected-resource" | "origin";
}

const FETCH_TIMEOUT_MS = 5_000;
const MAX_METADATA_BYTES = 65_536;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Scheme-only rule for a URL the owner configured or a browser opens. Discovery uses `isAllowedDiscoveryUrl` below,
 * because its URLs come from a remote server's response. */
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

/** `.local`, `.internal` and the like name this machine's network on some resolver, so a remote document must not aim a
 * fetch there. A public name is otherwise let through: TLS still has to prove the host before any body is read. */
const LOCAL_SUFFIX = /(?:^|\.)(?:localhost|local|internal|lan|home|ts\.net|invalid)$/i;

/**
 * Whether a URL in OAuth discovery may be fetched. Only the MCP server's own origin (the URL the owner configured) is
 * trusted with loopback, private or plain-http addresses; metadata and endpoints it names are remote input, so they must
 * be public HTTPS. Without this a malicious MCP server's `WWW-Authenticate: resource_metadata="http://127.0.0.1:…"` would
 * make the harness call this machine's anonymous loopback surface.
 */
export function isAllowedDiscoveryUrl(value: string, trustedOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  // The owner's own server keeps the configured-URL rule: https, or http on loopback only.
  if (url.origin === trustedOrigin) return isAllowedAuthUrl(value);
  let trusted: URL;
  try {
    trusted = new URL(trustedOrigin);
  } catch {
    return false;
  }
  // A local MCP server may name a sign-in server on another loopback port: both are code the owner installed here.
  if (isLoopbackName(trusted.hostname) && isLoopbackName(url.hostname)) return true;
  if (url.protocol !== "https:" || isLoopbackName(url.hostname)) return false;
  // A server the owner reaches on a private network (LAN, VPN, tailnet) may name a sign-in server on another private host;
  // a public server may only name public ones.
  return isPublicHost(trusted.hostname) ? isPublicHost(url.hostname) : true;
}

function isPublicHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
  if (isIP(host)) return isPublicDomainAddress(host);
  return host.includes(".") && !LOCAL_SUFFIX.test(host);
}

function isLoopbackName(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
  if (host === "localhost") return true;
  if (isIP(host) === 4) return host.startsWith("127.") || host === "0.0.0.0";
  if (isIP(host) !== 6) return false;
  const mapped = /^::ffff:(.+)$/u.exec(host)?.[1];
  if (mapped) return mapped.startsWith("127.") || mapped === "0.0.0.0" || /^7f[0-9a-f]{2}:/u.test(mapped) || mapped === "0:0";
  return host === "::1" || host === "0:0:0:0:0:0:0:1" || host === "::" || host === "0:0:0:0:0:0:0:0";
}

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

async function getJson(url: string, trustedOrigin: string, options: DiscoverOptions): Promise<Record<string, unknown> | null> {
  if (!isAllowedDiscoveryUrl(url, trustedOrigin)) return null;
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const response = await (options.fetch ?? fetch)(url, { headers: { accept: "application/json" }, redirect: "error", signal });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    // A server named by metadata is remote: read at most the cap, never buffer whatever it decides to send.
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_METADATA_BYTES) return null;
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value as string[] : undefined;
}

async function protectedResource(mcpUrl: URL, hint: string | null, trustedOrigin: string, options: DiscoverOptions) {
  const path = mcpUrl.pathname === "/" ? "" : mcpUrl.pathname;
  const candidates = [
    ...(hint ? [hint] : []),
    `${mcpUrl.origin}/.well-known/oauth-protected-resource${path}`,
    `${mcpUrl.origin}/.well-known/oauth-protected-resource`,
  ];
  for (const candidate of new Set(candidates)) {
    const document = await getJson(candidate, trustedOrigin, options);
    if (document) return document;
  }
  return null;
}

async function authorizationServer(issuer: string, trustedOrigin: string, options: DiscoverOptions) {
  const base = issuer.replace(/\/+$/, "");
  const url = new URL(base);
  const suffix = url.pathname === "/" ? "" : url.pathname;
  const candidates = [
    `${url.origin}/.well-known/oauth-authorization-server${suffix}`,
    `${url.origin}/.well-known/openid-configuration${suffix}`,
    ...(suffix ? [`${base}/.well-known/openid-configuration`] : []),
  ];
  for (const candidate of candidates) {
    const document = await getJson(candidate, trustedOrigin, options);
    if (document) return document;
  }
  return null;
}

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
  const trustedOrigin = target.origin;
  const resource = await protectedResource(target, resourceMetadataUrl(wwwAuthenticate), trustedOrigin, options);
  const servers = stringList(resource?.authorization_servers);
  const named = servers?.[0];
  const issuer = named ?? target.origin;
  if (!isAllowedDiscoveryUrl(issuer, trustedOrigin)) return null;
  const metadata = await authorizationServer(issuer, trustedOrigin, options);
  if (!metadata) return null;

  const authorizationEndpoint = metadata.authorization_endpoint;
  const tokenEndpoint = metadata.token_endpoint;
  if (typeof authorizationEndpoint !== "string" || !isAllowedDiscoveryUrl(authorizationEndpoint, trustedOrigin)) return null;
  if (typeof tokenEndpoint !== "string" || !isAllowedDiscoveryUrl(tokenEndpoint, trustedOrigin)) return null;
  if (!stringList(metadata.code_challenge_methods_supported)?.includes("S256")) return null;

  // RFC 8414 §3.3: the metadata must be for the issuer it was fetched for.
  if (typeof metadata.issuer === "string" && metadata.issuer.replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")) return null;
  const optionalEndpoint = (value: unknown) => typeof value === "string" && isAllowedDiscoveryUrl(value, trustedOrigin) ? value : undefined;
  const registrationEndpoint = optionalEndpoint(metadata.registration_endpoint);
  const revocationEndpoint = optionalEndpoint(metadata.revocation_endpoint);
  const scopes = stringList(resource?.scopes_supported);
  const tokenEndpointAuthMethods = stringList(metadata.token_endpoint_auth_methods_supported);
  target.hash = "";
  return {
    // RFC 9207: compared with a callback's iss, which may differ from the listed issuer by a trailing slash (Google).
    issuer: typeof metadata.issuer === "string" ? metadata.issuer : issuer,
    authorizationEndpoint,
    tokenEndpoint,
    ...(registrationEndpoint ? { registrationEndpoint } : {}),
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
    ...(scopes?.length ? { scopes } : {}),
    ...(tokenEndpointAuthMethods?.length ? { tokenEndpointAuthMethods } : {}),
    resource: target.toString(),
    source: named === undefined ? "origin" : "protected-resource",
  };
}
