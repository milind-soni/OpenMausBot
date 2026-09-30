import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { ChatGptPlanAuthController } from "./chatgpt-plan-auth.ts";

// Real loopback callback + signed synthetic OIDC/JWKS/token/model endpoints.
// No provider account, user home, real token, or paid inference is touched.
describe("official ChatGPT plan OAuth", () => {
  let home: string;
  let directory: string;
  let server: Server;
  let origin: string;
  let authorization: URL;
  let mode: string;
  let calls: Array<{ path: string; params: URLSearchParams; authorization?: string }>;
  let controllers: ChatGptPlanAuthController[];
  let key: CryptoKey;
  let wrongKey: CryptoKey;

  const create = (account = "account-one") => {
    const controller = new ChatGptPlanAuthController({ directory: join(home, "chatgpt-plan", account), testServerUrl: origin });
    controllers.push(controller);
    return controller;
  };
  const stored = () => JSON.parse(readFileSync(join(directory, "credentials.json"), "utf8"));
  const expire = () => {
    const record = stored(); record.tokens.expiresAt = Date.now() - 1000;
    writeFileSync(join(directory, "credentials.json"), JSON.stringify(record), { mode: 0o600 });
  };
  async function begin(controller: ChatGptPlanAuthController) {
    const flow = await controller.start();
    authorization = new URL(flow.authorizationUrl!);
    return flow;
  }
  async function callback(controller: ChatGptPlanAuthController, override: Record<string, string> = {}) {
    const flow = await begin(controller);
    const url = new URL(authorization.searchParams.get("redirect_uri")!);
    url.search = new URLSearchParams({ state: authorization.searchParams.get("state")!, code: "fixture-code", client_id: "oaiapp_fixture_account_1", ...override }).toString();
    await fetch(url);
    await expect.poll(async () => (await controller.get(flow.flowId!)).phase).not.toBe("waiting");
    return controller.get(flow.flowId!);
  }
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-chatgpt-plan-"));
    directory = join(home, "chatgpt-plan", "account-one");
    calls = []; controllers = []; mode = "success";
    const keys = await generateKeyPair("RS256"); key = keys.privateKey;
    wrongKey = (await generateKeyPair("RS256")).privateKey;
    const jwk = await exportJWK(keys.publicKey);
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const params = new URLSearchParams(Buffer.concat(chunks).toString());
      calls.push({ path: request.url!, params, authorization: request.headers.authorization });
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/.well-known/jwks.json") {
        if (mode === "refresh-jwks-unavailable") { response.statusCode = 503; response.end("{}"); return; }
        response.end(JSON.stringify({ keys: [{ ...jwk, kid: "fixture", alg: "RS256" }] })); return;
      }
      if (request.url === "/.well-known/openid-configuration") { response.end(JSON.stringify({ issuer: origin, revocation_endpoint: `${origin}/revoke` })); return; }
      if (request.url === "/revoke") { response.statusCode = mode === "revoke-fails" ? 503 : 200; response.end(); return; }
      if (request.url === "/v1/models") {
        response.end(JSON.stringify({ models: [{ slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" }, { slug: "hidden", display_name: "Hidden", visibility: "hide" }, { slug: "gpt-fixture", display_name: "Fixture", visibility: "list" }] })); return;
      }
      if (request.url !== "/api/accounts/oauth/token") { response.statusCode = 404; response.end("{}"); return; }
      if (mode === "used-code") { response.statusCode = 400; response.end(JSON.stringify({ error: "invalid_grant" })); return; }
      if (params.get("grant_type") === "refresh_token") {
        if (mode === "refresh-revoked" || mode === "refresh-server-error") {
          response.statusCode = mode === "refresh-revoked" ? 400 : 503;
          response.end(JSON.stringify({ error: mode === "refresh-revoked" ? "refresh_token_reused" : "temporary_error", error_description: "never-show-fixture-secret" })); return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
        const idToken = mode.startsWith("refresh-id-") || mode === "refresh-jwks-unavailable" ? await new SignJWT({ email: "fixture@example.invalid" })
          .setProtectedHeader({ alg: "RS256", kid: "fixture" })
          .setSubject(mode === "refresh-id-subject" ? "other-subject" : "fixture-subject")
          .setIssuer(origin).setAudience("oaiapp_fixture_account_1").setIssuedAt().setExpirationTime("1h")
          .sign(mode === "refresh-id-invalid" ? wrongKey : key) : undefined;
        response.end(JSON.stringify({ access_token: "fixture-access-rotated", refresh_token: "fixture-refresh-rotated", token_type: "Bearer", expires_in: 3600, ...(idToken ? { id_token: mode === "refresh-id-malformed" ? 42 : idToken } : {}) })); return;
      }
      if (mode === "slow-exchange") await new Promise((resolve) => setTimeout(resolve, 80));
      const now = Math.floor(Date.now() / 1000);
      const id = await new SignJWT({ nonce: mode === "nonce" ? "wrong-nonce" : authorization.searchParams.get("nonce"), email: "fixture@example.invalid" })
        .setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .setSubject(mode === "subject" ? "other-subject" : "fixture-subject")
        .setIssuer(mode === "issuer" ? "https://untrusted.invalid" : origin)
        .setAudience(mode === "audience" ? "wrong-client" : "oaiapp_fixture_account_1")
        .setIssuedAt(mode === "future" ? now + 3600 : now)
        .setExpirationTime(mode === "expired" ? now - 300 : now + 3600)
        .sign(mode === "signature" ? wrongKey : key);
      response.end(JSON.stringify({ access_token: "fixture-access-private", ...(mode === "no-consent" ? {} : { refresh_token: "fixture-refresh-private" }), id_token: id, token_type: "Bearer", expires_in: 3600,
        scope: mode === "no-consent" ? "openid profile email" : "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener unavailable.");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await Promise.all(controllers.map((controller) => controller.dispose()));
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    removeTempDir(home);
  });

  it("exchanges issued client ID + PKCE, verifies identity, stores privately, and discovers exact account models", async () => {
    const controller = create();
    expect((await callback(controller)).phase).toBe("succeeded");
    expect(authorization.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authorization.searchParams.get("agent_name_hint")).toBe("openmausbot");
    expect(authorization.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
    const exchange = calls.find((call) => call.path.endsWith("/token"))!;
    expect(exchange.params.get("client_id")).toBe("oaiapp_fixture_account_1");
    expect(exchange.params.get("redirect_uri")).toBe(authorization.searchParams.get("redirect_uri"));
    expect(new URL(exchange.params.get("redirect_uri")!).hostname).toBe("127.0.0.1");
    expect(createHash("sha256").update(exchange.params.get("code_verifier")!).digest("base64url")).toBe(authorization.searchParams.get("code_challenge"));
    expect(await controller.accessToken()).toBe("fixture-access-private");
    expect(await controller.models()).toEqual({ default: "gpt-6.1-sol", options: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }, { id: "gpt-fixture", label: "Fixture" }] });
    expect(calls.at(-1)?.authorization).toBe("Bearer fixture-access-private");
    expect(await controller.snapshot()).toMatchObject({ authenticated: true, account: { email: "fixture@example.invalid", method: "login" } });
    expect(JSON.stringify(await controller.snapshot())).not.toContain("fixture-access");
    if (process.platform !== "win32") {
      expect(statSync(join(directory, "credentials.json")).mode & 0o777).toBe(0o600);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, "chatgpt-plan", "host-id.json")).mode & 0o777).toBe(0o600);
    }
  });
  it.each(["nonce", "issuer", "audience", "future", "expired", "signature"])("rejects %s identity errors without saving credentials", async (failure) => {
    mode = failure; const controller = create();
    expect(await callback(controller)).toMatchObject({ phase: "failed", message: expect.stringContaining("could not be verified") });
    expect((await controller.snapshot()).authenticated).toBe(false);
    await expect(controller.accessToken()).rejects.toThrow("Continue with ChatGPT");
  });
  it("rejects invalid state and duplicate parameters before touching tokens, then accepts the valid callback once", async () => {
    const controller = create();
    const flow = await begin(controller);
    const url = new URL(authorization.searchParams.get("redirect_uri")!);
    url.search = new URLSearchParams({ state: "bad-state", code: "fixture-code", client_id: "oaiapp_fixture_account_1" }).toString();
    expect((await fetch(url)).status).toBe(400);
    url.searchParams.set("state", authorization.searchParams.get("state")!);
    url.searchParams.append("state", "duplicate");
    expect((await fetch(url)).status).toBe(400);
    expect(calls).toHaveLength(0);
    url.searchParams.delete("state"); url.searchParams.set("state", authorization.searchParams.get("state")!);
    await fetch(url);
    await expect.poll(async () => (await controller.get(flow.flowId!)).phase).toBe("succeeded");
    await expect(fetch(url)).rejects.toThrow();
    expect(calls.filter((call) => call.path.endsWith("/token"))).toHaveLength(1);
  });
  it("rejects malformed targets and foreign hosts without crashing or consuming the legitimate callback", async () => {
    const controller = create(); const flow = await begin(controller);
    const url = new URL(authorization.searchParams.get("redirect_uri")!);
    url.search = new URLSearchParams({ state: authorization.searchParams.get("state")!, code: "fixture-code", client_id: "oaiapp_fixture_account_1" }).toString();
    const send = (path: string, host = url.host) => new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port: url.port, path, headers: { host } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.on("error", reject); request.end();
    });
    expect(await send("http://[invalid")).toBe(400);
    expect(await send(`//foreign.invalid${url.pathname}${url.search}`)).toBe(400);
    expect(await send(`${url.pathname}${url.search}`, "foreign.invalid")).toBe(400);
    expect(calls).toHaveLength(0);
    expect((await controller.get(flow.flowId!)).phase).toBe("waiting");
    await fetch(url);
    await expect.poll(async () => (await controller.get(flow.flowId!)).phase).toBe("succeeded");
  });
  it("does not exchange declined or incomplete registrations", async () => {
    const controller = create();
    expect((await callback(controller, { error: "access_denied" })).phase).toBe("failed");
    expect(calls).toHaveLength(0);
    expect((await callback(controller, { client_id: "dynamic_agent_client" })).phase).toBe("failed");
    expect(calls).toHaveLength(0);
  });
  it("retries an expired code with its issued client instead of registering another client", async () => {
    const controller = create(); mode = "used-code";
    expect((await callback(controller)).phase).toBe("failed");
    const state = authorization.searchParams.get("state");
    await begin(controller);
    expect(authorization.searchParams.get("client_id")).toBe("oaiapp_fixture_account_1");
    expect(authorization.searchParams.has("agent_name_hint")).toBe(false);
    expect(authorization.searchParams.get("state")).not.toBe(state);
    expect((await controller.snapshot()).authenticated).toBe(false);
  });
  it("retains identity without plan consent but prevents inference and requests explicit consent next time", async () => {
    mode = "no-consent"; const controller = create();
    expect(await callback(controller)).toMatchObject({ phase: "failed", message: expect.stringContaining("not enabled") });
    expect(await controller.snapshot()).toMatchObject({ authenticated: false, account: { email: "fixture@example.invalid" } });
    await expect(controller.accessToken()).rejects.toThrow("not enabled");
    const client = stored().clientId;
    await begin(controller);
    expect(authorization.searchParams.get("client_id")).toBe(client);
    expect(authorization.searchParams.get("prompt")).toBe("consent");
  });
  it("preserves registration + host across sign-out and keeps separate instances on the same host", async () => {
    const controller = create(); await callback(controller);
    const before = stored();
    await controller.signOut();
    const after = stored();
    expect(after.clientId).toBe(before.clientId); expect(after.subject).toBe(before.subject); expect(after.tokens).toBeUndefined();
    expect(calls.find((call) => call.path === "/revoke")?.params.get("token")).toBe("fixture-refresh-private");
    await begin(controller);
    expect(authorization.searchParams.get("client_id")).toBe(before.clientId);
    expect(authorization.searchParams.has("agent_name_hint")).toBe(false);
    expect(authorization.searchParams.get("ext_agent_host_id")).toBe(before.hostId);
    const second = create("account-two"); await begin(second);
    expect(authorization.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authorization.searchParams.get("ext_agent_host_id")).toBe(before.hostId);
  });
  it("never replaces a returning account with a different verified identity or callback client", async () => {
    const controller = create(); await callback(controller);
    const before = stored(); mode = "subject";
    expect(await callback(controller)).toMatchObject({ phase: "failed", message: expect.stringContaining("different account") });
    expect(stored()).toEqual(before);
    expect((await callback(controller, { client_id: "different-client" })).phase).toBe("failed");
    expect(stored()).toEqual(before);
  });
  it("serializes rotating refresh across controllers and replaces the whole token set once", async () => {
    const controller = create(); await callback(controller); expire();
    const other = create();
    expect(await Promise.all([controller.accessToken(), other.accessToken()])).toEqual(["fixture-access-rotated", "fixture-access-rotated"]);
    const refreshes = calls.filter((call) => call.params.get("grant_type") === "refresh_token");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]?.params.has("scope")).toBe(false);
    expect(refreshes[0]?.params.get("client_id")).toBe("oaiapp_fixture_account_1");
    expect(stored().tokens.refresh).toBe("fixture-refresh-rotated");
    expect(stored().tokens.scopes).toContain("chatgpt.tokens.use.direct");
  });
  it("serializes refresh across separate runtime processes sharing the same private account", async () => {
    const controller = create(); await callback(controller); expire();
    const script = `import { ChatGptPlanAuthController } from ${JSON.stringify(new URL("./chatgpt-plan-auth.ts", import.meta.url).href)};
      const auth = new ChatGptPlanAuthController(${JSON.stringify({ directory, testServerUrl: origin })});
      process.stdout.write(await auth.accessToken()); await auth.dispose();`;
    const run = () => promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { timeout: 15_000, env: { ...process.env, HOME: home, USERPROFILE: home } });
    const results = await Promise.all([run(), run()]);
    expect(results.map((result) => result.stdout)).toEqual(["fixture-access-rotated", "fixture-access-rotated"]);
    expect(calls.filter((call) => call.params.get("grant_type") === "refresh_token")).toHaveLength(1);
  });
  it("retains credentials on temporary refresh failure but clears tokens on terminal revocation", async () => {
    const controller = create(); await callback(controller); expire();
    const before = stored(); mode = "refresh-server-error";
    await expect(controller.accessToken()).rejects.toThrow("saved account has not been removed");
    expect(stored()).toEqual(before);
    mode = "refresh-revoked";
    await expect(controller.accessToken()).rejects.toThrow("Continue with ChatGPT");
    expect(stored().tokens).toBeUndefined(); expect(stored().clientId).toBe(before.clientId);
  });
  it("does not consume a refresh token when its successor cannot be verified because JWKS are unavailable", async () => {
    const controller = create(); await callback(controller); expire();
    const before = stored(); mode = "refresh-jwks-unavailable";
    await expect(controller.accessToken()).rejects.toThrow("identity keys are unavailable");
    expect(calls.filter((call) => call.params.get("grant_type") === "refresh_token")).toHaveLength(0);
    expect(stored()).toEqual(before);
    mode = "refresh-id-valid";
    expect(await controller.accessToken()).toBe("fixture-access-rotated");
    expect(stored().tokens.refresh).toBe("fixture-refresh-rotated");
    const exchangeIndex = calls.findIndex((call) => call.params.get("grant_type") === "refresh_token");
    expect(calls.slice(exchangeIndex + 1).filter((call) => call.path.endsWith("jwks.json"))).toHaveLength(0);
  });
  it.each(["refresh-id-invalid", "refresh-id-subject", "refresh-id-malformed"])("clears consumed tokens on %s without losing the account mapping or replaying refresh", async (failure) => {
    const controller = create(); await callback(controller); expire();
    const before = stored(); mode = failure;
    await expect(controller.accessToken()).rejects.toThrow("Continue with ChatGPT again");
    expect(stored().tokens).toBeUndefined();
    expect(stored().clientId).toBe(before.clientId); expect(stored().subject).toBe(before.subject);
    await expect(controller.accessToken()).rejects.toThrow("Continue with ChatGPT");
    expect(calls.filter((call) => call.params.get("grant_type") === "refresh_token")).toHaveLength(1);
  });
  it("clears local tokens and reports when remote revocation could not be confirmed", async () => {
    const controller = create(); await callback(controller); mode = "revoke-fails";
    await expect(controller.signOut()).rejects.toThrow("Signed out locally");
    expect(stored().tokens).toBeUndefined();
  });
  it("cancels an exchange in progress without persisting late credentials", async () => {
    const controller = create(); mode = "slow-exchange";
    const flow = await begin(controller);
    const url = new URL(authorization.searchParams.get("redirect_uri")!);
    url.search = new URLSearchParams({ state: authorization.searchParams.get("state")!, code: "fixture-code", client_id: "oaiapp_fixture_account_1" }).toString();
    await fetch(url); await controller.cancel();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect((await controller.get(flow.flowId!)).phase).toBe("cancelled");
    expect((await controller.snapshot()).authenticated).toBe(false);
  });
  it("shares one pending listener for concurrent starts and never opens arbitrary test endpoints", async () => {
    const controller = create();
    const [a, b] = await Promise.all([controller.start(), controller.start()]);
    expect(a.flowId).toBe(b.flowId);
    expect(() => new ChatGptPlanAuthController({ directory, testServerUrl: "https://untrusted.invalid" })).toThrow("loopback");
  });
});
