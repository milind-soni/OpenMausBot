import { describe, expect, it } from "vitest";

import { discoverMcpAuth, isAllowedAuthUrl, isAllowedDiscoveryUrl, resourceMetadataUrl } from "./mcp-oauth-discovery.ts";

const AS = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  registration_endpoint: "https://auth.example.com/register",
  revocation_endpoint: "https://auth.example.com/revoke",
  code_challenge_methods_supported: ["S256"],
};

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
      source: "protected-resource",
    });
  });

  it("falls back to the well-known protected-resource path, then the origin", async () => {
    const { impl, asked } = stubFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource": { authorization_servers: ["https://auth.example.com"] },
      "https://auth.example.com/.well-known/oauth-authorization-server": AS,
    });
    const meta = await discoverMcpAuth("https://mcp.example.com/mcp", null, { fetch: impl });
    expect(meta?.issuer).toBe("https://auth.example.com");
    expect(meta?.source).toBe("protected-resource");
    expect(asked[0]).toBe("https://mcp.example.com/.well-known/oauth-protected-resource/mcp");
  });

  it.each([
    ["the path-specific address", "https://mcp.example.com/.well-known/oauth-protected-resource/mcp"],
    ["the root address", "https://mcp.example.com/.well-known/oauth-protected-resource"],
  ])("reports a protected-resource source when %s names the authorization server", async (_label, address) => {
    const { impl } = stubFetch({
      [address]: { authorization_servers: ["https://auth.example.com"] },
      "https://auth.example.com/.well-known/oauth-authorization-server": AS,
    });
    expect((await discoverMcpAuth("https://mcp.example.com/mcp", null, { fetch: impl }))?.source).toBe("protected-resource");
  });

  it("treats the MCP origin as the authorization server when there is no resource metadata", async () => {
    const { impl } = stubFetch({
      "https://mcp.example.com/.well-known/openid-configuration": { ...AS, issuer: "https://mcp.example.com" },
    });
    const meta = await discoverMcpAuth("https://mcp.example.com/mcp", null, { fetch: impl });
    expect(meta?.issuer).toBe("https://mcp.example.com");
    expect(meta?.source).toBe("origin");
  });

  it("reports an origin source when the resource document names no authorization server", async () => {
    const { impl } = stubFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": { resource: "https://mcp.example.com/mcp" },
      "https://mcp.example.com/.well-known/openid-configuration": { ...AS, issuer: "https://mcp.example.com" },
    });
    const meta = await discoverMcpAuth("https://mcp.example.com/mcp", null, { fetch: impl });
    expect(meta?.issuer).toBe("https://mcp.example.com");
    expect(meta?.source).toBe("origin");
  });

  it("keeps the issuer from the authorization server metadata, not the listed spelling", async () => {
    const { impl } = stubFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource": { authorization_servers: ["https://auth.example.com/"] },
      "https://auth.example.com/.well-known/oauth-authorization-server": AS,
    });
    const meta = await discoverMcpAuth("https://mcp.example.com/mcp", null, { fetch: impl });
    expect(meta?.issuer).toBe("https://auth.example.com");
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

  it("stops reading a metadata document past the cap", async () => {
    const impl = (async () => new Response("x".repeat(70_000), { status: 200 })) as typeof fetch;
    expect(await discoverMcpAuth("https://mcp.example.com/mcp", null, { fetch: impl })).toBeNull();
  });

  it.each([
    "http://127.0.0.1:8799/api/health",
    "http://localhost:5000/prm",
    "http://[::1]:5000/prm",
    "https://10.0.0.5/prm",
    "https://169.254.169.254/latest/meta-data",
    "https://[fd00:ec2::254]/prm",
    "https://metadata.google.internal/prm",
  ])("never follows a remote metadata hint to %s", async (hint) => {
    const { impl, asked } = stubFetch({});
    const meta = await discoverMcpAuth("https://mcp.example.com/mcp", `Bearer resource_metadata="${hint}"`, { fetch: impl });
    expect(meta).toBeNull();
    expect(asked).not.toContain(hint);
  });

  it("refuses an authorization server on this machine named by a public MCP server", async () => {
    const { impl, asked } = stubFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource": { authorization_servers: ["http://127.0.0.1:8799"] },
    });
    expect(await discoverMcpAuth("https://mcp.example.com/mcp", null, { fetch: impl })).toBeNull();
    expect(asked.some((url) => url.startsWith("http://127.0.0.1:8799"))).toBe(false);
  });

  it("refuses private endpoints named by a public authorization server", async () => {
    const { impl } = stubFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource": { authorization_servers: ["https://auth.example.com"] },
      "https://auth.example.com/.well-known/oauth-authorization-server": { ...AS, token_endpoint: "https://127.0.0.1:9000/token" },
    });
    expect(await discoverMcpAuth("https://mcp.example.com/mcp", null, { fetch: impl })).toBeNull();
  });

  it("still discovers a loopback MCP server's own endpoints", async () => {
    const local = { ...AS, issuer: "http://127.0.0.1:5000", authorization_endpoint: "http://127.0.0.1:5000/authorize", token_endpoint: "http://127.0.0.1:5000/token" };
    const { impl } = stubFetch({
      "http://127.0.0.1:5000/.well-known/oauth-protected-resource": { authorization_servers: ["http://127.0.0.1:5000"] },
      "http://127.0.0.1:5000/.well-known/oauth-authorization-server": local,
    });
    const meta = await discoverMcpAuth("http://127.0.0.1:5000/mcp", null, { fetch: impl });
    expect(meta?.tokenEndpoint).toBe("http://127.0.0.1:5000/token");
  });
});

describe("isAllowedDiscoveryUrl", () => {
  it("trusts a local MCP server with this machine's other ports, and a remote one with public HTTPS only", () => {
    expect(isAllowedDiscoveryUrl("http://127.0.0.1:5000/prm", "http://127.0.0.1:5000")).toBe(true);
    expect(isAllowedDiscoveryUrl("http://127.0.0.1:9000/prm", "http://127.0.0.1:5000")).toBe(true);
    expect(isAllowedDiscoveryUrl("https://10.0.0.5/prm", "https://10.0.0.5")).toBe(true);
    expect(isAllowedDiscoveryUrl("http://127.0.0.1:5000/prm", "https://mcp.example.com")).toBe(false);
    expect(isAllowedDiscoveryUrl("https://10.0.0.5/prm", "https://mcp.example.com")).toBe(false);
    expect(isAllowedDiscoveryUrl("https://169.254.169.254/prm", "https://mcp.example.com")).toBe(false);
    expect(isAllowedDiscoveryUrl("https://localhost/prm", "https://mcp.example.com")).toBe(false);
    expect(isAllowedDiscoveryUrl("https://auth.example.com/prm", "https://mcp.example.com")).toBe(true);
    expect(isAllowedDiscoveryUrl("https://user:pw@auth.example.com/prm", "https://mcp.example.com")).toBe(false);
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
