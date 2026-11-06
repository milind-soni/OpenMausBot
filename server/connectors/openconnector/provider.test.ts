// The OpenConnector provider behind the ConnectorProvider seam. A stub runtime on an ephemeral
// port answers every call; the state store lives in a temp dir. No port 3000, no real runtime.
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../config.ts";
import { createOpenConnectorProvider, resolveAdminToken } from "./provider.ts";
import { OpenConnectorStateStore } from "./state.ts";

let api: Server;
let origin = "";
let dir = "";
const calls: Array<{ method: string; path: string; body: unknown }> = [];
let providersBody: unknown = [{ id: "github", name: "GitHub" }, { id: "gmail", name: "Gmail" }];
let actionsBody: unknown = [{ id: "github.get_current_user", description: "Who am I" }, { id: "github.create_issue", description: "Open an issue" }, { id: "gmail.list_emails" }];
let authenticatedBody: unknown = ["github"];
let failConnect = false;

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
    if (url.pathname.startsWith("/v1/actions/") && req.method === "POST") return ok({ ran: url.pathname.slice("/v1/actions/".length), input: (calls.at(-1)!.body as { input?: unknown }).input });
    if (url.pathname.startsWith("/v1/connections/") && req.method === "POST") {
      if (failConnect) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ success: false, message: "oauth not configured", errorCode: "oauth_config_missing" }));
      }
      return ok({ connectionRequestId: "cr_9", authorizationUrl: "https://provider.example.test/authorize" });
    }
    if (url.pathname.startsWith("/v1/connection-requests/")) return ok({ status: "connected" });
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
  actionsBody = [{ id: "github.get_current_user", description: "Who am I" }, { id: "github.create_issue", description: "Open an issue" }, { id: "gmail.list_emails" }];
  authenticatedBody = ["github"];
  failConnect = false;
});

const cfg = {} as AppConfig;
const newState = () => new OpenConnectorStateStore(join(dir, `state-${Math.random().toString(36).slice(2)}.json`));
const provider = (state = newState()) => createOpenConnectorProvider({
  settings: { url: origin, adminTokenRef: "env:STUB_ADMIN" },
  env: { STUB_ADMIN: "admintok" },
  state,
});
const lastCall = () => calls.at(-1)!;

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
  });
});

describe("tools / catalog", () => {
  it("groups actions under toolkit slugs with pattern-compliant names", async () => {
    const tools = await provider().tools(cfg);
    expect(tools.github).toEqual([
      { name: "GITHUB_CREATE_ISSUE", description: "Open an issue" },
      { name: "GITHUB_GET_CURRENT_USER", description: "Who am I" },
    ]);
    expect(tools.gmail).toEqual([{ name: "GMAIL_LIST_EMAILS" }]);
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

  it("removeService answers removed:0 when the runtime has no connection", async () => {
    const state = newState();
    await expect(provider(state).removeService(cfg, "github")).resolves.toEqual({ removed: 1 });
    await expect(provider(newState()).removeService(cfg, "ghost")).resolves.toEqual({ removed: 0 });
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
    expect(lastCall()).toMatchObject({ method: "POST", path: "/v1/connections/github/connect", body: { connectionName: "work" } });
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
      { name: "GITHUB_GET_CURRENT_USER", description: "Who am I" },
      { name: "GITHUB_CREATE_ISSUE", description: "Open an issue" },
      { name: "GMAIL_LIST_EMAILS" },
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
  });

  it("refuses an unmapped tool name without executing an action", async () => {
    const relayed = await provider().relayMcp(cfg, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "NOPE", arguments: {} } });
    const frame = JSON.parse(new TextDecoder().decode(relayed.bytes));
    expect(frame.error.message).toContain("Unknown connector tool");
    expect(calls.some((call) => call.method === "POST" && call.path.startsWith("/v1/actions/"))).toBe(false);
  });

  it("returns an MCP error frame with the upstream status when the action fails", async () => {
    actionsBody = [{ id: "github.get_current_user" }];
    const failing = createOpenConnectorProvider({
      settings: { url: origin, adminTokenRef: "env:STUB_ADMIN" },
      env: { STUB_ADMIN: "admintok" },
      state: newState(),
      fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/v1/actions/")) return new Response(JSON.stringify({ success: false, message: "credential_expired", errorCode: "credential_expired" }), { status: 400 });
        return fetch(input, init);
      }) as typeof fetch,
    });
    const relayed = await failing.relayMcp(cfg, {
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "GITHUB_GET_CURRENT_USER", arguments: {} },
    });
    expect(relayed.status).toBe(400);
    const frame = JSON.parse(new TextDecoder().decode(relayed.bytes));
    expect(frame.error.message).toBe("credential_expired");
  });

  it("rejects unknown methods as JSON-RPC method-not-found", async () => {
    const relayed = await provider().relayMcp(cfg, { jsonrpc: "2.0", id: 6, method: "resources/read", params: {} });
    const frame = JSON.parse(new TextDecoder().decode(relayed.bytes));
    expect(frame.error.code).toBe(-32601);
  });
});
