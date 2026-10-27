// The sign-in flow and the service's status against the fake relay: start → waiting → claim → connected, the once-only
// claim, expiry, cancellation, the Private Integration token path, disconnect, and the owner routes over all of it.
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createHighLevelRoutes } from "../routes/highlevel.ts";
import { PASS } from "../routes/table.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { FAKE_LOCATION_ID, startFakeHighLevel, startFakeRelay, type FakeHighLevel, type FakeRelay } from "../testing/fake-highlevel.ts";
import { HIGHLEVEL_RELAY_URL_DEFAULT, HighLevelRelayError, createHighLevelRelay, highlevelRelayUrl, type HighLevelRelay, type RelayTokens } from "./relay.ts";
import { HighLevelSignIn } from "./sign-in.ts";
import { HighLevelStore } from "./store.ts";
import { createHighLevelService, type HighLevelService } from "./service.ts";

let hl: FakeHighLevel;
let relay: FakeRelay;
const dirs: string[] = [];
const services: HighLevelService[] = [];

beforeAll(async () => {
  hl = await startFakeHighLevel();
  relay = await startFakeRelay({ onAccessToken: (token) => hl.tokens.add(token) });
});
afterAll(async () => { await hl.close(); await relay.close(); });
afterEach(async () => {
  hl.pathOverrides.clear();
  for (const service of services.splice(0)) service.close();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function service(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-highlevel-signin-"));
  dirs.push(dir);
  const created = createHighLevelService({ dataDir: dir, env: { OMB_HIGHLEVEL_RELAY_URL: relay.url, OMB_HIGHLEVEL_API_URL: hl.url, ...env }, pollMs: 20 });
  services.push(created);
  return created;
}

const until = async <T>(read: () => T, want: (value: T) => boolean, ms = 3_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (want(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting; last ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("relay URL", () => {
  it("defaults to accounts.openmausbot.com, accepts https or loopback http, and reads off as unavailable", () => {
    expect(highlevelRelayUrl({})).toBe(HIGHLEVEL_RELAY_URL_DEFAULT);
    expect(highlevelRelayUrl({ OMB_HIGHLEVEL_RELAY_URL: "" })).toBe(HIGHLEVEL_RELAY_URL_DEFAULT);
    expect(highlevelRelayUrl({ OMB_HIGHLEVEL_RELAY_URL: "https://relay.example.test/" })).toBe("https://relay.example.test");
    expect(highlevelRelayUrl({ OMB_HIGHLEVEL_RELAY_URL: "http://127.0.0.1:4321" })).toBe("http://127.0.0.1:4321");
    expect(highlevelRelayUrl({ OMB_HIGHLEVEL_RELAY_URL: "http://relay.example.test" })).toBeNull();
    expect(highlevelRelayUrl({ OMB_HIGHLEVEL_RELAY_URL: "off" })).toBeNull();
    expect(highlevelRelayUrl({ OMB_HIGHLEVEL_RELAY_URL: "not a url" })).toBeNull();
  });

  it("speaks the control plane's contract: 404 pending, 200 once, 410 after, 401 on a rejected refresh, 503 unavailable", async () => {
    const upstream = createHighLevelRelay(relay.url);
    const started = await upstream.start();
    expect(started.authorizationUrl).toMatch(/^https:\/\/marketplace\.leadconnectorhq\.com\/v2\/oauth\/chooselocation\?/u);
    expect(relay.calls.at(-1)).toEqual({ path: "/v1/highlevel/start", body: { kind: "location" } });
    expect(await upstream.claim(started.state)).toBe("pending");
    relay.complete(started.state);
    const tokens = await upstream.claim(started.state);
    expect(tokens).toMatchObject({ accessToken: expect.stringMatching(/^hl_access_/u), refreshToken: expect.stringMatching(/^hl_refresh_/u), expiresIn: 86_400, locationId: FAKE_LOCATION_ID });
    expect(await upstream.claim(started.state)).toBe("claimed");
    if (typeof tokens === "string") throw new Error("unreachable");
    const rotated = await upstream.refresh(tokens.refreshToken);
    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
    await expect(upstream.refresh(tokens.refreshToken)).rejects.toMatchObject({ status: 401, code: "highlevel_refresh_rejected" });
    relay.unavailable = true;
    await expect(upstream.start()).rejects.toMatchObject({ status: 503, code: "highlevel_unavailable", message: "HighLevel sign-in is not available on the OpenMausBot relay right now." });
    relay.unavailable = false;
  });
});

describe("sign-in flow", () => {
  it("connects once the person finishes in the browser and stores the location's name", async () => {
    const svc = service();
    expect(svc.status()).toEqual({ state: "signed-out" });
    const started = await svc.startSignIn();
    expect(started.authorizationUrl).toMatch(/^https:\/\//u);
    expect(svc.status()).toEqual({ state: "connecting", flow: { flowId: started.flowId, authorizationUrl: started.authorizationUrl, expiresAt: started.expiresAt } });
    expect(svc.signInStatus(started.flowId)).toEqual({ phase: "waiting" });
    expect(svc.signInStatus("00000000-0000-0000-0000-000000000000")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(svc.signInStatus(started.flowId)).toEqual({ phase: "waiting" });
    expect(relay.calls.filter((call) => call.path === "/v1/highlevel/claim").length).toBeGreaterThan(0);
    const state = [...relay.states.keys()].at(-1)!;
    relay.complete(state);
    await until(() => svc.signInStatus(started.flowId), (status) => status?.phase === "connected");
    expect(svc.status()).toMatchObject({ state: "connected", kind: "oauth", location: { id: FAKE_LOCATION_ID, name: "Example Profiles" } });
    expect(svc.status().connectedAt).toEqual(expect.any(Number));
    expect(svc.connected()).toBe(true);
    expect(svc.store.get()).toMatchObject({ kind: "oauth", locationName: "Example Profiles", companyId: "company_1", userId: "user_1", scopes: expect.stringContaining("contacts.write") });
    // The flow's answer stays readable, and the tokens are nowhere in the status.
    expect(JSON.stringify(svc.status())).not.toMatch(/hl_access|hl_refresh/u);
    expect(svc.signInStatus(started.flowId)).toEqual({ phase: "connected" });
    expect(svc.disconnect()).toEqual({ state: "signed-out" });
    expect(svc.store.get()).toBeNull();
  });

  it("replaces a waiting flow, cancels on request, and reports a used state as failed", async () => {
    const svc = service();
    const first = await svc.startSignIn();
    const second = await svc.startSignIn();
    expect(svc.signInStatus(first.flowId)).toEqual({ phase: "failed", message: "A newer sign-in replaced this one." });
    expect(svc.status().flow?.flowId).toBe(second.flowId);
    expect(svc.cancelSignIn(second.flowId)).toBe(true);
    expect(svc.signInStatus(second.flowId)).toEqual({ phase: "failed", message: "Cancelled." });
    expect(svc.status()).toEqual({ state: "signed-out" });
    const third = await svc.startSignIn();
    const state = [...relay.states.keys()].at(-1)!;
    relay.complete(state);
    relay.states.get(state)!.claimed = true;
    await until(() => svc.signInStatus(third.flowId), (status) => status?.phase === "failed");
    expect(svc.signInStatus(third.flowId)).toEqual({ phase: "failed", message: "This sign-in was already used. Start again." });
  });

  it("expires after the cap and keeps polling through relay hiccups", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-highlevel-signin-"));
    dirs.push(dir);
    let now = Date.now();
    const svc = createHighLevelService({ dataDir: dir, env: { OMB_HIGHLEVEL_RELAY_URL: relay.url, OMB_HIGHLEVEL_API_URL: hl.url }, pollMs: 10, now: () => now });
    services.push(svc);
    const started = await svc.startSignIn();
    relay.unavailable = true;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(svc.signInStatus(started.flowId)).toEqual({ phase: "waiting" });
    relay.unavailable = false;
    now += 11 * 60_000;
    await until(() => svc.signInStatus(started.flowId), (status) => status?.phase === "expired");
    expect(svc.signInStatus(started.flowId)).toEqual({ phase: "expired", message: "The sign-in took longer than 10 minutes. Start again." });
  });

  it("is unavailable without a relay, and a Private Integration token still works", async () => {
    const svc = service({ OMB_HIGHLEVEL_RELAY_URL: "off" });
    expect(svc.status()).toEqual({ state: "unavailable" });
    await expect(svc.startSignIn()).rejects.toThrow(/no OpenMausBot relay is configured/u);
    await expect(svc.connectWithToken("nope", FAKE_LOCATION_ID)).rejects.toThrow("Paste a Private Integration token. It starts with pit-.");
    await expect(svc.connectWithToken("pit-abcdefgh12345678", "x")).rejects.toThrow(/Enter the location id/u);
    await expect(svc.connectWithToken("pit-abcdefgh12345678", FAKE_LOCATION_ID)).rejects.toThrow(/^HighLevel did not accept this token \(401\)\./u);
    expect(svc.store.get()).toBeNull();
    hl.tokens.add("pit-abcdefgh12345678");
    expect(await svc.connectWithToken(" pit-abcdefgh12345678 ", ` ${FAKE_LOCATION_ID} `)).toMatchObject({ state: "connected", kind: "token", location: { id: FAKE_LOCATION_ID, name: "Example Profiles" } });
    expect(svc.store.get()).toMatchObject({ kind: "token", accessToken: "pit-abcdefgh12345678", companyId: "company_1" });
    expect(svc.store.get()?.refreshToken).toBeUndefined();
    svc.store.markNeedsSignIn("HighLevel rejected the Private Integration token.", svc.store.get()!);
    expect(svc.status()).toMatchObject({ state: "needs-sign-in", kind: "token", problem: "HighLevel rejected the Private Integration token." });
  });
});

describe("a replaced flow's late claim", () => {
  function staged() {
    const dir = mkdtempSync(join(tmpdir(), "omb-highlevel-signin-"));
    dirs.push(dir);
    const claims: Array<{ state: string; reject(error: unknown): void }> = [];
    let starts = 0;
    const stub: HighLevelRelay = {
      start: async () => ({ state: `state_${++starts}`, authorizationUrl: "https://marketplace.leadconnectorhq.com/v2/oauth/chooselocation", expiresAt: Date.now() + 600_000 }),
      claim: (state) => new Promise<RelayTokens | "pending" | "claimed">((_resolve, reject) => { claims.push({ state, reject }); }),
      refresh: () => Promise.reject(new Error("unused")),
    };
    const signIn = new HighLevelSignIn({ relay: stub, store: new HighLevelStore({ dataDir: dir }), lookupLocationName: async () => undefined, pollMs: 1 });
    const claimsFor = (state: string) => claims.filter((claim) => claim.state === state);
    return { signIn, claims, claimsFor };
  }

  it.each([
    ["refused", new HighLevelRelayError(400, "highlevel_bad_state", "The relay refused this sign-in.")],
    ["unavailable", new HighLevelRelayError(503, "highlevel_unavailable", "The relay is down.")],
  ])("leaves the newer flow alone when the replaced flow's claim fails late (%s)", async (_name, failure) => {
    const { signIn, claimsFor } = staged();
    try {
      const first = await signIn.start();
      await until(() => claimsFor("state_1").length, (count) => count === 1);
      const second = await signIn.start();
      await until(() => claimsFor("state_2").length, (count) => count === 1);
      claimsFor("state_1")[0]!.reject(failure);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(signIn.active()?.flowId).toBe(second.flowId);
      expect(signIn.status(second.flowId)).toEqual({ phase: "waiting" });
      expect(signIn.status(first.flowId)).toEqual({ phase: "failed", message: "A newer sign-in replaced this one." });
      expect(claimsFor("state_1")).toHaveLength(1);
      expect(claimsFor("state_2")).toHaveLength(1);
    } finally {
      signIn.close();
    }
  });
});

describe("owner routes", () => {
  const admin: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
  const member: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };
  async function request(handler: ReturnType<typeof createHighLevelRoutes>, method: string, path: string, auth: RequestAuth, body?: unknown) {
    const { createServer } = await import("node:http");
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://fixture");
      const out = await handler({ req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (out === PASS && !res.writableEnded) { res.writeHead(599); res.end("pass"); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, body: text === "pass" ? "pass" : JSON.parse(text) };
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("answers the contract for the owner and refuses everyone else", async () => {
    const svc = service();
    const routes = createHighLevelRoutes({ service: svc });
    expect(await request(routes, "GET", "/api/bots", admin)).toMatchObject({ status: 599, body: "pass" });
    expect(await request(routes, "GET", "/api/highlevel", member)).toMatchObject({ status: 403, body: { error: expect.stringMatching(/owner or an admin/u) } });
    expect(await request(routes, "GET", "/api/highlevel", admin)).toEqual({ status: 200, body: { state: "signed-out" } });
    const started = await request(routes, "POST", "/api/highlevel/sign-in", admin);
    expect(started.status).toBe(200);
    expect(started.body).toEqual({ flowId: expect.stringMatching(/^[0-9a-f-]{36}$/u), authorizationUrl: expect.stringMatching(/^https:\/\//u), expiresAt: expect.any(Number) });
    expect(await request(routes, "GET", "/api/highlevel", admin)).toMatchObject({ status: 200, body: { state: "connecting", flow: { flowId: started.body.flowId } } });
    expect(await request(routes, "GET", `/api/highlevel/sign-in/${started.body.flowId}`, admin)).toEqual({ status: 200, body: { phase: "waiting" } });
    expect(await request(routes, "GET", "/api/highlevel/sign-in/00000000-0000-0000-0000-000000000000", admin)).toEqual({ status: 404, body: { error: "This sign-in is no longer available. Start again." } });
    expect(await request(routes, "DELETE", `/api/highlevel/sign-in/${started.body.flowId}`, admin)).toEqual({ status: 200, body: { ok: true } });
    expect(await request(routes, "GET", `/api/highlevel/sign-in/${started.body.flowId}`, admin)).toEqual({ status: 200, body: { phase: "failed", message: "Cancelled." } });
    expect(await request(routes, "POST", "/api/highlevel/token", admin, { token: "", locationId: FAKE_LOCATION_ID })).toEqual({ status: 400, body: { error: "Paste a Private Integration token. It starts with pit-." } });
    expect(await request(routes, "POST", "/api/highlevel/token", admin, { token: "pit-abcdefgh12345678" })).toEqual({ status: 400, body: { error: "Enter the location id (Settings → Business Profile in HighLevel)." } });
    // Each refusal reaches the card as its own sentence, with HighLevel's reason and never the token.
    expect(await request(routes, "POST", "/api/highlevel/token", admin, { token: "pit-not-accepted-1", locationId: FAKE_LOCATION_ID })).toEqual({ status: 401, body: { error: "HighLevel did not accept this token (401). Check that it was copied whole and has not been rotated or deleted, and that its Private Integration has the View Locations permission. HighLevel said: Invalid JWT" } });
    hl.tokens.add("pit-route-token-123");
    expect(await request(routes, "POST", "/api/highlevel/token", admin, { token: "pit-route-token-123", locationId: "loc_other_9" })).toEqual({ status: 403, body: {
      error: "This token does not belong to that location (403): it was created in another sub-account or at the agency level. Create the Private Integration inside the sub-account whose location ID you entered. HighLevel said: The token does not have access to this location.",
    } });
    hl.pathOverrides.set(`GET /locations/${FAKE_LOCATION_ID}`, { status: 401, body: { statusCode: 401, message: "The token is not authorized for this scope.", error: "Unauthorized" } });
    const missing = await request(routes, "POST", "/api/highlevel/token", admin, { token: "pit-route-token-123", locationId: FAKE_LOCATION_ID });
    expect(missing).toMatchObject({ status: 401, body: { error: expect.stringMatching(/^This token is missing the View Locations permission \(401\).+HighLevel said: The token is not authorized for this scope\.$/u) } });
    expect(JSON.stringify(missing.body)).not.toContain("pit-route");
    hl.pathOverrides.clear();
    const connected = await request(routes, "POST", "/api/highlevel/token", admin, { token: " pit-route-token-123 ", locationId: FAKE_LOCATION_ID });
    expect(connected).toMatchObject({ status: 200, body: { state: "connected", kind: "token", location: { id: FAKE_LOCATION_ID, name: "Example Profiles" } } });
    expect(JSON.stringify(connected.body)).not.toContain("pit-route");
    expect(await request(routes, "DELETE", "/api/highlevel", admin)).toEqual({ status: 200, body: { state: "signed-out" } });
    relay.unavailable = true;
    expect(await request(routes, "POST", "/api/highlevel/sign-in", admin)).toEqual({ status: 502, body: { error: "HighLevel sign-in is not available on the OpenMausBot relay right now.", code: "highlevel_unavailable" } });
    relay.unavailable = false;
  });
});
