import { statSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.ts";
import { DATA_DIR } from "./config.ts";
import {
  authorizeService,
  prepareConnectionAuthConfigs,
  prepareProjectSession,
  relayMcp,
  setManagedBrokerAccess,
} from "./composio.ts";
import { forgetProjectAuthConfigs } from "./composio-project.ts";

// Composio's own wording for a toolkit it has no managed sign-in for (Xero, Buffer) when the Session names no auth config.
const NO_MANAGED_AUTH = (toolkit: string) =>
  `Composio does not manage auth for toolkit ${toolkit} and no auth config without required fields is available. `
  + "Please create an auth config manually or specify one in auth_config_override.";
const NEEDS_OWN_APP = new Set(["xero", "buffer"]);
const KEYS = ["ak_byo", "ak_pick", "ak_down", "ak_refuse", "ak_hint", "ak_dash", "ak_card", "ak_later", "ak_plain", "ak_scoped"];

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
let sessionPatch = true;
let authConfigEdits = true;

/** Composio uses a Session's named auth config only while that config is enabled for Tool Router. */
function onForToolRouter(apiKey: string, named: Record<string, string> | undefined): Record<string, string> {
  const project = projectConfigs[apiKey] ?? [];
  return Object.fromEntries(Object.entries(named ?? {}).filter(([, id]) =>
    project.some((config) => config.id === id && config.is_enabled_for_tool_router === true)));
}

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
    if (req.method === "PATCH" && single) {
      if (!authConfigEdits) return json(res, 403, { error: { message: "This API key may not edit auth configs" } });
      const item = (projectConfigs[apiKey] ?? []).find((config) => config.id === single[1]);
      if (!item) return json(res, 404, { error: { message: "Auth config not found" } });
      if (body?.type !== item.type) return json(res, 400, { error: { message: "type must match the auth config" } });
      if (typeof body.is_enabled_for_tool_router === "boolean") item.is_enabled_for_tool_router = body.is_enabled_for_tool_router;
      return json(res, 200, { success: true, message: "updated" });
    }
    if (req.method === "GET" && single) {
      const item = (projectConfigs[apiKey] ?? []).find((config) => config.id === single[1]);
      return item ? json(res, 200, item) : json(res, 404, { error: { message: "Auth config not found" } });
    }
    if (req.method === "POST" && url.pathname === "/api/v3.1/tool_router/session") {
      const named = Object.values((body.auth_configs ?? {}) as Record<string, string>);
      const refused = named.find((id) => refusedIds.has(id));
      if (refused) return json(res, 400, { error: { message: `Auth config ${refused} is not enabled for tool router` } });
      const id = `trs_${nextSession++}`;
      sessions.set(id, { user_id: body.user_id, auth_configs: onForToolRouter(apiKey, body.auth_configs) });
      return json(res, 201, sessionBody(id));
    }
    const session = url.pathname.match(/^\/api\/v3\.1\/tool_router\/session\/([\w-]+)(\/link|\/toolkits)?$/);
    if (session && sessions.has(session[1]!)) {
      if (!session[2] && req.method === "GET") return json(res, 200, sessionBody(session[1]!));
      if (!session[2] && req.method === "PATCH" && sessionPatch) {
        if (body.auth_configs) sessions.get(session[1]!)!.auth_configs = onForToolRouter(apiKey, body.auth_configs);
        return json(res, 200, sessionBody(session[1]!));
      }
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
  sessionPatch = true;
  authConfigEdits = true;
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
const sessionWrites = (since: number) => calls.slice(since)
  .filter((call) => call.path.startsWith("/api/v3.1/tool_router/session") && !call.path.endsWith("/link")
    && (call.method === "POST" || call.method === "PATCH"))
  .map((call) => call.body.auth_configs);
const linkPosts = (since: number) => calls.slice(since).filter((call) => call.method === "POST" && call.path.endsWith("/link"));
const callTool = (cfg: AppConfig, name: string) =>
  relayMcp(cfg, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: {} } })
    .then((relayed) => JSON.parse(new TextDecoder().decode(relayed.bytes)) as { result: { content: Array<{ text: string }>; isError?: boolean } });

const enabled = (id: string, slug: string, updated: string, extra: Record<string, unknown> = {}): AuthConfigItem => ({
  id, type: "custom", toolkit: { slug }, status: "ENABLED", is_composio_managed: false, is_enabled_for_tool_router: true,
  created_at: updated, last_updated_at: updated, ...extra,
});
/** A custom auth config a person made in the Composio dashboard: enabled, with Tool Router unset. */
const fromDashboard = (id: string, slug: string, created: string, extra: Record<string, unknown> = {}): AuthConfigItem => {
  const { is_enabled_for_tool_router: _off, ...item } = enabled(id, slug, created, extra);
  return { ...item, ...extra };
};
const patches = (since: number) => calls.slice(since).filter((call) => call.method === "PATCH");

describe("a person's own Composio project", () => {
  it("connects Xero and Buffer through the project's enabled custom auth configs, replacing a Session Composio won't change", async () => {
    sessionPatch = false;
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
    expect(info).toHaveBeenCalledWith("[composio] 2 enabled auth configs for xero; using the most recently created, ac_xero_newest");
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("uses the auth config a bot names for a toolkit once the person's project confirms it", async () => {
    projectConfigs.ak_pick = [
      enabled("ac_xero_team", "xero", "2026-10-01T00:00:00Z"),
      enabled("ac_xero_newest", "xero", "2026-10-20T00:00:00Z"),
      enabled("ac_xero_disabled", "xero", "2026-10-22T00:00:00Z", { status: "DISABLED" }),
      enabled("ac_slack_one", "slack", "2026-10-02T00:00:00Z"),
    ];
    const sessionId = existingSession();
    const cfg: AppConfig = { composio: { apiKey: "ak_pick", userId: "openmausbot_person", sessionId } };
    const pick = (authConfigId: string) => prepareConnectionAuthConfigs(cfg, [{ slug: "XERO", authConfigId }]);

    await expect(pick("ac_missing")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/has no auth config ac_missing/) });
    await expect(pick("ac_slack_one")).rejects.toThrow("Auth config ac_slack_one is for slack, not xero.");
    await expect(pick("ac_xero_disabled")).rejects.toThrow(/is disabled/);
    const before = calls.length;
    await expect(authorizeService(cfg, "xero")).resolves.toEqual({ url: "https://connect.composio.dev/link/xero/ac_xero_newest" });

    await expect(pick("ac_xero_team")).resolves.toBe("xero connects with the person's own Composio auth config ac_xero_team, the one asked for.");
    await expect(authorizeService(cfg, "xero")).resolves.toEqual({ url: "https://connect.composio.dev/link/xero/ac_xero_team" });
    expect(sessionWrites(before)).toEqual([
      { slack: "ac_slack_one", xero: "ac_xero_newest" },
      { slack: "ac_slack_one", xero: "ac_xero_team" },
    ]);
    expect(cfg.composio?.sessionId).toBe(sessionId);

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
      message: "Composio would not use your xero auth config. Check it is enabled in your Composio project. "
        + "Composio said: Auth config ac_xero_refused is not enabled for tool router",
    });
    expect(cfg.composio?.sessionId).toMatch(/^trs_\d+$/);
  });

  it("tells the bot in plain words what a toolkit with no managed sign-in needs, and looks again on the next call", async () => {
    const cfg: AppConfig = { composio: { apiKey: "ak_hint", userId: "openmausbot_person", sessionId: existingSession() } };
    const reply = await callTool(cfg, "XERO_LIST_INVOICES");
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content).toHaveLength(2);
    expect(reply.result.content[1]!.text).toContain("xero has no Composio-managed sign-in, so it needs an auth config with "
      + "the person's own OAuth app in their Composio project, and there is no enabled one for xero.");

    projectConfigs.ak_hint = [enabled("ac_xero_new", "xero", "2026-10-22T00:00:00Z")];
    const retried = await callTool(cfg, "XERO_LIST_INVOICES");
    expect(JSON.parse(retried.result.content[0]!.text)).toEqual({ successful: true, data: { authConfig: "ac_xero_new" } });
  });
});

describe("custom auth configs made in the Composio dashboard", () => {
  it("connects Xero and Buffer: Tool Router is turned on for the person's config and the Session they already have names it", async () => {
    projectConfigs.ak_dash = [
      fromDashboard("ac_xero_dash", "xero", "2026-10-20T00:00:00Z"),
      fromDashboard("ac_buffer_dash", "buffer", "2026-10-21T00:00:00Z", { is_enabled_for_tool_router: false }),
    ];
    const sessionId = existingSession();
    const cfg: AppConfig = { composio: { apiKey: "ak_dash", userId: "openmausbot_person", sessionId } };
    const before = calls.length;

    await expect(authorizeService(cfg, "xero")).resolves.toEqual({ url: "https://connect.composio.dev/link/xero/ac_xero_dash" });
    await expect(authorizeService(cfg, "buffer")).resolves.toEqual({ url: "https://connect.composio.dev/link/buffer/ac_buffer_dash" });

    expect(patches(before).filter((call) => call.path.includes("/auth_configs/")).map(({ path, body }) => [path, body])).toEqual([
      ["/api/v3.1/auth_configs/ac_xero_dash", { type: "custom", is_enabled_for_tool_router: true }],
      ["/api/v3.1/auth_configs/ac_buffer_dash", { type: "custom", is_enabled_for_tool_router: true }],
    ]);
    expect(sessionPosts(before)).toHaveLength(0);
    expect(cfg.composio?.sessionId).toBe(sessionId);
    expect(sessions.get(sessionId)!.auth_configs).toEqual({ buffer: "ac_buffer_dash", xero: "ac_xero_dash" });
    const reply = await callTool(cfg, "XERO_LIST_INVOICES");
    expect(JSON.parse(reply.result.content[0]!.text)).toEqual({ successful: true, data: { authConfig: "ac_xero_dash" } });
  });

  it("readies the config before the card shows, and tells the bot which of several it uses", async () => {
    projectConfigs.ak_card = [
      fromDashboard("ac_xero_first", "xero", "2026-09-01T00:00:00Z"),
      fromDashboard("ac_xero_latest", "xero", "2026-10-25T00:00:00Z", { last_updated_at: "2026-10-25T00:00:00Z" }),
      fromDashboard("ac_xero_edited", "xero", "2026-10-02T00:00:00Z", { last_updated_at: "2026-10-26T00:00:00Z" }),
    ];
    const sessionId = existingSession();
    const cfg: AppConfig = { composio: { apiKey: "ak_card", userId: "openmausbot_person", sessionId } };
    vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(prepareConnectionAuthConfigs(cfg, [{ slug: "xero" }, { slug: "gmail" }])).resolves.toBe(
      "xero connects with the person's own Composio auth config ac_xero_latest, the most recently created of their 3 enabled ones.",
    );
    expect(sessions.get(sessionId)!.auth_configs).toEqual({ xero: "ac_xero_latest" });
    const before = calls.length;
    await expect(authorizeService(cfg, "xero")).resolves.toEqual({ url: "https://connect.composio.dev/link/xero/ac_xero_latest" });
    expect(patches(before)).toEqual([]);

    await expect(prepareConnectionAuthConfigs(cfg, [{ slug: "xero", authConfigId: "ac_xero_first" }])).resolves.toBe(
      "xero connects with the person's own Composio auth config ac_xero_first, the one asked for.",
    );
    await expect(authorizeService(cfg, "xero")).resolves.toEqual({ url: "https://connect.composio.dev/link/xero/ac_xero_first" });
    expect(projectConfigs.ak_card.map((config) => [config.id, config.is_enabled_for_tool_router])).toEqual([
      ["ac_xero_first", true], ["ac_xero_latest", true], ["ac_xero_edited", undefined],
    ]);
  });

  it("picks up a config made after the bot's Session started, from the very call that needed it, with no restart", async () => {
    const sessionId = existingSession();
    const cfg: AppConfig = { composio: { apiKey: "ak_later", userId: "openmausbot_person", sessionId } };
    vi.spyOn(console, "info").mockImplementation(() => {});
    await expect(callTool(cfg, "BUFFER_LIST_POSTS")).resolves.toMatchObject({ result: { isError: true } });

    projectConfigs.ak_later = [fromDashboard("ac_buffer_new", "buffer", "2026-10-26T08:00:00Z")];
    const failed = await callTool(cfg, "BUFFER_LIST_POSTS");
    expect(failed.result.content[0]!.text).toContain(NO_MANAGED_AUTH("buffer"));
    expect(failed.result.content[1]!.text).toBe(
      "OpenMausBot note: buffer has no Composio-managed sign-in. buffer connects with the person's own Composio auth config "
      + 'ac_buffer_new. Call COMPOSIO_MANAGE_CONNECTIONS with toolkits ["buffer"] to show the person a card that connects '
      + "it, then end the turn. Do not retry this call before that.",
    );
    expect(sessions.get(sessionId)!.auth_configs).toEqual({ buffer: "ac_buffer_new" });
    await expect(authorizeService(cfg, "buffer")).resolves.toEqual({ url: "https://connect.composio.dev/link/buffer/ac_buffer_new" });
    expect(cfg.composio?.sessionId).toBe(sessionId);
  });

  it("leaves a toolkit with Composio-managed sign-in and no config of the person's exactly as it was", async () => {
    projectConfigs.ak_plain = [fromDashboard("ac_xero_plain", "xero", "2026-10-20T00:00:00Z")];
    const sessionId = existingSession();
    const cfg: AppConfig = { composio: { apiKey: "ak_plain", userId: "openmausbot_person", sessionId } };
    const before = calls.length;

    await expect(prepareConnectionAuthConfigs(cfg, [{ slug: "gmail" }])).resolves.toBeUndefined();
    await expect(authorizeService(cfg, "gmail")).resolves.toEqual({ url: "https://connect.composio.dev/link/gmail/managed" });
    expect(patches(before)).toEqual([]);
    expect(sessionPosts(before)).toEqual([]);
    expect(sessions.get(sessionId)!.auth_configs).toEqual({});
    expect(projectConfigs.ak_plain[0]!.is_enabled_for_tool_router).toBeUndefined();
  });

  it("says in plain words when Composio won't let the key turn Tool Router on", async () => {
    authConfigEdits = false;
    projectConfigs.ak_scoped = [fromDashboard("ac_xero_scoped", "xero", "2026-10-20T00:00:00Z")];
    const cfg: AppConfig = { composio: { apiKey: "ak_scoped", userId: "openmausbot_person", sessionId: existingSession() } };

    await expect(authorizeService(cfg, "xero")).rejects.toMatchObject({
      status: 409,
      message: "OpenMausBot could not turn on Tool Router for your xero auth config ac_xero_scoped, which Composio needs before "
        + "it uses it. Check that your Composio project key may edit auth configs. Composio said: This API key may not edit auth configs",
    });
    const reply = await callTool(cfg, "XERO_LIST_INVOICES");
    expect(reply.result.content[1]!.text).toMatch(/^OpenMausBot note: OpenMausBot could not turn on Tool Router for your xero auth config/);
  });
});

describe("OpenMausBot's managed connected apps", () => {
  const managed = {} as AppConfig;
  const plainLine = "xero needs your own OAuth app. Add your Composio project key in Settings → API keys; OpenMausBot then "
    + "uses your xero auth config from that project. Connect again.";

  it("answers a toolkit that needs the person's own OAuth app with one plain line instead of Composio's error", async () => {
    setManagedBrokerAccess({ url: `${origin}/broker`, token: "c".repeat(64) });
    await expect(authorizeService(managed, "xero")).rejects.toMatchObject({ status: 409, message: plainLine });

    const before = calls.length;
    await expect(prepareConnectionAuthConfigs(managed, [{ slug: "xero", authConfigId: "ac_xero_newest" }]))
      .rejects.toMatchObject({ status: 409, message: plainLine });
    await expect(prepareConnectionAuthConfigs(managed, [{ slug: "xero" }])).resolves.toBeUndefined();
    expect(calls.slice(before)).toEqual([]);

    const reply = await callTool(managed, "XERO_LIST_INVOICES");
    expect(reply.result.content[1]!.text).toContain("OpenMausBot's built-in connected apps cannot use. Tell the person: add their own Composio project key in Settings → API keys");
    expect(reply.result.content[1]!.text).toContain("OpenMausBot then picks that auth config up on its own");
    expect(calls.slice(before).some((call) => call.path.startsWith("/api/"))).toBe(false);
  });
});
