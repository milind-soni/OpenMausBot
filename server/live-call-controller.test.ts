import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveCallState, LiveClientFailure } from "../shared/wire.ts";
import {
  ATTACH_TIMEOUT_MS, CLOSE_TIMEOUT_MS, CONSENT_SETTLE_MS, DELEGATION_SETTLE_MS, GOODBYE_MS, IDLE_CHECK_MS, PROGRESS_INTERVAL_MS,
  LiveCallBusyError, LiveCallController, LiveCallSignedOutError, type LiveActivity, type LiveCallDeps, type LiveSocket,
} from "./live-call-controller.ts";
import { LIVE_COPY } from "../shared/live-approval.ts";
import { LIVE_NEEDS_AZURE, LIVE_NEEDS_KEY, LiveSessionError, type LiveEndpoint } from "./live-call.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { Message, StoreChange } from "./store.ts";
import { createQwenLiveSession } from "./qwen-live-session.ts";

class FakeSocket implements LiveSocket {
  readyState = 0;
  url: string;
  key: string;
  sent: Array<Record<string, unknown>> = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(url: string, key: string) { this.url = url; this.key = key; }
  send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({}); }
  open() { this.readyState = 1; this.onopen?.({}); }
  receive(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
  refuse() { this.onerror?.({}); this.readyState = 3; }
  drop() { this.readyState = 3; this.onclose?.({}); }
  appends(kind: string) { return this.sent.filter((e) => e.type === `session.${kind}.append`); }
}

const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const BOT = { botId: "bot1", botName: "Ada", threadId: "t1" };
const ENDPOINT: LiveEndpoint = { provider: "openai", apiBase: "https://api.openai.com/v1", model: "gpt-live-1" };

function setup(overrides: Partial<LiveCallDeps> = {}) {
  const listeners = new Set<(change: StoreChange) => void>();
  const sockets: FakeSocket[] = [];
  const frames: Array<LiveCallState | null> = [];
  const logs: string[] = [];
  let activity: LiveActivity = "idle";
  const settings: ReturnType<LiveCallDeps["settings"]> = { key: "sk-test", endpoint: ENDPOINT, voice: "sol", readTypedReplies: true, idleMinutes: 5 };
  const queue = new Set<string>();
  let messageCounter = 0;
  const deps: LiveCallDeps = {
    store: { onChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } },
    send: vi.fn(async () => ({ kind: "started" as const, messageId: `m${++messageCounter}` })),
    respond: vi.fn(async () => ({ ok: true as const })),
    queued: vi.fn((_botId: string, _threadId: string, queueId: string) => queue.has(queueId)),
    activity: () => activity,
    broadcast: (frame) => frames.push(frame.call),
    settings: () => settings,
    azureRefusal: vi.fn(() => null),
    createSession: vi.fn(async () => ({ sessionId: "sess_1", sdp: "answer-sdp" })),
    openSocket: (url, key) => { const socket = new FakeSocket(url, key); sockets.push(socket); return socket; },
    attachUrl: (id) => `ws://fake/${id}/attach`,
    speakable: (text) => text.split(/(?<=[.!?])\s+/).filter(Boolean),
    log: (line) => logs.push(line),
    now: () => Date.now(),
    ...overrides,
  };
  const controller = new LiveCallController(deps);
  const emit = (change: StoreChange) => { for (const listener of Array.from(listeners)) listener(change); };
  const message = (m: Partial<Message> & { id: string }) => emit({ type: "message", threadId: "t1", message: { role: "bot", kind: "text", ...m } as Message });
  const patch = (m: Partial<Message> & { id: string }) => emit({ type: "message.patch", threadId: "t1", message: { role: "bot", kind: "text", ...m } as Message });
  const setActivity = (next: LiveActivity) => { activity = next; emit({ type: "bot", botId: "bot1" }); };
  const start = async () => {
    const result = await controller.start({ auth: owner, ...BOT, client: "desktop", sdp: "offer-sdp" });
    sockets.at(-1)!.open();
    return result;
  };
  return { controller, deps, sockets, frames, logs, settings, queue, listeners, emit, message, patch, setActivity, start, socket: () => sockets.at(-1)! };
}

async function setupQwenMedia(auth: RequestAuth = owner, bind = true, overrides: Partial<LiveCallDeps> = {}) {
  const provider = new FakeSocket("unused", "fixture");
  const endpoint: LiveEndpoint = { provider: "qwen", apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash" };
  const signedIn = vi.fn(() => true);
  const t = setup({ ...overrides, signedIn, createSession: input => createQwenLiveSession({ ...input, bot: { name: "Fixture" }, history: [], upstream: provider }) });
  t.settings.provider = "qwen"; t.settings.endpoint = endpoint;
  const { call } = await t.controller.start({ auth, ...BOT, sdp: "", client: "web", transports: ["ws-pcm"] });
  provider.open(); provider.receive({ type: "session.updated" });
  const media = { bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
  if (bind) expect(t.controller.bindMedia(call.callId, auth, media, "credit-v1")).toBe(true);
  return { ...t, provider, media, callId: call.callId, signedIn };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("LiveCallController lifecycle", () => {
  it("keeps a requested hangup reason when media disconnects before provider closure", async () => {
    const t = setup();
    const { call } = await t.start();
    const ending = t.controller.end(call.callId);
    t.controller.mediaDisconnected("unrelated");
    expect(t.controller.current()?.status).toBe("ending");
    t.controller.mediaDisconnected(call.callId);
    await ending;
    expect(t.frames.filter(Boolean).at(-1)).toMatchObject({ endReason: "hung-up" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("closes a prepared socket if startup fails before attachment", async () => {
    const socket = new FakeSocket("fixture", "fixture");
    const t = setup({ createSession: async () => ({ sessionId: "prepared", sdp: "", socket }), activity: () => { throw new Error("fixture activity failed"); } });
    await expect(t.controller.start({ auth: owner, ...BOT, client: "web", sdp: "offer" })).rejects.toThrow("fixture activity failed");
    expect(socket.readyState).toBe(3);
    expect(t.controller.current()).toBeNull();
  });
  it.each(["qwen", "openai", "azure"] as const)("pins steering correlation to the %s call even if configured provider changes", async provider => {
    const t = setup();
    t.settings.provider = provider;
    t.settings.endpoint = { ...ENDPOINT, provider };
    await t.controller.start({ auth: owner, ...BOT, sdp: "offer", client: "web", transports: ["ws-pcm"] });
    t.socket().open();
    t.settings.provider = provider === "qwen" ? "openai" : "qwen";
    t.settings.endpoint = { ...ENDPOINT, provider: t.settings.provider };
    t.socket().receive({ type: "session.input_transcript.delta", delta: "Fixture request.", start_ms: 0, end_ms: 100 });
    t.socket().receive({ type: "session.delegation.created", delegation: { id: "fixture-delegation", target: "client" }, offset_ms: 100,
      request: { text: "Fixture request.", withoutEcho: "Fixture request." } });
    await vi.advanceTimersByTimeAsync(DELEGATION_SETTLE_MS);
    expect(t.deps.send).toHaveBeenCalledOnce();
    expect(vi.mocked(t.deps.send).mock.calls[0][0].requireSteerRequestId).toBe(provider === "qwen" ? true : undefined);
    await t.controller.shutdown();
  });

  it.each(["session-revoked", "media-disconnected", "shutdown"])("releases queued credit playback on %s and refuses late control", async action => {
    const auth: Extract<RequestAuth, { kind: "session" }> = { kind: "session", via: "cookie", scopes: ["admin", "client"], session: { id: "fixture-session", tokenHash: "fixture", label: "fixture", scopes: ["admin", "client"], createdAt: 0, lastSeenAt: 0, expiresAt: 9999999999999 } };
    const f = await setupQwenMedia(auth);
    f.provider.receive({ type: "response.audio.delta", response_id: "r", delta: Buffer.alloc(1_920).toString("base64") });
    const credit = { type: "playback.credit", epoch: 0, seq: 1, bytes: 960, contextState: "running" } as const;
    expect(f.controller.playbackCredit(f.callId, credit)).toBe(true);
    expect(f.controller.sessionRevoked("different-session")).toBeNull();
    if (action === "session-revoked") f.controller.sessionRevoked(auth.session.id);
    else if (action === "media-disconnected") f.controller.mediaDisconnected(f.callId);
    else await f.controller.shutdown();
    expect(f.controller.current()).toBeNull();
    expect(f.media.close).toHaveBeenCalledOnce();
    expect(f.provider.readyState).toBe(3);
    expect(f.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.controller.playbackCredit(f.callId, credit)).toBe(false);
    expect(f.controller.clientFailure(f.callId, { type: "client.failure", code: "audio-context", contextState: "closed", bufferedBytes: 0, queuedMs: 0, frameAgeMs: 0 })).toBe(false);
    expect(f.logs.some(line => line.includes("source=client-untrusted"))).toBe(false);
  });
  it("records the Qwen duration limit without reporting a dropped connection", async () => {
    const f = await setupQwenMedia(owner, true, { recordCall: vi.fn() });
    vi.setSystemTime(Date.now() + 3_600_001);
    f.controller.inputMedia(f.callId, Buffer.alloc(640));
    expect(f.frames.at(-1)).toMatchObject({ status: "ended", endReason: "duration-limit" });
    expect(f.frames.at(-1)?.error).toBeUndefined();
    expect(vi.mocked(f.deps.recordCall!).mock.calls.map(([input]) => input.record.endReason)).toEqual(["duration-limit"]);
    expect(f.logs.find(line => line.includes("call ended"))).toContain("errors=qwen-duration-limit");
    expect(f.controller.current()).toBeNull();
    expect(f.media.close).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("records a Qwen call that the server shuts down as shutdown, though the adapter closes synchronously", async () => {
    const f = await setupQwenMedia(owner, true, { recordCall: vi.fn() });
    await f.controller.shutdown();
    const ended = f.frames.at(-1);
    expect(ended).toMatchObject({ status: "ended", endReason: "shutdown" });
    expect(ended?.error).toBeUndefined();
    expect(vi.mocked(f.deps.recordCall!).mock.calls.map(([input]) => input.record.endReason)).toEqual(["shutdown"]);
    expect(f.logs.filter(line => line.includes("end=")).map(line => /end=(\S+)/.exec(line)?.[1])).toEqual(["shutdown"]);
    expect(f.controller.current()).toBeNull();
    expect(f.media.close).toHaveBeenCalledOnce();
    expect(f.provider.readyState).toBe(3);
    expect(f.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("refuses direct unbound, wrong-call, signed-out and non-finite client diagnostics without logging their contents", async () => {
    const f = await setupQwenMedia(owner, false);
    const failure = { type: "client.failure", code: "audio-context", contextState: "closed", bufferedBytes: 0, queuedMs: 0, frameAgeMs: 0 } as const;
    expect(f.controller.clientFailure(f.callId, failure)).toBe(false);
    expect(f.controller.playbackCredit(f.callId, { type: "playback.credit", epoch: 0, seq: 1, bytes: 960, contextState: "running" })).toBe(false);
    expect(f.controller.bindMedia(f.callId, owner, f.media, "credit-v1")).toBe(true);
    expect(f.controller.clientFailure("another-call", failure)).toBe(false);
    for (const override of [{ bufferedBytes: NaN }, { queuedMs: Infinity }, { frameAgeMs: -1 }, { code: "never-log-this" }, { reason: "never-log-this" }]) {
      expect(f.controller.clientFailure(f.callId, { ...failure, ...override } as LiveClientFailure)).toBe(false);
    }
    f.signedIn.mockReturnValue(false);
    expect(f.controller.clientFailure(f.callId, failure)).toBe(false);
    expect(f.logs.some(line => line.includes("source=client-untrusted"))).toBe(false);
    expect(f.logs.join("\n")).not.toContain("never-log-this");
    await f.controller.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not treat consumed client credit as evidence to authorize Qwen spoken approval", async () => {
    const f = await setupQwenMedia();
    f.message({ id: "approval", kind: "options", card: { title: "Approval needed", subtitle: "synthetic operation", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.playbackCredit(f.callId, { type: "playback.credit", epoch: 0, seq: 1, bytes: 24_000, contextState: "running" })).toBe(true);
    f.provider.receive({ type: "response.created", response: { id: "prompt" } });
    f.provider.receive({ type: "response.audio.delta", response_id: "prompt", delta: Buffer.alloc(960).toString("base64") });
    expect(f.controller.playbackCredit(f.callId, { type: "playback.credit", epoch: 0, seq: 2, bytes: 960, contextState: "running" })).toBe(true);
    f.provider.receive({ type: "input_audio_buffer.speech_started", item_id: "yes", audio_start_ms: 1000 });
    f.provider.receive({ type: "input_audio_buffer.speech_stopped", item_id: "yes", audio_end_ms: 2000 });
    f.provider.receive({ type: "input_audio_buffer.committed", item_id: "yes" });
    f.provider.receive({ type: "response.created", response: { id: "r-yes" } });
    f.provider.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "yes", transcript: "yes" });
    f.provider.receive({ type: "response.function_call_arguments.done", response_id: "r-yes", call_id: "yes-tool", name: "delegate_to_bot", arguments: "{}" });
    await vi.advanceTimersByTimeAsync(DELEGATION_SETTLE_MS + CONSENT_SETTLE_MS);
    expect(f.deps.respond).not.toHaveBeenCalled();
    expect(f.deps.send).not.toHaveBeenCalled();
    await f.controller.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ends a stalled credit playback with the fixed safe error and releases adapter and controller timers", async () => {
    const provider = new FakeSocket("unused", "fixture");
    const endpoint: LiveEndpoint = { provider: "qwen", apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash" };
    const t = setup({ createSession: input => createQwenLiveSession({ ...input, bot: { name: "Fixture" }, history: [], upstream: provider }) });
    t.settings.provider = "qwen"; t.settings.endpoint = endpoint;
    const { call } = await t.controller.start({ auth: owner, ...BOT, sdp: "", client: "web", transports: ["ws-pcm"] });
    provider.open(); provider.receive({ type: "session.updated" });
    const media = { bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
    expect(t.controller.bindMedia(call.callId, owner, media, "credit-v1")).toBe(true);
    provider.receive({ type: "response.created", response: { id: "r" } });
    provider.receive({ type: "response.audio.delta", response_id: "r", delta: Buffer.alloc(960).toString("base64") });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "error", error: "The call ended because audio playback stopped making progress." });
    expect(t.logs.find(line => line.includes("call ended"))).toContain("errors=qwen-playback-stalled");
    expect(provider.readyState).toBe(3);
    expect(media.close).toHaveBeenCalledOnce();
    expect(t.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(t.deps.send).not.toHaveBeenCalled();
    expect(t.deps.respond).not.toHaveBeenCalled();
  });
  it("does not leave close timers behind when the explicit Qwen adapter closes synchronously", async () => {
    const prepared = new FakeSocket("unused", "fixture");
    prepared.send = (raw) => { if ((JSON.parse(raw) as { type: string }).type === "session.close") prepared.close(); };
    const t = setup({ createSession: vi.fn(async () => ({ sessionId: "q1", sdp: "", socket: prepared })) });
    t.settings.provider = "qwen";
    t.settings.endpoint = { provider: "qwen", apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash" };
    const call = await t.controller.start({ auth: owner, ...BOT, sdp: "offer", client: "web", transports: ["ws-pcm"] }); prepared.open();
    await t.controller.end(call.call.callId);
    expect(t.controller.current()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("binds a Qwen media consumer to the exact starting session once and expires unbound calls", async () => {
    const first: Extract<RequestAuth, { kind: "session" }> = { kind: "session", via: "cookie", scopes: ["admin", "client"],
      session: { id: "session-one", userId: "same-person", tokenHash: "fixture", label: "fixture", scopes: ["admin", "client"], createdAt: 0, lastSeenAt: 0, expiresAt: 9999999999999 },
    };
    const other: RequestAuth = { ...first, session: { ...first.session, id: "session-two" } };
    const prepared = Object.assign(new FakeSocket("unused", "fixture"), { bindMedia: vi.fn(() => true), appendPcm: vi.fn(() => true) });
    const t = setup({ createSession: vi.fn(async () => ({ sessionId: "q1", sdp: "", socket: prepared })) });
    t.settings.provider = "qwen";
    t.settings.endpoint = { provider: "qwen", apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash" };
    const call = await t.controller.start({ auth: first, ...BOT, sdp: "offer", client: "web", transports: ["ws-pcm"] });
    prepared.open();
    const media = { bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
    expect(t.controller.bindMedia(call.call.callId, other, media)).toBe(false);
    expect(t.controller.bindMedia(call.call.callId, owner, media)).toBe(false);
    expect(t.controller.bindMedia(call.call.callId, first, media)).toBe(true);
    expect(t.controller.bindMedia(call.call.callId, first, media)).toBe(false);
    expect(t.controller.inputMedia(call.call.callId, Buffer.from([0, 0]))).toBe(true);
    t.controller.mediaDisconnected(call.call.callId);
    expect(t.controller.current()).toBeNull();
    expect(prepared.readyState).toBe(3);
    const second = Object.assign(new FakeSocket("unused", "fixture"), { bindMedia: vi.fn(() => true), appendPcm: vi.fn(() => true) });
    second.open();
    t.deps.createSession = vi.fn(async () => ({ sessionId: "q2", sdp: "", socket: second }));
    await t.controller.start({ auth: first, ...BOT, sdp: "offer", client: "web", transports: ["ws-pcm"] });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(t.controller.current()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.controller.current()).toBeNull();
  });
  it("refuses Qwen without a declared browser PCM transport before creating anything", async () => {
    const t = setup();
    t.settings.provider = "qwen";
    t.settings.endpoint = { provider: "qwen", apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash" };
    for (const input of [{ client: "ios", transports: ["ws-pcm"] }, { client: "android", transports: ["ws-pcm"] }, { client: "web" }, { client: "desktop", transports: [] }] as const) {
      await expect(t.controller.start({ auth: owner, ...BOT, sdp: "offer", ...input })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("ws-pcm") });
    }
    expect(t.deps.createSession).not.toHaveBeenCalled();
    expect(t.controller.current()).toBeNull();
  });
  it("keeps the Qwen voice separate from native voice validation", async () => {
    const t = setup();
    t.settings.provider = "qwen";
    t.settings.endpoint = { provider: "qwen", apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash" };
    t.settings.qwenVoice = "longanqian_v3.1";
    await t.controller.start({ auth: owner, ...BOT, sdp: "offer", client: "web", transports: ["ws-pcm"] });
    expect(t.deps.createSession).toHaveBeenCalledWith(expect.objectContaining({ voice: "longanqian_v3.1" }));
  });
  it("creates the session with the key and voice, attaches the sideband and goes live", async () => {
    const t = setup();
    const result = await t.controller.start({ auth: owner, ...BOT, client: "ios", sdp: "offer-sdp" });
    expect(t.deps.createSession).toHaveBeenCalledWith({ key: "sk-test", endpoint: ENDPOINT, sdp: "offer-sdp", botId: "bot1", threadId: "t1", voice: "sol" });
    expect(result.sdp).toBe("answer-sdp");
    expect(result.call).toMatchObject({ botId: "bot1", threadId: "t1", client: "ios", voice: "sol", status: "connecting" });
    expect(t.socket().url).toBe("ws://fake/sess_1/attach");
    expect(t.socket().key).toBe("sk-test");
    t.socket().open();
    expect(t.controller.current()?.status).toBe("live");
    expect(t.frames.map((f) => f?.status)).toEqual(["connecting", "live"]);
  });

  it("refuses a second call while one is active, before creating a session", async () => {
    const t = setup();
    const first = t.controller.start({ auth: owner, ...BOT, client: "desktop", sdp: "a" });
    await expect(t.controller.start({ auth: owner, ...BOT, client: "ios", sdp: "b" })).rejects.toBeInstanceOf(LiveCallBusyError);
    await first;
    expect(t.deps.createSession).toHaveBeenCalledTimes(1);
  });

  it("asks every client for the person's own key when none is set, never for a plan", async () => {
    for (const input of [{ client: "desktop" }, { client: "web" }, { client: "ios" }, { client: "android" }, { client: "ios", device: "phone-1" }] as const) {
      const t = setup();
      t.settings.key = " ";
      const refused = t.controller.start({ auth: owner, ...BOT, ...input, sdp: "a" });
      await expect(refused, JSON.stringify(input)).rejects.toMatchObject({ status: 409, message: LIVE_NEEDS_KEY });
      expect(t.deps.createSession).not.toHaveBeenCalled();
      expect(t.controller.current()).toBeNull();
    }
    expect(LIVE_NEEDS_KEY).toBe("Live calls use your own OpenAI key. Add it in Settings → API keys.");
  });

  it("refuses an Azure call whose setup is incomplete with the setup message, before reaching Azure", async () => {
    const t = setup();
    t.settings.endpoint = null;
    t.settings.provider = "azure";
    t.settings.setupProblem = LIVE_NEEDS_AZURE;
    await expect(t.controller.start({ auth: owner, ...BOT, client: "desktop", sdp: "a" })).rejects.toMatchObject({ status: 409, message: LIVE_NEEDS_AZURE });
    expect(t.deps.createSession).not.toHaveBeenCalled();
    expect(t.controller.current()).toBeNull();
  });

  it("creates and attaches an Azure call on the Azure endpoint it started with, even if settings change mid-call", async () => {
    const azure: LiveEndpoint = { provider: "azure", apiBase: "https://res.openai.azure.com/openai/v1", model: "live-dep" };
    const attachUrl = vi.fn((id: string, endpoint: LiveEndpoint) => `${endpoint.apiBase}/live/sessions/${id}/attach`);
    const t = setup({ attachUrl });
    t.settings.endpoint = azure;
    const pending = t.controller.start({ auth: owner, ...BOT, client: "web", sdp: "offer-sdp" });
    t.settings.endpoint = ENDPOINT;
    await pending;
    expect(t.deps.createSession).toHaveBeenCalledWith(expect.objectContaining({ endpoint: azure }));
    expect(attachUrl).toHaveBeenCalledWith("sess_1", azure);
    expect(t.socket().url).toBe("https://res.openai.azure.com/openai/v1/live/sessions/sess_1/attach");
    t.socket().open();
    expect(t.controller.current()).toMatchObject({ status: "live" });
  });

  describe("with Azure chosen", () => {
    const AZURE: LiveEndpoint = { provider: "azure", apiBase: "https://res.openai.azure.com/openai/v1", model: "live-dep" };
    const REFUSED = "only an admin, in these words";
    const member: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };
    const azure = (overrides: Partial<LiveCallDeps> = {}) => {
      const t = setup(overrides);
      t.settings.endpoint = AZURE;
      t.settings.provider = "azure";
      return t;
    };

    it("asks who is calling, with their own sign-in, and goes ahead when they may", async () => {
      const t = azure();
      await t.controller.start({ auth: owner, ...BOT, client: "web", sdp: "a" });
      expect(t.deps.azureRefusal).toHaveBeenCalledWith(owner);
      expect(t.deps.createSession).toHaveBeenCalledOnce();
    });

    it("refuses with the reason as a 403, never a setup prompt, before any session, socket or line is taken", async () => {
      const t = azure({ azureRefusal: () => REFUSED });
      await expect(t.controller.start({ auth: member, ...BOT, client: "ios", sdp: "a" })).rejects.toMatchObject({ status: 403, message: REFUSED });
      expect(t.deps.createSession).not.toHaveBeenCalled();
      expect(t.sockets).toHaveLength(0);
      expect(t.frames).toEqual([]);
      expect(t.controller.current()).toBeNull();
      expect(t.logs.join("\n")).toContain("[live] call refused bot=bot1 client=ios provider=azure");
    });

    it("refuses a person who may not call even while Azure is not set up yet, rather than sending them to set it up", async () => {
      const t = azure({ azureRefusal: () => REFUSED });
      t.settings.endpoint = null;
      t.settings.key = "";
      t.settings.setupProblem = LIVE_NEEDS_AZURE;
      await expect(t.controller.start({ auth: member, ...BOT, client: "web", sdp: "a" })).rejects.toMatchObject({ status: 403, message: REFUSED });
    });

    it("asks too when only the endpoint says Azure, so no reading of the settings slips past it", async () => {
      const t = azure({ azureRefusal: () => REFUSED });
      delete t.settings.provider;
      await expect(t.controller.start({ auth: member, ...BOT, client: "web", sdp: "a" })).rejects.toMatchObject({ status: 403 });
      expect(t.deps.createSession).not.toHaveBeenCalled();
    });

    it("tells a refused caller nothing about a call already running", async () => {
      let asked = 0;
      const t = azure({ azureRefusal: () => (asked++ === 0 ? null : REFUSED) });
      await t.start();
      const second = t.controller.start({ auth: member, ...BOT, client: "web", sdp: "a" });
      await expect(second).rejects.toMatchObject({ status: 403, message: REFUSED });
      await expect(second).rejects.not.toBeInstanceOf(LiveCallBusyError);
    });

  });

  it("asks nothing of the Azure limit for a call through OpenAI", async () => {
    const t = setup({ azureRefusal: vi.fn(() => "never asked") });
    await t.controller.start({ auth: owner, ...BOT, client: "desktop", sdp: "a" });
    expect(t.deps.azureRefusal).not.toHaveBeenCalled();
    expect(t.deps.createSession).toHaveBeenCalledOnce();
  });

  it("starts a phone's call with no plan at all once a key exists, through the companion or by the phone's own client", async () => {
    for (const input of [{ client: "ios", device: "phone-1" }, { client: "android", device: "phone-2" }, { client: "ios" }, { client: "android" }] as const) {
      const t = setup();
      const { call } = await t.controller.start({ auth: owner, ...BOT, ...input, sdp: "offer-sdp" });
      expect(call, JSON.stringify(input)).toMatchObject({ client: input.client, status: "connecting" });
      expect(t.deps.createSession).toHaveBeenCalledWith(expect.objectContaining({ key: "sk-test" }));
      t.socket().open();
      expect(t.controller.current()).toMatchObject({ callId: call.callId, status: "live" });
    }
  });

  it("frees the slot when OpenAI refuses the session", async () => {
    const t = setup({ createSession: vi.fn().mockRejectedValueOnce(new LiveSessionError("nope", 502)).mockResolvedValue({ sessionId: "sess_2", sdp: "x" }) });
    await expect(t.controller.start({ auth: owner, ...BOT, client: "desktop", sdp: "a" })).rejects.toBeInstanceOf(LiveSessionError);
    expect(t.controller.current()).toBeNull();
    await expect(t.controller.start({ auth: owner, ...BOT, client: "desktop", sdp: "a" })).resolves.toBeTruthy();
  });

  it("ends with sideband-lost when attach is refused", async () => {
    const t = setup();
    await t.controller.start({ auth: owner, ...BOT, client: "desktop", sdp: "a" });
    t.socket().refuse();
    expect(t.controller.current()).toBeNull();
    expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "sideband-lost" });
    expect(t.logs.some((line) => line.startsWith("[live] call ended") && line.includes("end=sideband-lost"))).toBe(true);
  });

  it("ends with sideband-lost and leaves no timer when the sideband cannot be opened", async () => {
    const t = setup({ openSocket: () => { throw new Error("bad url"); } });
    const result = await t.controller.start({ auth: owner, ...BOT, client: "desktop", sdp: "a" });
    expect(result.call).toMatchObject({ status: "ended", endReason: "sideband-lost" });
    expect(t.controller.current()).toBeNull();
    expect(t.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends one session.close when asked to hang up twice", async () => {
    const t = setup();
    const { call } = await t.start();
    const first = t.controller.end(call.callId);
    const second = t.controller.end(call.callId);
    expect(t.socket().sent.filter((e) => e.type === "session.close")).toHaveLength(1);
    t.socket().receive({ type: "session.closed", reason: "close_requested" });
    await expect(first).resolves.toMatchObject({ status: "ended", endReason: "hung-up" });
    await expect(second).resolves.toMatchObject({ status: "ended", endReason: "hung-up" });
  });

  it.each(["request", "approval"])("does not dispatch a settled spoken %s after hang-up", async (kind) => {
    const t = setup();
    const { call } = await t.start();
    if (kind === "approval") {
      t.message({ id: "approval", kind: "options", card: { title: "Approval needed", subtitle: "delete build", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash" } });
      await vi.advanceTimersByTimeAsync(0);
    }
    t.socket().receive({ type: "session.input_transcript.delta", delta: kind === "approval" ? "yes" : "delete build", start_ms: 100, end_ms: 200 });
    t.socket().receive({ type: "session.delegation.created", offset_ms: 250, delegation: { id: "late", target: "client" } });
    const ending = t.controller.end(call.callId);
    await vi.advanceTimersByTimeAsync(CONSENT_SETTLE_MS + 1);
    expect(t.controller.current()?.status).toBe("ending");
    expect(t.deps.send).not.toHaveBeenCalled();
    expect(t.deps.respond).not.toHaveBeenCalled();
    t.socket().receive({ type: "session.closed", reason: "close_requested" });
    await ending;
  });

  it("ends with sideband-lost when attach never opens", async () => {
    const t = setup();
    await t.controller.start({ auth: owner, ...BOT, client: "desktop", sdp: "a" });
    await vi.advanceTimersByTimeAsync(ATTACH_TIMEOUT_MS + 1);
    expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "sideband-lost" });
  });

  it("ends with sideband-lost when the sideband drops mid-call", async () => {
    const t = setup();
    await t.start();
    t.socket().drop();
    expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "sideband-lost" });
  });

  it("hangs up gracefully: session.close, then session.closed", async () => {
    const t = setup();
    const { call } = await t.start();
    const ending = t.controller.end(call.callId);
    expect(t.socket().sent.at(-1)).toMatchObject({ type: "session.close" });
    expect(t.frames.at(-1)?.status).toBe("ending");
    t.socket().receive({ type: "session.closed", reason: "close_requested", usage: { seconds: 61 } });
    await expect(ending).resolves.toMatchObject({ status: "ended", endReason: "hung-up" });
    expect(t.logs.at(-1)).toContain("seconds=61");
  });

  it("finishes a hang-up after 5 s without session.closed", async () => {
    const t = setup();
    const { call } = await t.start();
    const ending = t.controller.end(call.callId);
    await vi.advanceTimersByTimeAsync(CLOSE_TIMEOUT_MS + 1);
    await expect(ending).resolves.toMatchObject({ status: "ended", endReason: "hung-up" });
  });

  it("returns null when asked to end an unknown call", async () => {
    const t = setup();
    await t.start();
    await expect(t.controller.end("other")).resolves.toBeNull();
  });

  it("maps OpenAI's close reasons", async () => {
    const t = setup();
    await t.start();
    t.socket().receive({ type: "session.closed", reason: "expired", usage: { seconds: 3600 } });
    expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "expired" });
  });

  it("hangs up after the idle minutes without speech or work", async () => {
    const t = setup();
    await t.start();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    t.socket().receive({ type: "session.input_transcript.delta", delta: "hi", start_ms: 1, end_ms: 2 });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(t.socket().sent.some((e) => e.type === "session.close")).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000 + IDLE_CHECK_MS);
    expect(t.socket().sent.at(-1)).toMatchObject({ type: "session.close" });
    t.socket().receive({ type: "session.closed", reason: "close_requested" });
    expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "idle" });
  });

  it("hangs up an idle Qwen call while silent PCM keeps arriving", async () => {
    const t = await setupQwenMedia();
    t.settings.idleMinutes = 1;
    const capture = setInterval(() => t.controller.inputMedia(t.callId, Buffer.alloc(640)), 20);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.controller.current()).toBeNull();
      expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "idle" });
      expect(t.provider.readyState).toBe(3);
      expect(t.media.close).toHaveBeenCalledOnce();
    } finally {
      clearInterval(capture);
      await t.controller.shutdown();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a Qwen call active for speech before timing out subsequent silence", async () => {
    const t = await setupQwenMedia();
    t.settings.idleMinutes = 1;
    const capture = setInterval(() => t.controller.inputMedia(t.callId, Buffer.alloc(640)), 20);
    try {
      await vi.advanceTimersByTimeAsync(45_000);
      t.provider.receive({ type: "input_audio_buffer.speech_started", item_id: "greeting", audio_start_ms: 44_000 });
      t.provider.receive({ type: "input_audio_buffer.speech_stopped", item_id: "greeting", audio_end_ms: 45_000 });
      t.provider.receive({ type: "input_audio_buffer.committed", item_id: "greeting" });
      t.provider.receive({ type: "response.created", response: { id: "reply" } });
      t.provider.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "greeting", transcript: "Hello." });
      t.provider.receive({ type: "response.done", response: { id: "reply", status: "completed" } });
      await vi.advanceTimersByTimeAsync(45_000);
      expect(t.controller.current()).toMatchObject({ status: "live" });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(t.controller.current()).toBeNull();
      expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "idle" });
      expect(t.deps.send).not.toHaveBeenCalled();
    } finally {
      clearInterval(capture);
      await t.controller.shutdown();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps Qwen speech active until VAD stops, then times out without requiring final ASR", async () => {
    const t = await setupQwenMedia();
    t.settings.idleMinutes = 1;
    try {
      await vi.advanceTimersByTimeAsync(45_000);
      t.provider.receive({ type: "input_audio_buffer.speech_started", item_id: "long-speech", audio_start_ms: 45_000 });
      await vi.advanceTimersByTimeAsync(84_000);
      expect(t.controller.current()).toMatchObject({ status: "live" });
      t.provider.receive({ type: "input_audio_buffer.speech_stopped", item_id: "long-speech", audio_end_ms: 129_000 });
      await vi.advanceTimersByTimeAsync(51_000);
      expect(t.controller.current()).toMatchObject({ status: "live" });
      await vi.advanceTimersByTimeAsync(IDLE_CHECK_MS);
      expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "idle" });
      expect(t.deps.send).not.toHaveBeenCalled();
    } finally { await t.controller.shutdown(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts Qwen speech between idle checks even before final ASR arrives", async () => {
    const t = await setupQwenMedia();
    t.settings.idleMinutes = 1;
    try {
      await vi.advanceTimersByTimeAsync(58_000);
      t.provider.receive({ type: "input_audio_buffer.speech_started", item_id: "brief", audio_start_ms: 58_000 });
      await vi.advanceTimersByTimeAsync(1000);
      t.provider.receive({ type: "input_audio_buffer.speech_stopped", item_id: "brief", audio_end_ms: 59_000 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(t.controller.current()).toMatchObject({ status: "live" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "idle" });
    } finally { await t.controller.shutdown(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not idle out while Qwen result audio is still draining", async () => {
    const t = await setupQwenMedia(owner, false);
    t.settings.idleMinutes = 1;
    expect(t.controller.bindMedia(t.callId, owner, t.media)).toBe(true);
    try {
      t.provider.receive({ type: "response.created", response: { id: "long-result" } });
      for (let chunk = 0; chunk < 175; chunk++) t.provider.receive({ type: "response.audio.delta", response_id: "long-result", delta: Buffer.alloc(19_200).toString("base64") });
      t.provider.receive({ type: "response.done", response: { id: "long-result", status: "completed" } });
      await vi.advanceTimersByTimeAsync(75_000);
      expect(t.controller.current()).toMatchObject({ status: "live" });
      expect(t.media.send.mock.calls.reduce((bytes, [frame]) => bytes + (Buffer.isBuffer(frame) ? frame.length : 0), 0)).toBe(3_360_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "idle" });
    } finally { await t.controller.shutdown(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["speech", "queued playback"])("revocation takes priority over Qwen %s at an idle check", async media => {
    const t = await setupQwenMedia();
    try {
      if (media === "speech") t.provider.receive({ type: "input_audio_buffer.speech_started", item_id: "long-speech" });
      else {
        t.provider.receive({ type: "response.created", response: { id: "readout" } });
        t.provider.receive({ type: "response.audio.delta", response_id: "readout", delta: Buffer.alloc(960).toString("base64") });
      }
      t.signedIn.mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(IDLE_CHECK_MS);
      expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "signed-out" });
      expect(t.provider.readyState).toBe(3);
      expect(t.media.close).toHaveBeenCalledOnce();
    } finally { await t.controller.shutdown(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not hang up while the bot works, but does while an approval waits", async () => {
    const t = setup();
    await t.start();
    t.setActivity("working");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.socket().sent.some((e) => e.type === "session.close")).toBe(false);
    t.setActivity("waiting");
    await vi.advanceTimersByTimeAsync(5 * 60_000 + IDLE_CHECK_MS);
    expect(t.socket().sent.some((e) => e.type === "session.close")).toBe(true);
  });

  it("ends the call when the thread is deleted", async () => {
    const t = setup();
    await t.start();
    t.emit({ type: "thread.deleted", threadId: "t1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().sent.at(-1)).toMatchObject({ type: "session.close" });
    await vi.advanceTimersByTimeAsync(CLOSE_TIMEOUT_MS + 1);
    expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "deleted" });
    expect(t.listeners.size).toBe(0);
  });

  it("shutdown closes the session and clears every timer", async () => {
    const t = setup();
    await t.start();
    await t.controller.shutdown();
    expect(t.socket().sent.at(-1)).toMatchObject({ type: "session.close" });
    expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "shutdown" });
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("a start cancelled while OpenAI creates the session", () => {
    function pendingSession() {
      let resolve!: (value: { sessionId: string; sdp: string }) => void;
      const createSession = vi.fn(() => new Promise<{ sessionId: string; sdp: string }>((done) => { resolve = done; }));
      return { createSession, answer: () => resolve({ sessionId: "sess_9", sdp: "answer-sdp" }) };
    }

    it("closes the session it created through the sideband", async () => {
      const pending = pendingSession();
      const t = setup({ createSession: pending.createSession });
      const starting = t.controller.start({ auth: owner, ...BOT, client: "ios", sdp: "offer-sdp" });
      const callId = t.controller.current()!.callId;
      await t.controller.end(callId);
      pending.answer();
      await expect(starting).rejects.toMatchObject({ status: 503 });
      const orphan = t.socket();
      expect(orphan.url).toBe("ws://fake/sess_9/attach");
      expect(orphan.key).toBe("sk-test");
      orphan.open();
      expect(orphan.sent).toEqual([expect.objectContaining({ type: "session.close" })]);
      expect(orphan.readyState).toBe(3);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("gives up on a sideband that never opens, leaving no timer behind", async () => {
      const pending = pendingSession();
      const t = setup({ createSession: pending.createSession });
      const starting = t.controller.start({ auth: owner, ...BOT, client: "desktop", sdp: "offer-sdp" });
      await t.controller.shutdown();
      pending.answer();
      await expect(starting).rejects.toMatchObject({ status: 503 });
      await vi.advanceTimersByTimeAsync(ATTACH_TIMEOUT_MS + 1);
      expect(t.socket().readyState).toBe(3);
      expect(t.socket().sent).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("frees the slot when setting up the call fails after the session exists", async () => {
    let fail = true;
    const t = setup({ activity: () => { if (fail) throw new Error("no such bot"); return "idle"; } });
    await expect(t.controller.start({ auth: owner, ...BOT, client: "desktop", sdp: "a" })).rejects.toThrow("no such bot");
    expect(t.controller.current()).toBeNull();
    expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "error" });
    const orphan = t.socket();
    expect(orphan.url).toBe("ws://fake/sess_1/attach");
    orphan.open();
    expect(orphan.sent).toEqual([expect.objectContaining({ type: "session.close" })]);
    expect(orphan.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
    fail = false;
    await expect(t.start()).resolves.toBeTruthy();
  });

  it("survives a failing relay step or broadcast and counts it, without crashing the harness", async () => {
    let failing = false;
    const boom = (what: string) => { if (failing) throw new Error(what); };
    const t = setup({
      speakable: () => { throw new Error("tts prep broke"); },
      activity: () => { boom("no such bot"); return "idle"; },
      broadcast: () => boom("sse down"),
    });
    await t.start();
    failing = true;
    t.message({ id: "u1", role: "user", kind: "text", text: "hi", sendId: "s1" });
    t.patch({ id: "b1", text: "Hello.", requestMessageId: "u1", turnTerminal: true });
    t.emit({ type: "bot", botId: "bot1" });
    await vi.advanceTimersByTimeAsync(IDLE_CHECK_MS + 1);
    expect(t.controller.current()?.status).toBe("live");
    t.socket().receive({ type: "session.closed", reason: "close_requested" });
    expect(t.controller.current()).toBeNull();
    expect(t.logs.at(-1)).toMatch(/errors=internal,internal,internal,broadcast$/);
  });

  describe("a call bound to the phone or sign-in that started it", () => {
    const fromPhone = (t: ReturnType<typeof setup>, device = "phone-1") =>
      t.controller.start({ auth: owner, device, ...BOT, client: "ios", sdp: "offer-sdp" });

    it("ends at once, and says why, when that phone is unpaired", async () => {
      const t = setup();
      await fromPhone(t);
      t.socket().open();
      const ending = t.controller.deviceRevoked("phone-1");
      expect(ending).toMatchObject({ status: "ending" });
      expect(t.socket().appends("commentary")).toEqual([expect.objectContaining({ content: LIVE_COPY.unpaired })]);
      expect(t.socket().sent.at(-1)).toMatchObject({ type: "session.close" });
      t.socket().receive({ type: "session.closed", reason: "close_requested" });
      expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "signed-out", error: LIVE_COPY.unpaired });
      expect(t.logs.at(-1)).toContain("end=signed-out");
    });

    it("ends a call that is still connecting to OpenAI", async () => {
      const t = setup();
      await fromPhone(t);
      t.controller.deviceRevoked("phone-1");
      expect(t.controller.current()).toBeNull();
      expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "signed-out" });
    });

    it("leaves a call from another phone, or from the computer, alone", async () => {
      const t = setup();
      await fromPhone(t, "phone-2");
      t.socket().open();
      expect(t.controller.deviceRevoked("phone-1")).toBeNull();
      expect(t.controller.current()?.status).toBe("live");
      await t.controller.shutdown();

      const desktop = setup();
      await desktop.start();
      expect(desktop.controller.deviceRevoked("phone-1")).toBeNull();
      expect(desktop.controller.current()?.status).toBe("live");
    });

    it("refuses a call from a phone that was already unpaired, before creating a session", async () => {
      const t = setup();
      t.controller.deviceRevoked("phone-1");
      await expect(fromPhone(t)).rejects.toBeInstanceOf(LiveCallSignedOutError);
      expect(t.deps.createSession).not.toHaveBeenCalled();
      await expect(fromPhone(t, "phone-2")).resolves.toBeTruthy();
    });

    it("ends at once when the sign-in that started it is revoked", async () => {
      const t = setup();
      const session = { id: "s1", tokenHash: "x".repeat(64), label: "Safari on Mac", scopes: ["admin" as const], createdAt: 0, lastSeenAt: 0, expiresAt: 0 };
      await t.controller.start({ auth: { kind: "session", session, via: "cookie", scopes: ["admin"] }, ...BOT, client: "desktop", sdp: "offer-sdp" });
      t.socket().open();
      expect(t.controller.sessionRevoked("s2")).toBeNull();
      expect(t.controller.sessionRevoked("s1")).toMatchObject({ status: "ending" });
      expect(t.socket().appends("commentary")).toEqual([expect.objectContaining({ content: LIVE_COPY.signedOut })]);
      t.socket().receive({ type: "session.closed", reason: "close_requested" });
      expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "signed-out", error: LIVE_COPY.signedOut });
    });
  });

  it("skips mirrored audio without parsing it and never logs speech", async () => {
    const t = setup();
    await t.start();
    t.socket().onmessage?.({ data: `{"type":"session.input_audio.append","audio":"${"A".repeat(50_000)}"}` });
    t.socket().receive({ type: "session.input_transcript.delta", delta: "my secret plan", start_ms: 1, end_ms: 2 });
    await t.controller.shutdown();
    expect(t.logs.join("\n")).not.toContain("secret");
  });
});

describe("Qwen delegation release", () => {
  it("keeps a real adapter's pending request through 600 greetings, releases after all chunks, and preserves interrupted readout", async () => {
    const provider = new FakeSocket("fixture", "fixture");
    let accept!: (value: { kind: "started"; messageId: string }) => void;
    let adapter!: Awaited<ReturnType<typeof createQwenLiveSession>>["socket"];
    const t = setup({
      send: vi.fn(() => new Promise<{ kind: "started"; messageId: string }>(resolve => { accept = resolve; })),
      createSession: async input => {
        const session = await createQwenLiveSession({ ...input, bot: { name: "Fixture" }, history: [], upstream: provider });
        adapter = session.socket;
        return session;
      },
    });
    t.settings.provider = "qwen";
    t.settings.endpoint = { provider: "qwen", apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash" };
    const { call } = await t.controller.start({ auth: owner, ...BOT, sdp: "", client: "web", transports: ["ws-pcm"] });
    provider.open(); provider.receive({ type: "session.updated" });
    expect(t.controller.bindMedia(call.callId, owner, { bufferedAmount: 0, send: vi.fn(), close: vi.fn() })).toBe(true);
    const released = vi.spyOn(adapter, "releaseDelegation");
    const input = (id: string, transcript: string, tool = false) => {
      provider.receive({ type: "input_audio_buffer.speech_started", item_id: id, audio_start_ms: 0 });
      provider.receive({ type: "input_audio_buffer.speech_stopped", item_id: id, audio_end_ms: 100 });
      provider.receive({ type: "input_audio_buffer.committed", item_id: id });
      provider.receive({ type: "response.created", response: { id: `response-${id}` } });
      provider.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript });
      if (tool) provider.receive({ type: "response.function_call_arguments.done", response_id: `response-${id}`, call_id: id, name: "delegate_to_bot", arguments: "{}" });
      provider.receive({ type: "response.done", response: { id: `response-${id}`, status: "completed" } });
    };
    input("task", "Perform the fixture request.", true);
    await vi.advanceTimersByTimeAsync(DELEGATION_SETTLE_MS);
    for (let index = 0; index < 600; index++) input(`greeting-${index}`, "Hello.");
    expect(t.deps.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: "Perform the fixture request." }));
    expect(released).not.toHaveBeenCalled();
    const result = ["first", "second", "third"].map(word => `${word} ${"x".repeat(400)}.`).join(" ");
    t.message({ id: "m1", role: "user", via: "call", callId: call.callId, text: "Perform the fixture request." });
    t.message({ id: "answer", requestMessageId: "m1", turnTerminal: true, text: result });
    await vi.advanceTimersByTimeAsync(0);
    expect(released).not.toHaveBeenCalled();
    accept({ kind: "started", messageId: "m1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toHaveBeenCalledExactlyOnceWith("task");
    const complete = (id: string) => {
      provider.receive({ type: "response.created", response: { id } });
      provider.receive({ type: "response.done", response: { id, status: "completed" } });
    };
    complete("ack");
    provider.receive({ type: "response.created", response: { id: "readout-1" } });
    provider.receive({ type: "input_audio_buffer.speech_started", item_id: "interrupt" });
    provider.receive({ type: "input_audio_buffer.speech_stopped", item_id: "interrupt", reason: "turn_invalid" });
    provider.receive({ type: "response.done", response: { id: "readout-1", status: "completed" } });
    complete("readout-2"); complete("readout-3"); complete("incomplete-notice");
    const outputs = provider.sent.map(event => event.item as { call_id?: string; output?: string } | undefined)
      .filter(item => item?.call_id === "task").map(item => JSON.parse(item!.output!));
    expect(outputs.map(output => output.status)).toEqual(["running", "completed", "completed", "completed", "incomplete"]);
    for (const output of outputs) expect(output).toMatchObject({ request_id: "m1", thread_id: "t1" });
    expect(outputs[4].result).toContain("not fully spoken");
    expect(t.controller.current()?.status).toBe("live");
    await t.controller.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });

  async function live(overrides: Partial<LiveCallDeps> = {}) {
    const t = setup(overrides);
    t.settings.provider = "qwen";
    t.settings.endpoint = { provider: "qwen", apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash" };
    const { call } = await t.controller.start({ auth: owner, ...BOT, sdp: "", client: "web", transports: ["ws-pcm"] });
    t.socket().open();
    const release = vi.fn((id: string) => { t.socket().sent.push({ type: "fixture.release", delegation_id: id }); });
    Object.assign(t.socket(), { releaseDelegation: release, bindMedia: () => true });
    t.controller.bindMedia(call.callId, owner, { bufferedAmount: 0, send: vi.fn(), close: vi.fn() });
    const delegate = async (id: string, text = "fixture request") => {
      t.socket().receive({ type: "session.delegation.created", delegation: { id, target: "client" }, request: { text, withoutEcho: text } });
      await vi.advanceTimersByTimeAsync(DELEGATION_SETTLE_MS);
    };
    return { ...t, release, delegate, callId: call.callId };
  }

  it("queues every completed chunk before releasing and sends later notifications without the old delegation", async () => {
    const t = await live();
    await t.delegate("d1");
    const text = ["first", "second", "third"].map(word => `${word} ${"x".repeat(400)}.`).join(" ");
    t.message({ id: "answer", requestMessageId: "m1", turnTerminal: true, text });
    await vi.advanceTimersByTimeAsync(0);
    const events = t.socket().sent.filter(event => event.type === "session.commentary.append" || event.type === "fixture.release");
    expect(events).toHaveLength(4);
    expect(events.slice(0, 3)).toEqual(["first", "second", "third"].map(word => expect.objectContaining({ content: expect.stringContaining(word), delegation_id: "d1", status: "completed" })));
    expect(events[3]).toMatchObject({ type: "fixture.release", delegation_id: "d1" });
    t.message({ id: "approval", kind: "options", card: { title: "Approval", subtitle: "Fixture operation", options: ["Allow", "Deny"], requestId: "card", tool: "Bash" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().appends("instructions").at(-1)?.delegation_id).toBeNull();
    await t.controller.shutdown();
  });

  it("holds a pending send and early result until the receipt, then releases exactly once", async () => {
    let accept!: (value: { kind: "started"; messageId: string }) => void;
    const t = await live({ send: vi.fn(() => new Promise<{ kind: "started"; messageId: string }>(resolve => { accept = resolve; })) });
    await t.delegate("d1");
    t.message({ id: "m1", role: "user", via: "call", callId: t.callId, text: "fixture request" });
    t.message({ id: "answer", requestMessageId: "m1", turnTerminal: true, text: "Early result." });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.release).not.toHaveBeenCalled();
    expect(t.socket().appends("commentary")).toHaveLength(0);
    accept({ kind: "started", messageId: "m1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().sent.filter(event => ["session.delegation.accepted", "session.commentary.append", "fixture.release"].includes(String(event.type)))).toMatchObject([
      { type: "session.delegation.accepted", delegation_id: "d1" },
      { type: "session.commentary.append", delegation_id: "d1", content: "Early result." },
      { type: "fixture.release", delegation_id: "d1" },
    ]);
    expect(t.release).toHaveBeenCalledOnce();
    await t.controller.shutdown();
  });

  it("waits for a pending steering receipt before settling the original result and both aliases", async () => {
    let accept!: (value: { kind: "steered"; messageId: string; requestMessageId: string }) => void;
    const t = await live({ send: vi.fn().mockResolvedValueOnce({ kind: "started", messageId: "m1" }).mockImplementationOnce(() => new Promise(resolve => { accept = resolve; })) });
    await t.delegate("d1"); await t.delegate("d2");
    t.message({ id: "answer", requestMessageId: "m1", turnTerminal: true, text: "Steered final result." });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.release).not.toHaveBeenCalled();
    expect(t.socket().appends("commentary")).toHaveLength(0);
    accept({ kind: "steered", messageId: "steer", requestMessageId: "m1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.release.mock.calls.map(([id]) => id).sort()).toEqual(["d1", "d2"]);
    expect(t.socket().appends("commentary")).toHaveLength(1);
    await t.controller.shutdown();
  });

  it.each([true, false])("gives a typed request's early result to the spoken request steered into it, once, with typed readout %s", async readTypedReplies => {
    let accept!: (value: { kind: "steered"; messageId: string; requestMessageId: string }) => void;
    const send = vi.fn(() => new Promise<{ kind: "steered"; messageId: string; requestMessageId: string }>(resolve => { accept = resolve; }));
    const t = await live({ personKey: () => "caller", send });
    t.settings.readTypedReplies = readTypedReplies;
    t.message({ id: "typed", role: "user", text: "Typed request", sender: { id: "caller", name: "Caller" }, sendId: "typed-send" });
    t.setActivity("working");
    await t.delegate("d1", "spoken addition");
    t.message({ id: "answer", requestMessageId: "typed", turnTerminal: true, text: "Typed result with the spoken addition." });
    t.setActivity("idle");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().appends("commentary")).toHaveLength(0);
    expect(t.release).not.toHaveBeenCalled();
    accept({ kind: "steered", messageId: "steer", requestMessageId: "typed" });
    await vi.advanceTimersByTimeAsync(0);
    t.patch({ id: "answer", requestMessageId: "typed", turnTerminal: true, text: "Typed result with the spoken addition." });
    t.setActivity("working"); t.setActivity("idle");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().appends("commentary")).toEqual([expect.objectContaining({ content: "Typed result with the spoken addition.", delegation_id: "d1", request_id: "typed", status: "completed" })]);
    expect(t.release).toHaveBeenCalledExactlyOnceWith("d1");
    expect(JSON.stringify(t.socket().sent)).not.toContain(LIVE_COPY.noAnswer);
    expect(send).toHaveBeenCalledOnce();
    await t.controller.shutdown();
  });

  it.each([true, false])("still treats an unrelated typed result that arrives during a pending send as typed, with readout %s", async readTypedReplies => {
    let accept!: (value: { kind: "started"; messageId: string }) => void;
    const t = await live({ personKey: () => "caller", send: vi.fn(() => new Promise<{ kind: "started"; messageId: string }>(resolve => { accept = resolve; })) });
    t.settings.readTypedReplies = readTypedReplies;
    t.message({ id: "typed", role: "user", text: "Typed request", sender: { id: "caller", name: "Caller" }, sendId: "typed-send" });
    await t.delegate("d1");
    t.message({ id: "typed-answer", requestMessageId: "typed", turnTerminal: true, text: "Typed answer." });
    await vi.advanceTimersByTimeAsync(0);
    accept({ kind: "started", messageId: "m1" });
    await vi.advanceTimersByTimeAsync(0);
    const typed = t.socket().appends("commentary").filter(event => event.request_id === "typed");
    if (readTypedReplies) expect(typed).toEqual([expect.objectContaining({ delegation_id: null, content: expect.stringContaining("Typed answer.") })]);
    else expect(typed).toEqual([]);
    expect(t.release).not.toHaveBeenCalled();
    t.message({ id: "answer", requestMessageId: "m1", turnTerminal: true, text: "Spoken result." });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().appends("commentary").filter(event => event.delegation_id === "d1")).toEqual([expect.objectContaining({ content: "Spoken result.", request_id: "m1" })]);
    expect(t.release).toHaveBeenCalledExactlyOnceWith("d1");
    await t.controller.shutdown();
  });

  it("drains early results only after both concurrent send receipts arrive", async () => {
    const accepts: Array<(value: { kind: "started"; messageId: string }) => void> = [];
    const t = await live({ send: vi.fn(() => new Promise<{ kind: "started"; messageId: string }>(resolve => { accepts.push(resolve); })) });
    await t.delegate("d1"); await t.delegate("d2");
    t.message({ id: "answer1", requestMessageId: "m1", turnTerminal: true, text: "First result." });
    await vi.advanceTimersByTimeAsync(0);
    accepts[0]({ kind: "started", messageId: "m1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().appends("commentary")).toHaveLength(0);
    expect(t.release).not.toHaveBeenCalled();
    accepts[1]({ kind: "started", messageId: "m2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().appends("commentary")).toMatchObject([{ content: "First result.", delegation_id: "d1" }]);
    expect(t.release).toHaveBeenCalledExactlyOnceWith("d1");
    t.message({ id: "answer2", requestMessageId: "m2", turnTerminal: true, text: "Second result." });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.release.mock.calls).toEqual([["d1"], ["d2"]]);
    await t.controller.shutdown();
  });

  it("waits for a pending send receipt before settling an idle turn without a result", async () => {
    let accept!: (value: { kind: "started"; messageId: string }) => void;
    const t = await live({ send: vi.fn(() => new Promise<{ kind: "started"; messageId: string }>(resolve => { accept = resolve; })) });
    await t.delegate("d1");
    t.setActivity("working"); await vi.advanceTimersByTimeAsync(0);
    t.setActivity("idle"); await vi.advanceTimersByTimeAsync(0);
    expect(t.release).not.toHaveBeenCalled();
    accept({ kind: "started", messageId: "m1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().appends("commentary")).toMatchObject([{ content: LIVE_COPY.noAnswer, delegation_id: "d1" }]);
    expect(t.release).toHaveBeenCalledExactlyOnceWith("d1");
    await t.controller.shutdown();
  });

  it.each(["approval", "question", "question-failed", "send-failed", "empty", "goodbye"])("releases %s paths without an accepted request", async path => {
    const t = await live(path === "send-failed" ? { send: vi.fn(async () => { throw new Error("fixture send failure"); }) }
      : path === "question-failed" ? { respond: vi.fn(async () => ({ ok: false as const, error: "fixture answer failure" })) } : {});
    if (path === "approval" || path.startsWith("question")) {
      t.message({ id: "card", kind: "options", card: { title: "Fixture", subtitle: "Which one?", options: path === "approval" ? ["Allow", "Deny"] : ["One", "Two"], requestId: "card", ...(path === "approval" ? { tool: "Bash" } : {}) } });
      await vi.advanceTimersByTimeAsync(0);
    }
    await t.delegate("d1", path === "empty" ? "" : path === "goodbye" ? "hang up" : "one");
    expect(t.release).toHaveBeenCalledExactlyOnceWith("d1");
    expect(t.socket().sent.some(event => event.type === "session.delegation.accepted")).toBe(false);
    expect(t.socket().sent.at(-1)).toMatchObject({ type: "fixture.release" });
    await t.controller.shutdown();
  });

  it.each(["empty-result", "idle"])("releases accepted requests ending with %s", async ending => {
    const t = await live();
    await t.delegate("d1");
    if (ending === "empty-result") t.message({ id: "answer", requestMessageId: "m1", turnTerminal: true, text: "" });
    else {
      t.setActivity("working");
      await vi.advanceTimersByTimeAsync(0);
      t.setActivity("idle");
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(t.release).toHaveBeenCalledExactlyOnceWith("d1");
    t.patch({ id: "answer", requestMessageId: "m1", turnTerminal: true, text: "Late duplicate." });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().appends("commentary").some(event => event.content === "Late duplicate.")).toBe(false);
    await t.controller.shutdown();
  });

  it("releases a canceled queue entry even while the bot stays idle", async () => {
    const t = await live({ send: vi.fn(async () => ({ kind: "queued" as const, queueId: "q1" })) });
    t.queue.add("q1");
    await t.delegate("d1");
    expect(t.release).not.toHaveBeenCalled();
    t.queue.delete("q1");
    t.setActivity("idle");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.release).toHaveBeenCalledExactlyOnceWith("d1");
    await t.controller.shutdown();
  });

  it("transfers queued ownership to every drained batch member and releases them after the combined answer", async () => {
    const t = await live({ send: vi.fn().mockResolvedValueOnce({ kind: "queued", queueId: "q1" }).mockResolvedValueOnce({ kind: "queued", queueId: "q2" }) });
    t.queue.add("q1"); t.queue.add("q2");
    await t.delegate("d1"); await t.delegate("d2");
    t.queue.clear();
    for (const [id, queueId] of [["m1", "q1"], ["m2", "q2"]]) t.message({ id, queueId, role: "user", via: "call", callId: t.callId, text: "fixture request" });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.release).not.toHaveBeenCalled();
    t.message({ id: "answer", requestMessageId: "m2", turnTerminal: true, text: "Combined result." });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.release.mock.calls).toEqual([["d1"], ["d2"]]);
    expect(t.socket().sent.slice(-3)).toMatchObject([{ type: "session.commentary.append" }, { type: "fixture.release" }, { type: "fixture.release" }]);
    await t.controller.shutdown();
  });

  it("settles a 201-member queue batch when its first request index has been evicted", async () => {
    let index = 0;
    const t = await live({ send: vi.fn(async () => ({ kind: "queued" as const, queueId: `q${index++}` })) });
    for (let member = 0; member < 201; member++) {
      t.queue.add(`q${member}`);
      await t.delegate(`d${member}`);
    }
    t.queue.clear();
    for (let member = 0; member < 201; member++) t.message({ id: `m${member}`, queueId: `q${member}`, role: "user", via: "call", callId: t.callId, text: "fixture request" });
    t.message({ id: "answer", requestMessageId: "m0", turnTerminal: true, text: "Combined result." });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.release).toHaveBeenCalledTimes(201);
    expect(new Set(t.release.mock.calls.map(([id]) => id))).toEqual(new Set(Array.from({ length: 201 }, (_, member) => `d${member}`)));
    expect(t.socket().appends("commentary")).toHaveLength(1);
    await t.controller.shutdown();
  });

  it("settles every queue batch member when the result uses a steering alias", async () => {
    const t = await live({ send: vi.fn().mockResolvedValueOnce({ kind: "queued", queueId: "q1" }).mockResolvedValueOnce({ kind: "queued", queueId: "q2" }).mockResolvedValueOnce({ kind: "steered", messageId: "steer", requestMessageId: "m2" }) });
    t.queue.add("q1"); t.queue.add("q2");
    await t.delegate("d1"); await t.delegate("d2");
    t.queue.clear();
    for (const [id, queueId] of [["m1", "q1"], ["m2", "q2"]]) t.message({ id, queueId, role: "user", via: "call", callId: t.callId, text: "fixture request" });
    await vi.advanceTimersByTimeAsync(0);
    await t.delegate("d3");
    t.message({ id: "answer", requestMessageId: "steer", turnTerminal: true, text: "Combined steered result." });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.release.mock.calls.map(([id]) => id).sort()).toEqual(["d1", "d2", "d3"]);
    expect(t.socket().appends("commentary")).toHaveLength(1);
    await t.controller.shutdown();
  });

  it("settles all steered request aliases together without releasing an unrelated pending request", async () => {
    const t = await live({ send: vi.fn().mockResolvedValueOnce({ kind: "started", messageId: "m1" }).mockResolvedValueOnce({ kind: "steered", messageId: "steer1", requestMessageId: "m1" }).mockResolvedValueOnce({ kind: "steered", messageId: "steer2", requestMessageId: "m1" }).mockResolvedValueOnce({ kind: "started", messageId: "m2" }) });
    for (const id of ["d1", "d2", "d3", "d4"]) await t.delegate(id);
    t.message({ id: "answer", requestMessageId: "m1", turnTerminal: true, text: "Steered result." });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.release.mock.calls.map(([id]) => id).sort()).toEqual(["d1", "d2", "d3"]);
    t.message({ id: "alias-answer", requestMessageId: "steer2", turnTerminal: true, text: "Duplicate alias result." });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().appends("commentary")).toHaveLength(1);
    t.message({ id: "other-answer", requestMessageId: "m2", turnTerminal: true, text: "Independent result." });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.release.mock.calls.at(-1)).toEqual(["d4"]);
    await t.controller.shutdown();
  });
});

describe("LiveCallController relay", () => {
  it("keeps Qwen typed readout and no-delegation approval announcements, while directing spoken approval to the chat card", async () => {
    const t = setup({ personKey: () => "caller" });
    t.settings.provider = "qwen";
    t.settings.endpoint = { provider: "qwen", apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash" };
    await t.controller.start({ auth: owner, ...BOT, sdp: "offer", client: "web", transports: ["ws-pcm"] }); t.socket().open();
    t.message({ id: "typed", role: "user", text: "Typed request", sender: { id: "caller", name: "Caller" }, sendId: "typed-send" });
    t.message({ id: "typed-answer", turnTerminal: true, requestMessageId: "typed", text: "Typed answer." });
    t.message({ id: "approval", kind: "options", card: { title: "Approval needed", subtitle: "delete build", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().appends("commentary")).toContainEqual(expect.objectContaining({ delegation_id: null, request_id: "typed", thread_id: "t1", content: expect.stringContaining("Typed answer.") }));
    expect(t.socket().appends("instructions")).toContainEqual(expect.objectContaining({ delegation_id: null, thread_id: "t1", content: expect.stringContaining("chat card") }));
    t.socket().receive({ type: "session.delegation.created", delegation: { id: "approval-signal", target: "client" }, request: { text: "yes", withoutEcho: "yes" } });
    await vi.advanceTimersByTimeAsync(DELEGATION_SETTLE_MS);
    expect(t.deps.respond).not.toHaveBeenCalled();
    expect(t.socket().appends("instructions").at(-1)?.content).toContain("chat card");
    await t.controller.shutdown();
  });
  it("pins Qwen steered results to the accepted original request rather than claiming an unrelated terminal", async () => {
    const t = setup({ send: vi.fn(async () => ({ kind: "steered" as const, messageId: "steer1", requestMessageId: "original-turn" })) });
    t.settings.provider = "qwen";
    t.settings.endpoint = { provider: "qwen", apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash" };
    await t.controller.start({ auth: owner, ...BOT, sdp: "offer", client: "web", transports: ["ws-pcm"] }); t.socket().open();
    t.socket().receive({ type: "session.delegation.created", delegation: { id: "c1", target: "client" }, request: { text: "steer", withoutEcho: "steer" } });
    await vi.advanceTimersByTimeAsync(DELEGATION_SETTLE_MS);
    t.message({ id: "wrong", turnTerminal: true, requestMessageId: "unrelated", text: "Foreign result." });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().appends("commentary")).toHaveLength(0);
    t.message({ id: "right", turnTerminal: true, requestMessageId: "original-turn", text: "Pinned result." });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().appends("commentary")).toContainEqual(expect.objectContaining({ content: "Pinned result.", delegation_id: "c1", request_id: "original-turn" }));
    await t.controller.shutdown();
  });
  it("keeps a Qwen terminal store result that arrives before its send receipt, but emits it only after the running ACK", async () => {
    let accept!: (value: { kind: "started"; messageId: string }) => void;
    const t = setup({ send: vi.fn(() => new Promise<{ kind: "started"; messageId: string }>((resolve) => { accept = resolve; })) });
    t.settings.provider = "qwen";
    t.settings.endpoint = { provider: "qwen", apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash" };
    await t.controller.start({ auth: owner, ...BOT, sdp: "offer", client: "web", transports: ["ws-pcm"] }); t.socket().open();
    t.socket().receive({ type: "session.delegation.created", delegation: { id: "c1", target: "client" }, request: { text: "request", withoutEcho: "request" } });
    await vi.advanceTimersByTimeAsync(DELEGATION_SETTLE_MS);
    t.message({ id: "early", turnTerminal: true, requestMessageId: "m1", text: "Early result." });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().appends("commentary")).toHaveLength(0);
    accept({ kind: "started", messageId: "m1" });
    await vi.advanceTimersByTimeAsync(0);
    const commands = t.socket().sent.filter((e) => ["session.delegation.accepted", "session.commentary.append"].includes(String(e.type)));
    expect(commands).toMatchObject([{ type: "session.delegation.accepted", request_id: "m1" }, { type: "session.commentary.append", request_id: "m1", content: "Early result." }]);
    await t.controller.shutdown();
  });
  it("accepts only correlated Qwen final ASR, ACKs after acceptance and associates each old result with its original request", async () => {
    let accept!: (value: { kind: "started"; messageId: string }) => void;
    const send = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; })).mockResolvedValueOnce({ kind: "started", messageId: "m2" });
    const t = setup({ send });
    t.settings.provider = "qwen";
    t.settings.endpoint = { provider: "qwen", apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash" };
    await t.controller.start({ auth: owner, ...BOT, sdp: "offer", client: "web", transports: ["ws-pcm"] });
    t.socket().open();
    t.socket().receive({ type: "session.input_transcript.delta", delta: "ambient must not become a request", start_ms: 0, end_ms: 1000 });
    t.socket().receive({ type: "session.delegation.created", delegation: { id: "c1", target: "client" }, offset_ms: 1000,
      request: { text: "first server-final request", withoutEcho: "first server-final request" } });
    await vi.advanceTimersByTimeAsync(DELEGATION_SETTLE_MS);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "first server-final request" }));
    expect(t.socket().sent.filter((e) => e.type === "session.delegation.accepted")).toHaveLength(0);
    expect(t.socket().appends("thinking")).toHaveLength(0);
    accept({ kind: "started", messageId: "m1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().sent).toContainEqual(expect.objectContaining({ type: "session.delegation.accepted", delegation_id: "c1", request_id: "m1", status: "running" }));
    t.socket().receive({ type: "session.delegation.created", delegation: { id: "c2", target: "client" }, request: { text: "second request", withoutEcho: "second request" } });
    await vi.advanceTimersByTimeAsync(DELEGATION_SETTLE_MS);
    t.message({ id: "answer-old", text: "Original result.", turnTerminal: true, requestMessageId: "m1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().appends("commentary")).toContainEqual(expect.objectContaining({ content: "Original result.", delegation_id: "c1", request_id: "m1", thread_id: "t1" }));
    await t.controller.shutdown();
  });
  async function live(overrides: Partial<LiveCallDeps> = {}) {
    const t = setup(overrides);
    await t.start();
    return t;
  }
  const hear = (t: ReturnType<typeof setup>, text: string, at: number, until = at + 100) =>
    t.socket().receive({ type: "session.input_transcript.delta", delta: text, start_ms: at, end_ms: until });
  const delegate = async (t: ReturnType<typeof setup>, id: string, offset: number) => {
    t.socket().receive({ type: "session.delegation.created", offset_ms: offset, delegation: { id, target: "client", type: "delegation" } });
    await vi.advanceTimersByTimeAsync(DELEGATION_SETTLE_MS + 1);
  };

  describe("when the sign-in that started the call ends", () => {
    const signedOut = (t: ReturnType<typeof setup>) => t.socket().appends("commentary").filter((e) => e.content === LIVE_COPY.signedOut);

    it("says so once and hangs up instead of retrying a request", async () => {
      const t = await live({ send: vi.fn(async () => { throw new LiveCallSignedOutError(); }) });
      hear(t, "what is on my calendar", 100);
      await delegate(t, "del_1", 400);
      expect(signedOut(t)).toEqual([expect.objectContaining({ delegation_id: "del_1" })]);
      expect(t.socket().appends("commentary").some((e) => String(e.content).includes("could not be sent"))).toBe(false);
      expect(t.socket().sent.at(-1)).toMatchObject({ type: "session.close" });
      hear(t, "and tomorrow", 2_000);
      await delegate(t, "del_2", 2_300);
      expect(signedOut(t)).toHaveLength(1);
      expect(t.socket().appends("commentary").some((e) => String(e.content).includes("could not be sent"))).toBe(false);
      expect(t.socket().sent.filter((e) => e.type === "session.close")).toHaveLength(1);
      t.socket().receive({ type: "session.closed", reason: "close_requested" });
      expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "signed-out", error: LIVE_COPY.signedOut });
      expect(t.logs.at(-1)).toContain("end=signed-out");
      expect(t.logs.at(-1)).toContain("errors=signed-out");
    });

    it("hangs up when a spoken decision is refused for the same reason", async () => {
      const t = await live({ respond: vi.fn(async () => { throw new LiveCallSignedOutError(); }) });
      t.message({ id: "c1", kind: "options", card: { title: "Approval needed", subtitle: "ls", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash" } });
      await vi.advanceTimersByTimeAsync(0);
      hear(t, "yes", 5_000);
      await delegate(t, "del_2", 5_100);
      expect(signedOut(t)).toEqual([expect.objectContaining({ delegation_id: "del_2" })]);
      expect(t.socket().appends("commentary").some((e) => String(e.content).includes("could not be saved"))).toBe(false);
      expect(t.socket().sent.at(-1)).toMatchObject({ type: "session.close" });
    });

    it("hangs up when a spoken answer to a question is refused for the same reason", async () => {
      const t = await live({ respond: vi.fn(async () => { throw new LiveCallSignedOutError(); }) });
      t.message({ id: "q1", kind: "options", card: { title: "A question", subtitle: "Which account?", options: [], requestId: "r7" } });
      await vi.advanceTimersByTimeAsync(0);
      hear(t, "savings", 5_000);
      await delegate(t, "del_2", 5_100);
      expect(signedOut(t)).toHaveLength(1);
      expect(t.socket().sent.at(-1)).toMatchObject({ type: "session.close" });
    });

    it("hangs up at the next idle check even while the person keeps talking", async () => {
      let signedIn = true;
      const t = await live({ signedIn: () => signedIn });
      hear(t, "hello", 100);
      await vi.advanceTimersByTimeAsync(IDLE_CHECK_MS);
      expect(t.socket().sent.some((e) => e.type === "session.close")).toBe(false);
      signedIn = false;
      hear(t, "still here", 20_000);
      await vi.advanceTimersByTimeAsync(IDLE_CHECK_MS);
      expect(signedOut(t)).toEqual([expect.objectContaining({ delegation_id: null })]);
      expect(t.socket().sent.at(-1)).toMatchObject({ type: "session.close" });
    });
  });

  describe("a spoken request to hang up", () => {
    const closes = (t: ReturnType<typeof setup>) => t.socket().sent.filter((e) => e.type === "session.close");

    it("says goodbye, then ends the call the way the End button does", async () => {
      const t = await live();
      hear(t, "okay, thanks, you can hang up now.", 100);
      await delegate(t, "del_1", 400);
      expect(t.deps.send).not.toHaveBeenCalled();
      expect(t.socket().appends("instructions").at(-1)).toMatchObject({ delegation_id: "del_1", content: LIVE_COPY.goodbye });
      expect(closes(t)).toHaveLength(0);
      hear(t, "wait", 1_000);
      await delegate(t, "del_2", 1_200);
      expect(t.deps.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(GOODBYE_MS);
      expect(closes(t)).toHaveLength(1);
      t.socket().receive({ type: "session.closed", reason: "close_requested" });
      expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "hung-up" });
      expect(t.controller.current()).toBeNull();
    });

    it("says nothing about a request that fails to send after the goodbye", async () => {
      let fail: (error: Error) => void = () => {};
      const t = await live({ send: vi.fn(() => new Promise<never>((_resolve, reject) => { fail = reject; })) });
      hear(t, "check my mail", 100);
      await delegate(t, "del_1", 400);
      hear(t, "hang up", 1_000);
      await delegate(t, "del_2", 1_200);
      fail(new Error("offline"));
      await vi.advanceTimersByTimeAsync(0);
      expect(t.socket().appends("commentary")).toHaveLength(0);
    });

    it("never says an answer is missing when the bot stops during the goodbye", async () => {
      const t = await live();
      hear(t, "check my mail", 100);
      await delegate(t, "del_1", 400);
      t.setActivity("working");
      await vi.advanceTimersByTimeAsync(0);
      hear(t, "hang up", 2_000);
      await delegate(t, "del_2", 2_200);
      t.setActivity("idle");
      await vi.advanceTimersByTimeAsync(0);
      expect(t.socket().appends("commentary").map((e) => e.content)).not.toContain(LIVE_COPY.noAnswer);
    });

    it("keeps the call for anything that is not a clear request to hang up", async () => {
      for (const text of ["don't hang up", "how do I end the call?", "hang up the poster in my room", "end the call with Sam on my calendar", "bye"]) {
        const t = await live();
        hear(t, text, 100);
        await delegate(t, "del_1", 400);
        expect(vi.mocked(t.deps.send).mock.calls.map(([input]) => input.text), text).toEqual([text]);
        await vi.advanceTimersByTimeAsync(GOODBYE_MS + CLOSE_TIMEOUT_MS);
        expect(closes(t), text).toHaveLength(0);
        expect(t.controller.current()?.status, text).toBe("live");
      }
    });

    it("never hangs up on the voice's own words heard back through a speaker", async () => {
      const t = await live();
      t.socket().receive({ type: "session.output_transcript.delta", delta: "Should I hang up?", start_ms: 1_000, end_ms: 2_000 });
      hear(t, "hang up", 1_200, 1_400);
      await delegate(t, "del_1", 1_500);
      await vi.advanceTimersByTimeAsync(GOODBYE_MS + CLOSE_TIMEOUT_MS);
      expect(closes(t)).toHaveLength(0);
      expect(t.socket().appends("instructions").some((e) => e.content === LIVE_COPY.goodbye)).toBe(false);
    });

    it("keeps the call when the words before \"hang up\" were heard over the voice", async () => {
      const t = await live();
      t.socket().receive({ type: "session.output_transcript.delta", delta: "Here is what I found.", start_ms: 1_000, end_ms: 2_000 });
      hear(t, "don't", 1_200, 1_400);
      hear(t, "hang up", 2_100, 2_300);
      await delegate(t, "del_1", 2_500);
      await vi.advanceTimersByTimeAsync(GOODBYE_MS + CLOSE_TIMEOUT_MS);
      expect(closes(t)).toHaveLength(0);
      expect(t.socket().appends("instructions").some((e) => e.content === LIVE_COPY.goodbye)).toBe(false);
    });

    it("speaks no more of the bot's answers once the goodbye starts", async () => {
      const t = await live();
      hear(t, "check my mail", 100);
      await delegate(t, "del_1", 300);
      hear(t, "okay, thanks, you can hang up now.", 1_000);
      await delegate(t, "del_2", 1_200);
      t.patch({ id: "b1", text: "You have two new emails.", requestMessageId: "m1", turnTerminal: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(t.socket().appends("instructions").at(-1)).toMatchObject({ content: LIVE_COPY.goodbye });
      expect(t.socket().appends("commentary")).toHaveLength(0);
    });

    it("keeps the real end reason when the call drops during the goodbye", async () => {
      const t = await live();
      hear(t, "hang up", 100);
      await delegate(t, "del_1", 400);
      t.socket().drop();
      expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "sideband-lost" });
      await vi.advanceTimersByTimeAsync(GOODBYE_MS);
      expect(closes(t)).toHaveLength(0);
    });
  });

  it("sends the words since the last request to the bot, as the call's starter", async () => {
    const t = await live();
    const callId = t.controller.current()!.callId;
    hear(t, "what is on ", 100);
    hear(t, "my calendar", 200);
    await delegate(t, "del_1", 400);
    expect(t.deps.send).toHaveBeenCalledWith({ auth: owner, botId: "bot1", threadId: "t1", text: "what is on my calendar", callId });
    expect(t.socket().appends("thinking").at(-1)).toMatchObject({ delegation_id: "del_1", content: expect.stringContaining("You are working on the request") });
  });

  it("tags every spoken request with the call's id, however the harness took it", async () => {
    const t = await live();
    const callId = t.controller.current()!.callId;
    vi.mocked(t.deps.send)
      .mockResolvedValueOnce({ kind: "started", messageId: "m1" })
      .mockResolvedValueOnce({ kind: "steered", messageId: "m2" })
      .mockResolvedValueOnce({ kind: "queued", queueId: "q1" });
    hear(t, "check the build", 100);
    await delegate(t, "del_1", 300);
    hear(t, "and the tests", 2_000);
    await delegate(t, "del_2", 2_300);
    hear(t, "then deploy", 4_000);
    await delegate(t, "del_3", 4_300);
    expect(vi.mocked(t.deps.send).mock.calls.map(([input]) => [input.text, input.callId])).toEqual([
      ["check the build", callId],
      ["and the tests", callId],
      ["then deploy", callId],
    ]);
  });

  it("gives the next call an id of its own", async () => {
    const t = await live();
    const first = t.controller.current()!.callId;
    t.socket().drop();
    await t.start();
    const second = t.controller.current()!.callId;
    expect(second).not.toBe(first);
    hear(t, "hello again", 100);
    await delegate(t, "del_1", 300);
    expect(vi.mocked(t.deps.send).mock.calls.at(-1)![0].callId).toBe(second);
  });

  it("asks to repeat when nothing was heard", async () => {
    const t = await live();
    await delegate(t, "del_1", 400);
    expect(t.deps.send).not.toHaveBeenCalled();
    expect(t.socket().appends("instructions").at(-1)).toMatchObject({ delegation_id: "del_1", content: expect.stringContaining("not heard clearly") });
  });

  it("ignores delegations aimed at OpenAI's own tools", async () => {
    const t = await live();
    hear(t, "hello", 100);
    t.socket().receive({ type: "session.delegation.created", offset_ms: 300, delegation: { id: "d", target: "responses" } });
    await vi.advanceTimersByTimeAsync(DELEGATION_SETTLE_MS + 1);
    expect(t.deps.send).not.toHaveBeenCalled();
  });

  it("speaks only the turn's final answer, in the delegation it answers", async () => {
    const t = await live();
    hear(t, "check my mail", 100);
    await delegate(t, "del_1", 300);
    t.message({ id: "b1", text: "Let me look.", requestMessageId: "m1" });
    t.message({ id: "a1", kind: "activity", tool: { name: "gmail", spoken: "Reading your inbox" } });
    t.message({ id: "b2", text: "You have two new emails. One is from Sam.", requestMessageId: "m1" });
    t.patch({ id: "b2", text: "You have two new emails. One is from Sam.", requestMessageId: "m1", turnTerminal: true });
    t.patch({ id: "b2", text: "You have two new emails. One is from Sam.", requestMessageId: "m1", turnTerminal: true, turnSucceeded: true });
    await vi.advanceTimersByTimeAsync(0);
    const commentary = t.socket().appends("commentary");
    expect(commentary).toHaveLength(1);
    expect(commentary[0]).toMatchObject({ delegation_id: "del_1", content: "You have two new emails. One is from Sam." });
    expect(t.socket().appends("thinking").some((e) => String(e.content).includes("Reading your inbox"))).toBe(true);
    expect(JSON.stringify(t.socket().sent)).not.toContain("Let me look.");
  });

  it("rate-limits progress to one every 4 s", async () => {
    const t = await live();
    t.message({ id: "a1", kind: "activity", tool: { name: "x", spoken: "Step one" } });
    t.message({ id: "a2", kind: "activity", tool: { name: "x", spoken: "Step two" } });
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS + 1);
    t.message({ id: "a3", kind: "activity", tool: { name: "x", spoken: "Step three" } });
    await vi.advanceTimersByTimeAsync(0);
    const progress = t.socket().appends("thinking").map((e) => String(e.content));
    expect(progress.filter((c) => c.startsWith("Progress:"))).toEqual(["Progress: Step one", "Progress: Step three"]);
  });

  it("says the result is in the chat when the turn ends without text", async () => {
    const t = await live();
    hear(t, "do it", 100);
    await delegate(t, "del_1", 300);
    // store listeners run in a microtask: flush between the two changes
    t.setActivity("working");
    await vi.advanceTimersByTimeAsync(0);
    t.setActivity("idle");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().appends("commentary").at(-1)).toMatchObject({ content: "I'm done. The result, or what went wrong, is in the chat." });
  });

  describe("a spoken request that waits in the queue", () => {
    const noAnswer = (t: ReturnType<typeof setup>) => t.socket().appends("commentary").filter((e) => e.content === LIVE_COPY.noAnswer);
    const queueNext = (t: ReturnType<typeof setup>, queueId: string) =>
      vi.mocked(t.deps.send).mockImplementationOnce(async () => {
        t.queue.add(queueId);
        return { kind: "queued", queueId };
      });

    it("is answered once it is delivered, with no missing-answer line", async () => {
      const t = await live();
      t.setActivity("working");
      queueNext(t, "q1");
      hear(t, "and then the weather", 100);
      await delegate(t, "del_1", 300);
      t.setActivity("idle");
      await vi.advanceTimersByTimeAsync(0);
      expect(t.socket().appends("commentary")).toHaveLength(0);
      t.queue.delete("q1");
      t.message({ id: "m9", role: "user", kind: "text", text: "and then the weather", via: "call", queueId: "q1" });
      t.setActivity("working");
      t.patch({ id: "b9", text: "Sunny.", requestMessageId: "m9", turnTerminal: true });
      await vi.advanceTimersByTimeAsync(0);
      t.setActivity("idle");
      await vi.advanceTimersByTimeAsync(0);
      expect(t.socket().appends("commentary")).toEqual([expect.objectContaining({ delegation_id: "del_1", content: "Sunny." })]);
    });

    it("still holds the missing-answer line back while it waits", async () => {
      const t = await live();
      hear(t, "do it", 100);
      await delegate(t, "del_1", 300);
      t.setActivity("working");
      await vi.advanceTimersByTimeAsync(0);
      queueNext(t, "q1");
      hear(t, "and then the weather", 2_000);
      await delegate(t, "del_2", 2_200);
      t.setActivity("idle");
      await vi.advanceTimersByTimeAsync(0);
      expect(noAnswer(t)).toHaveLength(0);
      expect(t.deps.queued).toHaveBeenCalledWith("bot1", "t1", "q1");
    });

    it("answers a drained batch of spoken lines once, without saying the result is in the chat", async () => {
      const t = await live();
      t.setActivity("working");
      await vi.advanceTimersByTimeAsync(0);
      queueNext(t, "q1");
      hear(t, "what is the weather", 100);
      await delegate(t, "del_1", 300);
      queueNext(t, "q2");
      hear(t, "and tomorrow", 2_000);
      await delegate(t, "del_2", 2_200);
      t.queue.clear();
      t.message({ id: "m1", role: "user", kind: "text", text: "what is the weather", via: "call", queueId: "q1" });
      t.message({ id: "m2", role: "user", kind: "text", text: "and tomorrow", via: "call", queueId: "q2" });
      t.patch({ id: "b1", text: "Sunny today and tomorrow.", requestMessageId: "m2", turnTerminal: true });
      await vi.advanceTimersByTimeAsync(0);
      t.setActivity("idle");
      await vi.advanceTimersByTimeAsync(0);
      expect(t.socket().appends("commentary")).toEqual([expect.objectContaining({ delegation_id: "del_2", content: "Sunny today and tomorrow." })]);
    });

    it("answers aloud a drained batch that holds a spoken line, even when a typed line came last", async () => {
      const t = await live();
      t.settings.readTypedReplies = false;
      t.setActivity("working");
      await vi.advanceTimersByTimeAsync(0);
      queueNext(t, "q1");
      hear(t, "what is the weather", 100);
      await delegate(t, "del_1", 300);
      t.queue.clear();
      t.message({ id: "m1", role: "user", kind: "text", text: "what is the weather", via: "call", queueId: "q1" });
      t.message({ id: "m2", role: "user", kind: "text", text: "in Utrecht", sendId: "s2", queueId: "q2" });
      t.patch({ id: "b1", text: "Sunny in Utrecht.", requestMessageId: "m2", turnTerminal: true });
      await vi.advanceTimersByTimeAsync(0);
      t.setActivity("idle");
      await vi.advanceTimersByTimeAsync(0);
      expect(t.socket().appends("commentary")).toEqual([expect.objectContaining({ delegation_id: "del_1", content: "Sunny in Utrecht." })]);
    });

    it("holds nothing back once it left the queue without being delivered", async () => {
      const t = await live();
      t.setActivity("working");
      queueNext(t, "q1");
      hear(t, "and then the weather", 100);
      await delegate(t, "del_1", 300);
      t.queue.delete("q1");
      t.setActivity("idle");
      await vi.advanceTimersByTimeAsync(0);
      hear(t, "do it", 2_000);
      await delegate(t, "del_2", 2_200);
      t.setActivity("working");
      await vi.advanceTimersByTimeAsync(0);
      t.setActivity("idle");
      await vi.advanceTimersByTimeAsync(0);
      expect(noAnswer(t)).toEqual([expect.objectContaining({ delegation_id: "del_2" })]);
    });
  });

  describe("status notes while the bot works", () => {
    const notes = (t: ReturnType<typeof setup>) =>
      t.socket().appends("thinking").filter((e) => String(e.content).startsWith("Status note"));

    it("tells the voice every 30 s how long the bot has worked and what its last step was", async () => {
      const t = await live();
      t.setActivity("working");
      await vi.advanceTimersByTimeAsync(0);
      t.message({ id: "a1", kind: "activity", tool: { name: "mcp__team-notes__describe_database", summary: "Admin/Instruction" } });
      t.message({ id: "a2", kind: "activity", tool: { name: "mcp__team-notes__query_database", summary: "SELECT secrets FROM /Users/someone" } });
      await vi.advanceTimersByTimeAsync(29_000);
      expect(notes(t)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(notes(t)).toHaveLength(1);
      const note = String(notes(t)[0].content);
      expect(note).toContain("you are still working on it");
      expect(note).toContain("2 steps");
      expect(note).toContain("team notes: query database");
      expect(note).not.toMatch(/secrets|\/Users/);
      expect(notes(t)[0].delegation_id).toBeNull();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(notes(t)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(notes(t)).toHaveLength(2);
      expect(String(notes(t)[1].content)).toContain("1 minute");
    });

    it("stops when the bot is done, and sends none while it waits for an answer", async () => {
      const t = await live();
      t.setActivity("working");
      await vi.advanceTimersByTimeAsync(31_000);
      expect(notes(t)).toHaveLength(1);
      t.setActivity("idle");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(notes(t)).toHaveLength(1);
      t.setActivity("waiting");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(notes(t)).toHaveLength(1);
    });

    it("counts a new piece of work from zero", async () => {
      const t = await live();
      t.setActivity("working");
      await vi.advanceTimersByTimeAsync(0);
      t.message({ id: "a1", kind: "activity", tool: { name: "Bash" } });
      await vi.advanceTimersByTimeAsync(31_000);
      t.setActivity("idle");
      await vi.advanceTimersByTimeAsync(0);
      t.setActivity("working");
      // notes ride on the 15 s idle tick: the next one lands 30–45 s after the work began
      await vi.advanceTimersByTimeAsync(46_000);
      const last = String(notes(t).at(-1)?.content);
      expect(last).toContain("0 steps");
      expect(last).not.toContain("run a command");
    });
  });

  it("says nothing when a message is typed, then reads the bot's answer once, with what was typed", async () => {
    const t = await live();
    const before = t.socket().sent.length;
    t.message({ id: "u1", role: "user", kind: "text", text: "kun je mij verstaan", sendId: "s1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().sent.length).toBe(before);
    t.patch({ id: "b1", text: "Ja, ik kan je verstaan.", requestMessageId: "u1", turnTerminal: true });
    await vi.advanceTimersByTimeAsync(0);
    const commentary = t.socket().appends("commentary");
    expect(commentary).toHaveLength(1);
    expect(commentary[0]).toMatchObject({ delegation_id: null, content: expect.stringContaining("kun je mij verstaan") });
    expect(commentary[0].content).toContain("Ja, ik kan je verstaan.");
    expect(t.socket().appends("thinking")).toHaveLength(0);
  });

  it("sends OpenAI nothing about a typed exchange when reading typed replies is off", async () => {
    const t = await live();
    t.settings.readTypedReplies = false;
    const before = t.socket().sent.length;
    t.message({ id: "u1", role: "user", kind: "text", text: "also book a table", sendId: "s1" });
    t.setActivity("working");
    await vi.advanceTimersByTimeAsync(0);
    t.message({ id: "a1", kind: "activity", tool: { name: "mcp__resy__book", spoken: "Booking at Luigi's" } });
    await vi.advanceTimersByTimeAsync(31_000 + IDLE_CHECK_MS);
    t.patch({ id: "b1", text: "Booked for eight.", requestMessageId: "u1", turnTerminal: true });
    t.setActivity("idle");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().sent.slice(before)).toEqual([]);
  });

  it("keeps telling the voice about work on a spoken request when typed replies are off", async () => {
    const t = await live();
    t.settings.readTypedReplies = false;
    hear(t, "check my mail", 100);
    await delegate(t, "del_1", 300);
    t.setActivity("working");
    await vi.advanceTimersByTimeAsync(0);
    t.message({ id: "a1", kind: "activity", tool: { name: "gmail", spoken: "Reading your inbox" } });
    await vi.advanceTimersByTimeAsync(31_000 + IDLE_CHECK_MS);
    const thinking = t.socket().appends("thinking").map((e) => String(e.content));
    expect(thinking).toContain("Progress: Reading your inbox");
    expect(thinking.some((c) => c.startsWith("Status note"))).toBe(true);
  });

  it("never relays a peer bot's line, or the answer to it, as something the person typed", async () => {
    const t = await live();
    const before = t.socket().sent.length;
    t.message({ id: "p1", role: "user", kind: "text", text: "[aside from Bo] the invoice is paid", aside: true, peerAsk: { botId: "bo", name: "Bo" } });
    t.message({ id: "p2", role: "user", kind: "text", text: "Bo asks: is the report ready?", peerAsk: { botId: "bo", name: "Bo" } });
    await vi.advanceTimersByTimeAsync(0);
    t.patch({ id: "b1", text: "Noted, thanks.", requestMessageId: "p1", turnTerminal: true });
    t.patch({ id: "b2", text: "Yes, it is in the shared folder.", requestMessageId: "p2", turnTerminal: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().sent.length).toBe(before);
    t.settings.readTypedReplies = false;
    t.message({ id: "p3", role: "user", kind: "text", text: "Bo asks: and the invoice?", peerAsk: { botId: "bo", name: "Bo" } });
    await vi.advanceTimersByTimeAsync(0);
    t.patch({ id: "b3", text: "Paid yesterday.", requestMessageId: "p3", turnTerminal: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().sent.length).toBe(before);
  });

  it("relays only a line the caller typed in a client", async () => {
    const t = await live();
    const before = t.socket().sent.length;
    const lines: Array<Partial<Message>> = [
      { sendId: "s1", sender: { name: "sam@example.test", id: "p_sam" } },
      {},
      { sendId: "s3", via: "api" },
    ];
    lines.forEach((line, index) => t.message({ id: `u${index}`, role: "user", kind: "text", text: `line ${index}`, ...line }));
    await vi.advanceTimersByTimeAsync(0);
    lines.forEach((_, index) => t.patch({ id: `b${index}`, text: `Answer ${index}.`, requestMessageId: `u${index}`, turnTerminal: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().sent.slice(before)).toEqual([]);

    t.message({ id: "u9", role: "user", kind: "text", text: "and mine", sendId: "s9" });
    await vi.advanceTimersByTimeAsync(0);
    t.patch({ id: "b9", text: "Done.", requestMessageId: "u9", turnTerminal: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().appends("commentary")).toEqual([expect.objectContaining({ content: expect.stringContaining("and mine") })]);
  });

  it("never reads a line a worker relayed into the call's chat back as the caller's own", async () => {
    const t = await live();
    const before = t.socket().sent.length;
    t.message({ id: "r1", role: "user", kind: "text", text: "Ada asks: is the report ready?", sendId: "slackjob_report_1", relayed: true });
    await vi.advanceTimersByTimeAsync(0);
    t.patch({ id: "b1", text: "Yes, it is in the shared folder.", requestMessageId: "r1", turnTerminal: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.socket().sent.slice(before)).toEqual([]);
  });

  it("knows a signed-in caller's own lines by who sent them", async () => {
    const t = setup({ personKey: (auth) => (auth.kind === "session" ? "p_me" : undefined) });
    const session = { id: "s1", tokenHash: "x".repeat(64), label: "Safari", scopes: ["admin" as const], createdAt: 0, lastSeenAt: 0, expiresAt: 0 };
    await t.controller.start({ auth: { kind: "session", session, via: "cookie", scopes: ["admin"] }, ...BOT, client: "desktop", sdp: "offer-sdp" });
    t.socket().open();
    t.message({ id: "u1", role: "user", kind: "text", text: "from the owner's desk", sendId: "s1" });
    t.message({ id: "u2", role: "user", kind: "text", text: "from me", sendId: "s2", sender: { name: "me@example.test", id: "p_me" } });
    await vi.advanceTimersByTimeAsync(0);
    t.patch({ id: "b1", text: "One.", requestMessageId: "u1", turnTerminal: true });
    t.patch({ id: "b2", text: "Two.", requestMessageId: "u2", turnTerminal: true });
    await vi.advanceTimersByTimeAsync(0);
    const said = t.socket().appends("commentary").map((e) => String(e.content));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("from me");
  });

  it("keeps a typed message's idle clock running like speech", async () => {
    const t = await live();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    t.message({ id: "u1", role: "user", kind: "text", text: "still there?" });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(t.socket().sent.some((e) => e.type === "session.close")).toBe(false);
  });

  describe("approvals", () => {
    const approval = (extra: Partial<Message["card"]> = {}) => ({
      id: "c1", kind: "options" as const,
      card: { title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash", ...extra },
    });

    it("reads the request and decides on a clear spoken yes", async () => {
      const t = await live();
      t.message(approval());
      await vi.advanceTimersByTimeAsync(0);
      expect(t.socket().appends("instructions").at(-1)).toMatchObject({ content: expect.stringContaining("I want to run a command. rm -rf build. May I?") });
      hear(t, "yes go ahead", 5_000);
      await delegate(t, "del_2", 5_200);
      expect(t.deps.respond).toHaveBeenCalledWith({ auth: owner, threadId: "t1", requestId: "r1", behavior: "allow", message: undefined });
      expect(t.deps.send).not.toHaveBeenCalled();
      expect(t.socket().appends("commentary").at(-1)).toMatchObject({ content: "Thanks, I'll go ahead." });
    });

    it("denies with the call's reason", async () => {
      const t = await live();
      t.message(approval());
      await vi.advanceTimersByTimeAsync(0);
      hear(t, "no", 5_000);
      await delegate(t, "del_2", 5_100);
      expect(t.deps.respond).toHaveBeenCalledWith(expect.objectContaining({ behavior: "deny", message: "Denied by the user, on a live call." }));
    });

    it("asks again when the answer is not a clear yes or no", async () => {
      const t = await live();
      t.message(approval());
      await vi.advanceTimersByTimeAsync(0);
      hear(t, "hmm what does that do", 5_000);
      await delegate(t, "del_2", 5_200);
      expect(t.deps.respond).not.toHaveBeenCalled();
      expect(t.socket().appends("instructions").at(-1)).toMatchObject({ content: expect.stringContaining("not a clear yes or no") });
    });

    it.each(["yes, but do not delete it", "yes — wait, no", "yes, what does that delete?"])("never grants an ambiguous spoken decision: %s", async (said) => {
      const t = await live();
      t.message(approval());
      await vi.advanceTimersByTimeAsync(0);
      hear(t, said, 5_000);
      await vi.advanceTimersByTimeAsync(CONSENT_SETTLE_MS + 1);
      await delegate(t, "del_ambiguous", 5_200);
      expect(t.deps.respond).not.toHaveBeenCalled();
      expect(t.socket().appends("instructions").at(-1)).toMatchObject({ content: LIVE_COPY.notClear });
    });

    it("says nothing about a failed save once the person asked to hang up", async () => {
      let finish: (result: { ok: false; error: string }) => void = () => {};
      const t = await live({ respond: vi.fn(() => new Promise<{ ok: false; error: string }>((resolve) => { finish = resolve; })) });
      t.message(approval());
      await vi.advanceTimersByTimeAsync(0);
      hear(t, "yes go ahead", 5_000);
      await delegate(t, "del_2", 5_200);
      expect(t.deps.respond).toHaveBeenCalled();
      hear(t, "hang up", 6_000);
      await delegate(t, "del_3", 6_200);
      finish({ ok: false, error: "disk full" });
      await vi.advanceTimersByTimeAsync(0);
      expect(t.socket().appends("commentary").map((e) => e.content)).not.toContain(LIVE_COPY.saveFailed("disk full"));
    });

    it("grants nothing heard after the person asked to hang up", async () => {
      const t = await live();
      t.message(approval());
      await vi.advanceTimersByTimeAsync(0);
      hear(t, "hang up", 5_000);
      await delegate(t, "del_2", 5_200);
      hear(t, "yes", 5_400);
      await vi.advanceTimersByTimeAsync(CONSENT_SETTLE_MS + 1);
      expect(t.deps.respond).not.toHaveBeenCalled();
    });

    it("accepts a yes heard in a quiet moment, without a delegation", async () => {
      const t = await live();
      t.message(approval());
      await vi.advanceTimersByTimeAsync(0);
      hear(t, "yes", 5_000);
      await vi.advanceTimersByTimeAsync(CONSENT_SETTLE_MS + 1);
      expect(t.deps.respond).toHaveBeenCalledWith(expect.objectContaining({ behavior: "allow" }));
    });

    // The voice's own opener comes back through a phone's speaker as input, and "okay…" is a hedge, not a yes.
    describe("on the open microphone of a Live call", () => {
      const speak = (t: ReturnType<typeof setup>, text: string, at: number, until: number) =>
        t.socket().receive({ type: "session.output_transcript.delta", delta: text, start_ms: at, end_ms: until });

      it("never takes a hedging okay heard in a quiet moment as a yes", async () => {
        const t = await live();
        t.message(approval());
        await vi.advanceTimersByTimeAsync(0);
        hear(t, "okay", 5_000);
        await vi.advanceTimersByTimeAsync(CONSENT_SETTLE_MS + 1);
        hear(t, " wait, what does it delete", 7_000);
        await vi.advanceTimersByTimeAsync(CONSENT_SETTLE_MS + 1);
        expect(t.deps.respond).not.toHaveBeenCalled();
      });

      it("asks again when a delegated answer is only a hedge", async () => {
        const t = await live();
        t.message(approval());
        await vi.advanceTimersByTimeAsync(0);
        hear(t, "okay", 5_000);
        await delegate(t, "del_2", 5_100);
        expect(t.deps.respond).not.toHaveBeenCalled();
        expect(t.socket().appends("instructions").at(-1)).toMatchObject({ delegation_id: "del_2", content: LIVE_COPY.notClear });
      });

      it("does not take the voice's own words, heard back, for the person's answer", async () => {
        const t = await live();
        t.message(approval());
        await vi.advanceTimersByTimeAsync(0);
        speak(t, "Okay, I need your permission to run a command. May I?", 4_000, 6_000);
        hear(t, "Okay I need your permission to run a command", 4_100, 5_900);
        await vi.advanceTimersByTimeAsync(CONSENT_SETTLE_MS + 1);
        expect(t.deps.respond).not.toHaveBeenCalled();
        hear(t, "no", 7_000);
        await delegate(t, "del_2", 7_200);
        expect(t.deps.respond).toHaveBeenCalledWith(expect.objectContaining({ behavior: "deny" }));
      });

      it("asks for a clear answer when all it heard was the voice itself", async () => {
        const t = await live();
        t.message(approval());
        await vi.advanceTimersByTimeAsync(0);
        speak(t, "May I run it?", 4_000, 5_000);
        hear(t, "may I run it", 4_100, 4_900);
        await delegate(t, "del_2", 5_000);
        expect(t.deps.respond).not.toHaveBeenCalled();
        expect(t.socket().appends("instructions").at(-1)).toMatchObject({ delegation_id: "del_2", content: LIVE_COPY.notClear });
      });

      it("still takes a clear yes after a hedge", async () => {
        const t = await live();
        t.message(approval());
        await vi.advanceTimersByTimeAsync(0);
        hear(t, "okay, yes", 5_000);
        await vi.advanceTimersByTimeAsync(CONSENT_SETTLE_MS + 1);
        expect(t.deps.respond).toHaveBeenCalledWith(expect.objectContaining({ behavior: "allow" }));
      });
    });

    it("does not ask to repeat a yes the quiet window already decided when its delegation arrives late", async () => {
      const t = await live();
      t.message(approval());
      await vi.advanceTimersByTimeAsync(0);
      hear(t, "yes", 5_000);
      await vi.advanceTimersByTimeAsync(CONSENT_SETTLE_MS + 1);
      expect(t.deps.respond).toHaveBeenCalledTimes(1);
      t.patch({ ...approval({ answered: "allow" }) });
      await delegate(t, "del_2", 5_300);
      expect(t.socket().appends("instructions").some((e) => String(e.content).includes("not heard clearly"))).toBe(false);
      expect(t.socket().appends("thinking").at(-1)).toMatchObject({ delegation_id: "del_2", content: "Thanks, I'll go ahead." });
      expect(t.deps.send).not.toHaveBeenCalled();
      await delegate(t, "del_3", 20_000);
      expect(t.socket().appends("instructions").at(-1)).toMatchObject({ delegation_id: "del_3", content: expect.stringContaining("not heard clearly") });
    });

    it("lets the user try again when saving the decision fails", async () => {
      const t = await live({ respond: vi.fn().mockResolvedValueOnce({ ok: false, error: "The bot is not running." }).mockResolvedValue({ ok: true }) });
      t.message(approval());
      await vi.advanceTimersByTimeAsync(0);
      hear(t, "yes", 5_000);
      await delegate(t, "del_2", 5_100);
      expect(t.socket().appends("commentary").at(-1)).toMatchObject({ content: expect.stringContaining("could not be saved") });
      hear(t, "yes", 9_000);
      await delegate(t, "del_3", 9_100);
      expect(t.deps.respond).toHaveBeenCalledTimes(2);
    });

    it("lets the user try again when saving the decision throws", async () => {
      const t = await live({ respond: vi.fn().mockRejectedValueOnce(new Error("store offline")).mockResolvedValue({ ok: true }) });
      t.message(approval());
      await vi.advanceTimersByTimeAsync(0);
      hear(t, "yes", 5_000);
      await delegate(t, "del_2", 5_100);
      expect(t.socket().appends("commentary").at(-1)).toMatchObject({ content: "The decision could not be saved. Ask the user to try again." });
      hear(t, "yes", 9_000);
      await delegate(t, "del_3", 9_100);
      expect(t.deps.respond).toHaveBeenCalledTimes(2);
      expect(t.controller.current()?.status).toBe("live");
    });

    it("stays quiet when a tap on screen settled the card just before the spoken decision", async () => {
      let t!: ReturnType<typeof setup>;
      const respond = vi.fn(async () => {
        t.patch({ ...approval({ answered: "allow" }) });
        return { ok: false as const, error: "The request is no longer open." };
      });
      t = await live({ respond });
      t.message(approval());
      await vi.advanceTimersByTimeAsync(0);
      hear(t, "yes", 5_000);
      await delegate(t, "del_2", 5_100);
      expect(respond).toHaveBeenCalledTimes(1);
      const said = t.socket().appends("commentary").map((e) => String(e.content));
      expect(said).toEqual(["Thanks, I'll go ahead."]);
      expect(t.controller.current()?.status).toBe("live");
    });

    it("forgets an approval answered in the chat", async () => {
      const t = await live();
      t.message(approval());
      await vi.advanceTimersByTimeAsync(0);
      t.patch({ ...approval({ answered: "allow" }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(t.socket().appends("thinking").at(-1)).toMatchObject({ content: expect.stringContaining("answered that request in the chat") });
      hear(t, "yes and also check the logs", 8_000);
      await delegate(t, "del_2", 8_100);
      expect(t.deps.respond).not.toHaveBeenCalled();
      expect(t.deps.send).toHaveBeenCalledWith(expect.objectContaining({ text: "yes and also check the logs" }));
    });

    it("sends harness reviews to the screen and never decides them by voice", async () => {
      const t = await live();
      t.message(approval({ tool: "stage_skill", title: "Enable the invoice skill", skillRequest: { action: "create" } as never }));
      await vi.advanceTimersByTimeAsync(0);
      expect(t.socket().appends("instructions").at(-1)).toMatchObject({ content: expect.stringContaining("you need their decision in the chat") });
      hear(t, "yes", 5_000);
      await delegate(t, "del_2", 5_100);
      expect(t.deps.respond).not.toHaveBeenCalled();
    });

    it("points the person at the chat when the bot needs an app connected", async () => {
      const t = await live();
      const connector = { slug: "gmail", label: "Gmail", description: "Read mail", status: "required" as const, resumeKey: "k1" };
      t.message({ id: "k1", kind: "connector", connector });
      t.patch({ id: "k1", kind: "connector", connector: { ...connector, status: "authorizing" } });
      await vi.advanceTimersByTimeAsync(0);
      const said = t.socket().appends("instructions").map((e) => String(e.content));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("Gmail");
      expect(said[0]).toContain("in the chat");
      t.message({ id: "k2", kind: "connector", connector: { ...connector, label: "Slack", status: "connected" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(t.socket().appends("instructions")).toHaveLength(1);
    });

    it("points at the chat for a credential, and never asks for it aloud", async () => {
      const t = await live();
      const secret = { target: "openaiImageApiKey", label: "OpenAI image key", description: "", placeholder: "sk-", helpUrl: "", requestKey: "r1" } as never;
      t.message({ id: "k1", kind: "secret", secret });
      t.message({ id: "k2", kind: "secret", secret: { ...(secret as object), requestKey: "r2", superseded: true } as never });
      await vi.advanceTimersByTimeAsync(0);
      const said = t.socket().appends("instructions").map((e) => String(e.content));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("OpenAI image key");
      expect(said[0]).toMatch(/never ask .*aloud/i);
    });

    it("answers a bot question with the next request", async () => {
      const t = await live();
      t.message({ id: "q1", kind: "options", card: { title: "Your bot has a question", subtitle: "Which account?", options: ["Main", "Savings"], requestId: "r7" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(t.socket().appends("instructions").at(-1)).toMatchObject({ content: expect.stringContaining("Which account?") });
      hear(t, "savings", 5_000);
      await delegate(t, "del_2", 5_100);
      expect(t.deps.respond).toHaveBeenCalledWith({ auth: owner, threadId: "t1", requestId: "r7", behavior: "answer", message: "savings", callId: t.controller.current()!.callId });
      expect(t.deps.send).not.toHaveBeenCalled();
    });

    it("leaves the voice's own question, heard back, out of the answer", async () => {
      const t = await live();
      t.message({ id: "q1", kind: "options", card: { title: "Your bot has a question", subtitle: "Which account?", options: ["Main", "Savings"], requestId: "r7" } });
      await vi.advanceTimersByTimeAsync(0);
      t.socket().receive({ type: "session.output_transcript.delta", delta: "Which account? Main or Savings?", start_ms: 4_000, end_ms: 6_000 });
      hear(t, "which account main or savings ", 4_100, 5_900);
      hear(t, "savings", 7_000);
      await delegate(t, "del_2", 7_100);
      expect(t.deps.respond).toHaveBeenCalledWith({ auth: owner, threadId: "t1", requestId: "r7", behavior: "answer", message: "savings", callId: t.controller.current()!.callId });
    });

    it("keeps an answer said over the voice", async () => {
      const t = await live();
      t.message({ id: "q1", kind: "options", card: { title: "Your bot has a question", subtitle: "Which account?", options: ["Main", "Savings"], requestId: "r7" } });
      await vi.advanceTimersByTimeAsync(0);
      t.socket().receive({ type: "session.output_transcript.delta", delta: "Which account? Main or Savings?", start_ms: 4_000, end_ms: 6_000 });
      hear(t, "savings", 5_000, 5_500);
      await delegate(t, "del_2", 5_600);
      expect(t.deps.respond).toHaveBeenCalledWith({ auth: owner, threadId: "t1", requestId: "r7", behavior: "answer", message: "savings", callId: t.controller.current()!.callId });
    });

    it("announces a second approval after the first one settles", async () => {
      const t = await live();
      t.message(approval());
      t.message({ ...approval({ requestId: "r2", subtitle: "ls" }), id: "c2" });
      await vi.advanceTimersByTimeAsync(0);
      expect(t.socket().appends("instructions")).toHaveLength(1);
      hear(t, "yes", 5_000);
      await delegate(t, "del_2", 5_100);
      t.patch({ ...approval({ answered: "allow" }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(t.socket().appends("instructions").at(-1)).toMatchObject({ content: expect.stringContaining("ls") });
    });
  });
});

describe("LiveCallController record", () => {
  const recorded = (t: ReturnType<typeof setup>) => vi.mocked(t.deps.recordCall!).mock.calls.map(([input]) => input);

  it("records a call that went live once, with OpenAI's usage seconds and nothing said on it", async () => {
    const t = setup({ recordCall: vi.fn() });
    const { call } = await t.start();
    t.socket().receive({ type: "session.input_transcript.delta", delta: "what is on my calendar", start_ms: 100, end_ms: 900 });
    const ending = t.controller.end(call.callId);
    t.socket().receive({ type: "session.closed", reason: "close_requested", usage: { seconds: 61.4 } });
    await ending;
    await t.controller.shutdown();
    expect(recorded(t)).toEqual([{
      threadId: "t1",
      botName: "Ada",
      record: { callId: call.callId, botId: "bot1", client: "desktop", startedAt: call.startedAt, endedAt: expect.any(Number), seconds: 61, endReason: "hung-up" },
    }]);
    expect(recorded(t)[0]!.record.endedAt).toBeGreaterThanOrEqual(call.startedAt);
    expect(JSON.stringify(recorded(t))).not.toContain("calendar");
  });

  it("counts wall-clock seconds when OpenAI sent none", async () => {
    const t = setup({ recordCall: vi.fn() });
    await t.start();
    await vi.advanceTimersByTimeAsync(95_400);
    t.socket().drop();
    expect(recorded(t)).toEqual([expect.objectContaining({ record: expect.objectContaining({ seconds: 95, endReason: "sideband-lost" }) })]);
  });

  it("records nothing for a call that never went live", async () => {
    const t = setup({ recordCall: vi.fn() });
    await t.controller.start({ auth: owner, ...BOT, client: "desktop", sdp: "a" });
    t.socket().refuse();
    expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "sideband-lost" });
    expect(t.deps.recordCall).not.toHaveBeenCalled();
  });

  it("records a call the harness shut down", async () => {
    const t = setup({ recordCall: vi.fn() });
    await t.start();
    await t.controller.shutdown();
    expect(recorded(t)).toEqual([expect.objectContaining({ record: expect.objectContaining({ endReason: "shutdown" }) })]);
  });

  it("ends the call cleanly, and counts it, when writing the record fails", async () => {
    const t = setup({ recordCall: vi.fn(() => { throw new Error("disk full"); }) });
    await t.start();
    t.socket().drop();
    expect(t.frames.at(-1)).toMatchObject({ status: "ended", endReason: "sideband-lost" });
    expect(t.controller.current()).toBeNull();
    expect(t.logs.at(-1)).toContain("errors=record");
    await expect(t.start()).resolves.toBeTruthy();
  });
});
