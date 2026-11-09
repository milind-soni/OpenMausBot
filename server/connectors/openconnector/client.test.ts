// The OpenConnector runtime-api client. A stub HTTP server on an ephemeral port answers every
// call; no test binds port 3000 or talks to a real runtime.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OpenConnectorClient, OpenConnectorError, normalizeOpenConnectorBaseUrl } from "./client.ts";

let api: Server;
let origin = "";
const calls: Array<{ method: string; path: string; body: unknown; authorization: string }> = [];
let nextResponse: { status: number; body: unknown; headers?: Record<string, string> } | null = null;

beforeAll(async () => {
  api = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls.push({
      method: req.method ?? "GET",
      path: url.pathname + url.search,
      body: raw ? JSON.parse(raw) : null,
      authorization: String(req.headers.authorization ?? ""),
    });
    const answer = nextResponse ?? { status: 200, body: { success: true, message: "OK", data: null } };
    nextResponse = null;
    res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => api.close(resolve));
});

const client = () => new OpenConnectorClient({ baseUrl: origin, adminToken: "admintok" });
const lastCall = () => calls.at(-1)!;

describe("normalizeOpenConnectorBaseUrl", () => {
  it("accepts https anywhere and http on loopback only", () => {
    expect(normalizeOpenConnectorBaseUrl("https://runtime.example.test/")).toBe("https://runtime.example.test");
    expect(normalizeOpenConnectorBaseUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
    expect(() => normalizeOpenConnectorBaseUrl("http://open-connector:3000")).toThrow(/loopback/);
    expect(() => normalizeOpenConnectorBaseUrl("http://192.168.1.10:3000")).toThrow(/loopback/);
  });

  it("refuses credentials, a query, or a fragment in the URL", () => {
    expect(() => normalizeOpenConnectorBaseUrl("https://user:pass@runtime.example.test")).toThrow(/credentials/);
    expect(() => normalizeOpenConnectorBaseUrl("https://runtime.example.test?token=1")).toThrow(/credentials/);
    expect(() => normalizeOpenConnectorBaseUrl("https://runtime.example.test/#x")).toThrow(/credentials/);
  });
});

describe("envelope handling", () => {
  it("sends the bearer token and returns the envelope data", async () => {
    nextResponse = { status: 200, body: { success: true, message: "OK", data: { services: ["github"] } } };
    const data = await client().authenticatedServices(["github"]);
    expect(data).toEqual(["github"]);
    expect(lastCall().authorization).toBe("Bearer admintok");
    expect(lastCall().path).toBe("/v1/apps/authenticated?service=github");
  });

  it("repeats the service query for every candidate", async () => {
    nextResponse = { status: 200, body: { success: true, data: ["github", "slack"] } };
    await client().authenticatedServices(["github", "slack", "gmail"]);
    expect(lastCall().path).toBe("/v1/apps/authenticated?service=github&service=slack&service=gmail");
  });

  it("returns an empty list without candidates, without calling the runtime", async () => {
    const before = calls.length;
    await expect(client().authenticatedServices([])).resolves.toEqual([]);
    expect(calls.length).toBe(before);
  });

  it("throws OpenConnectorError with the runtime errorCode on success:false", async () => {
    nextResponse = { status: 200, body: { success: false, message: "no such action", errorCode: "unknown_action" } };
    const error = await client().execute("nope.missing", {}).catch((caught) => caught);
    expect(error).toBeInstanceOf(OpenConnectorError);
    if (!(error instanceof OpenConnectorError)) throw new Error("expected OpenConnectorError");
    expect(error.code).toBe("unknown_action");
    expect(error.message).toBe("no such action");
  });

  it("throws with the HTTP status on a non-OK response", async () => {
    nextResponse = { status: 403, body: { success: false, message: "denied", errorCode: "connection_not_allowed" } };
    const error = await client().providers().catch((caught) => caught);
    expect(error).toBeInstanceOf(OpenConnectorError);
    if (!(error instanceof OpenConnectorError)) throw new Error("expected OpenConnectorError");
    expect(error.status).toBe(403);
    expect(error.code).toBe("connection_not_allowed");
  });

  it("throws on a non-JSON body", async () => {
    nextResponse = { status: 200, body: "garbage" as unknown as object };
    // The stub serializes whatever we give it, so poison the parser with a bare string payload.
    calls.length = 0;
    const rawClient = new OpenConnectorClient({
      baseUrl: origin,
      fetch: (async () => new Response("not json", { status: 200 })) as typeof fetch,
    });
    await expect(rawClient.providers()).rejects.toThrow(/non-JSON/);
  });

  it("combines a caller's abort signal with the request timeout", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchStub = (async (_url: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      return Response.json({ success: true, data: { ok: true } });
    }) as typeof fetch;
    const caller = new AbortController();
    await new OpenConnectorClient({ baseUrl: origin, fetch: fetchStub, timeoutMs: 10 })
      .execute("github.get_current_user", {}, undefined, caller.signal);
    expect(signals[0]).not.toBe(caller.signal);
    await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));

    const secondCaller = new AbortController();
    await new OpenConnectorClient({ baseUrl: origin, fetch: fetchStub, timeoutMs: 60_000 })
      .execute("github.get_current_user", {}, undefined, secondCaller.signal);
    secondCaller.abort();
    expect(signals[1]?.aborted).toBe(true);
  });

  it("surfaces Retry-After from a throttled connection-request poll", async () => {
    const throttled = new OpenConnectorClient({
      baseUrl: origin,
      fetch: (async () => new Response(JSON.stringify({ success: true, data: { status: "pending" } }), { status: 429, headers: { "retry-after": "3" } })) as typeof fetch,
    });
    await expect(throttled.connectionRequest("cr_1")).rejects.toMatchObject({ status: 429 });
    const captured = await new OpenConnectorClient({
      baseUrl: origin,
      fetch: (async () => new Response(JSON.stringify({ success: true, data: { status: "pending" } }), { status: 200, headers: { "retry-after": "1" } })) as typeof fetch,
    }).connectionRequest("cr_1");
    expect(captured.retryAfterMs).toBe(1000);
    expect(captured.state).toEqual({ status: "pending" });
  });
});

describe("endpoint shapes", () => {
  it("GET /v1/providers tolerates id- or service-keyed items and skips blanks", async () => {
    nextResponse = {
      status: 200,
      body: { success: true, data: [{ id: "github", name: "GitHub" }, { service: "slack", description: "chat" }, { name: "no id" }] },
    };
    const providers = await client().providers();
    expect(providers.map((provider) => provider.service)).toEqual(["github", "slack"]);
    expect(providers[0].name).toBe("GitHub");
    expect(lastCall()).toMatchObject({ method: "GET", path: "/v1/providers" });
  });

  it("GET /v1/actions takes an optional service filter", async () => {
    nextResponse = { status: 200, body: { success: true, data: [{ id: "github.get_current_user", description: "who am I" }] } };
    await client().actions("github");
    expect(lastCall().path).toBe("/v1/actions?service=github");
    nextResponse = { status: 200, body: { success: true, data: { items: [{ id: "gmail.list_emails" }] } } };
    const actions = await client().actions();
    expect(actions.map((action) => action.id)).toEqual(["gmail.list_emails"]);
    expect(lastCall().path).toBe("/v1/actions");
  });

  it("POST /v1/actions/:id sends {input} and the alias selector", async () => {
    nextResponse = { status: 200, body: { success: true, data: { login: "octocat" } } };
    const data = await client().execute("github.get_current_user", { verbose: true }, "work");
    expect(data).toEqual({ login: "octocat" });
    expect(lastCall()).toMatchObject({
      method: "POST",
      path: "/v1/actions/github.get_current_user?alias=work",
      body: { input: { verbose: true } },
    });
  });

  it("GET /api/oauth/configs reads expectedRedirectUri", async () => {
    nextResponse = { status: 200, body: { success: true, data: { expectedRedirectUri: "https://runtime.example.test/oauth/callback", configs: {} } } };
    const configs = await client().oauthConfigs();
    expect(configs.expectedRedirectUri).toBe("https://runtime.example.test/oauth/callback");
    expect(lastCall()).toMatchObject({ method: "GET", path: "/api/oauth/configs" });
  });

  it("PUT /api/oauth/configs/:service stores the OAuth client", async () => {
    nextResponse = { status: 200, body: { success: true } };
    await client().putOauthConfig("github", { clientId: "cid", clientSecret: "csec", scopes: ["repo"] });
    expect(lastCall()).toMatchObject({
      method: "PUT",
      path: "/api/oauth/configs/github",
      body: { clientId: "cid", clientSecret: "csec", scopes: ["repo"] },
    });
  });

  it("refuses a redirect instead of resending an OAuth client secret", async () => {
    nextResponse = { status: 302, body: {}, headers: { location: "https://redirect.example.test/oauth" } };
    await expect(client().putOauthConfig("github", { clientId: "cid", clientSecret: "csec" })).rejects.toThrow();
    expect(lastCall()).toMatchObject({ method: "PUT", path: "/api/oauth/configs/github", body: { clientSecret: "csec" } });
  });

  it("POST /v1/connections/:service/connect starts a request and reads its id and url", async () => {
    nextResponse = { status: 200, body: { success: true, data: { connectionRequestId: "cr_1", authorizationUrl: "https://github.com/login/oauth/authorize?x=1" } } };
    const begun = await client().beginConnect("github", "work");
    expect(begun).toEqual({ connectionRequestId: "cr_1", authorizationUrl: "https://github.com/login/oauth/authorize?x=1" });
    expect(lastCall()).toMatchObject({ method: "POST", path: "/v1/connections/github/connect", body: { connectionName: "work" } });
  });

  it("DELETE /api/connections/:service drops the credential", async () => {
    nextResponse = { status: 200, body: { success: true } };
    await client().disconnect("github");
    expect(lastCall()).toMatchObject({ method: "DELETE", path: "/api/connections/github" });
    await client().disconnect("github", "work");
    expect(lastCall()).toMatchObject({ method: "DELETE", path: "/api/connections/github?alias=work" });
  });
});
