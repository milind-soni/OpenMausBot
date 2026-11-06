// Per-app OAuth flow, mock-only. The stub runtime answers GET /api/oauth/configs,
// PUT /api/oauth/configs/:service and GET /v1/connection-requests/:id from fixture queues; the browser
// leg is never executed, which is exactly what MANUAL-ACCEPTANCE.md leaves to a human.
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpenConnectorClient } from "./client.ts";
import { OpenConnectorStateStore } from "./state.ts";
import { appOAuthStatus, configureAppOAuth, pollConnectionRequest } from "./oauth.ts";

let api: Server;
let origin = "";
let dir = "";
const calls: Array<{ method: string; path: string; body: unknown }> = [];
let oauthConfigsBody: unknown = { expectedRedirectUri: "https://runtime.example.test/oauth/callback", configs: { github: { clientId: "cid" } } };
let putOauthStatus = 200;
let requestStates: Array<{ status: number; body: unknown; headers?: Record<string, string> }> = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "omb-oconn-oauth-"));
  api = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls.push({ method: req.method ?? "GET", path: url.pathname, body: raw ? JSON.parse(raw) : null });
    if (url.pathname === "/api/oauth/configs") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ success: true, data: oauthConfigsBody }));
    }
    if (url.pathname.startsWith("/api/oauth/configs/") && req.method === "PUT") {
      res.writeHead(putOauthStatus, { "content-type": "application/json" });
      return res.end(JSON.stringify({ success: putOauthStatus === 200 }));
    }
    if (url.pathname.startsWith("/v1/connection-requests/")) {
      const next = requestStates.shift() ?? { status: 200, body: { success: true, data: { status: "connected" } } };
      res.writeHead(next.status, { "content-type": "application/json", ...next.headers });
      return res.end(JSON.stringify(next.body));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: false, message: `stub: no route ${url.pathname}` }));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => api.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  oauthConfigsBody = { expectedRedirectUri: "https://runtime.example.test/oauth/callback", configs: { github: { clientId: "cid" } } };
  putOauthStatus = 200;
  requestStates = [];
});

const newState = () => new OpenConnectorStateStore(join(dir, `state-${Math.random().toString(36).slice(2)}.json`));
const client = () => new OpenConnectorClient({ baseUrl: origin, adminToken: "admintok" });

describe("configureAppOAuth", () => {
  it("reads expectedRedirectUri, PUTs the client, and seals the local record", async () => {
    const state = newState();
    const result = await configureAppOAuth(client(), state, "github", { clientId: "cid", clientSecret: "shhh", scopes: [" repo ", "", "read:user"] });
    expect(result.expectedRedirectUri).toBe("https://runtime.example.test/oauth/callback");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/oauth/configs",
      "PUT /api/oauth/configs/github",
    ]);
    expect(calls[1].body).toEqual({ clientId: "cid", clientSecret: "shhh", scopes: ["repo", "read:user"] });
    const record = state.findAppOAuth("github");
    expect(record).toMatchObject({ clientId: "cid", scopes: ["repo", "read:user"] });
    expect(state.unsealSecret(record!.sealedClientSecret)).toBe("shhh");
  });

  it("never writes the plaintext secret to the state file", async () => {
    const state = newState();
    await configureAppOAuth(client(), state, "github", { clientId: "cid", clientSecret: "top-secret-value" });
    const onDisk = readFileSync(state.file, "utf8");
    expect(onDisk).not.toContain("top-secret-value");
    expect(onDisk).toContain("sealedClientSecret");
  });

  it("rejects a blank clientId or secret before any network call", async () => {
    const state = newState();
    await expect(configureAppOAuth(client(), state, "github", { clientId: " ", clientSecret: "x" }))
      .rejects.toMatchObject({ message: "OAuth clientId is required", status: 400 });
    await expect(configureAppOAuth(client(), state, "github", { clientId: "x", clientSecret: "" }))
      .rejects.toMatchObject({ message: "OAuth clientSecret is required", status: 400 });
    expect(calls).toEqual([]);
  });

  it("propagates a runtime refusal to store the config", async () => {
    putOauthStatus = 400;
    const state = newState();
    await expect(configureAppOAuth(client(), state, "github", { clientId: "cid", clientSecret: "sec" })).rejects.toThrow();
    expect(state.findAppOAuth("github")).toBeNull();
  });
});

describe("appOAuthStatus", () => {
  it("reports configured from the runtime or the local record, with the redirect target", async () => {
    const state = newState();
    expect((await appOAuthStatus(client(), state, "github")).configured).toBe(true);
    expect((await appOAuthStatus(client(), state, "notion")).configured).toBe(false);
    state.upsertAppOAuth({ service: "notion", clientId: "nid", sealedClientSecret: "x", updatedAt: "t" });
    const status = await appOAuthStatus(client(), state, "notion");
    expect(status.configured).toBe(true);
    expect(status.clientId).toBe("nid");
    expect(status.expectedRedirectUri).toBe("https://runtime.example.test/oauth/callback");
  });
});

describe("pollConnectionRequest", () => {
  const sleeps: number[] = [];
  const sleep = (ms: number) => {
    sleeps.push(ms);
    return Promise.resolve();
  };

  it("waits through pending and folds a connected result into the registry", async () => {
    sleeps.length = 0;
    requestStates = [
      { status: 200, body: { success: true, data: { status: "pending" } } },
      { status: 200, body: { success: true, data: { status: "awaiting_authorization" } } },
      { status: 200, body: { success: true, data: { status: "connected", connected: true } } },
    ];
    const state = newState();
    const result = await pollConnectionRequest(client(), state, "github", "cr_1", "work", { sleep, intervalMs: 100, timeoutMs: 5_000 });
    expect(result.connected).toBe(true);
    expect(result.record).toMatchObject({
      accountId: "oc:github:work",
      service: "github",
      alias: "work",
      connectionRequestId: "cr_1",
      status: "connected",
    });
    expect(state.findConnectionByAccountId("oc:github:work")).toMatchObject({ status: "connected" });
    expect(sleeps).toEqual([100, 100]);
  });

  it("honors Retry-After on a throttled poll instead of the interval", async () => {
    sleeps.length = 0;
    requestStates = [
      { status: 429, body: { success: false, message: "slow down" }, headers: { "retry-after": "7" } },
      { status: 200, body: { success: true, data: { status: "connected" } } },
    ];
    const state = newState();
    const result = await pollConnectionRequest(client(), state, "github", "cr_2", undefined, { sleep, intervalMs: 100, timeoutMs: 60_000 });
    expect(result.connected).toBe(true);
    expect(result.record.accountId).toBe("oc:github:default");
    expect(sleeps).toEqual([7000]);
  });

  it("records a terminal failure without throwing", async () => {
    requestStates = [{ status: 200, body: { success: true, data: { status: "expired" } } }];
    const state = newState();
    const result = await pollConnectionRequest(client(), state, "github", "cr_3", undefined, { sleep, intervalMs: 100, timeoutMs: 5_000 });
    expect(result.connected).toBe(false);
    expect(result.record.status).toBe("expired");
  });

  it("times out instead of polling past the deadline", async () => {
    sleeps.length = 0;
    requestStates = [
      { status: 200, body: { success: true, data: { status: "pending" } } },
      { status: 200, body: { success: true, data: { status: "pending" } } },
    ];
    const state = newState();
    let clock = 1_000;
    const advancingSleep = (ms: number) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    };
    await expect(pollConnectionRequest(client(), state, "github", "cr_4", undefined, {
      sleep: advancingSleep,
      intervalMs: 500,
      timeoutMs: 800,
      now: () => clock,
    })).rejects.toThrow(/Timed out/);
    expect(sleeps).toEqual([500]);
  });

  it("propagates a missing request instead of looping forever", async () => {
    requestStates = [{ status: 404, body: { success: false, message: "no such request", errorCode: "connection_request_not_found" } }];
    const state = newState();
    const error = await pollConnectionRequest(client(), state, "github", "cr_5", undefined, { sleep, intervalMs: 100 }).catch((caught) => caught);
    expect(error).toMatchObject({ status: 404, code: "connection_request_not_found" });
    expect(state.listConnections()).toEqual([]);
  });
});
