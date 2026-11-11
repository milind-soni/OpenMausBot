// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { exchangeMcpToken, issueMcpCode, OAuthError, parseScope, redirectMatches, registerMcpClient, RegistrationLimited, resolveMcpToken, revokeMcpToken, validateMcpAuthorization, validRedirect } from "./mcp-oauth";
import { clientAddress } from "./client-address";
import { convexStore, revokedConnectors, seedWorkspace, signedBridge, type Backend } from "../testing/convex-store";

const backend = vi.hoisted(() => ({ current: null as Backend | null }));
vi.mock("./integration-bridge", async importOriginal => ({
  ...await importOriginal<typeof import("./integration-bridge")>(),
  integrationBridge: (operation: string, args: unknown) => signedBridge(backend.current!, operation, args),
}));

test("redirect URIs: HTTPS or loopback only", () => {
  for (const uri of ["https://chatgpt.com/connector_platform_oauth_redirect", "https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1:33418/callback", "http://localhost:3000/callback", "http://[::1]:9/cb"]) expect(validRedirect(uri)).toBe(true);
  for (const uri of ["http://example.com/cb", "https://example.com/cb#x", "https://user:pw@example.com/cb", "cursor://callback", "not a url"]) expect(validRedirect(uri)).toBe(false);
});

test("loopback redirects match on any port, everything else exactly", () => {
  expect(redirectMatches("http://127.0.0.1/callback", "http://127.0.0.1:51234/callback")).toBe(true);
  expect(redirectMatches("http://localhost:3000/callback", "http://localhost:4111/callback")).toBe(true);
  expect(redirectMatches("http://localhost:3000/callback", "http://127.0.0.1:3000/callback")).toBe(false);
  expect(redirectMatches("http://127.0.0.1/callback", "http://127.0.0.1:5/other")).toBe(false);
  expect(redirectMatches("https://app.example/cb", "https://app.example:8443/cb")).toBe(false);
  expect(redirectMatches("https://app.example/cb", "https://app.example/cb")).toBe(true);
});

test("scopes default to read and write and always include read", () => {
  expect(parseScope(null)).toBe("origin:read origin:write");
  expect(parseScope("origin:write")).toBe("origin:read origin:write");
  expect(parseScope("origin:read")).toBe("origin:read");
  expect(() => parseScope("admin")).toThrow();
});

// Stateful flows against a Convex test backend, through the signed bridge.

describe("OAuth flows", () => {
  const redirect = "http://127.0.0.1:9/callback";
  const connectors = ["origin_oauth_replayed", "origin_oauth_pkce", "origin_oauth_expired", "origin_oauth_reused", "origin_oauth_scoped", "origin_oauth_revoked", "origin_oauth_used"];
  beforeEach(async () => {
    vi.useRealTimers();
    vi.stubEnv("ORIGIN_PUBLIC_URL", "http://origin.test");
    backend.current = convexStore();
    await seedWorkspace(backend.current, connectors);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
  const register = (name = "Agent", limit = { key: `register:${name}`, maximum: 10 }) => registerMcpClient({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none" }, limit);
  async function authorize(clientId: string, connectorToken: string, write = true, scope = "origin:read origin:write") {
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", scope });
    const url = new URL(await issueMcpCode(await validateMcpAuthorization(params), connectorToken, Date.now() + 86400000, write));
    return { verifier, code: url.searchParams.get("code")! };
  }
  const exchange = (clientId: string, code: string, verifier: string) => exchangeMcpToken(new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect }));
  const refresh = (clientId: string, token: string, scope?: string) => exchangeMcpToken(new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: token, ...(scope ? { scope } : {}) }));
  const oauthError = async (run: () => Promise<unknown>) => { try { await run(); } catch (error) { return error instanceof OAuthError ? error.code : String(error); } return "no error"; };
  const maintain = async (advanceMs: number) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + advanceMs);
    await backend.current!.run(async ctx => { await ctx.runMutation((await import("../convex/_generated/api")).internal.mcpOAuth.maintain, {}); });
    vi.useRealTimers();
  };

  test("identical registrations reuse the client; only new clients count against the limit", async () => {
    const limit = { key: "register-bucket", maximum: 1 };
    const first = await register("Agent", limit);
    const again = await register("Agent", limit);
    expect(again.client_id).toBe(first.client_id);
    await expect(register("Other", limit)).rejects.toBeInstanceOf(RegistrationLimited);
  });

  test("clients without a grant are deleted after a day", async () => {
    const unused = (await register("Unused")).client_id;
    const used = (await register("Used")).client_id;
    await authorize(used, "origin_oauth_used");
    await maintain(86400000 + 60000);
    const ids = await backend.current!.run(async ctx => (await ctx.db.query("mcpOAuthClients").take(10)).map(row => row.clientId));
    expect(ids).not.toContain(unused);
  });

  test("code exchange, then a replayed code revokes the tokens issued from it and the Convex grant", async () => {
    const client = (await register()).client_id;
    const { code, verifier } = await authorize(client, "origin_oauth_replayed");
    const tokens = await exchange(client, code, verifier);
    expect((await resolveMcpToken(tokens.access_token)).connectorToken).toBe("origin_oauth_replayed");
    expect(await oauthError(() => exchange(client, code, verifier))).toBe("invalid_grant");
    await expect(resolveMcpToken(tokens.access_token)).rejects.toThrow();
    expect(await revokedConnectors(backend.current!, connectors)).toEqual(["origin_oauth_replayed"]);
  });

  test("a failed PKCE check, an expired code and a reused refresh token all revoke in Convex", async () => {
    const client = (await register()).client_id;
    const pkce = await authorize(client, "origin_oauth_pkce");
    expect(await oauthError(() => exchange(client, pkce.code, randomBytes(32).toString("base64url")))).toBe("invalid_grant");

    await authorize(client, "origin_oauth_expired");
    await maintain(6 * 60000);

    const fresh = await authorize(client, "origin_oauth_reused");
    const tokens = await exchange(client, fresh.code, fresh.verifier);
    await refresh(client, tokens.refresh_token);
    expect(await oauthError(() => refresh(client, tokens.refresh_token))).toBe("invalid_grant");
    expect(await revokedConnectors(backend.current!, connectors)).toEqual(["origin_oauth_expired", "origin_oauth_pkce", "origin_oauth_reused"]);
  });

  test("refresh with a narrower scope issues and enforces it", async () => {
    const client = (await register()).client_id;
    const { code, verifier } = await authorize(client, "origin_oauth_scoped");
    const tokens = await exchange(client, code, verifier);
    expect((await resolveMcpToken(tokens.access_token)).write).toBe(true);
    const narrow = await refresh(client, tokens.refresh_token, "origin:read");
    expect(narrow.scope).toBe("origin:read");
    expect((await resolveMcpToken(narrow.access_token)).write).toBe(false);
    // Narrowed tokens cannot widen again.
    expect(await oauthError(() => refresh(client, narrow.refresh_token, "origin:read origin:write"))).toBe("invalid_scope");
    expect((await refresh(client, narrow.refresh_token)).scope).toBe("origin:read");
  });

  test("revoking a token revokes its grant and the Convex connector grant at once", async () => {
    const client = (await register()).client_id;
    const { code, verifier } = await authorize(client, "origin_oauth_revoked");
    const tokens = await exchange(client, code, verifier);
    expect(await revokeMcpToken(tokens.refresh_token, "someone-else")).toBe(false);
    expect(await revokeMcpToken(tokens.refresh_token, client)).toBe(true);
    await expect(resolveMcpToken(tokens.access_token)).rejects.toThrow();
    expect(await revokedConnectors(backend.current!, connectors)).toEqual(["origin_oauth_revoked"]);
  });

  test("Convex stores only hashes of codes and tokens, and the connector token sealed", async () => {
    const client = (await register()).client_id;
    const { code, verifier } = await authorize(client, "origin_oauth_scoped");
    const tokens = await exchange(client, code, verifier);
    const dump = await backend.current!.run(async ctx => JSON.stringify([
      await ctx.db.query("mcpOAuthGrants").take(10), await ctx.db.query("mcpOAuthCodes").take(10), await ctx.db.query("mcpOAuthTokens").take(10),
    ]));
    for (const secret of [code, verifier, tokens.access_token, tokens.refresh_token, "origin_oauth_scoped"]) expect(dump).not.toContain(secret);
  });
});

test("forwarded addresses are trusted only with ORIGIN_TRUSTED_PROXY", () => {
  const request = new Request("http://origin.test", { headers: { "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1, 203.0.113.9" } });
  const forwarded = new Request("http://origin.test", { headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.9" } });
  vi.stubEnv("ORIGIN_TRUSTED_PROXY", "");
  expect(clientAddress(request)).toBeNull();
  vi.stubEnv("ORIGIN_TRUSTED_PROXY", "1");
  expect(clientAddress(request)).toBe("203.0.113.7");
  expect(clientAddress(forwarded)).toBe("203.0.113.9");
  vi.unstubAllEnvs();
});
