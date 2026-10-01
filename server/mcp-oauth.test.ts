import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpOAuthError, McpOAuthManager, type McpSignInStatus, withMcpSignIn, withoutPendingSignIn } from "./mcp-oauth.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "./testing/fake-http-mcp-server.ts";
import { startFakeOAuth, type FakeOAuth, type FakeOAuthOptions } from "./testing/fake-oauth-server.ts";

let dir: string;
let oauth: FakeOAuth;
let mcp: FakeHttpMcp;
let manager: McpOAuthManager;

async function setup(options: FakeOAuthOptions = {}, lifetimeMs?: number) {
  oauth = await startFakeOAuth(options);
  mcp = await startFakeHttpMcp({ acceptBearer: oauth.isValid, wwwAuthenticate: oauth.challenge });
  manager = new McpOAuthManager({ file: join(dir, "mcp-oauth.json"), ...(lifetimeMs ? { lifetimeMs } : {}) });
}

/** What the person's browser does: open the link, follow the approval
 * redirect back to the loopback callback. */
async function approve(status: McpSignInStatus) {
  return fetch(status.authorizationUrl!, { redirect: "follow" });
}

async function settled(name: string, flowId: string): Promise<McpSignInStatus> {
  for (let i = 0; i < 100; i++) {
    const status = manager.status(name, flowId);
    if (status && status.phase !== "waiting") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("sign-in never settled");
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mcp-oauth-")); });
afterEach(async () => {
  manager?.dispose();
  await mcp?.close();
  await oauth?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("McpOAuthManager sign-in", () => {
  it("signs in through the browser and returns a working token", async () => {
    await setup();
    expect(manager.authState("docs", mcp.url)).toBe("none");
    const started = await manager.start("docs", mcp.url);
    expect(started.phase).toBe("waiting");
    const link = new URL(started.authorizationUrl!);
    expect(link.origin + link.pathname).toBe(`${oauth.issuer}/authorize`);
    expect(link.searchParams.get("code_challenge_method")).toBe("S256");
    expect(link.searchParams.get("resource")).toBe(mcp.url);
    expect(link.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp-oauth\/callback$/);

    const page = await approve(started);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/Signed in/);
    expect((await settled("docs", started.flowId)).phase).toBe("succeeded");

    expect(manager.authState("docs", mcp.url)).toBe("signed-in");
    const token = await manager.accessToken("docs", mcp.url);
    expect(oauth.isValid(`Bearer ${token}`)).toBe(true);
  });

  it("reuses the waiting flow when sign-in is started twice", async () => {
    await setup();
    const [a, b] = await Promise.all([manager.start("docs", mcp.url), manager.start("docs", mcp.url)]);
    expect(a.flowId).toBe(b.flowId);
    expect(oauth.counts.register).toBe(1);
  });

  it("rejects a callback with the wrong state and keeps waiting", async () => {
    await setup();
    const started = await manager.start("docs", mcp.url);
    const redirect = new URL(new URL(started.authorizationUrl!).searchParams.get("redirect_uri")!);
    redirect.searchParams.set("state", "forged");
    redirect.searchParams.set("code", "stolen");
    const response = await fetch(redirect);
    expect(response.status).toBe(400);
    expect(manager.status("docs", started.flowId)?.phase).toBe("waiting");
  });

  it("expires a sign-in nobody finishes and closes its listener", async () => {
    await setup({}, 100);
    const started = await manager.start("docs", mcp.url);
    expect((await settled("docs", started.flowId)).phase).toBe("expired");
    await expect(approve(started)).rejects.toThrow();
  });

  it("reports a denied sign-in", async () => {
    await setup({ deny: true });
    const started = await manager.start("docs", mcp.url);
    await approve(started);
    const status = await settled("docs", started.flowId);
    expect(status.phase).toBe("failed");
    expect(status.message).toMatch(/not approved/);
    expect(manager.authState("docs", mcp.url)).toBe("none");
  });

  it("explains a server that offers no client registration", async () => {
    await setup({ noRegistration: true });
    await expect(manager.start("docs", mcp.url)).rejects.toMatchObject({ code: "no-registration" });
  });

  it("refuses a server that does not use OAuth", async () => {
    await setup();
    const open = await startFakeHttpMcp();
    try {
      const error = await manager.start("open", open.url).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(McpOAuthError);
      expect(error).toMatchObject({ code: "not-oauth" });
    } finally {
      await open.close();
    }
  });
});

describe("McpOAuthManager tokens", () => {
  async function signedIn(options: FakeOAuthOptions = {}) {
    await setup(options);
    const started = await manager.start("docs", mcp.url);
    await approve(started);
    await settled("docs", started.flowId);
  }

  it("refreshes a token about to expire, once for concurrent callers", async () => {
    await signedIn({ expiresIn: 60 });
    const [a, b] = await Promise.all([manager.accessToken("docs", mcp.url), manager.accessToken("docs", mcp.url)]);
    expect(oauth.counts.refresh).toBe(1);
    expect(a).toBe(b);
    expect(oauth.isValid(`Bearer ${a}`)).toBe(true);
  });

  it("does not refresh a token with time left", async () => {
    await signedIn({ expiresIn: 3600 });
    await manager.accessToken("docs", mcp.url);
    expect(oauth.counts.refresh).toBe(0);
  });

  it("marks the server as needing sign-in when refresh is refused", async () => {
    await signedIn({ expiresIn: 60, rejectRefresh: true });
    expect(await manager.accessToken("docs", mcp.url)).toBeNull();
    expect(manager.authState("docs", mcp.url)).toBe("needs-sign-in");
  });

  it("never hands a token to a different URL", async () => {
    await signedIn();
    expect(await manager.accessToken("docs", "https://elsewhere.example.com/mcp")).toBeNull();
    expect(manager.authState("docs", "https://elsewhere.example.com/mcp")).toBe("none");
  });

  it("signs out: revokes and forgets", async () => {
    await signedIn();
    await manager.signOut("docs", mcp.url);
    expect(oauth.counts.revoke).toBeGreaterThan(0);
    expect(manager.authState("docs", mcp.url)).toBe("none");
    expect(await manager.accessToken("docs", mcp.url)).toBeNull();
  });

  it("remembers a server that needs sign-in until it is forgotten", async () => {
    await setup();
    manager.markNeedsSignIn("docs", mcp.url);
    expect(manager.authState("docs", mcp.url)).toBe("needs-sign-in");
    manager.forget("docs");
    expect(manager.authState("docs", mcp.url)).toBe("none");
  });
});

describe("turn servers", () => {
  const stdio = { command: "npx", args: ["notes"], env: {} };

  it("leaves out a URL server that needs sign-in, keeps the rest", async () => {
    await setup();
    manager.markNeedsSignIn("docs", mcp.url);
    const servers = { docs: { type: "http" as const, url: mcp.url, headers: {} }, notes: stdio };
    expect(withoutPendingSignIn(servers, manager)).toEqual({ notes: stdio });
  });

  it("sends a signed-in server its bearer token in place of any Authorization header", async () => {
    await setup();
    const started = await manager.start("docs", mcp.url);
    await approve(started);
    await settled("docs", started.flowId);
    const servers = {
      docs: { type: "http" as const, url: mcp.url, headers: { authorization: "Bearer stale", "X-Org": "acme" } },
      plain: { type: "http" as const, url: "https://plain.example.com/mcp", headers: { Authorization: "Bearer mine" } },
      notes: stdio,
    };
    const out = await withMcpSignIn(servers, manager);
    const token = await manager.accessToken("docs", mcp.url);
    expect(out.docs).toEqual({ type: "http", url: mcp.url, headers: { "X-Org": "acme", Authorization: `Bearer ${token}` } });
    expect(out.plain).toEqual(servers.plain);
    expect(out.notes).toEqual(stdio);
    expect(servers.docs.headers.authorization).toBe("Bearer stale");
  });

  it("drops a signed-in server whose token cannot be refreshed", async () => {
    await setup({ expiresIn: 60, rejectRefresh: true });
    const started = await manager.start("docs", mcp.url);
    await approve(started);
    await settled("docs", started.flowId);
    const out = await withMcpSignIn({ docs: { type: "http" as const, url: mcp.url, headers: {} } }, manager);
    expect(out).toEqual({});
  });
});

describe("review fixes", () => {
  it("keeps no tokens when the server is removed while the code is being exchanged", async () => {
    await setup({ tokenDelayMs: 150 });
    const started = await manager.start("docs", mcp.url);
    const browser = approve(started);
    await new Promise((resolve) => setTimeout(resolve, 50));
    manager.forget("docs");
    await browser;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(manager.authState("docs", mcp.url)).toBe("none");
  });

  it("keeps no tokens when sign-in is cancelled while the code is being exchanged", async () => {
    await setup({ tokenDelayMs: 150 });
    const started = await manager.start("docs", mcp.url);
    const browser = approve(started);
    await new Promise((resolve) => setTimeout(resolve, 50));
    manager.cancel("docs");
    await browser;
    expect(manager.status("docs", started.flowId)?.phase).toBe("cancelled");
    expect(manager.authState("docs", mcp.url)).toBe("none");
  });

  it("does not expire a sign-in whose code is already being exchanged", async () => {
    await setup({ tokenDelayMs: 200 }, 100);
    const started = await manager.start("docs", mcp.url);
    await approve(started);
    expect((await settled("docs", started.flowId)).phase).toBe("succeeded");
    expect(manager.authState("docs", mcp.url)).toBe("signed-in");
  });

  it("stays signed in when a refresh fails for a reason other than a dead grant", async () => {
    await setup({ expiresIn: 60, refreshStatus: 429 });
    const started = await manager.start("docs", mcp.url);
    await approve(started);
    await settled("docs", started.flowId);
    const token = await manager.accessToken("docs", mcp.url);
    expect(oauth.isValid(`Bearer ${token}`)).toBe(true);
    expect(manager.authState("docs", mcp.url)).toBe("signed-in");
  });

  it("registers a fresh client for every sign-in", async () => {
    await setup();
    for (let i = 0; i < 2; i++) {
      const started = await manager.start("docs", mcp.url);
      await approve(started);
      await settled("docs", started.flowId);
    }
    expect(oauth.counts.register).toBe(2);
  });

  it("refuses metadata that claims another issuer", async () => {
    await setup({ claimIssuer: "https://someone-else.example.com" });
    await expect(manager.start("docs", mcp.url)).rejects.toMatchObject({ code: "not-oauth" });
  });
});
