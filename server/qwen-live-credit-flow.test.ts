import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { expect, it, vi } from "vitest";
import { LiveCallController, type LiveCallDeps, type LiveSocket } from "./live-call-controller.ts";
import { createQwenLiveSession } from "./qwen-live-session.ts";
import { createLiveMediaRoutes } from "./routes/live-media.ts";
import { createUpgrades } from "./routes/upgrades.ts";
import { dispatchRoutes } from "./routes/table.ts";
import { json, readBody } from "./harness/http.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { LiveCallState } from "../shared/wire.ts";

class Provider implements LiveSocket {
  readyState = 0;
  onopen: LiveSocket["onopen"] = null; onmessage: LiveSocket["onmessage"] = null;
  onclose: LiveSocket["onclose"] = null; onerror: LiveSocket["onerror"] = null;
  sent: Record<string, unknown>[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); this.event({ type: "session.updated" }); }
  event(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
}
const first: Extract<RequestAuth, { kind: "session" }> = { kind: "session", via: "cookie", scopes: ["admin", "client"],
  session: { id: "fixture-one", userId: "same-person", tokenHash: "fixture", label: "fixture", scopes: ["admin", "client"], createdAt: 0, lastSeenAt: 0, expiresAt: 9999999999999 },
};
const other: RequestAuth = { ...first, session: { ...first.session, id: "fixture-two" } };
const endpoint = { provider: "qwen", apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash" } as const;
const credit = { type: "playback.credit", epoch: 0, seq: 1, bytes: 24_000, contextState: "running" } as const;
const failure = { type: "client.failure", code: "audio-context", contextState: "suspended", bufferedBytes: 0, queuedMs: 0, frameAgeMs: 0 } as const;
async function fixture(overrides: Partial<LiveCallDeps> = {}) {
  const provider = new Provider();
  const logs: string[] = [];
  const frames: Array<LiveCallState | null> = [];
  const signedIn = vi.fn(() => true);
  const deps: LiveCallDeps = {
    store: { onChange: () => () => {} }, send: vi.fn(async () => ({ kind: "started" as const, messageId: "m1" })), respond: vi.fn(async () => ({ ok: true as const })), queued: () => false,
    signedIn, activity: () => "working", broadcast: frame => frames.push(frame.call),
    settings: () => ({ provider: "qwen", endpoint, key: "test-only", voice: "marin", qwenVoice: "longanqian_v3.1", readTypedReplies: true, idleMinutes: 5 }),
    azureRefusal: () => null, createSession: input => createQwenLiveSession({ ...input, bot: { name: "Fixture" }, history: [], upstream: provider }),
    openSocket: () => { throw new Error("fixture requires a prepared adapter"); }, attachUrl: () => "unused", speakable: text => [text], log: line => logs.push(line), ...overrides,
  };
  const calls = new LiveCallController(deps);
  const started = await calls.start({ auth: first, botId: "bot", botName: "Fixture", threadId: "thread", client: "web", sdp: "", transports: ["ws-pcm"] });
  const upgrades = createUpgrades();
  const media = createLiveMediaRoutes({ upgrades, calls });
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = req.headers["x-fixture-auth"] === "other" ? other : first;
    await dispatchRoutes([media], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
  };
  const server = createServer(handle); upgrades.attach(server, handle);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const sockets: WebSocket[] = [];
  const open = async (identity = "first") => {
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/live/media`, { headers: { "x-fixture-auth": identity } });
    sockets.push(socket);
    const messages: Array<string | Buffer> = [];
    let closed: number | undefined;
    socket.on("message", (data, binary) => messages.push(binary ? Buffer.from(data as Buffer) : data.toString()));
    socket.on("close", code => { closed = code; });
    await once(socket, "open");
    return { socket, messages, closed: () => closed, send: (event: unknown) => socket.send(JSON.stringify(event)), bytes: () => messages.reduce<number>((sum, data) => sum + (Buffer.isBuffer(data) ? data.length : 0), 0) };
  };
  const close = async () => {
    for (const socket of sockets) socket.terminate();
    await calls.shutdown(); media.close(); upgrades.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  return { provider, calls, logs, frames, deps, signedIn, callId: started.call.callId, open, close };
}

it("negotiates credit through the real media route and current controller binding without forwarding client control to Qwen", async () => {
  const f = await fixture();
  try {
    f.provider.open();
    const client = await f.open();
    client.send({ type: "bind", callId: f.callId, playbackFlow: "credit-v1" });
    await vi.waitFor(() => expect({ messages: client.messages, closed: client.closed() }).toEqual({ messages: [JSON.stringify({ type: "media.ready", playbackFlow: "credit-v1", epoch: 0 })], closed: undefined }));
    f.provider.event({ type: "response.created", response: { id: "r" } });
    f.provider.event({ type: "response.audio.delta", response_id: "r", delta: Buffer.alloc(1_920).toString("base64") });
    expect(client.bytes()).toBe(0);
    client.send(credit);
    await vi.waitFor(() => expect(client.bytes()).toBe(1_920));
    expect(f.provider.sent.map(event => event.type)).not.toContain("playback.credit");
    expect(f.deps.send).not.toHaveBeenCalled();
    expect(f.deps.respond).not.toHaveBeenCalled();
    const closed = once(client.socket, "close"); client.send({ type: "hangup" }); await closed;
    expect(f.frames.at(-1)).toMatchObject({ status: "ended", endReason: "hung-up" });
  } finally { await f.close(); }
});

it("records one bounded untrusted client diagnostic and ends as error, never as hangup or a provider command", async () => {
  const f = await fixture();
  try {
    f.provider.open();
    const client = await f.open();
    client.send({ type: "bind", callId: f.callId, playbackFlow: "credit-v1" });
    await vi.waitFor(() => expect(client.messages).toHaveLength(1));
    const end = vi.spyOn(f.calls, "end");
    const diagnostic = { type: "client.failure", code: "playback-buffer", contextState: "suspended", bufferedBytes: 144_000, queuedMs: 3_000, frameAgeMs: 0 };
    const closed = once(client.socket, "close");
    client.send(diagnostic); client.send(diagnostic);
    await closed;
    expect(f.frames.at(-1)).toMatchObject({ status: "ended", endReason: "error" });
    expect(f.calls.current()).toBeNull();
    expect(f.logs.filter(line => line.includes("source=client-untrusted"))).toEqual([
      "[live] media failure source=client-untrusted code=playback-buffer contextState=suspended bufferedBytes=144000 queuedMs=3000 frameAgeMs=0",
    ]);
    expect(f.logs.find(line => line.includes("call ended"))).toContain("errors=qwen-client-playback-buffer");
    expect(f.provider.sent.map(event => event.type)).not.toContain("client.failure");
    expect(end).not.toHaveBeenCalled();
    expect(f.deps.send).not.toHaveBeenCalled();
    expect(f.deps.respond).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it("caps controls at 120 per rolling second, including duplicate zero-byte heartbeats", async () => {
  const f = await fixture();
  try {
    f.provider.open();
    const client = await f.open();
    client.send({ type: "bind", callId: f.callId, playbackFlow: "credit-v1" });
    await vi.waitFor(() => expect(client.messages).toHaveLength(1));
    for (let i = 0; i < 121; i++) client.send({ ...credit, bytes: 0 });
    await vi.waitFor(() => expect(client.closed()).toBe(1008));
    expect(f.logs.some(line => line.includes("source=client-untrusted"))).toBe(false);
    expect(f.provider.sent.map(event => event.type)).not.toContain("playback.credit");
  } finally { await f.close(); }
});

it("keeps an early negotiated bind silent until the provider confirms readiness", async () => {
  const f = await fixture();
  try {
    const bind = vi.spyOn(f.calls, "bindMedia");
    const client = await f.open();
    client.send({ type: "bind", callId: f.callId, playbackFlow: "credit-v1" });
    await vi.waitFor(() => expect(bind).toHaveBeenCalledOnce());
    expect(client.closed()).toBeUndefined();
    expect(client.messages).toEqual([]);
    f.provider.open();
    await vi.waitFor(() => expect(client.messages).toEqual([JSON.stringify({ type: "media.ready", playbackFlow: "credit-v1", epoch: 0 })]));
  } finally { await f.close(); }
});

it("does not let another session of the same person bind, diagnose or disconnect the starting session's call", async () => {
  const f = await fixture();
  try {
    f.provider.open();
    const refused = await f.open("other");
    refused.send({ type: "bind", callId: f.callId, playbackFlow: "credit-v1" });
    await vi.waitFor(() => expect(refused.closed()).toBe(1008));
    expect(f.calls.current()?.callId).toBe(f.callId);
    const bound = await f.open();
    bound.send({ type: "bind", callId: f.callId, playbackFlow: "credit-v1" });
    await vi.waitFor(() => expect(bound.messages).toHaveLength(1));
    const duplicate = await f.open();
    duplicate.send({ type: "bind", callId: f.callId, playbackFlow: "credit-v1" });
    await vi.waitFor(() => expect(duplicate.closed()).toBe(1008));
    expect(f.calls.current()?.callId).toBe(f.callId);
    expect(f.logs.some(line => line.includes("source=client-untrusted"))).toBe(false);
    expect(bound.closed()).toBeUndefined();
  } finally { await f.close(); }
});

it.each(["playback.credit", "client.failure"])("rechecks sign-in before accepting bound %s", async type => {
  const f = await fixture();
  try {
    f.provider.open();
    const client = await f.open();
    client.send({ type: "bind", callId: f.callId, playbackFlow: "credit-v1" });
    await vi.waitFor(() => expect(client.messages).toHaveLength(1));
    f.signedIn.mockReturnValue(false);
    client.send(type === "playback.credit" ? credit : failure);
    await vi.waitFor(() => expect(client.closed()).toBe(1008));
    await vi.waitFor(() => expect(f.calls.current()).toBeNull());
    expect(f.logs.some(line => line.includes("source=client-untrusted"))).toBe(false);
    expect(f.provider.readyState).toBe(3);
  } finally { await f.close(); }
});

it.each(["before-bind", "legacy"])("refuses credit and diagnostics in %s media without upgrading its authority", async mode => {
  for (const event of [credit, failure]) {
    const f = await fixture();
    try {
      f.provider.open();
      const client = await f.open();
      if (mode === "legacy") {
        client.send({ type: "bind", callId: f.callId });
        await vi.waitFor(() => expect(client.messages).toEqual([JSON.stringify({ type: "media.ready" })]));
      }
      client.send(event);
      await vi.waitFor(() => expect(client.closed()).toBe(1008));
      expect(f.logs.some(line => line.includes("source=client-untrusted"))).toBe(false);
    } finally { await f.close(); }
  }
});

it.each([
  { ...credit, bytes: -2 }, { ...credit, bytes: 1 }, { ...credit, bytes: 24_002 },
  { ...credit, epoch: 1 }, { ...credit, seq: 0.5 }, { ...credit, seq: 1_000_000_001 },
  { ...credit, contextState: "invalid" }, { ...credit, extra: "never-log-this" },
  { ...failure, code: "anything-provider-said" }, { ...failure, reason: "never-log-this" },
  { ...failure, bufferedBytes: 10_000_001 }, { ...failure, queuedMs: 3_600_001 },
  { ...failure, frameAgeMs: -1 }, { ...failure, frameAgeMs: 1.5 }, { ...failure, queuedMs: null },
  { ...failure, contextState: "invalid" }, { ...failure, callId: "another-call" },
])("rejects malformed or unauthorized controls through the actual WS schema: %j", async event => {
  const f = await fixture();
  try {
    f.provider.open();
    const client = await f.open();
    client.send({ type: "bind", callId: f.callId, playbackFlow: "credit-v1" });
    await vi.waitFor(() => expect(client.messages).toHaveLength(1));
    client.send(event);
    await vi.waitFor(() => expect(client.closed()).toBe(1008));
    expect(f.logs.some(line => line.includes("source=client-untrusted"))).toBe(false);
    expect(f.logs.join("\n")).not.toMatch(/anything-provider-said|never-log-this|another-call/);
    expect(f.deps.respond).not.toHaveBeenCalled();
    expect(f.deps.send).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it.each(["upload-backpressure", "capture-stale", "capture-overrun", "playback-buffer", "playback-stalled", "audio-context", "media-socket", "media-protocol", "media-processor"])("accepts only the fixed %s diagnostic with bounded integer metrics", async code => {
  const f = await fixture();
  try {
    f.provider.open();
    const client = await f.open();
    client.send({ type: "bind", callId: f.callId, playbackFlow: "credit-v1" });
    await vi.waitFor(() => expect(client.messages).toHaveLength(1));
    client.send({ ...failure, code, contextState: "closed", bufferedBytes: 10_000_000, queuedMs: 3_600_000, frameAgeMs: 3_600_000 });
    await vi.waitFor(() => expect(f.frames.at(-1)).toMatchObject({ status: "ended", endReason: "error" }));
    expect(f.logs.filter(line => line.includes("source=client-untrusted"))).toEqual([
      `[live] media failure source=client-untrusted code=${code} contextState=closed bufferedBytes=10000000 queuedMs=3600000 frameAgeMs=3600000`,
    ]);
    expect(f.provider.sent.map(event => event.type)).not.toContain("client.failure");
  } finally { await f.close(); }
});
