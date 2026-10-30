import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HIGHLEVEL_CLAIM_LIMIT,
  HIGHLEVEL_FLOW_TTL_MS,
  HIGHLEVEL_START_LIMIT,
  HIGHLEVEL_TOKEN_URL,
  flowLookup,
  readHighLevelConfig,
} from "../src/highlevel";
import { createWorker } from "../src/index";

const BASE_URL = "https://auth.openmausbot.test";
const CLIENT_ID = "68e9f2a1b3c4d5e6f7a8b9c0-mf1x2y3z";
const CLIENT_SECRET = "test-only-highlevel-client-secret-0123456789";
const REDIRECT_URL = "https://auth.openmausbot.test/v1/highlevel/callback";
const SCOPES = "contacts.readonly contacts.write locations.readonly";
const CODE = "7676cjcbdc6t76cdcbkjcd09821jknnkj";
const ACCESS_TOKEN = "eyJhbGciOiJIUzI1NiJ9.access-token-for-location.sig";
const REFRESH_TOKEN = "eyJhbGciOiJIUzI1NiJ9.refresh-token-for-location.sig";
const ACCESS_TOKEN_2 = "eyJhbGciOiJIUzI1NiJ9.access-token-after-refresh.sig";
const REFRESH_TOKEN_2 = "eyJhbGciOiJIUzI1NiJ9.refresh-token-after-refresh.sig";
const SECRETS = [CLIENT_SECRET, CODE, ACCESS_TOKEN, REFRESH_TOKEN, ACCESS_TOKEN_2, REFRESH_TOKEN_2];

type TestWorker = ReturnType<typeof createWorker>;

interface HighLevelCall {
  url: string;
  contentType: string;
  form: Record<string, string>;
}

type Answer = { status: number; body?: unknown } | { throws: true };

function tokenAnswer(overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    body: {
      access_token: ACCESS_TOKEN,
      token_type: "Bearer",
      expires_in: 86399,
      refresh_token: REFRESH_TOKEN,
      scope: SCOPES,
      userType: "Location",
      locationId: "l1C08ntBrFjLS0elLIYU",
      companyId: "c0mp4nyIdXXXXXXXXXXX",
      userId: "u5erIdXXXXXXXXXXXXXX",
      planId: "plan",
      ...overrides,
    },
  };
}

function fakeHighLevel(answers: Answer[] = []) {
  const calls: HighLevelCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    calls.push({
      url: request.url,
      contentType: request.headers.get("content-type") ?? "",
      form: Object.fromEntries(new URLSearchParams(text)),
    });
    const answer = answers.shift() ?? tokenAnswer();
    if ("throws" in answer) throw new TypeError("fetch failed");
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function highLevelEnv(extra: Record<string, string | undefined> = {}): Env {
  return {
    ...env,
    HIGHLEVEL_CLIENT_ID: CLIENT_ID,
    HIGHLEVEL_CLIENT_SECRET: CLIENT_SECRET,
    HIGHLEVEL_REDIRECT_URL: REDIRECT_URL,
    HIGHLEVEL_SCOPES: SCOPES,
    ...extra,
  } as unknown as Env;
}

interface CallOptions {
  body?: unknown;
  method?: string;
  ip?: string;
  origin?: string;
}

/** Every response body goes through here so the leak check sees all of them. */
const bodies: string[] = [];
const logs: string[] = [];

async function call(worker: TestWorker, testEnv: Env, path: string, options: CallOptions = {}) {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("content-type", "application/json");
  headers.set("cf-connecting-ip", options.ip ?? "203.0.113.7");
  if (options.origin !== undefined) headers.set("origin", options.origin);
  const request = new Request(`${BASE_URL}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  bodies.push(await response.clone().text());
  return response;
}

const start = (worker: TestWorker, testEnv: Env, options: CallOptions = {}) =>
  call(worker, testEnv, "/v1/highlevel/start", { body: { kind: "location" }, ...options });
const claim = (worker: TestWorker, testEnv: Env, state: string, options: CallOptions = {}) =>
  call(worker, testEnv, "/v1/highlevel/claim", { body: { state }, ...options });
const refresh = (worker: TestWorker, testEnv: Env, refreshToken: string, options: CallOptions = {}) =>
  call(worker, testEnv, "/v1/highlevel/refresh", { body: { refreshToken }, ...options });
const callback = (worker: TestWorker, testEnv: Env, query: Record<string, string>, options: CallOptions = {}) =>
  call(worker, testEnv, `/v1/highlevel/callback?${new URLSearchParams(query)}`, options);

async function started(worker: TestWorker, testEnv: Env) {
  const response = await start(worker, testEnv);
  expect(response.status).toBe(200);
  const body = await response.json<{ state: string; authorizationUrl: string; expiresAt: number }>();
  return body;
}

async function runScheduled(worker: TestWorker, testEnv: Env) {
  const controller = createScheduledController({ cron: "*/5 * * * *", scheduledTime: Date.now() });
  const ctx = createExecutionContext();
  await worker.scheduled(controller, testEnv, ctx);
  await waitOnExecutionContext(ctx);
}

async function age(state: string, byMs: number) {
  const aged = await env.DB.prepare("UPDATE highlevel_flows SET created_at = created_at - ? WHERE lookup = ?")
    .bind(byMs, await flowLookup(state))
    .run();
  expect(aged.meta.changes).toBe(1);
}

async function rows() {
  return (await env.DB.prepare("SELECT lookup, ciphertext, created_at, claimed_at FROM highlevel_flows").all<{
    lookup: string;
    ciphertext: string | null;
    created_at: number;
    claimed_at: number | null;
  }>()).results;
}

const expectedPayload = {
  accessToken: ACCESS_TOKEN,
  refreshToken: REFRESH_TOKEN,
  expiresIn: 86399,
  scope: SCOPES,
  locationId: "l1C08ntBrFjLS0elLIYU",
  companyId: "c0mp4nyIdXXXXXXXXXXX",
  userId: "u5erIdXXXXXXXXXXXXXX",
};

describe("HighLevel OAuth relay", () => {
  const capture = (...args: unknown[]) => {
    logs.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);

  afterEach(async () => {
    // The only places a secret may ever appear are the claim and refresh
    // JSON answers, which the tests below assert on directly. Every other
    // body, every page, and every log line must be free of the client secret,
    // the authorization code and the tokens.
    const allowed = new Set<string>();
    for (const body of bodies) {
      if (body.startsWith('{"accessToken":')) allowed.add(body);
    }
    for (const body of bodies) {
      if (allowed.has(body)) continue;
      for (const secret of SECRETS) expect(body).not.toContain(secret);
    }
    for (const line of logs) {
      for (const secret of SECRETS) expect(line).not.toContain(secret);
      expect(line).not.toMatch(/"(?:state|code|token|access_token|refresh_token)"/);
    }
    const stored = await rows();
    for (const row of stored) {
      for (const secret of SECRETS) expect(row.ciphertext ?? "").not.toContain(secret);
    }
    bodies.length = 0;
    logs.length = 0;
  });

  it("is unavailable, and says so, until the client secret is set", async () => {
    const highLevel = fakeHighLevel();
    const worker = createWorker(fetch, fetch, highLevel.fetch);
    const unset = highLevelEnv({ HIGHLEVEL_CLIENT_SECRET: undefined });
    expect(readHighLevelConfig(unset)).toBeNull();
    expect(readHighLevelConfig(env)).toBeNull();
    const response = await start(worker, unset);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "highlevel_unavailable" });
    expect((await claim(worker, unset, "a".repeat(43))).status).toBe(503);
    expect((await refresh(worker, unset, REFRESH_TOKEN)).status).toBe(503);
    const page = await callback(worker, unset, { code: CODE, state: "a".repeat(43) });
    expect(page.status).toBe(503);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(highLevel.calls).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("start, callback, claim once, then 410", async () => {
    const highLevel = fakeHighLevel();
    const worker = createWorker(fetch, fetch, highLevel.fetch);
    const testEnv = highLevelEnv();
    const before = Date.now();
    const flow = await started(worker, testEnv);

    expect(flow.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.expiresAt).toBeGreaterThanOrEqual(before + HIGHLEVEL_FLOW_TTL_MS);
    const authorize = new URL(flow.authorizationUrl);
    expect(authorize.origin + authorize.pathname).toBe("https://marketplace.leadconnectorhq.com/v2/oauth/chooselocation");
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      response_type: "code",
      redirect_uri: REDIRECT_URL,
      client_id: CLIENT_ID,
      scope: SCOPES,
      state: flow.state,
    });
    expect(flow.authorizationUrl).toContain("scope=contacts.readonly%20contacts.write");

    // The row holds a derivation of the state, not the state, and no payload yet.
    const [row] = await rows();
    expect(row).toMatchObject({ ciphertext: null, claimed_at: null });
    expect(row!.lookup).toBe(await flowLookup(flow.state));
    expect(row!.lookup).not.toContain(flow.state);

    // The person's browser arrives from HighLevel: no Origin, no credential.
    const page = await callback(worker, testEnv, { code: CODE, state: flow.state });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain("Connected");
    expect(html).toContain("Close this tab and go back to OpenMausBot.");
    expect(html).not.toContain(flow.state);

    expect(highLevel.calls).toHaveLength(1);
    expect(highLevel.calls[0]!.url).toBe(HIGHLEVEL_TOKEN_URL);
    expect(highLevel.calls[0]!.contentType).toBe("application/x-www-form-urlencoded");
    expect(highLevel.calls[0]!.form).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "authorization_code",
      code: CODE,
      user_type: "Location",
      redirect_uri: REDIRECT_URL,
    });

    // Sealed, not stored in clear.
    const [filled] = await rows();
    expect(filled!.ciphertext).toBeTruthy();
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, "l1C08ntBrFjLS0elLIYU"]) {
      expect(filled!.ciphertext).not.toContain(secret);
    }

    const first = await claim(worker, testEnv, flow.state);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(expectedPayload);
    const [claimed] = await rows();
    expect(claimed).toMatchObject({ ciphertext: null });
    expect(claimed!.claimed_at).toEqual(expect.any(Number));

    const second = await claim(worker, testEnv, flow.state);
    expect(second.status).toBe(410);
    expect(await second.json()).toEqual({ error: "highlevel_claimed" });
    // A late or replayed callback cannot refill a claimed flow.
    const replay = await callback(worker, testEnv, { code: CODE, state: flow.state });
    expect(replay.status).toBe(400);
    expect(highLevel.calls).toHaveLength(1);
  });

  it("claim before the callback is 404 so the harness keeps polling; a wrong state is 404 too", async () => {
    const highLevel = fakeHighLevel();
    const worker = createWorker(fetch, fetch, highLevel.fetch);
    const testEnv = highLevelEnv();
    const flow = await started(worker, testEnv);

    const early = await claim(worker, testEnv, flow.state);
    expect(early.status).toBe(404);
    expect(await early.json()).toEqual({ error: "highlevel_unknown_state" });
    // The other spellings of the very same 32 bytes (the last character's two spare bits) open nothing.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const aliases = [1, 2, 3].map((spare) => `${flow.state.slice(0, -1)}${alphabet[alphabet.indexOf(flow.state.at(-1)!) | spare]}`);
    for (const alias of aliases) expect((await callback(worker, testEnv, { code: CODE, state: alias })).status, alias).not.toBe(200);

    expect((await callback(worker, testEnv, { code: CODE, state: flow.state })).status).toBe(200);
    for (const alias of aliases) expect((await claim(worker, testEnv, alias)).status, alias).toBe(404);
    // A state that differs in one character opens nothing, before or after.
    const wrong = `${flow.state.slice(0, -1)}${flow.state.endsWith("A") ? "B" : "A"}`;
    const other = await claim(worker, testEnv, wrong);
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: "highlevel_unknown_state" });
    expect((await claim(worker, testEnv, "not a state")).status).toBe(400);
    expect((await claim(worker, testEnv, flow.state)).status).toBe(200);
  });

  it("an expired state fails the callback and the claim, and the cron sweeps it", async () => {
    const highLevel = fakeHighLevel();
    const worker = createWorker(fetch, fetch, highLevel.fetch);
    const testEnv = highLevelEnv();
    const flow = await started(worker, testEnv);
    await age(flow.state, HIGHLEVEL_FLOW_TTL_MS + 1_000);

    const page = await callback(worker, testEnv, { code: CODE, state: flow.state });
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("Connection expired");
    expect(highLevel.calls).toEqual([]);
    expect((await claim(worker, testEnv, flow.state)).status).toBe(404);

    expect(await rows()).toHaveLength(1);
    await runScheduled(worker, testEnv);
    expect(await rows()).toEqual([]);
    expect(logs.some((line) => line.includes('"message":"highlevel flow sweep"') && line.includes('"deleted":1'))).toBe(true);
    expect((await claim(worker, testEnv, flow.state)).status).toBe(404);

    // A live flow survives the sweep.
    const live = await started(worker, testEnv);
    await runScheduled(worker, testEnv);
    expect(await rows()).toHaveLength(1);
    expect((await callback(worker, testEnv, { code: CODE, state: live.state })).status).toBe(200);
  });

  it("a denied consent shows a cancelled page and the claim stays 404", async () => {
    const highLevel = fakeHighLevel();
    const worker = createWorker(fetch, fetch, highLevel.fetch);
    const testEnv = highLevelEnv();
    const flow = await started(worker, testEnv);

    const page = await callback(worker, testEnv, { error: "access_denied", error_description: "<script>alert(1)</script>", state: flow.state });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Connection cancelled");
    expect(html).not.toContain("script");
    expect(html).not.toContain("access_denied");
    expect(highLevel.calls).toEqual([]);
    expect(await rows()).toEqual([]);
    const response = await claim(worker, testEnv, flow.state);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "highlevel_unknown_state" });
    // The state cannot be reused with a code afterwards.
    expect((await callback(worker, testEnv, { code: CODE, state: flow.state })).status).toBe(400);
  });

  it("of two callbacks with the same code, only one exchanges it, and the other cannot wipe the saved tokens", async () => {
    let finish!: () => void;
    const firstDone = new Promise<void>((resolve) => { finish = resolve; });
    let secondArrived!: () => void;
    const second = new Promise<void>((resolve) => { secondArrived = resolve; });
    const calls: number[] = [];
    // HighLevel redeems the code once: the first exchange waits until the
    // second callback has either reached HighLevel too or answered, and the
    // second is refused only after the first has finished.
    const highLevelFetch = (async () => {
      calls.push(calls.length);
      if (calls.length === 1) {
        await Promise.race([second, firstDone]);
        return new Response(JSON.stringify(tokenAnswer().body), { status: 200, headers: { "content-type": "application/json" } });
      }
      secondArrived();
      await firstDone;
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const worker = createWorker(fetch, fetch, highLevelFetch);
    const testEnv = highLevelEnv();
    const flow = await started(worker, testEnv);

    const pages = [callback(worker, testEnv, { code: CODE, state: flow.state }), callback(worker, testEnv, { code: CODE, state: flow.state })];
    await Promise.race(pages);
    finish();
    const statuses = (await Promise.all(pages)).map((page) => page.status).sort();
    expect(statuses).toEqual([200, 400]);
    expect(calls).toHaveLength(1);
    const claimed = await claim(worker, testEnv, flow.state);
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toEqual(expectedPayload);
  });

  it("a denied consent that arrives during the exchange does not end the flow", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let exchanging!: () => void;
    const inExchange = new Promise<void>((resolve) => { exchanging = resolve; });
    const highLevelFetch = (async () => {
      exchanging();
      await released;
      return new Response(JSON.stringify(tokenAnswer().body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const worker = createWorker(fetch, fetch, highLevelFetch);
    const testEnv = highLevelEnv();
    const flow = await started(worker, testEnv);

    const connected = callback(worker, testEnv, { code: CODE, state: flow.state });
    await inExchange;
    const denied = await callback(worker, testEnv, { error: "access_denied", state: flow.state });
    expect(denied.status).toBe(400);
    release();
    expect((await connected).status).toBe(200);
    const claimed = await claim(worker, testEnv, flow.state);
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toEqual(expectedPayload);
  });

  it("a failed exchange shows the failed page, logs only a status, and the claim stays 404", async () => {
    const highLevel = fakeHighLevel([{ status: 400, body: { message: `invalid code ${CODE}`, statusCode: 400 } }]);
    const worker = createWorker(fetch, fetch, highLevel.fetch);
    const testEnv = highLevelEnv();
    const flow = await started(worker, testEnv);

    const page = await callback(worker, testEnv, { code: CODE, state: flow.state });
    expect(page.status).toBe(502);
    const html = await page.text();
    expect(html).toContain("Connection failed");
    expect(html).toContain("Go back to OpenMausBot and try again.");
    expect(highLevel.calls).toHaveLength(1);
    expect(logs.some((line) => line.includes('"errorCode":"highlevel_exchange_failed"') && line.includes('"status":400'))).toBe(true);
    expect((await claim(worker, testEnv, flow.state)).status).toBe(404);
    expect(await rows()).toEqual([]);

    // An unreachable HighLevel, or a malformed answer, fails the same way.
    for (const answer of [{ throws: true } as const, { status: 200, body: { token_type: "Bearer" } }]) {
      const again = await started(worker, testEnv);
      highLevel.calls.length = 0;
      const broken = fakeHighLevel([answer]);
      const brokenWorker = createWorker(fetch, fetch, broken.fetch);
      expect((await callback(brokenWorker, testEnv, { code: CODE, state: again.state })).status).toBe(502);
      expect((await claim(brokenWorker, testEnv, again.state)).status).toBe(404);
    }
  });

  it("the callback is not blocked by the origin allow-list, unlike the JSON routes", async () => {
    const highLevel = fakeHighLevel();
    const worker = createWorker(fetch, fetch, highLevel.fetch);
    const testEnv = highLevelEnv();
    const flow = await started(worker, testEnv);

    // A JSON route from a foreign origin is refused as everywhere else.
    const foreign = await claim(worker, testEnv, flow.state, { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: "origin_not_allowed" });

    // Browsers may attach `Origin: null` to a cross-site redirect; the page must still render.
    const page = await callback(worker, testEnv, { code: CODE, state: flow.state }, { origin: "null" });
    expect(page.status).toBe(200);
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await claim(worker, testEnv, flow.state)).status).toBe(200);

    // Only GET renders the callback; nothing else is served on that path.
    expect((await call(worker, testEnv, "/v1/highlevel/callback", { method: "POST", body: {} })).status).toBe(404);
  });

  it("refresh returns the rotated pair, and a HighLevel 4xx is 401 highlevel_refresh_rejected", async () => {
    const highLevel = fakeHighLevel([
      tokenAnswer({ access_token: ACCESS_TOKEN_2, refresh_token: REFRESH_TOKEN_2 }),
      { status: 401, body: { message: "Invalid refresh token", statusCode: 401 } },
      { status: 503, body: null },
      { throws: true },
    ]);
    const worker = createWorker(fetch, fetch, highLevel.fetch);
    const testEnv = highLevelEnv();

    const rotated = await refresh(worker, testEnv, REFRESH_TOKEN);
    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toEqual({ ...expectedPayload, accessToken: ACCESS_TOKEN_2, refreshToken: REFRESH_TOKEN_2 });
    expect(highLevel.calls[0]!.form).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
      user_type: "Location",
      redirect_uri: REDIRECT_URL,
    });

    const rejected = await refresh(worker, testEnv, REFRESH_TOKEN);
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toEqual({ error: "highlevel_refresh_rejected" });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = await refresh(worker, testEnv, REFRESH_TOKEN);
      expect(failed.status).toBe(502);
      expect(await failed.json()).toEqual({ error: "highlevel_refresh_failed" });
    }
    expect((await refresh(worker, testEnv, "")).status).toBe(400);
    expect((await call(worker, testEnv, "/v1/highlevel/refresh", { body: { refreshToken: REFRESH_TOKEN, extra: 1 } })).status).toBe(400);
    expect(highLevel.calls).toHaveLength(4);
    expect(await rows()).toEqual([]);
  });

  it("limits each route per caller address", async () => {
    const highLevel = fakeHighLevel();
    const worker = createWorker(fetch, fetch, highLevel.fetch);
    const testEnv = highLevelEnv();

    for (let attempt = 0; attempt < HIGHLEVEL_START_LIMIT; attempt += 1) {
      expect((await start(worker, testEnv, { ip: "198.51.100.1" })).status).toBe(200);
    }
    const limited = await start(worker, testEnv, { ip: "198.51.100.1" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    // Another address, and the other routes from the same address, still work.
    expect((await start(worker, testEnv, { ip: "198.51.100.2" })).status).toBe(200);
    expect((await claim(worker, testEnv, "a".repeat(43), { ip: "198.51.100.1" })).status).toBe(404);
    expect(HIGHLEVEL_CLAIM_LIMIT).toBeGreaterThan(HIGHLEVEL_START_LIMIT);

    const keys = await env.DB.prepare("SELECT ip_key FROM highlevel_ip_rate_limits").all<{ ip_key: string }>();
    expect(keys.results.length).toBeGreaterThan(0);
    for (const { ip_key } of keys.results) {
      expect(ip_key).toMatch(/^[0-9a-f]{64}$/);
      expect(ip_key).not.toContain("198.51.100");
    }
  });
});
