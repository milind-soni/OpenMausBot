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
import { streamedBody } from "./test-harness";

const multiAccount = {
  enable: true,
  max_accounts_per_toolkit: 10,
  require_explicit_selection: true,
};

function session(id: string, userId: string, configured = true) {
  return {
    session_id: id,
    mcp: { url: `https://mcp.composio.dev/${id}` },
    config: { user_id: userId, ...(configured ? { multi_account: multiAccount } : {}) },
  };
}

function testEnv(fetchCalls: Array<{ url: string; init?: RequestInit }>, userId = "omb_stable") {
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
              first: async () => ({ id: values[0], composio_user_id: userId, session_id: null, disabled_at: null }),
              run: async () => {
                dbRuns.push({ sql, values });
                return { meta: { changes: 1 } };
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

  it("stops reading a streamed authorize body once it passes 2 KiB", async () => {
    const stream = streamedBody(1024, 64);
    const refused = await requestAlias(new Request("https://broker.test/v1/connectors/gmail/authorize", stream.init)).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(413);
    expect(stream.read.cancelled).toBe(true);
    expect(stream.read.bytes).toBeLessThanOrEqual(4 * 1024);
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
      authConfigs: {},
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

  function accountFixture(installationUser: string) {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx } = testEnv(fetchCalls, installationUser);
    const installation = { id: "retry-install", composio_user_id: installationUser, session_id: "trs_retry", disabled_at: null };
    const fixture = {
      accounts: [] as Array<{ id: string; status?: string; alias?: string; toolkit: { slug: string } }>,
      deleteStatus: 200,
      authorize: (alias?: string) => authorize("gmail", alias, installation, env as never, ctx as never),
      links: () => fetchCalls.filter((call) => call.url.endsWith("/link"))
        .map((call) => JSON.parse(String(call.init?.body)) as { toolkit: string; alias?: string }),
      deletes: () => fetchCalls.filter((call) => call.init?.method === "DELETE").map((call) => call.url),
      fetchCalls,
    };
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (init?.method === "DELETE") return Response.json({ success: fixture.deleteStatus === 200 }, { status: fixture.deleteStatus });
      if (url.includes("/connected_accounts")) {
        expect(new URL(url).searchParams.get("user_ids")).toBe(installationUser);
        return Response.json({ items: fixture.accounts });
      }
      if (url.endsWith("/link")) return Response.json({ redirect_url: "https://connect.composio.dev/link/gmail" });
      return Response.json(session("trs_retry", installationUser));
    });
    return fixture;
  }

  it("retries without a label while no account works, and asks for one beside a working account", async () => {
    const fixture = accountFixture("retry-user");
    for (const status of ["INITIALIZING", "initiated", "EXPIRED", "FAILED", "INACTIVE", "PENDING", "unknown"]) {
      fixture.accounts = [{ id: "old", alias: "original", status, toolkit: { slug: "Gmail" } }];
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fixture.authorize();
        expect(response.status, status).toBe(200);
        await expect(response.json()).resolves.toEqual({ url: "https://connect.composio.dev/link/gmail" });
        expect(fixture.links().at(-1)).toEqual({ toolkit: "gmail", alias: expect.stringMatching(/^omb-retry-[0-9a-f-]{36}$/) });
      }
    }
    expect(new Set(fixture.links().map((body) => body.alias)).size).toBe(14);
    expect(fixture.deletes()).toEqual([]);
    const successfulLinks = fixture.links().length;
    for (const status of ["ACTIVE", undefined]) {
      fixture.accounts = [{ id: "expired", status: "EXPIRED", toolkit: { slug: "gmail" } }, { id: "protected", status, toolkit: { slug: "gmail" } }];
      const response = await fixture.authorize();
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Add an account alias so the existing connection is not replaced" });
    }
    fixture.accounts = Array.from({ length: 10 }, (_, id) => ({ id: String(id), status: "INITIALIZING", toolkit: { slug: "gmail" } }));
    const full = await fixture.authorize();
    expect(full.status).toBe(409);
    await expect(full.json()).resolves.toEqual({ error: "gmail already has the maximum of 10 accounts" });
    expect(fixture.links()).toHaveLength(successfulLinks);
    expect(fixture.deletes()).toEqual([]);
  });

  it("links a sixth account, raising a Session made under the old cap of 5 in place first", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx } = testEnv(fetchCalls, "agency-user");
    const installation = { id: "agency-install", composio_user_id: "agency-user", session_id: "trs_old_cap", disabled_at: null };
    let cap = 5;
    const accounts = Array.from({ length: 5 }, (_, id) => ({ id: `ca_${id}`, alias: `sub-${id}`, status: "ACTIVE", toolkit: { slug: "gmail" } }));
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.includes("/connected_accounts")) return Response.json({ items: accounts });
      if (url.endsWith("/link")) return Response.json({ redirect_url: "https://connect.composio.dev/link/gmail" });
      if (url.includes("/auth_configs")) return Response.json({ items: [] });
      if (init?.method === "PATCH") {
        cap = (JSON.parse(String(init.body)) as { multi_account: { max_accounts_per_toolkit: number } }).multi_account.max_accounts_per_toolkit;
        return Response.json({ session_id: "trs_old_cap" });
      }
      const old = session("trs_old_cap", "agency-user");
      return Response.json({ ...old, config: { ...old.config, multi_account: { ...multiAccount, max_accounts_per_toolkit: cap } } });
    });

    const response = await authorize("gmail", "sub-5", installation, env as never, ctx as never);
    expect(response.status).toBe(200);
    const steps = fetchCalls.filter((call) => call.init?.method === "PATCH" || call.url.endsWith("/link"));
    expect(steps.map((call) => [call.init?.method, call.url])).toEqual([
      ["PATCH", "https://backend.composio.dev/api/v3.1/tool_router/session/trs_old_cap"],
      ["POST", "https://backend.composio.dev/api/v3.1/tool_router/session/trs_old_cap/link"],
    ]);
    expect(JSON.parse(String(steps[0]!.init?.body))).toEqual({ multi_account: multiAccount });
    expect(fetchCalls.some((call) => call.init?.method === "POST" && call.url.endsWith("/tool_router/session"))).toBe(false);
  });

  it("still links when the request to raise the old cap cannot reach Composio", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx } = testEnv(fetchCalls, "offline-cap-user");
    const installation = { id: "offline-cap-install", composio_user_id: "offline-cap-user", session_id: "trs_cap_offline", disabled_at: null };
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (init?.method === "PATCH") throw new TypeError("fetch failed");
      if (url.includes("/connected_accounts")) return Response.json({ items: [{ id: "ca_0", alias: "sub-0", status: "ACTIVE", toolkit: { slug: "gmail" } }] });
      if (url.endsWith("/link")) return Response.json({ redirect_url: "https://connect.composio.dev/link/gmail" });
      if (url.includes("/auth_configs")) return Response.json({ items: [] });
      const old = session("trs_cap_offline", "offline-cap-user");
      return Response.json({ ...old, config: { ...old.config, multi_account: { ...multiAccount, max_accounts_per_toolkit: 5 } } });
    });

    const response = await authorize("gmail", "sub-1", installation, env as never, ctx as never);
    expect(response.status).toBe(200);
    expect(fetchCalls.some((call) => call.init?.method === "PATCH")).toBe(true);
    expect(fetchCalls.some((call) => call.url.endsWith("/trs_cap_offline/link"))).toBe(true);
  });

  it("links a toolkit whose only account failed to sign in", async () => {
    const fixture = accountFixture("failed-user");
    fixture.accounts = [{ id: "ca_failed", status: "FAILED", toolkit: { slug: "gmail" } }];
    const response = await fixture.authorize();
    expect(response.status).toBe(200);
    expect(fixture.links()).toHaveLength(1);
    expect(fixture.deletes()).toEqual([]);
  });

  it("frees a label held by an account that is not active, and keeps one a working account holds", async () => {
    const fixture = accountFixture("label-user");
    fixture.accounts = [
      { id: "ca_old_work", alias: "work", status: "INITIATED", toolkit: { slug: "gmail" } },
      { id: "ca_personal", alias: "personal", status: "ACTIVE", toolkit: { slug: "gmail" } },
    ];
    const replaced = await fixture.authorize("Work");
    expect(replaced.status).toBe(200);
    expect(fixture.deletes()).toEqual(["https://backend.composio.dev/api/v3.1/connected_accounts/ca_old_work?revoke_on_delete=true"]);
    expect(fixture.links()).toEqual([{ toolkit: "gmail", alias: "Work" }]);
    const order = fixture.fetchCalls.map((call) => call.init?.method === "DELETE" ? "delete" : call.url.endsWith("/link") ? "link" : "other");
    expect(order.indexOf("delete")).toBeLessThan(order.indexOf("link"));

    fixture.accounts = [{ id: "ca_work", alias: "work", status: "ACTIVE", toolkit: { slug: "gmail" } }];
    const taken = await fixture.authorize("work");
    expect(taken.status).toBe(409);
    await expect(taken.json()).resolves.toEqual({ error: 'Account alias "work" is already in use for gmail' });
    fixture.accounts = [{ id: "ca_unknown", alias: "work", toolkit: { slug: "gmail" } }];
    expect((await fixture.authorize("work")).status).toBe(409);
    expect(fixture.deletes()).toHaveLength(1);
    expect(fixture.links()).toHaveLength(1);

    const working = Array.from({ length: 9 }, (_, id) => ({ id: `ca_${id}`, alias: `other-${id}`, status: "ACTIVE", toolkit: { slug: "gmail" } }));
    fixture.accounts = [{ id: "ca_old_work", alias: "work", status: "INITIATED", toolkit: { slug: "gmail" } }, ...working];
    expect((await fixture.authorize("work")).status).toBe(200);
    fixture.accounts.push({ id: "ca_9", alias: "other-9", status: "ACTIVE", toolkit: { slug: "gmail" } });
    expect((await fixture.authorize("work")).status).toBe(409);
    expect(fixture.links()).toHaveLength(2);

    fixture.accounts = [{ id: "ca_old_work", alias: "work", status: "EXPIRED", toolkit: { slug: "gmail" } }];
    fixture.deleteStatus = 500;
    expect((await fixture.authorize("work")).status).toBe(502);
    expect(fixture.links()).toHaveLength(2);
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

    // A malformed cursor asks for the first page, which is kept from the first request.
    expect(fetchCalls.map((call) => new URL(call.url).searchParams.get("cursor"))).toEqual([
      null,
      "eyJwYWdlIjoyfQ==",
    ]);
  });

  describe("kept catalog pages", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    async function catalogHarness(page: () => Response = () => Response.json({ items: [{ slug: "deepgram" }], next_cursor: "Mi01MDA=" })) {
      vi.resetModules();
      const { catalog: read } = await import("./index");
      const upstream: string[] = [];
      const { env } = testEnv([]);
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        upstream.push(new URL(String(input)).searchParams.get("cursor") ?? "");
        return page();
      });
      const background: Array<Promise<unknown>> = [];
      const ctx = { waitUntil: (promise: Promise<unknown>) => void background.push(promise) };
      const catalogEnv = { ...env, COMPOSIO_TOOLKIT_BASE: "https://backend.composio.dev/api/v3" } as never;
      const get = (cursor?: string) => read(catalogEnv, new URL(`https://broker.test/v1/catalog${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`), ctx);
      return { get, upstream, settled: () => Promise.all(background) };
    }

    it("answers a page it has from memory, each cursor its own page, for thirty minutes", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
      const { get, upstream } = await catalogHarness();
      const first = await get();
      const again = await get();
      expect(upstream).toEqual([""]);
      expect(await again.json()).toEqual(await first.json());
      expect(again.headers.get("cache-control")).toBe("private, max-age=600");
      expect(again.headers.get("content-type")).toContain("application/json");

      await get("Mi01MDA=");
      await get("Mi01MDA=");
      expect(upstream).toEqual(["", "Mi01MDA="]);

      vi.setSystemTime(new Date("2026-11-20T12:29:59Z"));
      await get();
      expect(upstream).toHaveLength(2);
      vi.setSystemTime(new Date("2026-11-20T12:30:01Z"));
      await get();
      expect(upstream).toEqual(["", "Mi01MDA=", ""]);
    });

    it.each([
      ["an upstream error", () => Response.json({ error: "down" }, { status: 500 }), 502],
      ["a page with no toolkits", () => Response.json({ items: [] }), 200],
      ["a page that is not a catalog", () => new Response("<html>", { headers: { "content-type": "text/html" } }), 200],
    ])("never keeps %s", async (_name, page, status) => {
      const { get, upstream } = await catalogHarness(page);
      expect((await get()).status).toBe(status);
      expect((await get()).status).toBe(status);
      expect(upstream).toHaveLength(2);
    });

    it("stores a page in the data center's cache under its cursor alone, and another isolate answers from there", async () => {
      const stored = new Map<string, { body: string; headers: Headers }>();
      const edge = {
        match: async (key: string) => {
          const hit = stored.get(key);
          return hit ? new Response(hit.body, { headers: hit.headers }) : undefined;
        },
        put: async (key: string, response: Response) => void stored.set(key, { body: await response.text(), headers: response.headers }),
      };
      const first = await catalogHarness();
      vi.stubGlobal("caches", { default: edge });
      await first.get();
      await first.get("Mi01MDA=");
      await first.settled();
      expect([...stored.keys()]).toEqual(["https://catalog.invalid/v1/catalog?cursor=", "https://catalog.invalid/v1/catalog?cursor=Mi01MDA%3D"]);
      expect(stored.get("https://catalog.invalid/v1/catalog?cursor=")!.headers.get("cache-control")).toBe("public, max-age=1800");

      const second = await catalogHarness();
      vi.stubGlobal("caches", { default: edge });
      const answer = await second.get();
      expect(await answer.json()).toEqual({ items: [{ slug: "deepgram" }], next_cursor: "Mi01MDA=" });
      expect(answer.headers.get("cache-control")).toBe("private, max-age=600");
      await second.get();
      expect(second.upstream).toEqual([]);
    });

    it("still answers when the data center's cache fails", async () => {
      const { get, upstream, settled } = await catalogHarness();
      vi.stubGlobal("caches", { default: { match: async () => { throw new Error("cache down"); }, put: async () => { throw new Error("cache down"); } } });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect((await get()).status).toBe(200);
      await settled();
      expect(upstream).toEqual([""]);
      warn.mockRestore();
    });
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
                  return { meta: { changes: 1 } };
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
      // Read once per isolate and cached, so it is not part of a request's call sequence.
      if (path === "/auth_configs") return Response.json({ items: [] });
      calls.push(`${method} ${path}`);
      const under = path.match(/^\/tool_router\/session\/([^/]+)\//)?.[1];
      if (under && gone.has(under)) return Response.json({ error: "session not found" }, { status: 404 });
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

  // The desktop server drops mcp-session-id when it no longer knows a transport
  // session's backend (after a restart, say).
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

  const MANAGEMENT_ROUTES = [
    ["/v1/connectors/connected", {}],
    ["/v1/connectors?services=gmail", {}],
    ["/v1/connectors/gmail/authorize", { method: "POST", body: JSON.stringify({ alias: "second" }) }],
    ["/v1/connectors/gmail", { method: "DELETE" }],
    ["/v1/connectors/gmail/accounts/ca_relay", { method: "DELETE" }],
  ] as const;

  it("checks the Session once for the connector-management routes that follow within five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const relay = relayHarness("trs_connectors");
    const lookup = "GET /tool_router/session/trs_connectors";
    const first = await relay.send("/v1/connectors/connected");
    expect(first.calls[0]).toBe(lookup);

    for (const [path, init] of MANAGEMENT_ROUTES) {
      const result = await relay.send(path, init);
      expect(result.response.status, path).toBe(200);
      expect(result.calls, path).not.toContain(lookup);
    }
    expect((await relay.mcp()).calls).toEqual(["MCP trs_connectors"]);

    vi.setSystemTime(new Date("2026-11-20T12:05:01Z"));
    expect((await relay.send("/v1/connectors/connected")).calls[0]).toBe(lookup);
  });

  it.each(MANAGEMENT_ROUTES.slice(0, 4))("looks a dropped Session up again and sends %s once more", async (path, init) => {
    const id = `trs_dropped_${MANAGEMENT_ROUTES.findIndex(([route]) => route === path)}`;
    const relay = relayHarness(id);
    await relay.send("/v1/connectors/connected");
    relay.gone.add(id);

    const result = await relay.send(path, init);
    expect(result.response.status).toBe(200);
    expect(result.calls).toContain(`GET /tool_router/session/${id}`);
    expect(result.calls).toContain("POST /tool_router/session");
    expect(result.calls.filter((call) => call.includes(`/tool_router/session/${id}_new/`))).toHaveLength(1);
    expect(relay.row.session_id).toBe(`${id}_new`);
    expect(result.calls.filter((call) => call.endsWith("/link"))).toHaveLength(path.endsWith("/authorize") ? 2 : 0);
  });

  it("looks the Session up again when D1 points the installation at another one", async () => {
    const relay = relayHarness("trs_before_adoption");
    await relay.send("/v1/connectors/connected");
    relay.row.session_id = "trs_after_adoption";
    expect((await relay.send("/v1/connectors/connected")).calls[0]).toBe("GET /tool_router/session/trs_after_adoption");
  });
});

// The auth-config cache and upgrade sets are module state, so every test
// here loads a fresh copy of the Worker.
describe("project auth configs", () => {
  afterEach(() => vi.useRealTimers());

  const zohoCrm = { id: "ac_new", status: "ENABLED", is_composio_managed: false, last_updated_at: "2026-10-01T00:00:00Z", toolkit: { slug: "Zoho_Crm" } };

  function projectHarness(authConfigs: () => Response | Promise<Response>) {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx, dbRuns } = testEnv(fetchCalls);
    const sessions = new Map<string, unknown>();
    let created = 0;
    const harness = {
      env, ctx, dbRuns, fetchCalls, sessions,
      echoAuthConfigs: true,
      creations: () => fetchCalls.filter((call) => call.init?.method === "POST").map((call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>),
      authConfigReads: () => fetchCalls.filter((call) => call.url.includes("/auth_configs")),
      install: (sessionId: string | null) => ({ id: "install-1", composio_user_id: "omb_stable", session_id: sessionId, disabled_at: null }),
    };
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.includes("/auth_configs")) return authConfigs();
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { user_id: string; auth_configs?: Record<string, string> };
        const wire = session(`trs_new_${++created}`, body.user_id);
        if (harness.echoAuthConfigs && body.auth_configs) Object.assign(wire.config, { auth_configs: body.auth_configs });
        sessions.set(wire.session_id, wire);
        return Response.json(wire, { status: 201 });
      }
      const id = url.match(/\/tool_router\/session\/([^/?]+)$/)?.[1];
      const stored = id && sessions.get(id);
      return stored ? Response.json(stored) : Response.json({ error: "not found" }, { status: 404 });
    });
    return harness;
  }

  async function freshBroker() {
    vi.resetModules();
    return import("./index");
  }

  it("creates Sessions with the project's own auth configs, newest enabled one per toolkit", async () => {
    const { ensureSession, listCustomAuthConfigs } = await freshBroker();
    const harness = projectHarness(() => {
      const second = new URL(harness.fetchCalls.at(-1)?.url ?? "").searchParams.get("cursor") === "page-2";
      return Response.json(second
        ? { items: [{ id: "ac_x", is_composio_managed: false, toolkit: { slug: "X" } }] }
        : {
          items: [
            { id: "ac_old", is_composio_managed: false, last_updated_at: "2026-09-01T00:00:00Z", toolkit: { slug: "zoho_crm" } },
            zohoCrm,
            { id: "ac_gmail", is_composio_managed: true, toolkit: { slug: "gmail" } },
            { id: "ac_hubspot", status: "DISABLED", is_composio_managed: false, toolkit: { slug: "hubspot" } },
            { id: "ac_slack", is_composio_managed: false, is_enabled_for_tool_router: false, toolkit: { slug: "slack" } },
            { is_composio_managed: false, toolkit: { slug: "noid" } },
          ],
          next_cursor: "page-2",
        });
    });

    await expect(ensureSession(harness.install(null), harness.env as never, harness.ctx as never)).resolves.toMatchObject({
      sessionId: "trs_new_1",
      authConfigs: { zoho_crm: "ac_new", twitter: "ac_x" },
    });
    expect(harness.authConfigReads().map((call) => new URL(call.url).searchParams.get("is_composio_managed"))).toEqual(["false", "false"]);
    expect(harness.creations()).toEqual([expect.objectContaining({
      user_id: "omb_stable",
      multi_account: multiAccount,
      auth_configs: { zoho_crm: "ac_new", twitter: "ac_x" },
    })]);
    expect(harness.dbRuns.some((run) => run.sql.includes("SET session_id") && run.values[0] === "trs_new_1")).toBe(true);
    await expect(listCustomAuthConfigs(harness.env as never)).resolves.toEqual({ zoho_crm: "ac_new", twitter: "ac_x" });
  });

  it("recreates a Session that lacks the project's auth configs once, keeping the Composio user", async () => {
    const { ensureSession } = await freshBroker();
    const harness = projectHarness(() => Response.json({ items: [zohoCrm] }));
    harness.sessions.set("trs_old", session("trs_old", "omb_stable"));
    harness.echoAuthConfigs = false;

    const upgraded = await ensureSession(harness.install("trs_old"), harness.env as never, harness.ctx as never);
    expect(upgraded.sessionId).toBe("trs_new_1");
    expect(harness.creations()).toEqual([expect.objectContaining({ user_id: "omb_stable", auth_configs: { zoho_crm: "ac_new" } })]);
    expect(harness.dbRuns.filter((run) => run.sql.includes("SET session_id")).map((run) => [run.values[0], run.values[2]])).toEqual([["trs_new_1", "install-1"]]);

    // Composio left auth_configs out of the echo: the upgrade is not retried.
    await expect(ensureSession(harness.install("trs_new_1"), harness.env as never, harness.ctx as never)).resolves.toMatchObject({ sessionId: "trs_new_1" });
    expect(harness.creations()).toHaveLength(1);

    // A Session that echoes the config (in any slug case) is reused as is.
    harness.sessions.set("trs_covered", { ...session("trs_covered", "omb_stable"), config: { user_id: "omb_stable", multi_account: multiAccount, auth_configs: { Zoho_Crm: "ac_new" } } });
    await expect(ensureSession(harness.install("trs_covered"), harness.env as never, harness.ctx as never)).resolves.toMatchObject({ sessionId: "trs_covered" });
    expect(harness.creations()).toHaveLength(1);
    expect(harness.authConfigReads()).toHaveLength(1);
  });

  it("keeps Sessions working when the auth config read fails", async () => {
    const { ensureSession } = await freshBroker();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = projectHarness(() => Response.json({ error: "auth configs unavailable" }, { status: 500 }));
    harness.sessions.set("trs_ok", session("trs_ok", "omb_stable"));

    await expect(ensureSession(harness.install("trs_ok"), harness.env as never, harness.ctx as never)).resolves.toMatchObject({ sessionId: "trs_ok" });
    expect(harness.creations()).toEqual([]);
    await expect(ensureSession(harness.install(null), harness.env as never, harness.ctx as never)).resolves.toMatchObject({ sessionId: "trs_new_1" });
    expect(harness.creations()).toEqual([expect.not.objectContaining({ auth_configs: expect.anything() })]);
    expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)) as { message: string })).toEqual([
      expect.objectContaining({ message: "auth config lookup failed", error: "auth configs unavailable" }),
    ]);
    errors.mockRestore();
  });

  it("reads auth configs once per ten minutes and keeps the last good map over a failed read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    const { ensureSession } = await freshBroker();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let items: unknown[] | "fail" = [zohoCrm];
    const harness = projectHarness(() => items === "fail"
      ? Response.json({ error: "down" }, { status: 503 })
      : Response.json({ items }));
    const verify = (sessionId: string) => ensureSession(harness.install(sessionId), harness.env as never, harness.ctx as never);

    await verify("trs_missing");
    await verify("trs_new_1");
    vi.setSystemTime(new Date("2026-10-15T12:09:59Z"));
    await verify("trs_new_1");
    expect(harness.authConfigReads()).toHaveLength(1);
    expect(harness.creations()).toHaveLength(1);

    // A failed refresh keeps the known map, so the Session is still covered.
    items = "fail";
    vi.setSystemTime(new Date("2026-10-15T12:10:01Z"));
    await verify("trs_new_1");
    expect(harness.authConfigReads()).toHaveLength(2);
    expect(harness.creations()).toHaveLength(1);
    expect(errors).toHaveBeenCalledTimes(1);

    // The failed read is retried after a minute; a new auth config upgrades the Session once more.
    items = [zohoCrm, { id: "ac_x", is_composio_managed: false, toolkit: { slug: "x" } }];
    vi.setSystemTime(new Date("2026-10-15T12:10:30Z"));
    await verify("trs_new_1");
    expect(harness.authConfigReads()).toHaveLength(2);
    vi.setSystemTime(new Date("2026-10-15T12:11:02Z"));
    await expect(verify("trs_new_1")).resolves.toMatchObject({ sessionId: "trs_new_2", authConfigs: { zoho_crm: "ac_new", twitter: "ac_x" } });
    expect(harness.authConfigReads()).toHaveLength(3);
    expect(harness.creations().at(-1)).toEqual(expect.objectContaining({ user_id: "omb_stable", auth_configs: { zoho_crm: "ac_new", twitter: "ac_x" } }));
    errors.mockRestore();
  });
});
