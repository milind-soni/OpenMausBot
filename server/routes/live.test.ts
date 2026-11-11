import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LiveCallState, LiveSettings } from "../../shared/wire.ts";
import { json, readBody } from "../harness/http.ts";
import { LiveCallBusyError, LiveCallSignedOutError } from "../live-call-controller.ts";
import { LIVE_NEEDS_KEY, LiveSessionError } from "../live-call.ts";
import { requiredScope } from "../request-auth.ts";
import { RELAY_POLL_MS } from "../live-fish.ts";
import { createLiveRoutes, type LiveRouteDeps } from "./live.ts";
import { dispatchRoutes } from "./table.ts";

type SettingsPatch = Parameters<LiveRouteDeps["saveSettings"]>[0];

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(deps: LiveRouteDeps): Promise<string> {
  const routes = [createLiveRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody,
    });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function request(deps: LiveRouteDeps, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const base = await serve(deps);
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

const fromPhone = (device = "phone-1") => ({ "x-openmausbot-companion": "1", "x-openmausbot-companion-device": device });

function deps(overrides: Partial<LiveRouteDeps> = {}): LiveRouteDeps & { saved: SettingsPatch[] } {
  const saved: SettingsPatch[] = [];
  const call: LiveCallState = { callId: "c1", botId: "bot1", threadId: "t1", client: "desktop", voice: "marin", startedAt: 1, status: "connecting" };
  return {
    saved,
    calls: {
      start: vi.fn(async () => ({ call, sdp: "answer" })),
      end: vi.fn(async (id: string) => (id === "c1" ? { ...call, status: "ended" as const, endReason: "hung-up" as const } : null)),
      current: () => call,
      deviceRevoked: vi.fn((device: string) => (device === "phone-1" ? { ...call, client: "ios" as const, status: "ending" as const } : null)),
    },
    resolveTarget: (botId, threadId) => (botId === "bot1" && (threadId ?? "t1") === "t1" ? { botId, botName: "Ada", threadId: threadId ?? "t1" } : null),
    settings: () => ({ configured: true, voice: "marin", readTypedReplies: true, idleMinutes: 5 }),
    fishRelay: () => null,
    saveSettings: vi.fn(async (patch: SettingsPatch): Promise<LiveSettings> => {
      saved.push(patch);
      return { configured: true, voice: "marin", readTypedReplies: true, idleMinutes: 5, ...patch };
    }),
    ...overrides,
  };
}

describe("live routes", () => {
  it("starts a call and returns the answer", async () => {
    const d = deps();
    const res = await request(d, "POST", "/api/live/session", { botId: "bot1", sdp: "v=0\r\n", client: "ios" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ call: expect.objectContaining({ callId: "c1" }), transport: { type: "webrtc", sdp: "answer" } });
    expect(d.calls.start).toHaveBeenCalledWith(expect.objectContaining({ botId: "bot1", botName: "Ada", threadId: "t1", client: "ios", sdp: "v=0\r\n" }));
  });
  it("starts the call as the person who asked", async () => {
    const d = deps();
    await request(d, "POST", "/api/live/session", { botId: "bot1", threadId: "t1", sdp: "v=0\r\n", client: "android" });
    expect(d.calls.start).toHaveBeenCalledWith(expect.objectContaining({ auth: { kind: "loopback", scopes: ["admin", "client"] }, threadId: "t1", client: "android" }));
  });
  it("starts a call from a web browser", async () => {
    const d = deps();
    expect((await request(d, "POST", "/api/live/session", { botId: "bot1", sdp: "v=0\r\n", client: "web" })).status).toBe(201);
    expect(d.calls.start).toHaveBeenCalledWith(expect.objectContaining({ client: "web" }));
  });
  it("keeps the SDP byte for byte", async () => {
    const d = deps();
    await request(d, "POST", "/api/live/session", { botId: "bot1", sdp: "v=0\r\na=x \r\n", client: "desktop" });
    expect(d.calls.start).toHaveBeenCalledWith(expect.objectContaining({ sdp: "v=0\r\na=x \r\n" }));
  });
  it("rejects bad bodies and unknown targets", async () => {
    expect((await request(deps(), "POST", "/api/live/session", { botId: "bot1", sdp: "v=0", client: "fridge" })).status).toBe(400);
    expect((await request(deps(), "POST", "/api/live/session", { botId: "bot1", sdp: "v=0", client: "ios", extra: 1 })).status).toBe(400);
    expect((await request(deps(), "POST", "/api/live/session", { botId: "bot1", sdp: "", client: "ios" })).status).toBe(400);
    expect((await request(deps(), "POST", "/api/live/session", { botId: "bot1", sdp: "x".repeat(64 * 1024 + 1), client: "ios" })).status).toBe(400);
    expect((await request(deps(), "POST", "/api/live/session", { botId: "../bot1", sdp: "v=0", client: "ios" })).status).toBe(400);
    expect((await request(deps(), "POST", "/api/live/session", "{not json")).status).toBe(400);
    expect((await request(deps(), "POST", "/api/live/session", { botId: "nope", sdp: "v=0", client: "ios" })).status).toBe(404);
    expect((await request(deps(), "POST", "/api/live/session", { botId: "bot1", threadId: "other", sdp: "v=0", client: "ios" })).status).toBe(404);
  });
  it("does not start a call for a bad body or an unknown target", async () => {
    const d = deps();
    await request(d, "POST", "/api/live/session", { botId: "bot1", sdp: "v=0", client: "fridge" });
    await request(d, "POST", "/api/live/session", { botId: "nope", sdp: "v=0", client: "ios" });
    expect(d.calls.start).not.toHaveBeenCalled();
  });
  it("says when a key is needed and when a call is already running", async () => {
    const noKey = deps({ calls: { ...deps().calls, start: vi.fn(async () => { throw new LiveSessionError(LIVE_NEEDS_KEY, 409); }) } });
    for (const headers of [{}, fromPhone()]) {
      expect(await request(noKey, "POST", "/api/live/session", { botId: "bot1", sdp: "v=0", client: "ios" }, headers))
        .toEqual({ status: 409, body: { error: LIVE_NEEDS_KEY, needsKey: true } });
    }
    const active = { callId: "c0", botId: "bot2", threadId: "t2", client: "android", voice: "marin", startedAt: 1, status: "live" } as const;
    const busy = deps({ calls: { ...deps().calls, start: vi.fn(async () => { throw new LiveCallBusyError(active); }) } });
    const refused = await request(busy, "POST", "/api/live/session", { botId: "bot1", sdp: "v=0", client: "ios" });
    expect(refused).toMatchObject({ status: 409, body: { activeCall: active } });
    expect(refused.body).not.toHaveProperty("needsKey");
  });
  it("passes OpenAI's refusals through with their status and message", async () => {
    const refusal = deps({ calls: { ...deps().calls, start: vi.fn(async () => { throw new LiveSessionError("OpenAI rejected the API key. Check the key for Live calls.", 502); }) } });
    expect(await request(refusal, "POST", "/api/live/session", { botId: "bot1", sdp: "v=0", client: "desktop" }))
      .toEqual({ status: 502, body: { error: "OpenAI rejected the API key. Check the key for Live calls." } });
  });
  it("ends a call by id and 404s for another id", async () => {
    expect(await request(deps(), "POST", "/api/live/call/end", { callId: "c1" })).toMatchObject({ status: 200, body: { call: { status: "ended" } } });
    expect((await request(deps(), "POST", "/api/live/call/end", { callId: "zz" })).status).toBe(404);
    expect((await request(deps(), "POST", "/api/live/call/end", {})).status).toBe(400);
  });
  it("reports the current call, or none", async () => {
    expect(await request(deps(), "GET", "/api/live/call")).toMatchObject({ status: 200, body: { call: { callId: "c1" } } });
    expect(await request(deps({ calls: { ...deps().calls, current: () => null } }), "GET", "/api/live/call")).toEqual({ status: 200, body: { call: null } });
  });
  it("saves non-secret settings and refuses the key", async () => {
    const d = deps();
    expect(await request(d, "PATCH", "/api/live/settings", { idleMinutes: 10, readTypedReplies: false })).toMatchObject({ status: 200, body: { live: { idleMinutes: 10, readTypedReplies: false } } });
    expect(await request(d, "PATCH", "/api/live/settings", { key: "sk-x" })).toEqual({ status: 400, body: { error: "Those Live settings are not valid." } });
    expect((await request(d, "PATCH", "/api/live/settings", { idleMinutes: 0 })).status).toBe(400);
    expect((await request(d, "PATCH", "/api/live/settings", { idleMinutes: 61 })).status).toBe(400);
    expect((await request(d, "PATCH", "/api/live/settings", { voice: "Marin!" })).status).toBe(400);
    expect(d.saved).toEqual([{ idleMinutes: 10, readTypedReplies: false }]);
  });
  it("saves an Azure provider, endpoint and deployment, refusing a host the key must not reach", async () => {
    const d = deps();
    const azure = { provider: "azure", azureEndpoint: "https://my-res.openai.azure.com", azureDeployment: "live-prod" };
    expect(await request(d, "PATCH", "/api/live/settings", azure)).toMatchObject({ status: 200, body: { live: azure } });
    expect(await request(d, "PATCH", "/api/live/settings", { azureEndpoint: "https://evil.example" })).toMatchObject({ status: 400, body: { error: expect.stringContaining("Azure OpenAI resource") } });
    expect(await request(d, "PATCH", "/api/live/settings", { azureEndpoint: "http://my-res.openai.azure.com" })).toMatchObject({ status: 400 });
    expect(await request(d, "PATCH", "/api/live/settings", { azureDeployment: "a b" })).toMatchObject({ status: 400, body: { error: expect.stringContaining("deployment name") } });
    expect((await request(d, "PATCH", "/api/live/settings", { provider: "aws" })).status).toBe(400);
    expect((await request(d, "PATCH", "/api/live/settings", { azureEndpoint: "", azureDeployment: "" })).status).toBe(200);
    expect(d.saved).toEqual([azure, { azureEndpoint: "", azureDeployment: "" }]);
  });
  it("saves a Fish Audio provider and agent id, refusing an id that is not one", async () => {
    const d = deps();
    expect(await request(d, "PATCH", "/api/live/settings", { provider: "fish", fishAgentId: " agent_1 " })).toMatchObject({ status: 200, body: { live: { provider: "fish", fishAgentId: "agent_1" } } });
    for (const fishAgentId of ["../x", "a b", "x".repeat(129), 7]) {
      expect(await request(d, "PATCH", "/api/live/settings", { fishAgentId }), String(fishAgentId)).toMatchObject({ status: 400 });
    }
    expect((await request(d, "PATCH", "/api/live/settings", { fishAgentId: "" })).status).toBe(200);
    expect(d.saved).toEqual([{ provider: "fish", fishAgentId: "agent_1" }, { fishAgentId: "" }]);
  });

  it("saves nothing for an empty patch", async () => {
    const d = deps();
    expect(await request(d, "PATCH", "/api/live/settings", {})).toEqual({ status: 400, body: { error: "nothing to save" } });
    expect(d.saveSettings).not.toHaveBeenCalled();
  });
  it("never answers with the key", async () => {
    const res = await request(deps(), "PATCH", "/api/live/settings", { voice: "cedar" });
    expect(res).toEqual({ status: 200, body: { live: { configured: true, voice: "cedar", readTypedReplies: true, idleMinutes: 5 } } });
  });
  it("passes other paths and methods", async () => {
    expect(await request(deps(), "GET", "/api/live/summary")).toEqual({ status: 404, body: { from: "inline routes" } });
    expect(await request(deps(), "POST", "/api/live/summary", {})).toEqual({ status: 404, body: { from: "inline routes" } });
    expect(await request(deps(), "GET", "/api/live/session")).toEqual({ status: 404, body: { from: "inline routes" } });
    expect(await request(deps(), "PUT", "/api/live/settings", {})).toEqual({ status: 404, body: { from: "inline routes" } });
    expect(await request(deps(), "GET", "/api/bots")).toEqual({ status: 404, body: { from: "inline routes" } });
  });
  it("answers a call the Azure limit refuses with its words as a 403, and no setup prompt", async () => {
    const sentence = "Only an admin can start one.";
    const d = deps({ calls: { ...deps().calls, start: vi.fn(async () => { throw new LiveSessionError(sentence, 403); }) } });
    expect(await request(d, "POST", "/api/live/session", { botId: "bot1", sdp: "v=0", client: "web" })).toEqual({ status: 403, body: { error: sentence } });
  });
  it("is for admins only", () => {
    expect(requiredScope("POST", "/api/live/session")).toBe("admin");
    expect(requiredScope("POST", "/api/live/call/end")).toBe("admin");
    expect(requiredScope("GET", "/api/live/call")).toBe("admin");
    expect(requiredScope("PATCH", "/api/live/settings")).toBe("admin");
    expect(requiredScope("POST", "/api/live/device-revoked")).toBe("admin");
    expect(requiredScope("POST", "/api/live/relay")).toBe("admin");
  });

  describe("a call from a paired phone", () => {
    it("is bound to the phone the companion vouched for", async () => {
      const d = deps();
      await request(d, "POST", "/api/live/session", { botId: "bot1", sdp: "v=0", client: "ios" }, fromPhone());
      expect(d.calls.start).toHaveBeenCalledWith(expect.objectContaining({ device: "phone-1", client: "ios" }));
    });
    it("is bound to no phone without the companion's word, or with a malformed id", async () => {
      const d = deps();
      await request(d, "POST", "/api/live/session", { botId: "bot1", sdp: "v=0", client: "desktop" });
      await request(d, "POST", "/api/live/session", { botId: "bot1", sdp: "v=0", client: "ios" }, { "x-openmausbot-companion-device": "phone-1" });
      await request(d, "POST", "/api/live/session", { botId: "bot1", sdp: "v=0", client: "ios" }, fromPhone("../phone"));
      for (const [input] of vi.mocked(d.calls.start).mock.calls) expect(input.device).toBeUndefined();
    });
    it("is refused once its phone was unpaired", async () => {
      const refused = deps({ calls: { ...deps().calls, start: vi.fn(async () => { throw new LiveCallSignedOutError(); }) } });
      expect(await request(refused, "POST", "/api/live/session", { botId: "bot1", sdp: "v=0", client: "ios" }, fromPhone()))
        .toEqual({ status: 401, body: { error: "The sign-in that started this call has ended." } });
    });
    it("ends when the companion says its phone was unpaired", async () => {
      const d = deps();
      expect(await request(d, "POST", "/api/live/device-revoked", undefined, fromPhone()))
        .toMatchObject({ status: 200, body: { call: { status: "ending" } } });
      expect(d.calls.deviceRevoked).toHaveBeenCalledWith("phone-1");
      expect(await request(d, "POST", "/api/live/device-revoked", undefined, fromPhone("phone-2"))).toEqual({ status: 200, body: { call: null } });
    });
    it("takes the unpairing only from the companion, for a well-formed phone", async () => {
      const d = deps();
      expect((await request(d, "POST", "/api/live/device-revoked", undefined, { "x-openmausbot-companion-device": "phone-1" })).status).toBe(403);
      expect((await request(d, "POST", "/api/live/device-revoked", undefined, { "x-openmausbot-companion": "1" })).status).toBe(400);
      expect((await request(d, "POST", "/api/live/device-revoked", undefined, fromPhone("a/b"))).status).toBe(400);
      expect(d.calls.deviceRevoked).not.toHaveBeenCalled();
    });
  });
});

describe("a Fish Audio call", () => {
  const TOKEN = { transport: "livekit" as const, session_id: "fish_1", expires_at: "x", max_duration_seconds: 900, livekit_url: "wss://lk.example", token: "jwt" };
  const fishTransport = { type: "fish" as const, session: TOKEN, relayToken: "r".repeat(43) };

  function relayDeps() {
    const relay = { receive: vi.fn(), poll: vi.fn(async (_wait: number) => ({ commands: [{ type: "close" as const }], closed: false })) };
    const fishRelay = vi.fn((sessionId: string, token: string) => (sessionId === "fish_1" && token === fishTransport.relayToken ? relay : null));
    return { d: deps({ fishRelay }), relay, fishRelay };
  }
  const body = (extra: Record<string, unknown> = {}) => ({ sessionId: "fish_1", token: fishTransport.relayToken, ...extra });

  it("starts with no SDP and answers with Fish's session and the relay's token", async () => {
    const call = deps().calls.current()!;
    const d = deps({ calls: { ...deps().calls, start: vi.fn(async () => ({ call, fish: fishTransport })) } });
    const res = await request(d, "POST", "/api/live/session", { botId: "bot1", client: "web" });
    expect(res).toEqual({ status: 201, body: { call: expect.objectContaining({ callId: "c1" }), transport: fishTransport } });
    expect(vi.mocked(d.calls.start).mock.calls[0]![0]).not.toHaveProperty("sdp");
  });

  it("passes the client's reports to the relay and answers with what is queued, without waiting", async () => {
    const { d, relay } = relayDeps();
    const events = [{ type: "connected" }, { type: "heard", text: "hi", startMs: 1, endMs: 2 }, { type: "delegate", id: "call_1", atMs: 3 }];
    expect(await request(d, "POST", "/api/live/relay", body({ events, wait: true }))).toEqual({ status: 200, body: { commands: [{ type: "close" }], closed: false } });
    expect(relay.receive).toHaveBeenCalledWith(events);
    expect(relay.poll).toHaveBeenCalledWith(0);
  });

  it("holds a poll open only when the client asks to wait and reports nothing", async () => {
    const { d, relay } = relayDeps();
    await request(d, "POST", "/api/live/relay", body({ wait: true }));
    await request(d, "POST", "/api/live/relay", body());
    expect(relay.poll.mock.calls.map(([wait]) => wait)).toEqual([RELAY_POLL_MS, 0]);
    expect(relay.receive).not.toHaveBeenCalled();
  });

  it("answers 404 to a wrong token or session, and gives the relay nothing", async () => {
    const { d, relay } = relayDeps();
    expect(await request(d, "POST", "/api/live/relay", body({ token: "guessed" }))).toEqual({ status: 404, body: { error: "That call is not running." } });
    expect((await request(d, "POST", "/api/live/relay", body({ sessionId: "other" }))).status).toBe(404);
    expect(relay.receive).not.toHaveBeenCalled();
    expect(relay.poll).not.toHaveBeenCalled();
  });

  it("refuses a report that is not one the client makes, before looking for the relay", async () => {
    const { d, fishRelay } = relayDeps();
    for (const bad of [
      body({ events: [{ type: "heard", text: "", startMs: 0, endMs: 1 }] }),
      body({ events: [{ type: "heard", text: "x".repeat(2_001), startMs: 0, endMs: 1 }] }),
      body({ events: [{ type: "delegate", id: "a b", atMs: 0 }] }),
      body({ events: [{ type: "ended", reason: "Bye!" }] }),
      body({ events: [{ type: "heard", text: "hi", startMs: -1, endMs: 1 }] }),
      body({ events: [{ type: "session.close" }] }),
      body({ events: [{ type: "connected", extra: 1 }] }),
      body({ events: Array.from({ length: 21 }, () => ({ type: "connected" })) }),
      body({ extra: 1 }),
      { sessionId: "fish_1" },
      "{not json",
    ]) {
      expect((await request(d, "POST", "/api/live/relay", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(fishRelay).not.toHaveBeenCalled();
  });
});
