// The OpenConnector provider behind the ConnectorProvider seam. A stub runtime on an ephemeral
// port answers every call; the state store lives in a temp dir. No port 3000, no real runtime.
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../config.ts";
import { createOpenConnectorProvider, resolveAdminToken } from "./provider.ts";
import { OpenConnectorStateStore } from "./state.ts";

let api: Server;
let origin = "";
let dir = "";
const calls: Array<{ method: string; path: string; body: unknown }> = [];
let providersBody: unknown = [{ id: "github", name: "GitHub" }, { id: "gmail", name: "Gmail" }];
let actionsBody: unknown = [
  { id: "github.get_current_user", description: "Who am I", inputSchema: { type: "object", properties: { verbose: { type: "boolean" } } } },
  { id: "github.create_issue", description: "Open an issue", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
  { id: "gmail.list_emails" },
];
let actionDetailsBody: unknown | null = null;
let authenticatedBody: unknown = ["github"];
let failConnect = false;
let connectionRequestBody: unknown = { status: "connected" };
let connectionRequestStatus = 200;
let gateConnectionRequests = false;
let releaseGate: (() => void) | null = null;
let holdConnectResponse = false;
let onConnectRequest: (() => void) | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "omb-oconn-"));
  api = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls.push({ method: req.method ?? "GET", path: url.pathname + url.search, body: raw ? JSON.parse(raw) : null });
    const ok = (data: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, message: "OK", data }));
    };
    if (url.pathname === "/v1/providers") return ok(providersBody);
    if (url.pathname === "/v1/actions") return ok(actionsBody);
    if (url.pathname === "/v1/apps/authenticated") {
      const requested = url.searchParams.getAll("service");
      return ok(Array.isArray(authenticatedBody) ? authenticatedBody.filter((s) => requested.includes(String(s))) : []);
    }
    if (url.pathname.startsWith("/v1/actions/") && req.method === "GET") {
      const id = decodeURIComponent(url.pathname.slice("/v1/actions/".length));
      const details = actionDetailsBody ?? actionsBody;
      const action = (Array.isArray(details) ? details : []).find((item) => (item as { id?: string }).id === id);
      return ok(action ?? { id });
    }
    if (url.pathname.startsWith("/v1/actions/") && req.method === "POST") return ok({ ran: url.pathname.slice("/v1/actions/".length), input: (calls.at(-1)!.body as { input?: unknown }).input });
    if (url.pathname.startsWith("/v1/connections/") && req.method === "POST") {
      if (failConnect) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ success: false, message: "oauth not configured", errorCode: "oauth_config_missing" }));
      }
      onConnectRequest?.();
      if (holdConnectResponse) await new Promise((resolve) => setTimeout(resolve, 20));
      return ok({ connectionRequestId: "cr_9", authorizationUrl: "https://provider.example.test/authorize" });
    }
    if (url.pathname.startsWith("/v1/connection-requests/")) {
      if (gateConnectionRequests) await new Promise<void>((resolve) => { releaseGate = resolve; });
      if (connectionRequestStatus !== 200) {
        res.writeHead(connectionRequestStatus, { "content-type": "application/json" });
        return res.end(JSON.stringify({ success: false, message: "poll failed" }));
      }
      return ok(connectionRequestBody);
    }
    if (url.pathname.startsWith("/api/connections/") && req.method === "DELETE") {
      const service = url.pathname.slice("/api/connections/".length);
      if (service === "ghost" || url.searchParams.get("alias") === "ghost") {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ success: false, message: "not found", errorCode: "connection_not_found" }));
      }
      return ok({ deleted: true });
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
  providersBody = [{ id: "github", name: "GitHub" }, { id: "gmail", name: "Gmail" }];
  actionDetailsBody = null;
  actionsBody = [
    { id: "github.get_current_user", description: "Who am I", inputSchema: { type: "object", properties: { verbose: { type: "boolean" } } } },
    { id: "github.create_issue", description: "Open an issue", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
    { id: "gmail.list_emails" },
  ];
  authenticatedBody = ["github"];
  failConnect = false;
  connectionRequestBody = { status: "connected" };
  connectionRequestStatus = 200;
  gateConnectionRequests = false;
  releaseGate = null;
  holdConnectResponse = false;
  onConnectRequest = null;
});

const cfg = {} as AppConfig;
const newState = () => new OpenConnectorStateStore(join(dir, `state-${Math.random().toString(36).slice(2)}.json`));
const provider = (state = newState(), polling?: { intervalMs?: number; timeoutMs?: number }) => createOpenConnectorProvider({
  settings: { url: origin, adminTokenRef: "env:STUB_ADMIN" },
  env: { STUB_ADMIN: "admintok" },
  state,
  ...(polling ? { polling } : {}),
});
const lastCall = () => calls.at(-1)!;
const requestPollCalls = () => calls.filter((call) => call.path.startsWith("/v1/connection-requests/"));

describe("availability", () => {
  it("is self-hosted only with a url and a resolvable admin token", () => {
    const ready = provider();
    expect(ready.mode(cfg)).toBe("self-hosted");
    expect(ready.isConfigured(cfg)).toBe(true);
    const noToken = createOpenConnectorProvider({ settings: { url: origin, adminTokenRef: "env:MISSING" }, env: {} });
    expect(noToken.mode(cfg)).toBe("unavailable");
    expect(noToken.isConfigured(cfg)).toBe(false);
    const noUrl = createOpenConnectorProvider({ settings: {}, env: { MISSING: "x" } });
    expect(noUrl.mode(cfg)).toBe("unavailable");
  });

  it("resolves a bare token env var as a fallback", () => {
    expect(resolveAdminToken({ url: origin }, { OMB_OPENCONNECTOR_ADMIN_TOKEN: " tok " })).toBe("tok");
  });
});

describe("inventory / status", () => {
  it("lists providers with connected state from /v1/apps/authenticated", async () => {
    const services = await provider().inventory(cfg);
    expect(services.complete).toBe(true);
    expect(services.services.github).toEqual({ connected: true, pending: false, status: "ACTIVE", accounts: [] });
    expect(services.services.gmail).toEqual({ connected: false, pending: false, status: "not_connected", accounts: [] });
    expect(await provider().serviceSlugs(cfg)).toEqual(["github", "gmail"]);
  });

  it("answers requested keys, merging local registry accounts and pending records", async () => {
    const state = newState();
    state.upsertConnection({ accountId: "oc:github:work", service: "github", alias: "work", label: "Work GitHub", status: "ACTIVE", updatedAt: "t" });
    state.upsertConnection({ accountId: "oc:gmail:default", service: "gmail", status: "pending", updatedAt: "t" });
    const status = await provider(state).status(cfg, ["github", "gmail"]);
    expect(status.github.accounts).toEqual([{ id: "oc:github:work", status: "ACTIVE", alias: "work" }]);
    expect(status.github.connected).toBe(true);
    expect(status.gmail).toEqual({ connected: false, pending: true, status: "pending", accounts: [{ id: "oc:gmail:default", status: "pending" }] });
    const connected = newState();
    connected.upsertConnection({ accountId: "oc:slack:default", service: "slack", status: "connected", updatedAt: "t" });
    expect((await provider(connected).status(cfg, ["slack"])).slack.accounts).toEqual([
      { id: "oc:slack:default", status: "ACTIVE" },
    ]);
  });

  it("reports setup-needed without a runtime request when settings are incomplete", async () => {
    const state = newState();
    state.upsertConnection({ accountId: "oc:gmail:default", service: "gmail", status: "pending", updatedAt: "t" });
    const unavailable = createOpenConnectorProvider({ settings: { url: origin }, env: {}, state });
    expect(unavailable.mode(cfg)).toBe("unavailable");
    expect(await unavailable.inventory(cfg)).toEqual({ services: {}, complete: true });
    expect(await unavailable.tools(cfg)).toEqual({});
    expect(await unavailable.serviceSlugs(cfg)).toEqual([]);
    expect(await unavailable.status(cfg, ["github", "gmail"])).toMatchObject({
      github: { connected: false, pending: false, status: "setup-needed" },
      gmail: { connected: false, pending: true, status: "pending" },
    });
    await expect(unavailable.authorize(cfg, "github")).rejects.toThrow(/admin token/);
    expect(calls).toEqual([]);
  });

  it("keeps strict URL validation for operations while status still reports", async () => {
    const unavailable = createOpenConnectorProvider({
      settings: { url: "ftp://invalid.example.test", adminTokenRef: "env:STUB_ADMIN" },
      env: { STUB_ADMIN: "admintok" },
      state: newState(),
    });
    expect(await unavailable.status(cfg, ["github"])).toMatchObject({ github: { status: "setup-needed" } });
    expect(await unavailable.tools(cfg)).toEqual({});
    await expect(unavailable.catalog(cfg)).rejects.toThrow(/runtime must use HTTPS/);
  });
});

describe("tools / catalog", () => {
  it("groups actions under toolkit slugs with pattern-compliant names", async () => {
    const tools = await provider().tools(cfg);
    const emptySchema = { type: "object", properties: {}, additionalProperties: false, required: [] };
    expect(tools.github).toEqual([
      { name: "GITHUB_CREATE_ISSUE", description: "Open an issue", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
      { name: "GITHUB_GET_CURRENT_USER", description: "Who am I", inputSchema: { type: "object", properties: { verbose: { type: "boolean" } } } },
    ]);
    expect(tools.gmail).toEqual([{ name: "GMAIL_LIST_EMAILS", inputSchema: emptySchema }]);
  });

  it("fetches action details for tools/list so required input schemas are preserved", async () => {
    actionsBody = [
      { id: "github.create_issue", description: "Open an issue" },
      { id: "gmail.list_emails" },
    ];
    actionDetailsBody = [
      { id: "github.create_issue", description: "Open an issue", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
      { id: "gmail.list_emails" },
    ];
    const current = provider();
    const relayed = await current.relayMcp(cfg, { jsonrpc: "2.0", id: 20, method: "tools/list" });
    const frame = JSON.parse(new TextDecoder().decode(relayed.bytes));
    expect(frame.result.tools).toEqual([
      { name: "GITHUB_CREATE_ISSUE", description: "Open an issue", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
      { name: "GMAIL_LIST_EMAILS", inputSchema: { type: "object", properties: {}, additionalProperties: false, required: [] } },
    ]);
    expect(calls.filter((call) => call.path === "/v1/actions")).toHaveLength(1);
    expect(calls.filter((call) => call.path.startsWith("/v1/actions/"))).toHaveLength(2);

    calls.length = 0;
    await current.relayMcp(cfg, { jsonrpc: "2.0", id: 21, method: "tools/list" });
    expect(calls.filter((call) => call.path === "/v1/actions")).toHaveLength(1);
    expect(calls.filter((call) => call.path.startsWith("/v1/actions/"))).toHaveLength(0);
  });

  it("keeps tools/list usable when one missing detail fails", async () => {
    actionsBody = [
      { id: "github.create_issue", description: "Open an issue" },
      { id: "gmail.list_emails" },
    ];
    actionDetailsBody = [
      { id: "github.create_issue", description: "Open an issue", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
    ];
    const current = provider();
    const relayed = await current.relayMcp(cfg, { jsonrpc: "2.0", id: 22, method: "tools/list" });
    const frame = JSON.parse(new TextDecoder().decode(relayed.bytes));
    expect(frame.result.tools).toEqual([
      { name: "GITHUB_CREATE_ISSUE", description: "Open an issue", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
      { name: "GMAIL_LIST_EMAILS", inputSchema: { type: "object", properties: {}, additionalProperties: false, required: [] } },
    ]);
  });

  it("serves the provider list as the app catalog", async () => {
    const catalog = await provider().catalog(cfg);
    expect(catalog.source).toBe("api");
    expect(catalog.pagination).toEqual({ items: 2, stalled: false, complete: true });
    expect(catalog.cards).toEqual([
      { slug: "github", label: "GitHub", blurb: "", logo: null, domain: null },
      { slug: "gmail", label: "Gmail", blurb: "", logo: null, domain: null },
    ]);
  });
});

describe("disconnect", () => {
  it("removeService deletes the runtime connection and the local records", async () => {
    const state = newState();
    state.upsertConnection({ accountId: "oc:github:default", service: "github", status: "ACTIVE", updatedAt: "t" });
    await expect(provider(state).removeService(cfg, "github")).resolves.toEqual({ removed: 1 });
    expect(state.listConnections()).toEqual([]);
    expect(lastCall()).toMatchObject({ method: "DELETE", path: "/api/connections/github" });
  });

  it("reads state once per inventory and selects only usable accounts", async () => {
    const state = newState();
    state.upsertConnection({ accountId: "oc:github:default", service: "github", status: "ACTIVE", updatedAt: "t" });
    state.upsertConnection({ accountId: "oc:github:failed", service: "github", alias: "failed", status: "expired", updatedAt: "t" });
    const current = provider(state);
    await expect(current.inventory(cfg)).resolves.toMatchObject({
      services: { github: { connected: true, status: "ACTIVE", accounts: [
        { id: "oc:github:default", status: "ACTIVE" },
        { id: "oc:github:failed", status: "expired", alias: "failed" },
      ] } },
    });
    const before = readFileSync(state.file, "utf8");
    const selected = await current.relayMcp(cfg, {
      jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "GITHUB_GET_CURRENT_USER", arguments: {}, _meta: { openconnectorAccountAlias: "failed" } },
    });
    expect(JSON.parse(new TextDecoder().decode(selected.bytes)).result.isError).toBe(true);
    expect(readFileSync(state.file, "utf8")).toBe(before);
  });

  it("removeService disconnects every named connection before clearing local records", async () => {
    const state = newState();
    state.upsertConnection({ accountId: "oc:github:default", service: "github", status: "ACTIVE", updatedAt: "t" });
    state.upsertConnection({ accountId: "oc:github:work", service: "github", alias: "work", status: "ACTIVE", updatedAt: "t" });
    await expect(provider(state).removeService(cfg, "github")).resolves.toEqual({ removed: 2 });
    expect(state.listConnections()).toEqual([]);
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      "/api/connections/github",
      "/api/connections/github?alias=work",
    ]);
  });

  it("rejects member-scoped requests instead of using host admin credentials", async () => {
    const state = newState();
    const access = { url: "https://broker.example.test", token: "member-token" } as never;
    const current = provider(state);
    await expect(current.inventory(cfg, access)).rejects.toThrow(/member-scoped/);
    await expect(current.serviceSlugs(cfg, access)).rejects.toThrow(/member-scoped/);
    await expect(current.status(cfg, ["github"], access)).rejects.toThrow(/member-scoped/);
    await expect(current.removeService(cfg, "github", access)).rejects.toThrow(/member-scoped/);
    await expect(current.authorize(cfg, "github", undefined, access)).rejects.toThrow(/member-scoped/);
    await expect(current.relayMcp(cfg, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, undefined, undefined, undefined, access)).rejects.toThrow(/member-scoped/);
    expect(state.listConnections()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("removeService answers removed:0 when the runtime has no connection and clears stale records", async () => {
    const state = newState();
    await expect(provider(state).removeService(cfg, "github")).resolves.toEqual({ removed: 1 });
    const stale = newState();
    stale.upsertConnection({ accountId: "oc:ghost:default", service: "ghost", status: "ACTIVE", updatedAt: "t" });
    await expect(provider(stale).removeService(cfg, "ghost")).resolves.toEqual({ removed: 0 });
    expect(stale.listConnections()).toEqual([]);
  });

  it("removeAccount sends the alias selector and removes only the matching record", async () => {
    const state = newState();
    state.upsertConnection({ accountId: "oc:github:work", service: "github", alias: "work", status: "ACTIVE", updatedAt: "t" });
    state.upsertConnection({ accountId: "oc:github:default", service: "github", status: "ACTIVE", updatedAt: "t" });
    await expect(provider(state).removeAccount(cfg, "github", "oc:github:work")).resolves.toEqual({ removed: 1 });
    expect(lastCall().path).toBe("/api/connections/github?alias=work");
    expect(state.listConnections().map((record) => record.accountId)).toEqual(["oc:github:default"]);
    await expect(provider(state).removeAccount(cfg, "github", "oc:github:work")).resolves.toEqual({ removed: 0 });
    await expect(provider(state).removeAccount(cfg, "github", "nonsense")).resolves.toEqual({ removed: 0 });
  });

  it("removeAccount clears the local record when the runtime already lost it", async () => {
    const state = newState();
    state.upsertConnection({ accountId: "oc:github:ghost", service: "github", alias: "ghost", status: "ACTIVE", updatedAt: "t" });
    await expect(provider(state).removeAccount(cfg, "github", "oc:github:ghost")).resolves.toEqual({ removed: 0 });
    expect(state.listConnections()).toEqual([]);
  });
});

describe("authorize", () => {
  it("starts a connection request and records a pending local account", async () => {
    const state = newState();
    const result = await provider(state).authorize(cfg, "github", "work");
    expect(result.url).toBe("https://provider.example.test/authorize");
    expect(result.connectionRequestId).toBe("cr_9");
    expect(lastCall()).toMatchObject({ method: "POST", path: "/v1/connections/github/connect", body: {} });
    expect(state.listConnections()).toEqual([{
      accountId: "oc:github:work",
      service: "github",
      alias: "work",
      connectionRequestId: "cr_9",
      status: "pending",
      updatedAt: expect.any(String),
    }]);
  });

  it("surfaces a runtime refusal to start", async () => {
    failConnect = true;
    const state = newState();
    await expect(provider(state).authorize(cfg, "github")).rejects.toMatchObject({ code: "oauth_config_missing" });
    expect(state.listConnections()).toEqual([]);
  });

  it("captures the existing version before the network and refuses to replace a concurrent update", async () => {
    const state = newState();
    state.upsertConnection({ accountId: "oc:github:work", service: "github", alias: "work", connectionRequestId: "cr_old", status: "connected", updatedAt: "old" });
    const before = readFileSync(state.file, "utf8");
    holdConnectResponse = true;
    onConnectRequest = () => {
      const other = new OpenConnectorStateStore(state.file, origin);
      other.upsertConnection({ accountId: "oc:github:work", service: "github", alias: "work", connectionRequestId: "cr_new", status: "pending", updatedAt: "new" });
    };
    const authorize = provider(state).authorize(cfg, "github", "work");
    authorize.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    const racedBytes = readFileSync(state.file, "utf8");
    await expect(authorize).rejects.toThrow(/updated by another process/);
    expect(readFileSync(state.file, "utf8")).toBe(racedBytes);
    expect(racedBytes).not.toBe(before);
    expect(new OpenConnectorStateStore(state.file, origin).findConnectionByAccountId("oc:github:work")).toMatchObject({ connectionRequestId: "cr_new", status: "pending" });
  });

  it("captures the existing version before the network and refuses to resurrect a concurrent deletion", async () => {
    const state = newState();
    state.upsertConnection({ accountId: "oc:github:work", service: "github", alias: "work", connectionRequestId: "cr_old", status: "connected", updatedAt: "old" });
    holdConnectResponse = true;
    onConnectRequest = () => {
      new OpenConnectorStateStore(state.file, origin).removeConnection("oc:github:work");
    };
    const authorize = provider(state).authorize(cfg, "github", "work");
    authorize.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    const racedBytes = readFileSync(state.file, "utf8");
    await expect(authorize).rejects.toThrow(/updated by another process/);
    expect(readFileSync(state.file, "utf8")).toBe(racedBytes);
    expect(new OpenConnectorStateStore(state.file, origin).listConnections()).toEqual([]);
  });
});

describe("background authorization convergence", () => {
  it("converges the local record to connected on its own after authorize", async () => {
    const state = newState();
    const result = await provider(state, { intervalMs: 10 }).authorize(cfg, "github", "work");
    expect(result.connectionRequestId).toBe("cr_9");
    expect(state.findConnectionByAccountId("oc:github:work")).toMatchObject({ status: "pending" });
    await vi.waitFor(() => {
      expect(state.findConnectionByAccountId("oc:github:work")).toMatchObject({ status: "connected", connectionRequestId: "cr_9" });
    }, { timeout: 5_000, interval: 20 });
  });

  it("lands a terminal failure in the registry without touching authorize's return", async () => {
    connectionRequestBody = { status: "expired" };
    const state = newState();
    const result = await provider(state, { intervalMs: 10 }).authorize(cfg, "github");
    expect(result.url).toBe("https://provider.example.test/authorize");
    await vi.waitFor(() => {
      expect(state.findConnectionByAccountId("oc:github:default")).toMatchObject({ status: "expired" });
    }, { timeout: 5_000, interval: 20 });
  });

  it("marks the record error when polling itself fails, still without touching authorize's return", async () => {
    connectionRequestStatus = 500;
    const state = newState();
    const result = await provider(state, { intervalMs: 10 }).authorize(cfg, "github");
    expect(result.connectionRequestId).toBe("cr_9");
    await vi.waitFor(() => {
      const record = state.findConnectionByAccountId("oc:github:default");
      expect(record).toMatchObject({ status: "error" });
      expect(record!.lastError).toBeTruthy();
    }, { timeout: 5_000, interval: 20 });
  });

  it("polls one authorization request at a time per connection request id", async () => {
    gateConnectionRequests = true;
    const state = newState();
    const one = provider(state, { intervalMs: 10 });
    await one.authorize(cfg, "github", "work");
    await vi.waitFor(() => {
      expect(requestPollCalls().length).toBeGreaterThanOrEqual(1);
    }, { timeout: 5_000, interval: 20 });
    const polled = requestPollCalls().length;
    await one.authorize(cfg, "github", "work");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(requestPollCalls().length).toBe(polled);
    connectionRequestBody = { status: "connected" };
    gateConnectionRequests = false;
    releaseGate?.();
    await vi.waitFor(() => {
      expect(state.findConnectionByAccountId("oc:github:work")).toMatchObject({ status: "connected" });
    }, { timeout: 5_000, interval: 20 });
  });

  it("resumes polling a persisted pending request after provider restart", async () => {
    gateConnectionRequests = true;
    const state = newState();
    state.upsertConnection({
      accountId: "oc:github:restart", service: "github", alias: "restart",
      connectionRequestId: "cr_restart", status: "pending", updatedAt: "t",
    });
    provider(state, { intervalMs: 10 });
    await vi.waitFor(() => {
      expect(requestPollCalls().some((call) => call.path.includes("cr_restart"))).toBe(true);
    }, { timeout: 5_000, interval: 20 });
    connectionRequestBody = { status: "connected" };
    gateConnectionRequests = false;
    releaseGate?.();
    await vi.waitFor(() => {
      expect(state.findConnectionByAccountId("oc:github:restart")).toMatchObject({ status: "connected" });
    }, { timeout: 5_000, interval: 20 });
  });

  it("silently abandons background polling after the runtime state switches", async () => {
    const state = new OpenConnectorStateStore(join(dir, `mismatch-${Math.random().toString(36).slice(2)}.json`), "https://first.example.test");
    state.upsertConnection({
      accountId: "oc:github:mismatch",
      service: "github",
      connectionRequestId: "cr_mismatch",
      status: "pending",
      updatedAt: "first-runtime",
    });
    connectionRequestStatus = 500;
    gateConnectionRequests = true;
    const unhandled: Array<unknown> = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    createOpenConnectorProvider({
      settings: { url: origin, adminTokenRef: "env:STUB_ADMIN" },
      env: { STUB_ADMIN: "admintok" },
      state,
      polling: { intervalMs: 10 },
    });
    try {
      await vi.waitFor(() => {
        expect(requestPollCalls().some((call) => call.path.includes("cr_mismatch"))).toBe(true);
      }, { timeout: 5_000, interval: 20 });

      const replaced = {
        runtimeUrl: "https://second.example.test",
        connections: [{
          accountId: "oc:linear:new",
          service: "linear",
          connectionRequestId: "cr_new",
          status: "pending",
          updatedAt: "second-runtime",
        }],
        appOAuth: [],
      };
      const before = JSON.stringify(replaced);
      writeFileSync(state.file, before, { mode: 0o600 });
      gateConnectionRequests = false;
      releaseGate?.();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(unhandled).toEqual([]);
      expect(readFileSync(state.file, "utf8")).toBe(before);
      expect(new OpenConnectorStateStore(state.file, "https://second.example.test").listConnections()).toEqual([
        expect.objectContaining({ accountId: "oc:linear:new", status: "pending" }),
      ]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      gateConnectionRequests = false;
      releaseGate = null;
      connectionRequestStatus = 200;
    }
  });

  it("defers polling while unavailable and resumes when the token becomes available", async () => {
    const env: NodeJS.ProcessEnv = {};
    const state = newState();
    state.upsertConnection({
      accountId: "oc:github:deferred", service: "github", alias: "deferred",
      connectionRequestId: "cr_deferred", status: "pending", updatedAt: "t",
    });
    createOpenConnectorProvider({
      settings: { url: origin, adminTokenRef: "env:STUB_ADMIN" },
      env,
      state,
      polling: { intervalMs: 1, resumeIntervalMs: 10 },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requestPollCalls()).toEqual([]);
    expect(state.findConnectionByAccountId("oc:github:deferred")).toMatchObject({ status: "pending" });
    env.STUB_ADMIN = "admintok";
    await vi.waitFor(() => {
      expect(requestPollCalls().some((call) => call.path.includes("cr_deferred"))).toBe(true);
      expect(state.findConnectionByAccountId("oc:github:deferred")).toMatchObject({ status: "connected" });
    }, { timeout: 5_000, interval: 20 });
  });
});

describe("relayMcp translation", () => {
  it("answers initialize locally", async () => {
    const frame = JSON.parse(new TextDecoder().decode((await provider().relayMcp(cfg, {
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" },
    })).bytes));
    expect(frame.result.serverInfo.name).toBe("openconnector");
    expect(frame.result.protocolVersion).toBe("2025-03-26");
  });

  it("serves tools/list from GET /v1/actions with mapped names", async () => {
    const relayed = await provider().relayMcp(cfg, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const frame = JSON.parse(new TextDecoder().decode(relayed.bytes));
    expect(frame.result.tools).toEqual([
      { name: "GITHUB_GET_CURRENT_USER", description: "Who am I", inputSchema: { type: "object", properties: { verbose: { type: "boolean" } } } },
      { name: "GITHUB_CREATE_ISSUE", description: "Open an issue", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
      { name: "GMAIL_LIST_EMAILS", inputSchema: { type: "object", properties: {}, additionalProperties: false, required: [] } },
    ]);
    expect(calls.some((call) => call.path === "/v1/actions")).toBe(true);
  });

  it("maps tools/call to POST /v1/actions/:id and wraps the result", async () => {
    const relayed = await provider().relayMcp(cfg, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "GITHUB_GET_CURRENT_USER", arguments: { verbose: true } },
    });
    const frame = JSON.parse(new TextDecoder().decode(relayed.bytes));
    expect(frame.result.isError).toBe(false);
    expect(JSON.parse(frame.result.content[0].text)).toEqual({ ran: "github.get_current_user", input: { verbose: true } });
    expect(lastCall()).toMatchObject({ method: "POST", path: "/v1/actions/github.get_current_user" });
    expect(calls.filter((call) => call.method === "GET" && call.path.startsWith("/v1/actions/"))).toEqual([]);
  });

  it("refuses an unmapped tool name without executing an action", async () => {
    const relayed = await provider().relayMcp(cfg, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "NOPE", arguments: {} } });
    const frame = JSON.parse(new TextDecoder().decode(relayed.bytes));
    expect(frame.error.message).toContain("Unknown connector tool");
    expect(calls.some((call) => call.method === "POST" && call.path.startsWith("/v1/actions/"))).toBe(false);
  });

  it("carries an explicitly selected account into the action call and rejects ambiguity", async () => {
    const state = newState();
    state.upsertConnection({ accountId: "oc:github:default", service: "github", status: "ACTIVE", updatedAt: "t" });
    state.upsertConnection({ accountId: "oc:github:work", service: "github", alias: "work", status: "ACTIVE", updatedAt: "t" });
    const selected = await provider(state).relayMcp(cfg, {
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "GITHUB_GET_CURRENT_USER", arguments: {}, _meta: { openconnectorAccountAlias: "work" } },
    });
    const selectedFrame = JSON.parse(new TextDecoder().decode(selected.bytes));
    expect(selectedFrame.result.isError).toBe(false);
    expect(lastCall()).toMatchObject({ path: "/v1/actions/github.get_current_user?alias=work" });
    const ambiguous = await provider(state).relayMcp(cfg, {
      jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "GITHUB_GET_CURRENT_USER", arguments: {} },
    });
    const ambiguousFrame = JSON.parse(new TextDecoder().decode(ambiguous.bytes));
    expect(ambiguous.status).toBe(200);
    expect(ambiguousFrame.result.isError).toBe(true);
    expect(ambiguousFrame.result.content[0].text).toContain("_meta.openconnectorAccountAlias");
    const missing = await provider(state).relayMcp(cfg, {
      jsonrpc: "2.0", id: 9, method: "tools/call",
      params: { name: "GITHUB_GET_CURRENT_USER", arguments: {}, _meta: { openconnectorAccountAlias: "missing" } },
    });
    const missingFrame = JSON.parse(new TextDecoder().decode(missing.bytes));
    expect(missingFrame.result.isError).toBe(true);
    expect(missingFrame.result.content[0].text).toContain("missing");
  });

  it("maps an action-like suffix by exact catalog identity", async () => {
    actionsBody = [{ id: "google.calendar_list", inputSchema: { type: "object" } }];
    const relayed = await provider().relayMcp(cfg, {
      jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "GOOGLE_CALENDAR_LIST", arguments: {} },
    });
    const frame = JSON.parse(new TextDecoder().decode(relayed.bytes));
    expect(frame.result.isError).toBe(false);
    expect(lastCall()).toMatchObject({ path: "/v1/actions/google.calendar_list" });
  });

  it("returns an action failure as an MCP tool result", async () => {
    actionsBody = [{ id: "github.get_current_user" }];
    const failing = createOpenConnectorProvider({
      settings: { url: origin, adminTokenRef: "env:STUB_ADMIN" },
      env: { STUB_ADMIN: "admintok" },
      state: newState(),
      fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/v1/actions/") && init?.method === "POST") return new Response(JSON.stringify({ success: false, message: "credential_expired", errorCode: "credential_expired" }), { status: 400 });
        return fetch(input, init);
      }) as typeof fetch,
    });
    const relayed = await failing.relayMcp(cfg, {
      jsonrpc: "2.0", id: 11, method: "tools/call",
      params: { name: "GITHUB_GET_CURRENT_USER", arguments: {} },
    });
    expect(relayed.status).toBe(200);
    const frame = JSON.parse(new TextDecoder().decode(relayed.bytes));
    expect(frame.result.isError).toBe(true);
    expect(frame.result.content[0].text).toBe("credential_expired");
  });

  it("rejects unknown methods as JSON-RPC method-not-found", async () => {
    const relayed = await provider().relayMcp(cfg, { jsonrpc: "2.0", id: 6, method: "resources/read", params: {} });
    const frame = JSON.parse(new TextDecoder().decode(relayed.bytes));
    expect(frame.error.code).toBe(-32601);
  });
});
