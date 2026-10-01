import { describe, expect, it } from "vitest";

import { discoverMcpAuth, isAllowedAuthUrl, resourceMetadataUrl } from "./mcp-oauth-discovery.ts";

const AS = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  registration_endpoint: "https://auth.example.com/register",
  revocation_endpoint: "https://auth.example.com/revoke",
  code_challenge_methods_supported: ["S256"],
};

/** A fetch that answers JSON for known URLs and 404 for everything else,
 * and records what was asked. */
function stubFetch(routes: Record<string, unknown>) {
  const asked: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    if (!(url in routes)) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[url]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, asked };
}

describe("resourceMetadataUrl", () => {
  it("reads resource_metadata from a Bearer challenge", () => {
    expect(resourceMetadataUrl('Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"'))
      .toBe("https://mcp.example.com/.well-known/oauth-protected-resource");
  });
  it("returns null without the parameter", () => {
    expect(resourceMetadataUrl('Bearer realm="x"')).toBeNull();
    expect(resourceMetadataUrl(null)).toBeNull();
  });
});

describe("discoverMcpAuth", () => {
  it("follows the header hint to the authorization server", async () => {
    const { impl } = stubFetch({
      "https://mcp.example.com/prm": { resource: "https://mcp.example.com/mcp", authorization_servers: ["https://auth.example.com"], scopes_supported: ["read", "write"] },
      "https://auth.example.com/.well-known/oauth-authorization-server": AS,
    });
    const meta = await discoverMcpAuth("https://mcp.example.com/mcp", 'Bearer resource_metadata="https://mcp.example.com/prm"', { fetch: impl });
    expect(meta).toEqual({
      issuer: "https://auth.example.com",
      authorizationEndpoint: "https://auth.example.com/authorize",
      tokenEndpoint: "https://auth.example.com/token",
      registrationEndpoint: "https://auth.example.com/register",
      revocationEndpoint: "https://auth.example.com/revoke",
      scopes: ["read", "write"],
      resource: "https://mcp.example.com/mcp",
    });
  });

  it("falls back to the well-known protected-resource path, then the origin", async () => {
    const { impl, asked } = stubFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource": { authorization_servers: ["https://auth.example.com"] },
      "https://auth.example.com/.well-known/oauth-authorization-server": AS,
    });
    const meta = await discoverMcpAuth("https://mcp.example.com/mcp", null, { fetch: impl });
    expect(meta?.issuer).toBe("https://auth.example.com");
    expect(asked[0]).toBe("https://mcp.example.com/.well-known/oauth-protected-resource/mcp");
  });

  it("treats the MCP origin as the authorization server when there is no resource metadata", async () => {
    const { impl } = stubFetch({
      "https://mcp.example.com/.well-known/openid-configuration": { ...AS, issuer: "https://mcp.example.com" },
    });
    const meta = await discoverMcpAuth("https://mcp.example.com/mcp", null, { fetch: impl });
    expect(meta?.issuer).toBe("https://mcp.example.com");
  });

  it("refuses an authorization server without PKCE S256", async () => {
    const { impl } = stubFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource": { authorization_servers: ["https://auth.example.com"] },
      "https://auth.example.com/.well-known/oauth-authorization-server": { ...AS, code_challenge_methods_supported: ["plain"] },
    });
    expect(await discoverMcpAuth("https://mcp.example.com/mcp", null, { fetch: impl })).toBeNull();
  });

  it("refuses plain-http endpoints on a non-loopback host", async () => {
    const { impl } = stubFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource": { authorization_servers: ["http://auth.example.com"] },
    });
    expect(await discoverMcpAuth("https://mcp.example.com/mcp", null, { fetch: impl })).toBeNull();
  });

  it("returns null when nothing answers", async () => {
    const { impl } = stubFetch({});
    expect(await discoverMcpAuth("https://mcp.example.com/mcp", null, { fetch: impl })).toBeNull();
  });
});

describe("isAllowedAuthUrl", () => {
  it("allows https anywhere and http only on loopback", () => {
    expect(isAllowedAuthUrl("https://auth.example.com/x")).toBe(true);
    expect(isAllowedAuthUrl("http://127.0.0.1:5000/x")).toBe(true);
    expect(isAllowedAuthUrl("http://localhost:5000/x")).toBe(true);
    expect(isAllowedAuthUrl("http://auth.example.com/x")).toBe(false);
    expect(isAllowedAuthUrl("https://user:pw@auth.example.com/x")).toBe(false);
    expect(isAllowedAuthUrl("javascript:alert(1)")).toBe(false);
  });
});
