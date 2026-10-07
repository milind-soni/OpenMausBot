import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpOAuthError, McpOAuthManager, mcpOAuthRedirectUri, type McpSignInStatus, withMcpSignIn, withoutPendingSignIn } from "./mcp-oauth.ts";
import type { McpOAuthClientConfig } from "./mcp-registry.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "./testing/fake-http-mcp-server.ts";
import { startFakeOAuth, type FakeOAuth, type FakeOAuthOptions } from "./testing/fake-oauth-server.ts";
import { withFreeSignInPort } from "./testing/ports.ts";

let dir: string;
let oauth: FakeOAuth;
let mcp: FakeHttpMcp;
let manager: McpOAuthManager;
/** the sign-in app config.json would hold for "docs" */
let registered: McpOAuthClientConfig | undefined;

async function setup(options: FakeOAuthOptions = {}, lifetimeMs?: number) {
  oauth = await startFakeOAuth(options);
  mcp = await startFakeHttpMcp({ acceptBearer: oauth.isValid, wwwAuthenticate: oauth.challenge });
  // a pre-registered app returns to the port derived from the URL: make it a free one
  if (options.preRegistered) mcp = { ...mcp, url: await withFreeSignInPort(mcp.url) };
  manager = new McpOAuthManager({
    file: join(dir, "mcp-oauth.json"),
    ...(lifetimeMs ? { lifetimeMs } : {}),
    clients: (name, url) => (name === "docs" && url === mcp.url ? registered : undefined),
  });
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-oauth-"));
  registered = undefined;
});
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

describe("a sign-in app registered in advance", () => {
  async function signIn(): Promise<McpSignInStatus> {
    const started = await manager.start("docs", mcp.url);
    await approve(started);
    return settled("docs", started.flowId);
  }

  it("signs in as a public app on a server without registration, with its own scopes", async () => {
    await setup({ noRegistration: true, preRegistered: { "entra-app": null } });
    registered = { clientId: "entra-app", scopes: ["api://mcp/read", "offline_access"] };
    const started = await manager.start("docs", mcp.url);
    const link = new URL(started.authorizationUrl!);
    expect(link.searchParams.get("client_id")).toBe("entra-app");
    expect(link.searchParams.get("scope")).toBe("api://mcp/read offline_access");
    expect(link.searchParams.get("redirect_uri")).toBe(mcpOAuthRedirectUri(mcp.url));
    await approve(started);
    expect((await settled("docs", started.flowId)).phase).toBe("succeeded");
    expect(oauth.counts.register).toBe(0);
    expect(oauth.clientAuths).toEqual([{ method: "none", clientId: "entra-app" }]);
    expect(oauth.isValid(`Bearer ${await manager.accessToken("docs", mcp.url)}`)).toBe(true);
  });

  it("uses the app in place of registration even when the server offers it", async () => {
    await setup({ preRegistered: { mine: null } });
    registered = { clientId: "mine" };
    expect((await signIn()).phase).toBe("succeeded");
    expect(oauth.counts.register).toBe(0);
    // no scopes of its own: the server's advertised ones
    expect(oauth.lastAuthorize?.get("scope")).toBe("mcp");
  });

  it("proves a secret with HTTP Basic by default, on sign-in, refresh and sign-out, and never stores it", async () => {
    const secret = "s3cret:with/odd+chars";
    await setup({ noRegistration: true, expiresIn: 60, preRegistered: { corp: secret } });
    registered = { clientId: "corp", clientSecret: secret };
    expect((await signIn()).phase).toBe("succeeded");
    const token = await manager.accessToken("docs", mcp.url);
    expect(oauth.counts.refresh).toBe(1);
    expect(oauth.isValid(`Bearer ${token}`)).toBe(true);
    await manager.signOut("docs", mcp.url);
    expect(oauth.counts.revoke).toBe(1);
    expect(oauth.clientAuths).toEqual([
      { method: "basic", clientId: "corp" },
      { method: "basic", clientId: "corp" },
      { method: "basic", clientId: "corp" },
    ]);
    expect(oauth.lastAuthorize?.has("client_secret")).toBe(false);
  });

  it("sends the secret in the form when the server only takes that", async () => {
    const secret = "app-secret-never-stored";
    await setup({ noRegistration: true, preRegistered: { corp: secret }, tokenAuthMethods: ["client_secret_post"] });
    registered = { clientId: "corp", clientSecret: secret };
    expect((await signIn()).phase).toBe("succeeded");
    expect(oauth.clientAuths).toEqual([{ method: "post", clientId: "corp" }]);
    const stored = readFileSync(join(dir, "mcp-oauth.json"), "utf8");
    expect(stored).not.toContain(secret);
    expect(JSON.parse(stored).servers.docs).toMatchObject({ clientId: "corp", tokenAuth: "client_secret_post" });
  });

  it("reports a refused secret as a failed sign-in", async () => {
    await setup({ noRegistration: true, preRegistered: { corp: "right" } });
    registered = { clientId: "corp", clientSecret: "wrong" };
    const status = await signIn();
    expect(status.phase).toBe("failed");
    expect(manager.authState("docs", mcp.url)).toBe("none");
  });

  it("does not refresh with a secret once the app is no longer configured", async () => {
    await setup({ noRegistration: true, expiresIn: 60, preRegistered: { corp: "pw" } });
    registered = { clientId: "corp", clientSecret: "pw" };
    await signIn();
    registered = { clientId: "another-app", clientSecret: "pw" };
    // still valid for a minute: kept, but nothing is sent on another app's behalf
    expect(oauth.isValid(`Bearer ${await manager.accessToken("docs", mcp.url)}`)).toBe(true);
    expect(oauth.counts.refresh).toBe(0);
  });

  it("explains a busy redirect port instead of moving to another one", async () => {
    await setup({ noRegistration: true, preRegistered: { corp: null } });
    registered = { clientId: "corp" };
    const blocker = createServer();
    const port = Number(new URL(mcpOAuthRedirectUri(mcp.url)).port);
    await new Promise<void>((resolve) => {
      blocker.once("error", () => resolve());
      blocker.listen(port, "127.0.0.1", resolve);
    });
    try {
      await expect(manager.start("docs", mcp.url)).rejects.toMatchObject({ code: "port-busy" });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe("MCP sign-in from another computer", () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }
  async function redirect(status: McpSignInStatus): Promise<string> {
    const response = await fetch(status.authorizationUrl!, { redirect: "manual" });
    return response.headers.get("location")!;
  }

  it.each(["none", "basic", "post"] as const)("completes a pre-registered %s app remotely and retains its refresh authentication", async (method) => {
    const secret = method === "none" ? undefined : "private-client-secret";
    await setup({
      noRegistration: true, expiresIn: 60, preRegistered: { corp: secret ?? null },
      ...(method === "post" ? { tokenAuthMethods: ["client_secret_post"] } : {}),
    });
    registered = { clientId: "corp", scopes: ["mcp", "offline_access"], ...(secret ? { clientSecret: secret } : {}) };
    const started = await manager.start("docs", mcp.url, undefined, "alice");
    const callback = await redirect(started);
    await expect(manager.completeCallback("docs", started.flowId, callback, "bob")).rejects.toMatchObject({ status: 404 });
    expect((await manager.completeCallback("docs", started.flowId, callback, "alice")).phase).toBe("succeeded");
    expect(oauth.counts.register).toBe(0);
    expect(oauth.isValid(`Bearer ${await manager.accessToken("docs", mcp.url)}`)).toBe(true);
    expect(oauth.counts.refresh).toBe(1);
    await manager.signOut("docs", mcp.url);
    expect(oauth.clientAuths).toEqual(Array.from({ length: 3 }, () => ({ method, clientId: "corp" })));
    expect(oauth.counts.revoke).toBe(1);
  });

  it("completes a pasted redirect with PKCE, without visiting the loopback listener", async () => {
    await setup();
    const started = await manager.start("docs", mcp.url, undefined, "alice");
    const callback = await redirect(started);
    const result = await manager.completeCallback("docs", started.flowId, callback, "alice");
    expect(result).toMatchObject({ phase: "succeeded", authorizationUrl: null });
    expect(oauth.isValid(`Bearer ${await manager.accessToken("docs", mcp.url)}`)).toBe(true);
    await expect(manager.completeCallback("docs", started.flowId, callback, "alice")).rejects.toMatchObject({ status: 409 });
    expect(oauth.counts.token).toBe(1);
  });

  it("isolates starts, status, cancellation and completion by owner", async () => {
    await setup();
    const starting = manager.start("docs", mcp.url, undefined, "alice");
    await expect(manager.start("docs", mcp.url, undefined, "bob")).rejects.toMatchObject({ status: 409 });
    const started = await starting;
    const callback = await redirect(started);
    await expect(manager.start("docs", mcp.url, undefined, "bob")).rejects.toMatchObject({ status: 409 });
    expect(manager.status("docs", started.flowId, "bob")).toBeUndefined();
    expect(() => manager.cancelFlow("docs", "bob", started.flowId)).toThrow();
    await expect(manager.completeCallback("docs", started.flowId, callback, "bob")).rejects.toMatchObject({ status: 404 });
    expect(oauth.counts.token).toBe(0);
    expect((await manager.completeCallback("docs", started.flowId, callback, "alice")).phase).toBe("succeeded");
  });

  it("rejects malformed callbacks without spending the flow or requesting their addresses", async () => {
    await setup();
    const started = await manager.start("docs", mcp.url);
    const callback = await redirect(started);
    const variants = [
      "not a URL", "x".repeat(16_385),
      callback.replace("127.0.0.1", "attacker.example"),
      callback.replace("http:", "https:"),
      callback.replace("127.0.0.1", "user:pass@127.0.0.1"),
      callback.replace("/mcp-oauth/callback", "/other"),
      callback + "#fragment", callback + "&code=duplicate", callback + "&error=access_denied",
      callback + "&iss=https%3A%2F%2Fwrong.example",
    ];
    const wrongState = new URL(callback);
    wrongState.searchParams.set("state", "wrong");
    variants.push(wrongState.href);
    const wrongPort = new URL(callback);
    wrongPort.port = String(Number(wrongPort.port) + 1);
    variants.push(wrongPort.href);
    for (const invalid of variants) {
      await expect(manager.completeCallback("docs", started.flowId, invalid)).rejects.toMatchObject({ status: 400 });
      expect(manager.status("docs", started.flowId)?.phase).toBe("waiting");
    }
    expect(oauth.counts.token).toBe(0);
    expect((await manager.completeCallback("docs", started.flowId, callback)).phase).toBe("succeeded");
  });

  it("reports a pasted provider denial without exposing its error description", async () => {
    await setup({ deny: true });
    const started = await manager.start("docs", mcp.url);
    const result = await manager.completeCallback("docs", started.flowId, await redirect(started) + "&error_description=private");
    expect(result).toMatchObject({ phase: "failed", message: "Sign-in was not approved." });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(oauth.counts.token).toBe(0);
  });

  it.each(["cancel", "revoke", "forget", "expire"])("rejects a pasted callback after %s", async (action) => {
    await setup({}, action === "expire" ? 100 : undefined);
    const started = await manager.start("docs", mcp.url);
    const callback = await redirect(started);
    if (action === "cancel") manager.cancelFlow("docs", "loopback", started.flowId);
    if (action === "revoke") manager.revokeOwner("loopback");
    if (action === "forget") manager.forget("docs");
    if (action === "expire") await expect.poll(() => manager.status("docs", started.flowId)?.phase).toBe("expired");
    await expect(manager.completeCallback("docs", started.flowId, callback)).rejects.toThrow();
    expect(oauth.counts.token).toBe(0);
    expect(manager.authState("docs", mcp.url)).toBe("none");
  });

  it("checks session expiry even before its revocation event is delivered", async () => {
    await setup();
    manager.dispose();
    let live = true;
    manager = new McpOAuthManager({ file: join(dir, "mcp-oauth.json"), isOwnerLive: () => live });
    const started = await manager.start("docs", mcp.url, undefined, "alice");
    const callback = await redirect(started);
    live = false;
    await expect(manager.completeCallback("docs", started.flowId, callback, "alice")).rejects.toMatchObject({ status: 409 });
    expect(oauth.counts.token).toBe(0);
  });

  it("releases a dead owner's waiting flow before accepting another admin's start", async () => {
    await setup();
    manager.dispose();
    let aliceLive = true;
    manager = new McpOAuthManager({ file: join(dir, "mcp-oauth.json"), isOwnerLive: (owner) => owner !== "alice" || aliceLive });
    const old = await manager.start("docs", mcp.url, undefined, "alice");
    aliceLive = false;
    const current = await manager.start("docs", mcp.url, undefined, "bob");
    expect(current.phase).toBe("waiting");
    expect(current.flowId).not.toBe(old.flowId);
    expect(manager.status("docs", current.flowId, "bob")?.phase).toBe("waiting");
    expect(manager.status("docs", old.flowId, "alice")).toBeUndefined();
  });

  it("does not let an old cancellation cancel a new attempt", async () => {
    await setup();
    const old = await manager.start("docs", mcp.url);
    manager.cancel("docs");
    const current = await manager.start("docs", mcp.url);
    expect(() => manager.cancelFlow("docs", "loopback", old.flowId)).toThrow();
    expect(manager.status("docs", current.flowId)?.phase).toBe("waiting");
  });

  it("revokes a start still waiting for registration", async () => {
    const entered = deferred();
    const release = deferred();
    await setup({ beforeRegister: async () => { entered.resolve(); await release.promise; } });
    const started = manager.start("docs", mcp.url, undefined, "alice");
    const rejected = expect(started).rejects.toMatchObject({ status: 409 });
    await entered.promise;
    manager.revokeOwner("alice");
    release.resolve();
    await rejected;
    expect(manager.authState("docs", mcp.url)).toBe("none");
  });

  it("spends one code when pasted and listener callbacks race, and discards tokens on logout", async () => {
    const entered = deferred();
    const release = deferred();
    await setup({ beforeToken: async () => { entered.resolve(); await release.promise; } });
    const started = await manager.start("docs", mcp.url, undefined, "alice");
    const callback = await redirect(started);
    const completing = manager.completeCallback("docs", started.flowId, callback, "alice");
    const rejected = expect(completing).rejects.toMatchObject({ status: 409 });
    await entered.promise;
    expect((await fetch(callback)).status).toBe(409);
    await expect(manager.completeCallback("docs", started.flowId, callback, "alice")).rejects.toMatchObject({ status: 409 });
    manager.revokeOwner("alice");
    release.resolve();
    await rejected;
    expect(oauth.counts.token).toBe(1);
    expect(manager.authState("docs", mcp.url)).toBe("none");
    await expect.poll(() => oauth.counts.revoke).toBe(1);
  });
});
