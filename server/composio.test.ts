import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppConfig } from "./config.ts";
import {
  authorizeService,
  connectedServices,
  connectionStatus,
  mcpIntegration,
  normalizeAccountAlias,
  prepareProjectSession,
  removeAccount,
  removeService,
} from "./composio.ts";

let api: Server;
let base = "";
const calls: Array<{ method: string; path: string; query: string; body: any }> = [];
let malformedConnectedAccounts = false;
let connectedAccountsUnavailable = false;

beforeAll(async () => {
  api = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method ?? "GET", path: url.pathname, query: url.search, body });

    if (req.headers["x-api-key"] !== "ak_test") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "invalid project key" } }));
    }

    if (req.method === "POST" && url.pathname === "/api/v3.1/tool_router/session") {
      res.writeHead(201, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        session_id: "trs_test",
        mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_test/mcp" },
        config: { user_id: body.user_id, multi_account: body.multi_account },
      }));
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
        },
      }));
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
  base = `http://127.0.0.1:${(api.address() as { port: number }).port}/api/v3.1`;
  process.env.OMB_COMPOSIO_API = base;
});

afterAll(async () => {
  delete process.env.OMB_COMPOSIO_API;
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

describe.sequential("Composio Sessions", () => {
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
        OMB_COMMS_TOKEN: "secret",
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
});
