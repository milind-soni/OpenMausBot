import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.ts";
import {
  applyManagedBrokerMessage,
  authorizeService,
  connectedServices,
  connectionMode,
  connectionStatus,
  listToolkits,
  mcpIntegration,
  normalizeAccountAlias,
  prepareProjectSession,
  removeAccount,
  removeService,
  relayMcp,
  setManagedBrokerAccess,
} from "./composio.ts";

let api: Server;
let origin = "";
let base = "";
const calls: Array<{
  method: string;
  path: string;
  query: string;
  body: any;
  apiKey: string;
  transportSessionId: string;
}> = [];
let malformedConnectedAccounts = false;
let connectedAccountsUnavailable = false;
let emptyConnectedAccounts = false;
// The project's own auth configs, and the ones the stub Session was created
// with — a Session only knows the configs named at its creation, which is
// the whole reason #509 happened.
let customAuthConfigs: Array<Record<string, unknown>> = [];
let sessionAuthConfigs: Record<string, string> = {};

beforeAll(async () => {
  api = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.search,
      body,
      apiKey: String(req.headers["x-api-key"] ?? ""),
      transportSessionId: String(req.headers["mcp-session-id"] ?? ""),
    });

    if (url.pathname.startsWith("/broker/")) {
      if (req.headers.authorization !== `Bearer ${"a".repeat(64)}`) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid broker token" }));
      }
      if (req.method === "GET" && url.pathname === "/broker/v1/connectors") {
        const services = Object.fromEntries(
          (url.searchParams.get("services") ?? "").split(",").filter(Boolean).map((slug) => [
            slug,
            { connected: slug === "github", status: slug === "github" ? "ACTIVE" : "not_connected" },
          ]),
        );
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ services }));
      }
      if (req.method === "GET" && url.pathname === "/broker/v1/connectors/connected") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ services: { github: { connected: true, status: "ACTIVE" } } }));
      }
      if (req.method === "POST" && url.pathname.endsWith("/authorize")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ url: "https://connect.composio.dev/managed" }));
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/broker/v1/connectors/")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ removed: 1 }));
      }
      if (req.method === "GET" && url.pathname === "/broker/v1/catalog") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ items: [{ slug: "github", name: "GitHub" }] }));
      }
      if (req.method === "POST" && url.pathname === "/broker/v1/mcp") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "mcp_broker" });
        return res.end(JSON.stringify({ source: "broker" }));
      }
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unknown broker route" }));
    }

    const apiKey = String(req.headers["x-api-key"] ?? "");
    if (!["ak_test", "ak_catalog_a", "ak_catalog_b", "ak_catalog_pages", "ak_catalog_partial", "ak_catalog_stuck"].includes(apiKey)) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "invalid project key" } }));
    }

    if (req.method === "POST" && url.pathname === "/api/v3.1/tool_router/session") {
      sessionAuthConfigs = body.auth_configs ?? {};
      res.writeHead(201, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        session_id: "trs_test",
        mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_test/mcp" },
        config: { user_id: body.user_id, multi_account: body.multi_account, auth_configs: sessionAuthConfigs },
      }));
    }
    if (
      req.method === "GET" && url.pathname === "/api/v3/toolkits"
      && (apiKey === "ak_catalog_pages" || apiKey === "ak_catalog_partial" || apiKey === "ak_catalog_stuck")
    ) {
      if (apiKey === "ak_catalog_stuck") {
        // A broker deployed before this fix ignores the cursor and replays page one.
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ items: [{ slug: "gmail", name: "Gmail" }], next_cursor: "catalog-page-2" }));
      }
      // Mirrors the real marketplace: a usage-sorted head, then an alphabetical
      // tail only a second page reaches. ak_catalog_partial loses that page.
      if (url.searchParams.get("cursor") === "catalog-page-2") {
        if (apiKey === "ak_catalog_partial") {
          res.writeHead(502, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "catalog page unavailable" }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          items: [{ slug: "deepgram", name: "Deepgram" }, { slug: "zoom", name: "Zoom" }],
        }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        items: [
          { slug: "gmail", name: "Gmail" },
          { slug: "bland_ai", name: "Bland AI" },
          { slug: "currencyscoop", name: "CurrencyScoop" },
        ],
        next_cursor: "catalog-page-2",
      }));
    }
    if (req.method === "GET" && url.pathname === "/api/v3/toolkits") {
      res.writeHead(200, { "content-type": "application/json" });
      if (apiKey === "ak_catalog_a") {
        return res.end(JSON.stringify({ items: [{ slug: "notion", name: "Catalog A" }] }));
      }
      if (apiKey === "ak_catalog_b") {
        return res.end(JSON.stringify({ items: [{ slug: "linear", name: "Catalog B" }] }));
      }
      return res.end(JSON.stringify({ items: [{ slug: "x", name: "X (Twitter)" }, { slug: "github", name: "GitHub" }] }));
    }
    if (req.method === "GET" && url.pathname === "/api/v3.1/tool_router/session/trs_test") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        session_id: "trs_test",
        mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_test/mcp" },
        config: {
          user_id: "openmausbot_existing",
          multi_account: {
            enable: true,
            max_accounts_per_toolkit: 5,
            require_explicit_selection: true,
          },
          auth_configs: sessionAuthConfigs,
        },
      }));
    }
    if (req.method === "GET" && url.pathname === "/api/v3.1/auth_configs") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ items: customAuthConfigs }));
    }
    if (req.method === "GET" && url.pathname === "/api/v3.1/tool_router/session/trs_legacy") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        session_id: "trs_legacy",
        mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_legacy/mcp" },
        config: { user_id: "openmausbot_legacy" },
      }));
    }
    if (req.method === "GET" && url.pathname.endsWith("/toolkits")) {
      res.writeHead(200, { "content-type": "application/json" });
      if (url.searchParams.get("cursor") === "toolkits-page-2") {
        return res.end(JSON.stringify({
          items: [
            { slug: "publicsearch", is_no_auth: true },
            { slug: "selectedonly", connected_account: { id: "ca_session_only", status: "ACTIVE" } },
          ],
        }));
      }
      const page = {
        items: [
          { slug: "github", connected_account: { id: "ca_github", status: "ACTIVE" } },
          { slug: "gmail", is_no_auth: true },
          { slug: "slack" },
          { slug: "unconnected", connected_account: null },
        ],
        next_cursor: url.searchParams.has("toolkits") ? undefined : "toolkits-page-2",
      };
      return res.end(JSON.stringify(page));
    }
    if (req.method === "GET" && url.pathname === "/api/v3.1/connected_accounts") {
      if (connectedAccountsUnavailable) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "connected-account read not granted" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (malformedConnectedAccounts) return res.end(JSON.stringify({ items: {} }));
      if (emptyConnectedAccounts) return res.end(JSON.stringify({ items: [] }));
      if (url.searchParams.get("cursor") === "accounts-page-2") {
        return res.end(JSON.stringify({
          items: [
            { id: "ca_toolkit_41", alias: "overflow", toolkit: { slug: "toolkit_41" }, status: "ACTIVE", updated_at: "2026-08-17T10:00:00Z" },
          ],
        }));
      }
      return res.end(JSON.stringify({
        items: [
          { id: "ca_github_work", alias: "work", toolkit: { slug: "github" }, status: "ACTIVE", updated_at: "2026-08-17T08:00:00Z" },
          { id: "ca_github_personal", alias: "personal", toolkit: { slug: "github" }, status: "ACTIVE", updated_at: "2026-08-17T09:00:00Z" },
          { id: "ca_notion", alias: "team", toolkit: { slug: "notion" }, status: "INITIATED", updated_at: "2026-08-17T08:01:00Z" },
          { id: "ca_linear", toolkit: { slug: "linear" }, status: "EXPIRED", updated_at: "2026-08-17T08:02:00Z" },
        ],
        next_cursor: "accounts-page-2",
      }));
    }
    if (req.method === "POST" && url.pathname.endsWith("/link")) {
      // twitter has no Composio-managed auth: the link only works when the
      // Session was created with the project's own config for it
      if (body.toolkit === "twitter" && !sessionAuthConfigs.twitter) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          error: {
            message:
              "Composio does not manage auth for toolkit twitter and no auth config without required fields is available. "
              + "Please create an auth config manually or specify one in auth_config_override.",
          },
        }));
      }
      res.writeHead(201, { "content-type": "application/json" });
      return res.end(JSON.stringify({ redirect_url: `https://connect.composio.dev/link/${body.toolkit}` }));
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/v3.1/connected_accounts/ca_")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ success: true }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  base = `${origin}/api/v3.1`;
  process.env.OMB_COMPOSIO_API = base;
  process.env.OMB_COMPOSIO_TOOLKITS_API = `${origin}/api/v3`;
});

afterAll(async () => {
  setManagedBrokerAccess(null);
  delete process.env.OMB_COMPOSIO_API;
  delete process.env.OMB_COMPOSIO_TOOLKITS_API;
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

describe.sequential("Composio Sessions", () => {
  it("rejects broker URL components and invalid tokens from the environment", () => {
    process.env.OMB_COMPOSIO_BROKER_TOKEN = "a".repeat(64);
    try {
      for (const url of [
        "https://user:secret@broker.example/root",
        "https://broker.example/root?redirect=evil",
        "https://broker.example/root#fragment",
      ]) {
        process.env.OMB_COMPOSIO_BROKER_URL = url;
        expect(() => connectionMode({})).toThrow(/must not include/);
      }
      process.env.OMB_COMPOSIO_BROKER_URL = "http://[::1]:3210/root/";
      expect(connectionMode({})).toBe("managed");
      process.env.OMB_COMPOSIO_BROKER_TOKEN = "short";
      expect(() => connectionMode({})).toThrow(/token is invalid/);
    } finally {
      delete process.env.OMB_COMPOSIO_BROKER_URL;
      delete process.env.OMB_COMPOSIO_BROKER_TOKEN;
    }
  });
  it("accepts a private desktop credential update and rejects unsafe broker URLs", () => {
    setManagedBrokerAccess({ url: "http://127.0.0.1:3210/", token: "a".repeat(64) });
    expect(connectionMode({})).toBe("managed");
    setManagedBrokerAccess({ url: "http://[::1]:3210/", token: "a".repeat(64) });
    expect(connectionMode({})).toBe("managed");
    expect(() =>
      setManagedBrokerAccess({ url: "http://broker.example", token: "a".repeat(64) }),
    ).toThrow(/HTTPS/);
    for (const url of [
      "https://user:secret@broker.example/root",
      "https://broker.example/root?redirect=evil",
      "https://broker.example/root#fragment",
    ]) {
      expect(() => setManagedBrokerAccess({ url, token: "a".repeat(64) })).toThrow(/must not include/);
    }
    expect(() => setManagedBrokerAccess({ url: "https://broker.example", token: "short" })).toThrow();
    setManagedBrokerAccess(null);
  });
  it("ignores credential sync without access and clears only on explicit null", () => {
    const messageType = "openmausbot:managed-composio";
    setManagedBrokerAccess({ url: "http://127.0.0.1:3210/", token: "a".repeat(64) });

    expect(applyManagedBrokerMessage({ type: messageType })).toBe(false);
    expect(connectionMode({})).toBe("managed");

    expect(applyManagedBrokerMessage({ type: messageType, access: null })).toBe(true);
    expect(connectionMode({})).toBe("unavailable");
  });

  it("does not reuse a self-hosted catalog after the project key changes", async () => {
    const before = calls.length;
    const first = await listToolkits({ composio: { apiKey: "ak_catalog_a" } });
    const second = await listToolkits({ composio: { apiKey: "ak_catalog_b" } });

    expect(first.cards).toEqual([expect.objectContaining({ slug: "notion", label: "Catalog A" })]);
    expect(second.cards).toEqual([expect.objectContaining({ slug: "linear", label: "Catalog B" })]);
    expect(calls.slice(before).filter((call) => call.path === "/api/v3/toolkits").map((call) => call.apiKey)).toEqual([
      "ak_catalog_a",
      "ak_catalog_b",
    ]);
  });

  it("pages the marketplace catalog past the first page", async () => {
    const before = calls.length;
    const { cards } = await listToolkits({ composio: { apiKey: "ak_catalog_pages" } });

    // "Deepgram" only exists on page two: #634 saw the catalog stop at "CurrencyScoop".
    expect(cards.map((card) => card.slug)).toEqual(["gmail", "bland_ai", "currencyscoop", "deepgram", "zoom"]);
    const pages = calls.slice(before).filter((call) => call.path === "/api/v3/toolkits");
    expect(pages).toHaveLength(2);
    expect(pages[0]?.query).not.toContain("cursor=");
    expect(pages[1]?.query).toContain("cursor=catalog-page-2");
  });

  it("keeps the catalog pages already read when a later page fails", async () => {
    await expect(listToolkits({ composio: { apiKey: "ak_catalog_partial" } })).resolves.toMatchObject({
      source: "api",
      cards: [{ slug: "gmail" }, { slug: "bland_ai" }, { slug: "currencyscoop" }],
    });
  });

  it("stops paging a catalog endpoint that replays the same cursor", async () => {
    const before = calls.length;
    const { cards } = await listToolkits({ composio: { apiKey: "ak_catalog_stuck" } });

    expect(cards).toEqual([expect.objectContaining({ slug: "gmail" })]);
    expect(calls.slice(before).filter((call) => call.path === "/api/v3/toolkits")).toHaveLength(2);
  });

  it("drops a managed MCP session when routing switches to a user project", async () => {
    setManagedBrokerAccess({ url: `${origin}/broker`, token: "a".repeat(64) });
    const projectSessions: string[] = [];
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      if (url.startsWith("https://app.composio.dev/tool_router/")) {
        projectSessions.push(new Headers(init?.headers).get("mcp-session-id") ?? "");
        return new Response(JSON.stringify({ source: "project" }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "mcp_project_after_managed" },
        });
      }
      return realFetch(input, init);
    });
    try {
      const managed = await relayMcp({}, { jsonrpc: "2.0", id: 101, method: "tools/list" });
      expect(managed.transportSessionId).toBe("mcp_broker");
      await relayMcp(
        {},
        { jsonrpc: "2.0", id: 105, method: "tools/list" },
        managed.transportSessionId,
      );
      expect(calls.findLast((call) => call.path === "/broker/v1/mcp" && call.body?.id === 105)?.transportSessionId)
        .toBe("mcp_broker");
      const project = await relayMcp(
        { composio: { apiKey: "ak_test", userId: "openmausbot_existing", sessionId: "trs_test" } },
        { jsonrpc: "2.0", id: 102, method: "tools/list" },
        managed.transportSessionId,
      );
      expect(project.transportSessionId).toBe("mcp_project_after_managed");
      expect(projectSessions).toEqual([""]);
    } finally {
      fetchSpy.mockRestore();
      setManagedBrokerAccess(null);
    }
  });

  it("drops a project MCP session when routing switches to the managed broker", async () => {
    setManagedBrokerAccess({ url: `${origin}/broker`, token: "a".repeat(64) });
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      if (url.startsWith("https://app.composio.dev/tool_router/")) {
        return new Response(JSON.stringify({ source: "project" }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "mcp_project_before_managed" },
        });
      }
      return realFetch(input, init);
    });
    try {
      const project = await relayMcp(
        { composio: { apiKey: "ak_test", userId: "openmausbot_existing", sessionId: "trs_test" } },
        { jsonrpc: "2.0", id: 103, method: "tools/list" },
      );
      expect(project.transportSessionId).toBe("mcp_project_before_managed");
      await relayMcp(
        {},
        { jsonrpc: "2.0", id: 104, method: "tools/list" },
        project.transportSessionId,
      );
      expect(calls.findLast((call) => call.path === "/broker/v1/mcp" && call.body?.id === 104)?.transportSessionId).toBe("");
    } finally {
      fetchSpy.mockRestore();
      setManagedBrokerAccess(null);
    }
  });

  it("uses a user-owned project for every connector operation even when the managed broker is available", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "openmausbot_existing", sessionId: "trs_test" },
    };
    setManagedBrokerAccess({ url: `${origin}/broker`, token: "a".repeat(64) });
    const before = calls.length;
    const realFetch = globalThis.fetch;
    const mcpRequests: Array<{ url: string; apiKey: string | null }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      if (url.startsWith("https://app.composio.dev/tool_router/")) {
        mcpRequests.push({ url, apiKey: new Headers(init?.headers).get("x-api-key") });
        return new Response(JSON.stringify({ source: "project" }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "mcp_project" },
        });
      }
      return realFetch(input, init);
    });

    try {
      expect(connectionMode(cfg)).toBe("self-hosted");
      await expect(listToolkits(cfg)).resolves.toMatchObject({
        source: "api",
        cards: [{ slug: "twitter" }, { slug: "github" }],
      });
      await expect(connectedServices(cfg)).resolves.toHaveProperty("github.connected", true);
      await expect(connectionStatus(cfg, ["slack"])).resolves.toHaveProperty("slack.connected", false);
      await expect(authorizeService(cfg, "slack")).resolves.toEqual({
        url: "https://connect.composio.dev/link/slack",
      });
      await expect(removeAccount(cfg, "github", "ca_github_personal")).resolves.toEqual({ removed: 1 });
      await expect(removeService(cfg, "github")).resolves.toEqual({ removed: 1 });
      const relayed = await relayMcp(cfg, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(JSON.parse(new TextDecoder().decode(relayed.bytes))).toEqual({ source: "project" });
      expect(relayed.transportSessionId).toBe("mcp_project");

      expect(mcpRequests).toEqual([{
        url: "https://app.composio.dev/tool_router/v3/trs_test/mcp",
        apiKey: "ak_test",
      }]);
      const since = calls.slice(before);
      expect(since.some((call) => call.path === "/api/v3.1/tool_router/session/trs_test")).toBe(true);
      expect(since.some((call) => call.path.startsWith("/broker/"))).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      setManagedBrokerAccess(null);
    }
  });

  it("accepts the legacy x alias but authorizes Composio's twitter toolkit", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "openmausbot_existing", sessionId: "trs_test" },
    };
    sessionAuthConfigs = { twitter: "ac_twitter" };
    setManagedBrokerAccess({ url: `${origin}/broker`, token: "a".repeat(64) });
    const before = calls.length;
    try {
      await expect(authorizeService(cfg, "x")).resolves.toEqual({
        url: "https://connect.composio.dev/link/twitter",
      });
      await expect(connectionStatus(cfg, ["x"])).resolves.toHaveProperty("x.connected", false);
      await expect(removeService(cfg, "x")).resolves.toEqual({ removed: 0 });
      const catalog = await listToolkits(cfg);
      expect(catalog.cards).toContainEqual(expect.objectContaining({ slug: "twitter" }));

      const since = calls.slice(before);
      expect(since.filter((call) => call.method === "POST" && call.path.endsWith("/link")).at(-1)?.body).toEqual({
        toolkit: "twitter",
      });
      expect(since.some((call) => call.query.includes("toolkits=twitter"))).toBe(true);
      expect(since.some((call) => call.path.startsWith("/broker/"))).toBe(false);
    } finally {
      sessionAuthConfigs = {};
      setManagedBrokerAccess(null);
    }
  });

  it("falls back to the managed broker immediately after the project key is cleared", async () => {
    const cfg: AppConfig = { composio: { apiKey: "" } };
    setManagedBrokerAccess({ url: `${origin}/broker`, token: "a".repeat(64) });
    const before = calls.length;
    try {
      expect(connectionMode(cfg)).toBe("managed");
      await expect(connectionStatus(cfg, ["github"])).resolves.toHaveProperty("github.connected", true);
      await expect(authorizeService(cfg, "github")).resolves.toEqual({
        url: "https://connect.composio.dev/managed",
      });
      await expect(listToolkits(cfg)).resolves.toMatchObject({ source: "api", cards: [{ slug: "github" }] });
      const relayed = await relayMcp(cfg, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(JSON.parse(new TextDecoder().decode(relayed.bytes))).toEqual({ source: "broker" });

      const brokerCalls = calls.slice(before).filter((call) => call.path.startsWith("/broker/"));
      expect(brokerCalls.map((call) => `${call.method} ${call.path}`)).toEqual([
        "GET /broker/v1/connectors",
        "POST /broker/v1/connectors/github/authorize",
        "GET /broker/v1/catalog",
        "POST /broker/v1/mcp",
      ]);
    } finally {
      setManagedBrokerAccess(null);
    }
  });

  it("accepts only project API keys", async () => {
    await expect(prepareProjectSession("old_key")).rejects.toThrow(/start with ak_/i);
    await expect(prepareProjectSession("ak_wrong")).rejects.toThrow(/invalid project key/i);
  });

  it("creates one stable per-installation session and reuses it", async () => {
    const created = await prepareProjectSession("ak_test", { userId: "openmausbot_existing" });
    expect(created).toEqual({
      apiKey: "ak_test",
      userId: "openmausbot_existing",
      sessionId: "trs_test",
    });
    expect(calls.filter((call) => call.method === "POST" && call.path.endsWith("/session")).at(-1)?.body).toEqual({
      user_id: "openmausbot_existing",
      manage_connections: {
        enable: true,
        enable_wait_for_connections: true,
        enable_connection_removal: true,
      },
      multi_account: {
        enable: true,
        max_accounts_per_toolkit: 5,
        require_explicit_selection: true,
      },
    });

    const reused = await prepareProjectSession("ak_test", created);
    expect(reused).toEqual({
      apiKey: "ak_test",
      userId: "openmausbot_existing",
      sessionId: "trs_test",
    });
  });

  it("recreates a legacy Session with the same Composio user ID", async () => {
    const upgraded = await prepareProjectSession("ak_test", {
      apiKey: "ak_test",
      userId: "stale-local-user-id",
      sessionId: "trs_legacy",
    });
    expect(upgraded).toEqual({
      apiKey: "ak_test",
      userId: "openmausbot_legacy",
      sessionId: "trs_test",
    });
    expect(calls.filter((call) => call.method === "POST" && call.path.endsWith("/session")).at(-1)?.body).toMatchObject({
      user_id: "openmausbot_legacy",
      multi_account: {
        enable: true,
        max_accounts_per_toolkit: 5,
        require_explicit_selection: true,
      },
    });
  });

  it("names the project's own auth configs at creation and rebuilds a Session that predates them", async () => {
    customAuthConfigs = [
      { id: "ac_twitter_old", toolkit: { slug: "twitter" }, is_composio_managed: false, status: "ENABLED", last_updated_at: "2026-08-20T00:00:00Z" },
      // newest wins, and the slug is matched case-insensitively
      { id: "ac_twitter", toolkit: { slug: "TWITTER" }, is_composio_managed: false, status: "ENABLED", last_updated_at: "2026-08-25T00:00:00Z" },
      // Composio-managed, disabled, and switched-off-for-Sessions configs are not the user's choice
      { id: "ac_github_managed", toolkit: { slug: "github" }, is_composio_managed: true, status: "ENABLED" },
      { id: "ac_slack_disabled", toolkit: { slug: "slack" }, is_composio_managed: false, status: "DISABLED" },
      { id: "ac_notion_off", toolkit: { slug: "notion" }, is_composio_managed: false, is_enabled_for_tool_router: false },
    ];
    sessionAuthConfigs = {};
    try {
      const current = { apiKey: "ak_test", userId: "openmausbot_existing", sessionId: "trs_test" };
      const before = calls.length;
      await expect(prepareProjectSession("ak_test", current)).resolves.toEqual({ ...current });
      const creates = calls.slice(before).filter((call) => call.method === "POST" && call.path.endsWith("/session"));
      expect(creates).toHaveLength(1);
      expect(creates[0].body).toMatchObject({ user_id: "openmausbot_existing", auth_configs: { twitter: "ac_twitter" } });
      // the rebuilt Session now covers the configs, so the next check reuses it
      const after = calls.length;
      await prepareProjectSession("ak_test", current);
      expect(calls.slice(after).some((call) => call.method === "POST" && call.path.endsWith("/session"))).toBe(false);
    } finally {
      customAuthConfigs = [];
      sessionAuthConfigs = {};
    }
  });

  it("rebuilds the Session and retries when a toolkit needs the project's own auth config", async () => {
    customAuthConfigs = [{ id: "ac_twitter", toolkit: { slug: "twitter" }, is_composio_managed: false, status: "ENABLED" }];
    sessionAuthConfigs = {};
    const cfg: AppConfig = {
      // The live Session is authoritative. A stale local user ID must never
      // move the rebuilt Session away from the existing connected accounts.
      composio: { apiKey: "ak_test", userId: "stale-local-user", sessionId: "trs_test" },
    };
    try {
      const before = calls.length;
      await expect(authorizeService(cfg, "twitter")).resolves.toEqual({ url: "https://connect.composio.dev/link/twitter" });
      const since = calls.slice(before);
      // once against the stale Session, once against the rebuilt one
      expect(since.filter((call) => call.method === "POST" && call.path.endsWith("/link"))).toHaveLength(2);
      expect(since.filter((call) => call.method === "POST" && call.path.endsWith("/session")).at(-1)?.body).toMatchObject({
        user_id: "openmausbot_existing",
        auth_configs: { twitter: "ac_twitter" },
      });
      // the same Composio user keeps every existing connection
      expect(cfg.composio).toMatchObject({ userId: "openmausbot_existing", sessionId: "trs_test" });
    } finally {
      customAuthConfigs = [];
      sessionAuthConfigs = {};
    }
  });

  it("says what to create when the project has no auth config for the toolkit", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "openmausbot_existing", sessionId: "trs_test" },
    };
    const before = calls.length;
    await expect(authorizeService(cfg, "twitter")).rejects.toThrow(/create an auth config for "twitter"/i);
    expect(calls.slice(before).some((call) => call.method === "POST" && call.path.endsWith("/session"))).toBe(false);
    expect(cfg.composio).toMatchObject({ userId: "openmausbot_existing", sessionId: "trs_test" });
    // and a failure that is not about auth configs is passed through untouched
    await expect(authorizeService(cfg, "github", "personal-three")).resolves.toEqual({
      url: "https://connect.composio.dev/link/github",
    });
  });

  it("does not offer Twitter through the official managed broker without an owned OAuth app", async () => {
    setManagedBrokerAccess({
      url: "https://broker.openmausbot.test",
      token: "a".repeat(64),
    });
    try {
      await expect(authorizeService({} as AppConfig, "twitter")).rejects.toThrow(/X Developer app/i);
      await expect(authorizeService({} as AppConfig, "x")).rejects.toThrow(/self-hosted connected apps/i);
    } finally {
      setManagedBrokerAccess(null);
    }
  });

  it("validates account aliases before sending them upstream", () => {
    expect(normalizeAccountAlias("  personal gmail  ")).toBe("personal gmail");
    expect(() => normalizeAccountAlias("bad\nalias")).toThrow(/printable/i);
    expect(() => normalizeAccountAlias("x".repeat(65))).toThrow(/1-64/i);
  });

  it("mounts the Session MCP endpoint with the project key header", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "openmausbot_existing", sessionId: "trs_test" },
    };
    const integration = await mcpIntegration(cfg, {
      harnessUrl: "http://127.0.0.1:8799",
      commsToken: "secret",
      botId: "bot-1",
      threadId: "thread-1",
    });
    expect(integration).toMatchObject({
      command: process.execPath,
      args: [expect.stringContaining("connector-proxy")],
      env: {
        OMB_CONNECTOR_UPSTREAM_URL: "http://127.0.0.1:8799/api/internal/connectors/mcp",
        OMB_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: "Bearer secret" }),
        OMB_HARNESS_URL: "http://127.0.0.1:8799",
        OMB_CONNECTOR_TOKEN: "secret",
        OMB_BOT_ID: "bot-1",
        OMB_THREAD_ID: "thread-1",
      },
    });
  });

  it("reports connection state, creates auth links and revokes disconnects", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "openmausbot_existing", sessionId: "trs_test" },
    };
    await expect(connectionStatus(cfg, ["github", "gmail", "slack", "notion", "linear"])).resolves.toEqual({
      github: {
        connected: true,
        pending: false,
        status: "ACTIVE",
        accounts: [
          { id: "ca_github_personal", alias: "personal", status: "ACTIVE" },
          { id: "ca_github_work", alias: "work", status: "ACTIVE" },
          // the Session-selected account is synthesized when the raw list
          // omits it — same rule as the inventory path
          { id: "ca_github", status: "ACTIVE" },
        ],
      },
      gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [] },
      slack: { connected: false, pending: false, status: "not_connected", accounts: [] },
      notion: {
        connected: false,
        pending: true,
        status: "INITIATED",
        accounts: [{ id: "ca_notion", alias: "team", status: "INITIATED" }],
      },
      linear: {
        connected: false,
        pending: false,
        status: "EXPIRED",
        accounts: [{ id: "ca_linear", status: "EXPIRED" }],
      },
    });
    await expect(authorizeService(cfg, "github")).rejects.toThrow(/alias.*not replaced/i);
    await expect(authorizeService(cfg, "github", "work")).rejects.toThrow(/already in use/i);
    await expect(authorizeService(cfg, "github", "personal-two")).resolves.toEqual({
      url: "https://connect.composio.dev/link/github",
    });
    expect(calls.filter((call) => call.method === "POST" && call.path.endsWith("/link")).at(-1)?.body).toEqual({
      toolkit: "github",
      alias: "personal-two",
    });
    await expect(removeAccount(cfg, "github", "ca_github_personal")).resolves.toEqual({ removed: 1 });
    await expect(removeAccount(cfg, "github", "ca_other_user")).resolves.toEqual({ removed: 0 });
    await expect(removeAccount(cfg, "github", "../other")).rejects.toThrow(/invalid connected-account ID/i);
    await expect(removeService(cfg, "github")).resolves.toEqual({ removed: 1 });
    expect(calls.some(
      (call) => call.method === "DELETE"
        && call.path.endsWith("/connected_accounts/ca_github")
        && call.query === "?revoke_on_delete=true",
    )).toBe(true);
  });

  it("enumerates connected services independently of catalog position", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "openmausbot_existing", sessionId: "trs_test" },
    };
    const callCount = calls.length;

    await expect(connectedServices(cfg)).resolves.toMatchObject({
      toolkit_41: {
        connected: true,
        pending: false,
        status: "ACTIVE",
        accounts: [{ id: "ca_toolkit_41", alias: "overflow", status: "ACTIVE" }],
      },
      github: {
        accounts: [
          { id: "ca_github_personal", alias: "personal", status: "ACTIVE" },
          { id: "ca_github_work", alias: "work", status: "ACTIVE" },
          { id: "ca_github", status: "ACTIVE" },
        ],
      },
      publicsearch: {
        connected: true,
        pending: false,
        status: "ACTIVE",
        accounts: [],
      },
      selectedonly: {
        connected: true,
        pending: false,
        status: "ACTIVE",
        accounts: [{ id: "ca_session_only", status: "ACTIVE" }],
      },
    });

    const inventoryCalls = calls.slice(callCount).filter((call) => call.path.endsWith("/connected_accounts"));
    expect(inventoryCalls).toHaveLength(2);
    expect(inventoryCalls[0]?.query).not.toContain("toolkit_slugs=");
    expect(inventoryCalls[1]?.query).toContain("cursor=accounts-page-2");
    const toolkitCalls = calls.slice(callCount).filter((call) => call.path.endsWith("/toolkits"));
    expect(toolkitCalls).toHaveLength(2);
    expect(toolkitCalls[0]?.query).toContain("is_connected=true");
    expect(toolkitCalls[1]?.query).toContain("cursor=toolkits-page-2");
  });

  it("falls back to complete Session toolkit state without connected-account read permission", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "openmausbot_existing", sessionId: "trs_test" },
    };
    connectedAccountsUnavailable = true;
    try {
      await expect(connectedServices(cfg)).resolves.toMatchObject({
        github: {
          connected: true,
          status: "ACTIVE",
          accounts: [{ id: "ca_github", status: "ACTIVE" }],
        },
        gmail: { connected: true, status: "ACTIVE", accounts: [] },
        publicsearch: { connected: true, status: "ACTIVE", accounts: [] },
        selectedonly: {
          connected: true,
          status: "ACTIVE",
          accounts: [{ id: "ca_session_only", status: "ACTIVE" }],
        },
      });
    } finally {
      connectedAccountsUnavailable = false;
    }
  });

  it("falls back to session toolkit state when connected-account items is malformed", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "openmausbot_existing", sessionId: "trs_test" },
    };
    malformedConnectedAccounts = true;
    try {
      await expect(connectionStatus(cfg, ["github", "slack"])).resolves.toEqual({
        // the malformed list degrades to [], but the Session still names its
        // selected account — synthesized so a poll never wipes the row
        github: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "ca_github", status: "ACTIVE" }] },
        slack: { connected: false, pending: false, status: "not_connected", accounts: [] },
      });
    } finally {
      malformedConnectedAccounts = false;
    }
  });

  it("uses the provided alias for the first account authorization", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "openmausbot_existing", sessionId: "trs_test" },
    };
    emptyConnectedAccounts = true;
    try {
      await expect(connectionStatus(cfg, ["slack"])).resolves.toMatchObject({
        slack: { connected: false, pending: false, accounts: [] },
      });
      const before = calls.length;
      await expect(authorizeService(cfg, "slack", "team")).resolves.toEqual({
        url: "https://connect.composio.dev/link/slack",
      });
      const linkCalls = calls.slice(before).filter((call) => call.method === "POST" && call.path.endsWith("/link"));
      expect(linkCalls).toHaveLength(1);
      expect(linkCalls[0].body).toEqual({ toolkit: "slack", alias: "team" });
    } finally {
      emptyConnectedAccounts = false;
    }
  });
});
