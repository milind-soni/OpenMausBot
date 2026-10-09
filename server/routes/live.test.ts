// The Live call routes, the way a request reaches them: through the table,
// on a real HTTP server, with a stand-in for index.ts's inline routes behind
// it. The controller and the config are stand-ins; their own tests cover them.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LiveCallState, LiveSettings } from "../../shared/wire.ts";
import { json, readBody } from "../harness/http.ts";
import { LiveCallBusyError, LiveCallNeedsProError, LiveCallSignedOutError } from "../live-call-controller.ts";
import { LiveSessionError } from "../live-call.ts";
import { requiredScope } from "../request-auth.ts";
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

/** What the companion adds to a paired phone's request (companion/src/proxy.ts). */
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
  // A Cloud's page in a web browser says so, so a busy line can say where
  // the other call is instead of "on this computer".
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
    const noKey = deps({ calls: { ...deps().calls, start: vi.fn(async () => { throw new LiveSessionError("Add an OpenAI API key to use Live calls.", 409); }) } });
    expect(await request(noKey, "POST", "/api/live/session", { botId: "bot1", sdp: "v=0", client: "ios" })).toMatchObject({ status: 409, body: { needsKey: true } });
    const active = { callId: "c0", botId: "bot2", threadId: "t2", client: "android", voice: "marin", startedAt: 1, status: "live" } as const;
    const busy = deps({ calls: { ...deps().calls, start: vi.fn(async () => { throw new LiveCallBusyError(active); }) } });
    const refused = await request(busy, "POST", "/api/live/session", { botId: "bot1", sdp: "v=0", client: "ios" });
    expect(refused).toMatchObject({ status: 409, body: { activeCall: active } });
    expect(refused.body).not.toHaveProperty("needsKey");
  });
  // Checked before the key (the controller's order), so a person without Pro
  // is never asked for one; the phones read the same body through the companion.
  it("says when Live calls need a Pro plan, and nothing about a key", async () => {
    for (const headers of [{}, fromPhone()]) {
      const noPro = deps({ calls: { ...deps().calls, start: vi.fn(async () => { throw new LiveCallNeedsProError(); }) } });
      const refused = await request(noPro, "POST", "/api/live/session", { botId: "bot1", sdp: "v=0", client: "android" }, headers);
      expect(refused).toEqual({ status: 402, body: { error: "Live calls need a Pro plan.", needsPro: true } });
    }
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
    // The key is saved with the rest of the settings (on a Cloud's page) or
    // in the desktop's credential store, never here; the refusal does not
    // send the person to "the computer that runs OpenMausBot".
    expect(await request(d, "PATCH", "/api/live/settings", { key: "sk-x" })).toEqual({ status: 400, body: { error: "Those Live settings are not valid." } });
    expect((await request(d, "PATCH", "/api/live/settings", { idleMinutes: 0 })).status).toBe(400);
    expect((await request(d, "PATCH", "/api/live/settings", { idleMinutes: 61 })).status).toBe(400);
    expect((await request(d, "PATCH", "/api/live/settings", { voice: "Marin!" })).status).toBe(400);
    expect(d.saved).toEqual([{ idleMinutes: 10, readTypedReplies: false }]);
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
  it("is for admins only", () => {
    expect(requiredScope("POST", "/api/live/session")).toBe("admin");
    expect(requiredScope("POST", "/api/live/call/end")).toBe("admin");
    expect(requiredScope("GET", "/api/live/call")).toBe("admin");
    expect(requiredScope("PATCH", "/api/live/settings")).toBe("admin");
    expect(requiredScope("POST", "/api/live/device-revoked")).toBe("admin");
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
