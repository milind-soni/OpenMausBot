import { statSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.ts";
import { DATA_DIR } from "./config.ts";
import {
  authorizeService,
  prepareProjectSession,
  relayMcp,
  setManagedBrokerAccess,
  useRequestedAuthConfigs,
} from "./composio.ts";
import { forgetProjectAuthConfigs } from "./composio-project.ts";

// Composio's own wording for a toolkit it has no managed sign-in for (Xero, Buffer) when the Session names no auth config.
const NO_MANAGED_AUTH = (toolkit: string) =>
  `Composio does not manage auth for toolkit ${toolkit} and no auth config without required fields is available. `
  + "Please create an auth config manually or specify one in auth_config_override.";
const NEEDS_OWN_APP = new Set(["xero", "buffer"]);
const KEYS = ["ak_byo", "ak_pick", "ak_down", "ak_refuse", "ak_hint"];

interface FakeSession { user_id: string; auth_configs: Record<string, string> }
type AuthConfigItem = Record<string, unknown> & { id: string };

let api: Server;
let origin = "";
const calls: Array<{ method: string; path: string; apiKey: string; body: any }> = [];
const sessions = new Map<string, FakeSession>();
let projectConfigs: Record<string, AuthConfigItem[]> = {};
let authConfigsDown = false;
let refusedIds = new Set<string>();
let nextSession = 1;

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

function sessionBody(id: string) {
  const session = sessions.get(id)!;
  return {
    session_id: id,
    mcp: { type: "http", url: `${origin}/mcp/${id}` },
    config: { user_id: session.user_id, multi_account: { enable: true }, auth_configs: session.auth_configs },
  };
}

function toolResult(id: unknown, payload: Record<string, unknown>, isError = false) {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }], ...(isError ? { isError } : {}) } };
}

beforeAll(async () => {
  api = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const apiKey = String(req.headers["x-api-key"] ?? "");
    calls.push({ method: req.method ?? "GET", path: url.pathname, apiKey, body });

    if (url.pathname.startsWith("/broker/")) {
      if (req.method === "POST" && url.pathname === "/broker/v1/connectors/xero/authorize") {
        return json(res, 502, { error: NO_MANAGED_AUTH("xero") });
      }
      if (req.method === "POST" && url.pathname === "/broker/v1/mcp") {
        return json(res, 200, toolResult(body.id, { successful: false, error: NO_MANAGED_AUTH("xero") }, true));
      }
      return json(res, 404, { error: "unknown broker route" });
    }
    const mcp = url.pathname.match(/^\/mcp\/([\w-]+)$/);
    if (mcp && req.method === "POST") {
      const session = sessions.get(mcp[1]!);
      const tool = String(body?.params?.name ?? "");
      if (!session || body?.method !== "tools/call") return json(res, 200, { jsonrpc: "2.0", id: body?.id, result: {} });
      const toolkit = tool.split("_")[0]!.toLowerCase();
      if (NEEDS_OWN_APP.has(toolkit) && !session.auth_configs[toolkit]) {
        return json(res, 200, toolResult(body.id, { successful: false, error: NO_MANAGED_AUTH(toolkit) }, true));
      }
      return json(res, 200, toolResult(body.id, { successful: true, data: { authConfig: session.auth_configs[toolkit] } }));
    }
    if (!KEYS.includes(apiKey)) return json(res, 401, { error: { message: "invalid project key" } });

    if (req.method === "GET" && url.pathname === "/api/v3.1/auth_configs") {
      if (authConfigsDown) return json(res, 503, { error: { message: "auth configs unavailable" } });
      return json(res, 200, { items: projectConfigs[apiKey] ?? [] });
    }
    const single = url.pathname.match(/^\/api\/v3\.1\/auth_configs\/([\w-]+)$/);
    if (req.method === "GET" && single) {
      const item = (projectConfigs[apiKey] ?? []).find((config) => config.id === single[1]);
      return item ? json(res, 200, item) : json(res, 404, { error: { message: "Auth config not found" } });
    }
    if (req.method === "POST" && url.pathname === "/api/v3.1/tool_router/session") {
      const named = Object.values((body.auth_configs ?? {}) as Record<string, string>);
      const refused = named.find((id) => refusedIds.has(id));
      if (refused) return json(res, 400, { error: { message: `Auth config ${refused} is not enabled for tool router` } });
      const id = `trs_${nextSession++}`;
      sessions.set(id, { user_id: body.user_id, auth_configs: body.auth_configs ?? {} });
      return json(res, 201, sessionBody(id));
    }
    const session = url.pathname.match(/^\/api\/v3\.1\/tool_router\/session\/([\w-]+)(\/link|\/toolkits)?$/);
    if (session && sessions.has(session[1]!)) {
      if (!session[2] && req.method === "GET") return json(res, 200, sessionBody(session[1]!));
      if (session[2] === "/toolkits") return json(res, 200, { items: [] });
      if (session[2] === "/link" && req.method === "POST") {
        const configs = sessions.get(session[1]!)!.auth_configs;
        if (NEEDS_OWN_APP.has(body.toolkit) && !configs[body.toolkit]) {
          return json(res, 400, { error: { message: NO_MANAGED_AUTH(body.toolkit) } });
        }
        return json(res, 201, { redirect_url: `https://connect.composio.dev/link/${body.toolkit}/${configs[body.toolkit] ?? "managed"}` });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/v3.1/connected_accounts") return json(res, 200, { items: [] });
    return json(res, 404, { error: { message: "not found" } });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  process.env.OMB_COMPOSIO_API = `${origin}/api/v3.1`;
});

afterAll(async () => {
  delete process.env.OMB_COMPOSIO_API;
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

beforeEach(() => {
  forgetProjectAuthConfigs();
  projectConfigs = {};
  authConfigsDown = false;
  refusedIds = new Set();
});

afterEach(() => {
  vi.restoreAllMocks();
  setManagedBrokerAccess(null);
});

const existingSession = (auth_configs: Record<string, string> = {}) => {
  const id = `trs_${nextSession++}`;
  sessions.set(id, { user_id: "openmausbot_person", auth_configs });
  return id;
};
const sessionPosts = (since: number) =>
  calls.slice(since).filter((call) => call.method === "POST" && call.path === "/api/v3.1/tool_router/session");
const linkPosts = (since: number) => calls.slice(since).filter((call) => call.method === "POST" && call.path.endsWith("/link"));
const callTool = (cfg: AppConfig, name: string) =>
  relayMcp(cfg, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: {} } })
    .then((relayed) => JSON.parse(new TextDecoder().decode(relayed.bytes)) as { result: { content: Array<{ text: string }>; isError?: boolean } });

const enabled = (id: string, slug: string, updated: string, extra: Record<string, unknown> = {}): AuthConfigItem => ({
  id, toolkit: { slug }, status: "ENABLED", is_composio_managed: false, is_enabled_for_tool_router: true, last_updated_at: updated, ...extra,
});

describe("a person's own Composio project", () => {
  it("connects Xero and Buffer through the project's enabled custom auth configs with nothing named by the bot", async () => {
    projectConfigs.ak_byo = [
      enabled("ac_xero_first", "xero", "2026-10-01T00:00:00Z"),
      enabled("ac_xero_newest", "XERO", "2026-10-20T00:00:00Z"),
      enabled("ac_xero_disabled", "xero", "2026-10-21T00:00:00Z", { status: "DISABLED" }),
      enabled("ac_buffer", "buffer", "2026-10-02T00:00:00Z"),
      enabled("ac_buffer_managed", "buffer", "2026-10-22T00:00:00Z", { is_composio_managed: true }),
    ];
    const cfg: AppConfig = { composio: { apiKey: "ak_byo", userId: "openmausbot_person", sessionId: existingSession() } };
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const before = calls.length;

    const reply = await callTool(cfg, "XERO_LIST_INVOICES");
    expect(reply.result.isError).toBeUndefined();
    expect(JSON.parse(reply.result.content[0]!.text)).toEqual({ successful: true, data: { authConfig: "ac_xero_newest" } });
    const created = sessionPosts(before);
    expect(created).toHaveLength(1);
    expect(created[0]!.body).toMatchObject({
      user_id: "openmausbot_person",
      auth_configs: { buffer: "ac_buffer", xero: "ac_xero_newest" },
    });
    expect(cfg.composio).toMatchObject({ userId: "openmausbot_person", sessionId: `trs_${nextSession - 1}` });

    await expect(authorizeService(cfg, "xero")).resolves.toEqual({ url: "https://connect.composio.dev/link/xero/ac_xero_newest" });
    await expect(authorizeService(cfg, "buffer")).resolves.toEqual({ url: "https://connect.composio.dev/link/buffer/ac_buffer" });
    expect(linkPosts(before)).toHaveLength(2);
    expect(sessionPosts(before)).toHaveLength(1);
    expect(info).toHaveBeenCalledWith("[composio] 2 enabled auth configs for xero; using the most recently updated, ac_xero_newest");
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("uses the auth config a bot names for a toolkit once the person's project confirms it", async () => {
    projectConfigs.ak_pick = [
      enabled("ac_xero_team", "xero", "2026-10-01T00:00:00Z"),
      enabled("ac_xero_newest", "xero", "2026-10-20T00:00:00Z"),
      enabled("ac_xero_off", "xero", "2026-10-21T00:00:00Z", { is_enabled_for_tool_router: false }),
      enabled("ac_xero_disabled", "xero", "2026-10-22T00:00:00Z", { status: "DISABLED" }),
      enabled("ac_slack_one", "slack", "2026-10-02T00:00:00Z"),
    ];
    const cfg: AppConfig = { composio: { apiKey: "ak_pick", userId: "openmausbot_person", sessionId: existingSession() } };
    const pick = (authConfigId: string) => useRequestedAuthConfigs(cfg, [{ slug: "XERO", authConfigId }]);

    await expect(pick("ac_missing")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/has no auth config ac_missing/) });
    await expect(pick("ac_slack_one")).rejects.toThrow("Auth config ac_slack_one is for slack, not xero.");
    await expect(pick("ac_xero_off")).rejects.toThrow(/xero auth config is not enabled for Tool Router/);
    await expect(pick("ac_xero_disabled")).rejects.toThrow(/is disabled/);
    const before = calls.length;
    await expect(authorizeService(cfg, "xero")).resolves.toEqual({ url: "https://connect.composio.dev/link/xero/ac_xero_newest" });

    await pick("ac_xero_team");
    await expect(authorizeService(cfg, "xero")).resolves.toEqual({ url: "https://connect.composio.dev/link/xero/ac_xero_team" });
    expect(sessionPosts(before).map((call) => call.body.auth_configs)).toEqual([
      { slack: "ac_slack_one", xero: "ac_xero_newest" },
      { slack: "ac_slack_one", xero: "ac_xero_team" },
    ]);

    const file = join(DATA_DIR, "composio-auth-configs.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("ac_xero_team");
    expect(readFileSync(file, "utf8")).not.toContain("ak_pick");
    vi.resetModules();
    const restarted = await import("./composio-project.ts");
    await expect(restarted.projectAuthConfigs("ak_pick")).resolves.toMatchObject({ configs: { xero: "ac_xero_team" } });
  });

  it("keeps the last auth configs it read, or none, when the lookup fails, and never blocks a Session", async () => {
    let now = Date.parse("2026-10-22T09:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    projectConfigs.ak_down = [enabled("ac_xero_down", "xero", "2026-10-20T00:00:00Z")];
    const created = async () => {
      const before = calls.length;
      await prepareProjectSession("ak_down", { userId: "openmausbot_person" });
      return sessionPosts(before)[0]!.body.auth_configs;
    };

    authConfigsDown = true;
    await expect(created()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not read the project's auth configs \(auth configs unavailable\)/));
    authConfigsDown = false;
    now += 16_000;
    await expect(created()).resolves.toEqual({ xero: "ac_xero_down" });
    authConfigsDown = true;
    now += 61_000;
    await expect(created()).resolves.toEqual({ xero: "ac_xero_down" });
    forgetProjectAuthConfigs("ak_down");
    await expect(created()).resolves.toEqual({ xero: "ac_xero_down" });

    const cfg: AppConfig = { composio: { apiKey: "ak_down", userId: "openmausbot_person", sessionId: existingSession({ xero: "ac_xero_down" }) } };
    const before = calls.length;
    await expect(callTool(cfg, "XERO_LIST_INVOICES")).resolves.toMatchObject({ result: { content: [{ text: expect.stringContaining("ac_xero_down") }] } });
    expect(sessionPosts(before)).toHaveLength(0);
  });

  it("creates the Session without an auth config Composio refuses, and says so plainly when that toolkit connects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    projectConfigs.ak_refuse = [
      enabled("ac_xero_refused", "xero", "2026-10-20T00:00:00Z"),
      enabled("ac_buffer_fine", "buffer", "2026-10-20T00:00:00Z"),
    ];
    refusedIds = new Set(["ac_xero_refused"]);
    const cfg: AppConfig = { composio: { apiKey: "ak_refuse", userId: "openmausbot_person" } };
    const before = calls.length;

    const reply = await callTool(cfg, "BUFFER_LIST_POSTS");
    expect(JSON.parse(reply.result.content[0]!.text)).toEqual({ successful: true, data: { authConfig: "ac_buffer_fine" } });
    expect(sessionPosts(before).map((call) => call.body.auth_configs)).toEqual([
      { buffer: "ac_buffer_fine", xero: "ac_xero_refused" },
      { buffer: "ac_buffer_fine" },
    ]);
    await expect(authorizeService(cfg, "buffer")).resolves.toEqual({ url: "https://connect.composio.dev/link/buffer/ac_buffer_fine" });
    await expect(authorizeService(cfg, "xero")).rejects.toMatchObject({
      status: 400,
      message: "Composio would not use your xero auth config. Check it is enabled, and enabled for Tool Router, in your "
        + "Composio project. Composio said: Auth config ac_xero_refused is not enabled for tool router",
    });
    expect(cfg.composio?.sessionId).toMatch(/^trs_\d+$/);
  });

  it("tells the bot in plain words what a toolkit with no managed sign-in needs, and looks again on the next call", async () => {
    const cfg: AppConfig = { composio: { apiKey: "ak_hint", userId: "openmausbot_person", sessionId: existingSession() } };
    const reply = await callTool(cfg, "XERO_LIST_INVOICES");
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content).toHaveLength(2);
    expect(reply.result.content[1]!.text).toContain("xero has no Composio-managed sign-in");
    expect(reply.result.content[1]!.text).toContain('[{"name":"xero","action":"add","auth_config_id":"ac_…"}]');

    projectConfigs.ak_hint = [enabled("ac_xero_new", "xero", "2026-10-22T00:00:00Z")];
    const retried = await callTool(cfg, "XERO_LIST_INVOICES");
    expect(JSON.parse(retried.result.content[0]!.text)).toEqual({ successful: true, data: { authConfig: "ac_xero_new" } });
  });
});

describe("OpenMausBot's managed connected apps", () => {
  const managed = {} as AppConfig;
  const plainLine = "xero needs your own OAuth app. Add your Composio project key in Settings → API keys, with an enabled "
    + "xero auth config there, then connect again.";

  it("answers a toolkit that needs the person's own OAuth app with one plain line instead of Composio's error", async () => {
    setManagedBrokerAccess({ url: `${origin}/broker`, token: "c".repeat(64) });
    await expect(authorizeService(managed, "xero")).rejects.toMatchObject({ status: 409, message: plainLine });

    const before = calls.length;
    await expect(useRequestedAuthConfigs(managed, [{ slug: "xero", authConfigId: "ac_xero_newest" }]))
      .rejects.toMatchObject({ status: 409, message: plainLine });
    expect(calls.slice(before)).toEqual([]);

    const reply = await callTool(managed, "XERO_LIST_INVOICES");
    expect(reply.result.content[1]!.text).toContain("OpenMausBot's built-in connected apps cannot use. Tell the person: add their own Composio project key in Settings → API keys");
  });
});
