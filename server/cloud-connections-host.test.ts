import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCloudConnectionsHost } from "./cloud-connections-host.ts";
import { signInDigest } from "./cloud-connections.ts";
import type { AppConfig } from "./config.ts";
import { createHighLevelService } from "./highlevel/service.ts";
import type { HighLevelConnection } from "./highlevel/store.ts";
import { McpOAuthManager } from "./mcp-oauth.ts";
import type { McpOAuthRecord } from "./mcp-oauth-store.ts";
import { PASS } from "./routes/table.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "omb-connections-host-")); dirs.push(dir); return dir; };

const LINEAR = "https://mcp.linear.app/sse";
const signIn = (access: string, refresh: string): McpOAuthRecord => ({ url: LINEAR, state: "signed-in", clientId: "client", tokenEndpoint: "https://linear.app/token", tokens: { access, refresh, expiresAt: 10 } });
const HIGHLEVEL: HighLevelConnection = { kind: "oauth", accessToken: "hl-access", refreshToken: "hl-refresh", expiresAt: 5, locationId: "loc_1", scopes: "", connectedAt: 1, state: "signed-in" };

function host(cloudHome: boolean) {
  const dir = temp();
  const config = { mcpServers: { linear: { type: "http", url: LINEAR, headers: {}, enabled: true }, dodo: { command: "npx", args: ["dodo"], env: {}, enabled: true } } } as unknown as AppConfig;
  const mcpOAuth = new McpOAuthManager({ file: join(dir, "mcp-oauth.json") });
  const highlevel = createHighLevelService({ dataDir: dir, env: {} });
  const connections = createCloudConnectionsHost({ cloudHome: cloudHome ? { publicOrigin: "https://omb-u-1.fly.dev" } : null, config: () => config,
    environmentId: "env-desktop-1", mcpOAuth, highlevel, engines: async () => ["claude", "openrouter"] });
  async function call(method: string, path: string, body?: unknown, type = "application/json") {
    let status = 0, answered: unknown = null;
    const url = new URL(`https://cloud.test${path}`);
    const out = await connections.routes({
      req: { headers: { "content-type": type } } as never, res: { setHeader() {} } as never, url, path: url.pathname, method, auth: { scopes: ["admin"] } as never,
      json: ((_res: unknown, code: number, value: unknown) => { status = code; answered = value; }) as never,
      readBody: (async () => body) as never,
    });
    return { out, status, body: answered as Record<string, any> };
  }
  return { connections, mcpOAuth, highlevel, call };
}

describe("a move's routes and private port", () => {
  it("names this server's connections, the computer it is, the engines it runs and the programs it has; never a secret", async () => {
    const { call } = host(false);
    const listed = await call("GET", "/api/cloud-connections");
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ computer: { environmentId: "env-desktop-1", label: expect.any(String) }, engines: ["claude", "openrouter"], commands: expect.any(Array),
      connections: [{ id: "mcp:linear", kind: "mcp" }, { id: "mcp:dodo", kind: "mcp", launcher: "npx" }] });
    // Only a Cloud home takes connections.
    expect((await call("PUT", "/api/cloud-connections/mcp/linear/sign-in", signIn("a", "r"))).status).toBe(404);
    expect((await call("GET", "/api/cloud-send")).out).toBe(PASS);
  });

  it("takes a moved sign-in for a server here at the same address, keeps one of its own, and lets a newer one replace only the one moved here", async () => {
    const { call, mcpOAuth } = host(true);
    const route = "/api/cloud-connections/mcp/linear/sign-in";
    expect(await call("PUT", "/api/cloud-connections/mcp/notes/sign-in", signIn("a", "r"))).toMatchObject({ status: 404, body: { error: "This MCP server is not here yet." } });
    expect(await call("PUT", "/api/cloud-connections/mcp/dodo/sign-in", { ...signIn("a", "r") })).toMatchObject({ status: 404 });
    expect(await call("PUT", route, { ...signIn("a", "r"), url: "https://elsewhere.example/sse" })).toMatchObject({ status: 409, body: { error: "This MCP server has another address here." } });
    expect((await call("PUT", route, { url: LINEAR })).status).toBe(400);
    expect((await call("PUT", route, signIn("a", "r"), "text/plain")).status).toBe(415);
    expect((await call("POST", route, signIn("a", "r"))).status).toBe(405);

    expect(await call("PUT", route, signIn("a1", "r1"))).toMatchObject({ status: 200, body: { adopted: true } });
    expect(mcpOAuth.authState("linear", LINEAR)).toBe("signed-in");
    expect(mcpOAuth.signInRecord("linear", LINEAR)?.tokens?.refresh).toBe("r1");
    // Signed in here already: kept, unless it is the very one a move put here.
    expect(await call("PUT", route, signIn("a2", "r2"))).toMatchObject({ status: 200, body: { kept: true } });
    expect(await call("PUT", `${route}?replaces=${"0".repeat(64)}`, signIn("a2", "r2"))).toMatchObject({ status: 200, body: { kept: true } });
    expect((await call("PUT", `${route}?replaces=nope`, signIn("a2", "r2"))).status).toBe(400);
    expect(await call("PUT", `${route}?replaces=${signInDigest({ access: "a1", refresh: "r1", expiresAt: 10 })}`, signIn("a2", "r2"))).toMatchObject({ status: 200, body: { adopted: true } });
    expect(mcpOAuth.signInRecord("linear", LINEAR)?.tokens?.refresh).toBe("r2");
  });

  it("takes a moved HighLevel connection, keeping one signed in here", async () => {
    const { call, highlevel } = host(true);
    expect((await call("PUT", "/api/cloud-connections/highlevel", { kind: "oauth" })).status).toBe(400);
    expect(await call("PUT", "/api/cloud-connections/highlevel", HIGHLEVEL)).toMatchObject({ status: 200, body: { adopted: true } });
    expect(highlevel.status()).toMatchObject({ state: "connected", kind: "oauth", location: { id: "loc_1" } });
    expect(await call("PUT", "/api/cloud-connections/highlevel", { ...HIGHLEVEL, accessToken: "other", locationId: "loc_2" })).toMatchObject({ status: 200, body: { kept: true } });
    expect(highlevel.store.get()?.locationId).toBe("loc_1");
  });

  it("hands over a sign-in over the private port, then forgets it here without signing it out", async () => {
    const { connections, mcpOAuth } = host(false);
    mcpOAuth.adopt("linear", LINEAR, signIn("a1", "r1"));
    const answer = await connections.handoff({ kind: "connection", id: "mcp:linear" });
    expect(answer).toMatchObject({ ok: true, connection: { mcp: { name: "linear", signIn: { tokens: { refresh: "r1" } } } }, digest: signInDigest({ access: "a1", refresh: "r1", expiresAt: 10 }) });
    const digest = (answer as { digest: string }).digest;
    expect(await connections.handoff({ kind: "connection-release", id: "mcp:linear", digest: "0".repeat(64) })).toEqual({ ok: true, release: { changed: true } });
    expect(mcpOAuth.authState("linear", LINEAR)).toBe("signed-in");
    expect(await connections.handoff({ kind: "connection-release", id: "mcp:linear", digest })).toEqual({ ok: true, release: { released: true } });
    expect(mcpOAuth.authState("linear", LINEAR)).toBe("none");
  });

  it("tells a bot on My Cloud, and only there", () => {
    const desktop = host(false), cloud = host(true);
    cloud.mcpOAuth.markNeedsSignIn("linear", LINEAR);
    desktop.mcpOAuth.markNeedsSignIn("linear", LINEAR);
    expect(cloud.connections.prompt({})).toContain("linear (sign in here: https://omb-u-1.fly.dev/?connect=mcp%3Alinear)");
    expect(desktop.connections.prompt({})).toBe("");
  });
});
