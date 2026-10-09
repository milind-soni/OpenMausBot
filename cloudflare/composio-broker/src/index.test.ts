import { afterEach, describe, expect, it, vi } from "vitest";

import worker, {
  authorize,
  catalog,
  connectedServices,
  connectionStatus,
  createSession,
  disconnectAccount,
  ensureSession,
  normalizeAccountAlias,
  parseSession,
  requestAlias,
  sha256,
} from "./index";

const multiAccount = {
  enable: true,
  max_accounts_per_toolkit: 5,
  require_explicit_selection: true,
};

function session(id: string, userId: string, configured = true) {
  return {
    session_id: id,
    mcp: { url: `https://mcp.composio.dev/${id}` },
    config: { user_id: userId, ...(configured ? { multi_account: multiAccount } : {}) },
  };
}

function testEnv(fetchCalls: Array<{ url: string; init?: RequestInit }>) {
  const dbRuns: Array<{ sql: string; values: unknown[] }> = [];
  const env = {
    COMPOSIO_API_BASE: "https://backend.composio.dev/api/v3.1",
    COMPOSIO_API_KEY: "ak_test",
    SESSION_LIMITER: { limit: async () => ({ success: true }) },
    DB: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              run: async () => {
                dbRuns.push({ sql, values });
              },
            };
          },
        };
      },
    },
  };
  const ctx = { waitUntil(promise: Promise<unknown>) { void promise; } };
  return { env, ctx, dbRuns, fetchCalls };
}

afterEach(() => vi.unstubAllGlobals());

describe("connected-apps broker boundaries", () => {
  it("accepts an empty authorize body as a first-account request", async () => {
    await expect(requestAlias(new Request("https://broker.test/v1/connectors/gmail/authorize", {
      method: "POST",
      body: "",
    }))).resolves.toBeUndefined();
    await expect(requestAlias(new Request("https://broker.test/v1/connectors/gmail/authorize", {
      method: "POST",
      body: "  \n",
    }))).resolves.toBeUndefined();
  });

  it("accepts only HTTPS Composio MCP endpoints", () => {
    expect(parseSession({
      session_id: "session-1",
      mcp: { url: "https://mcp.composio.dev/session", headers: { "x-session": "one", host: "bad" } },
    })).toEqual({
      sessionId: "session-1",
      url: "https://mcp.composio.dev/session",
      headers: { "x-session": "one" },
      userId: undefined,
      multiAccountConfigured: false,
    });
    expect(() => parseSession({ session_id: "session-1", mcp: { url: "https://attacker.example/mcp" } })).toThrow(/untrusted/i);
    expect(() => parseSession({ session_id: "session-1", mcp: { url: "http://mcp.composio.dev/session" } })).toThrow(/untrusted/i);
  });

  it("hashes installation tokens before storage", async () => {
    await expect(sha256("openmausbot")).resolves.toBe("63c74f70a9d4681c334e84001935955a75245ea5b16b9c37c808e85c69963705");
  });

  it("creates Sessions with explicit multi-account selection", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env } = testEnv(fetchCalls);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return Response.json(session("trs_new", "omb_user"), { status: 201 });
    });

    await expect(createSession(env as never, "omb_user")).resolves.toMatchObject({
      sessionId: "trs_new",
      multiAccountConfigured: true,
    });
    expect(JSON.parse(String(fetchCalls[0].init?.body))).toMatchObject({
      user_id: "omb_user",
      multi_account: multiAccount,
    });
  });

  it("upgrades a legacy Session without changing the installation's Composio user", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx, dbRuns } = testEnv(fetchCalls);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (init?.method === "POST") return Response.json(session("trs_new", "omb_stable"), { status: 201 });
      return Response.json(session("trs_legacy", "omb_stable", false));
    });

    await expect(ensureSession({
      id: "install-1",
      composio_user_id: "omb_stable",
      session_id: "trs_legacy",
      disabled_at: null,
    }, env as never, ctx as never)).resolves.toMatchObject({ sessionId: "trs_new", multiAccountConfigured: true });
    const creation = fetchCalls.find((call) => call.init?.method === "POST");
    expect(JSON.parse(String(creation?.init?.body))).toMatchObject({ user_id: "omb_stable", multi_account: multiAccount });
    expect(dbRuns.some((run) => run.values[0] === "trs_new" && run.values[2] === "install-1")).toBe(true);
  });

  it("returns every account and deletes only an owned account ID", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx } = testEnv(fetchCalls);
    const accounts = {
      items: [
        { id: "ca_work", alias: "work", toolkit: { slug: "gmail" }, status: "ACTIVE", updated_at: "2026-08-21T10:00:00Z" },
        { id: "ca_personal", alias: "personal", toolkit: { slug: "gmail" }, status: "INITIALIZING", updated_at: "2026-08-21T11:00:00Z" },
      ],
      next_cursor: "accounts-page-2",
    };
    let connectedAccountsUnavailable = false;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.includes("/tool_router/session/trs_multi/toolkits")) {
        const query = new URL(url).searchParams;
        if (query.get("cursor") === "toolkits-page-2") {
          return Response.json({
            items: [
              { slug: "publicsearch", is_no_auth: true },
              { slug: "selectedonly", connected_account: { id: "ca_session_only", status: "ACTIVE" } },
            ],
          });
        }
        const body = {
          items: [
            { slug: "gmail", connected_account: { id: "ca_work", status: "ACTIVE" } },
            { slug: "unconnected", connected_account: null },
          ],
          next_cursor: query.has("toolkits") ? undefined : "toolkits-page-2",
        };
        return Response.json(body);
      }
      if (url.endsWith("/tool_router/session/trs_multi/link") && init?.method === "POST") {
        return Response.json({ redirect_url: "https://connect.composio.dev/link/gmail" }, { status: 201 });
      }
      if (url.includes("/tool_router/session/trs_multi")) return Response.json(session("trs_multi", "omb_stable"));
      if (url.includes("/connected_accounts?") && !init?.method) {
        if (connectedAccountsUnavailable) {
          return Response.json({ error: "connected-account read not granted" }, { status: 403 });
        }
        if (url.includes("cursor=accounts-page-2")) {
          return Response.json({
            items: [
              { id: "ca_toolkit_41", alias: "overflow", toolkit: { slug: "toolkit_41" }, status: "ACTIVE", updated_at: "2026-08-21T12:00:00Z" },
            ],
          });
        }
        return Response.json(accounts);
      }
      if (url.includes("/connected_accounts/ca_work") && init?.method === "DELETE") return Response.json({ success: true });
      return Response.json({ error: "not found" }, { status: 404 });
    });
    const installation = {
      id: "install-1",
      composio_user_id: "omb_stable",
      session_id: "trs_multi",
      disabled_at: null,
    };

    const statusResponse = await connectionStatus(
      new URL("https://broker.example/v1/connectors?services=gmail"),
      installation,
      env as never,
      ctx as never,
    );
    await expect(statusResponse.json()).resolves.toEqual({
      services: {
        gmail: {
          connected: true,
          pending: true,
          status: "ACTIVE",
          accounts: [
            { id: "ca_personal", alias: "personal", status: "INITIALIZING" },
            { id: "ca_work", alias: "work", status: "ACTIVE" },
          ],
        },
      },
    });
    const connectedResponse = await connectedServices(installation, env as never, ctx as never);
    await expect(connectedResponse.json()).resolves.toMatchObject({
      configured: true,
      services: {
        toolkit_41: {
          connected: true,
          pending: false,
          status: "ACTIVE",
          accounts: [{ id: "ca_toolkit_41", alias: "overflow", status: "ACTIVE" }],
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
      },
    });
    const inventoryCall = fetchCalls.find((call) =>
      call.url.includes("/connected_accounts?") && !call.url.includes("toolkit_slugs=")
    );
    expect(inventoryCall).toBeDefined();
    expect(fetchCalls.some((call) =>
      call.url.includes("/connected_accounts?")
        && !call.url.includes("toolkit_slugs=")
        && call.url.includes("cursor=accounts-page-2")
    )).toBe(true);
    expect(fetchCalls.some((call) =>
      call.url.includes("/tool_router/session/trs_multi/toolkits?")
        && !call.url.includes("toolkits=")
        && call.url.includes("is_connected=true")
        && call.url.includes("cursor=toolkits-page-2")
    )).toBe(true);

    connectedAccountsUnavailable = true;
    const fallbackResponse = await connectedServices(installation, env as never, ctx as never);
    await expect(fallbackResponse.json()).resolves.toMatchObject({
      configured: true,
      services: {
        gmail: {
          connected: true,
          status: "ACTIVE",
          accounts: [{ id: "ca_work", status: "ACTIVE" }],
        },
        publicsearch: { connected: true, status: "ACTIVE", accounts: [] },
        selectedonly: {
          connected: true,
          status: "ACTIVE",
          accounts: [{ id: "ca_session_only", status: "ACTIVE" }],
        },
      },
    });
    connectedAccountsUnavailable = false;
    await expect((await disconnectAccount("gmail", "ca_work", installation, env as never, ctx as never)).json())
      .resolves.toEqual({ removed: 1 });
    await expect((await disconnectAccount("gmail", "ca_not_owned", installation, env as never, ctx as never)).json())
      .resolves.toEqual({ removed: 0 });
    expect(fetchCalls.filter((call) => call.init?.method === "DELETE")).toHaveLength(1);

    const missingAlias = await authorize("gmail", undefined, installation, env as never, ctx as never);
    expect(missingAlias.status).toBe(400);
    await expect(missingAlias.json()).resolves.toEqual({
      error: "Add an account alias so the existing connection is not replaced",
    });
    const authorized = await authorize("gmail", "second", installation, env as never, ctx as never);
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toEqual({ url: "https://connect.composio.dev/link/gmail" });
    const linkCall = fetchCalls.find((call) => call.url.endsWith("/tool_router/session/trs_multi/link"));
    expect(JSON.parse(String(linkCall?.init?.body))).toEqual({ toolkit: "gmail", alias: "second" });
  });

  it("retries only unfinished or expired accounts without replacing grants", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx } = testEnv(fetchCalls);
    const installation = { id: "retry-install", composio_user_id: "retry-user", session_id: "trs_retry", disabled_at: null };
    let accounts: Array<{ id: string; status?: string; alias?: string; toolkit: { slug: string } }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.includes("/connected_accounts")) {
        expect(new URL(url).searchParams.get("user_ids")).toBe("retry-user");
        return Response.json({ items: accounts });
      }
      if (url.endsWith("/link")) return Response.json({ redirect_url: "https://connect.composio.dev/link/gmail" });
      return Response.json(session("trs_retry", "retry-user"));
    });
    const linkBodies = () => fetchCalls.filter((call) => call.url.endsWith("/link"))
      .map((call) => JSON.parse(String(call.init?.body)) as { toolkit: string; alias?: string });

    for (const status of ["INITIALIZING", "initiated", "EXPIRED"]) {
      accounts = [{ id: "old", alias: "original", status, toolkit: { slug: "Gmail" } }];
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await authorize("gmail", undefined, installation, env as never, ctx as never);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ url: "https://connect.composio.dev/link/gmail" });
        expect(linkBodies().at(-1)).toEqual({ toolkit: "gmail", alias: expect.stringMatching(/^omb-retry-[0-9a-f-]{36}$/) });
      }
      expect(accounts[0].alias).toBe("original");
    }
    expect(new Set(linkBodies().map((body) => body.alias)).size).toBe(6);
    const successfulLinks = linkBodies().length;
    for (const status of ["ACTIVE", "PENDING", "FAILED", "INACTIVE", "REVOKED", "unknown", undefined]) {
      accounts = [{ id: "protected", status, toolkit: { slug: "gmail" } }];
      const response = await authorize("gmail", undefined, installation, env as never, ctx as never);
      expect(response.status).toBe(400);
    }
    accounts = [{ id: "old", alias: "Original", status: "EXPIRED", toolkit: { slug: "gmail" } }];
    expect((await authorize("gmail", "original", installation, env as never, ctx as never)).status).toBe(409);
    accounts = Array.from({ length: 5 }, (_, id) => ({ id: String(id), status: "INITIALIZING", toolkit: { slug: "gmail" } }));
    expect((await authorize("gmail", undefined, installation, env as never, ctx as never)).status).toBe(409);
    expect(linkBodies()).toHaveLength(successfulLinks);
    expect(fetchCalls.filter((call) => /^(DELETE|PATCH)$/.test(call.init?.method ?? ""))).toHaveLength(0);
  });

  it("pages the catalog by forwarding a well-formed cursor only", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env } = testEnv(fetchCalls);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return Response.json({ items: [{ slug: "deepgram" }] });
    });
    const catalogEnv = { ...env, COMPOSIO_TOOLKIT_BASE: "https://backend.composio.dev/api/v3" } as never;

    await catalog(catalogEnv, new URL("https://broker.test/v1/catalog"));
    await catalog(catalogEnv, new URL("https://broker.test/v1/catalog?cursor=eyJwYWdlIjoyfQ=="));
    await catalog(catalogEnv, new URL("https://broker.test/v1/catalog?cursor=%20%26limit%3D1"));

    expect(fetchCalls.map((call) => new URL(call.url).searchParams.get("cursor"))).toEqual([
      null,
      "eyJwYWdlIjoyfQ==",
      null,
    ]);
  });

  it("passes catalog pagination metadata through untouched", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env } = testEnv(fetchCalls);
    vi.stubGlobal("fetch", async () =>
      Response.json({
        items: [{ slug: "gmail" }],
        next_cursor: "Mi01MDA=",
        current_page: 1,
        total_pages: 4,
        total_items: 1540,
      }));
    const catalogEnv = { ...env, COMPOSIO_TOOLKIT_BASE: "https://backend.composio.dev/api/v3" } as never;

    const response = await catalog(catalogEnv, new URL("https://broker.test/v1/catalog?cursor=Mi01MDA%3D"));

    await expect(response.json()).resolves.toEqual({
      items: [{ slug: "gmail" }],
      next_cursor: "Mi01MDA=",
      current_page: 1,
      total_pages: 4,
      total_items: 1540,
    });
  });

  it("validates aliases at the broker boundary", () => {
    expect(normalizeAccountAlias("  work gmail  ")).toBe("work gmail");
    expect(() => normalizeAccountAlias("bad\nalias")).toThrow(/printable/i);
  });

  // Composio prefixes slugs that would otherwise lead with a digit, so
  // 1Password arrives as `_1password`. The catalog lists those toolkits, so
  // routing them to the 404 branch stranded every one of them at Connect.
  it("routes underscore-prefixed toolkit slugs instead of 404ing them", async () => {
    const token = "a".repeat(64);
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx } = testEnv(fetchCalls);
    const dbEnv = {
      ...env,
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                run: async () => {},
                first: async () => (
                  sql.includes("FROM installations")
                    ? { id: "install-1", composio_user_id: "omb_user", session_id: "trs_test", disabled_at: null }
                    : null
                ),
              };
            },
          };
        },
      },
    };
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.endsWith("/link")) return Response.json({ redirect_url: "https://connect.composio.dev/link/_1password" });
      if (url.includes("/connected_accounts")) return Response.json({ items: [] });
      if (url.includes("/toolkits")) return Response.json({ items: [] });
      return Response.json(session("trs_test", "omb_user"));
    });

    const response = await worker.fetch(
      new Request("https://broker.test/v1/connectors/_1password/authorize", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ alias: "work" }),
      }),
      dbEnv as never,
      ctx as never,
    );

    expect(response.status).not.toBe(404);
    await expect(response.json()).resolves.not.toEqual({ error: "not found" });
    expect(fetchCalls.some((call) => call.url.endsWith("/link"))).toBe(true);
  });
});

// The verified-Session cache is module state that outlives a test, so every
// test here owns its Session ids.
describe("MCP relay Session reuse", () => {
  afterEach(() => vi.useRealTimers());

  /** One installation behind worker.fetch: a D1 row that keeps what the Worker
   *  writes, and a Composio stub that logs each upstream call in order. */
  function relayHarness(sessionId: string, lastSeenAt = 0) {
    const token = "b".repeat(64);
    const row = { id: `install-${sessionId}`, composio_user_id: "omb_relay", session_id: sessionId, disabled_at: null, last_seen_at: lastSeenAt };
    const calls: string[] = [];
    const mcpBodies: string[] = [];
    const lastSeenWrites: number[] = [];
    const gone = new Set<string>();
    const mcpFailures: Array<number | "throw"> = [];
    const env = {
      COMPOSIO_API_BASE: "https://backend.composio.dev/api/v3.1",
      COMPOSIO_API_KEY: "ak_test",
      SESSION_LIMITER: { limit: async () => ({ success: true }) },
      DB: {
        prepare(sql: string) {
          return {
            bind(...values: unknown[]) {
              return {
                first: async () => ({ ...row }),
                run: async () => {
                  if (sql.includes("SET session_id")) row.session_id = String(values[0]);
                  if (sql.startsWith("UPDATE installations SET last_seen_at")) {
                    lastSeenWrites.push(Number(values[0]));
                    row.last_seen_at = Number(values[0]);
                  }
                },
              };
            },
          };
        },
      },
    };
    const ctx = { waitUntil(promise: Promise<unknown>) { void promise; } };
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.hostname === "mcp.composio.dev") {
        const id = url.pathname.slice(1);
        calls.push(`MCP ${id}`);
        mcpBodies.push(new TextDecoder().decode(init?.body as ArrayBuffer));
        const failure = mcpFailures.shift();
        if (failure === "throw") throw new TypeError("network connection lost");
        if (failure) return Response.json({ error: "upstream failure" }, { status: failure });
        if (gone.has(id)) return Response.json({ error: "session not found" }, { status: 404 });
        return Response.json({ jsonrpc: "2.0", id: 1, result: {} }, { headers: { "mcp-session-id": "mcp-1" } });
      }
      const path = url.pathname.replace("/api/v3.1", "");
      calls.push(`${method} ${path}`);
      const lookup = path.match(/^\/tool_router\/session\/([^/]+)$/)?.[1];
      if (method === "GET" && lookup) {
        return gone.has(lookup) ? Response.json({ error: "not found" }, { status: 404 }) : Response.json(session(lookup, "omb_relay"));
      }
      if (method === "POST" && path === "/tool_router/session") return Response.json(session(`${sessionId}_new`, "omb_relay"), { status: 201 });
      if (path.endsWith("/link")) return Response.json({ redirect_url: "https://connect.composio.dev/link/gmail" });
      if (path.includes("/toolkits")) return Response.json({ items: [{ slug: "gmail", connected_account: { id: "ca_relay", status: "ACTIVE" } }] });
      if (path.includes("/connected_accounts")) return Response.json({ items: [{ id: "ca_relay", toolkit: { slug: "gmail" }, status: "ACTIVE" }] });
      return Response.json({ error: "not mocked" }, { status: 500 });
    });
    const send = async (path: string, init: RequestInit = {}) => {
      const before = calls.length;
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      const response = await worker.fetch(new Request(`https://broker.test${path}`, { ...init, headers }), env as never, ctx as never);
      return { response, calls: calls.slice(before) };
    };
    const mcp = (mcpSessionId?: string, body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}') => send("/v1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...(mcpSessionId ? { "mcp-session-id": mcpSessionId } : {}) },
      body,
    });
    return { row, calls, mcpBodies, lastSeenWrites, gone, mcpFailures, send, mcp };
  }

  it("relays MCP messages without re-reading a Session this isolate verified", async () => {
    const relay = relayHarness("trs_reuse");

    const first = await relay.mcp();
    expect(first.response.status).toBe(200);
    expect(first.calls).toEqual(["GET /tool_router/session/trs_reuse", "MCP trs_reuse"]);
    const second = await relay.mcp("mcp-1");
    expect(second.response.status).toBe(200);
    await expect(second.response.json()).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(second.response.headers.get("mcp-session-id")).toBe("mcp-1");
    expect(second.calls).toEqual(["MCP trs_reuse"]);
    expect(relay.calls).toHaveLength(3);
  });

  it("re-reads the Session when D1 points the installation at another one", async () => {
    const relay = relayHarness("trs_before_upgrade");
    await relay.mcp();
    relay.row.session_id = "trs_after_upgrade";

    expect((await relay.mcp("mcp-1")).calls).toEqual(["GET /tool_router/session/trs_after_upgrade", "MCP trs_after_upgrade"]);
  });

  it("re-reads a verified Session once it is five minutes old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    const relay = relayHarness("trs_ttl");
    await relay.mcp();

    vi.setSystemTime(new Date("2026-10-06T12:04:59Z"));
    expect((await relay.mcp("mcp-1")).calls).toEqual(["MCP trs_ttl"]);
    vi.setSystemTime(new Date("2026-10-06T12:05:01Z"));
    expect((await relay.mcp("mcp-1")).calls).toEqual(["GET /tool_router/session/trs_ttl", "MCP trs_ttl"]);
  });

  it("resends an initialize once when Composio dropped the reused Session", async () => {
    const relay = relayHarness("trs_dropped");
    await relay.mcp();
    relay.gone.add("trs_dropped");
    const initialize = '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}';

    const retried = await relay.mcp(undefined, initialize);
    expect(retried.response.status).toBe(200);
    expect(retried.calls).toEqual([
      "MCP trs_dropped",
      "GET /tool_router/session/trs_dropped",
      "POST /tool_router/session",
      "MCP trs_dropped_new",
    ]);
    expect(relay.mcpBodies.slice(-2)).toEqual([initialize, initialize]);
    expect(relay.row.session_id).toBe("trs_dropped_new");
    // The replacement is verified and already stored in D1, so it is reused.
    expect((await relay.mcp("mcp-1")).calls).toEqual(["MCP trs_dropped_new"]);
  });

  // The desktop server drops mcp-session-id when it no longer knows which
  // backend a transport session belongs to (after a restart, for example). An
  // uncached request would look the Session up and deliver the message, so
  // reuse must not turn that into a failure.
  it("still delivers a message without an mcp-session-id when Composio dropped the Session", async () => {
    const relay = relayHarness("trs_server_restart");
    await relay.mcp();
    relay.gone.add("trs_server_restart");
    const toolsCall = '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"GMAIL_FETCH_EMAILS"}}';

    const delivered = await relay.mcp(undefined, toolsCall);
    expect(delivered.response.status).toBe(200);
    expect(delivered.calls.at(-1)).toBe("MCP trs_server_restart_new");
    expect(relay.mcpBodies.at(-1)).toBe(toolsCall);
  });

  it("passes a 404 for an existing MCP session through and re-reads next time", async () => {
    const relay = relayHarness("trs_stale_mcp");
    await relay.mcp();
    relay.gone.add("trs_stale_mcp");

    const stale = await relay.mcp("mcp-1");
    expect(stale.response.status).toBe(404);
    expect(stale.calls).toEqual(["MCP trs_stale_mcp"]);
    const reinitialized = await relay.mcp();
    expect(reinitialized.response.status).toBe(200);
    expect(reinitialized.calls).toEqual([
      "GET /tool_router/session/trs_stale_mcp",
      "POST /tool_router/session",
      "MCP trs_stale_mcp_new",
    ]);
  });

  it("drops a reused Session after any other upstream failure", async () => {
    const relay = relayHarness("trs_unauthorized");
    await relay.mcp();
    relay.mcpFailures.push(401);

    const denied = await relay.mcp();
    expect(denied.response.status).toBe(401);
    expect(denied.calls).toEqual(["MCP trs_unauthorized"]);
    expect((await relay.mcp("mcp-1")).calls).toEqual(["GET /tool_router/session/trs_unauthorized", "MCP trs_unauthorized"]);

    relay.mcpFailures.push("throw");
    expect((await relay.mcp("mcp-1")).response.status).toBe(503);
    expect((await relay.mcp("mcp-1")).calls).toEqual(["GET /tool_router/session/trs_unauthorized", "MCP trs_unauthorized"]);
  });

  it("writes last_seen_at at most once per ten minutes", async () => {
    const recent = relayHarness("trs_seen_recently", Date.now() - 60_000);
    await recent.mcp();
    await recent.mcp("mcp-1");
    await recent.send("/v1/connectors/connected");
    expect(recent.lastSeenWrites).toEqual([]);

    const idle = relayHarness("trs_seen_long_ago", Date.now() - 11 * 60_000);
    await idle.mcp();
    await idle.mcp("mcp-1");
    await idle.send("/v1/connectors/connected");
    expect(idle.lastSeenWrites).toHaveLength(1);
  });

  it("keeps checking the Session on every connector-management route", async () => {
    const relay = relayHarness("trs_connectors");
    await relay.mcp();
    const lookup = "GET /tool_router/session/trs_connectors";

    for (const [path, init] of [
      ["/v1/connectors/connected", {}],
      ["/v1/connectors?services=gmail", {}],
      ["/v1/connectors/gmail/authorize", { method: "POST", body: JSON.stringify({ alias: "second" }) }],
      ["/v1/connectors/gmail", { method: "DELETE" }],
      ["/v1/connectors/gmail/accounts/ca_relay", { method: "DELETE" }],
    ] as const) {
      const result = await relay.send(path, init);
      expect(result.response.status, path).toBe(200);
      expect(result.calls[0], path).toBe(lookup);
    }
  });
});
