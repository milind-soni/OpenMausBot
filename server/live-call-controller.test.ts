import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveCallState } from "../shared/wire.ts";
import {
  ATTACH_TIMEOUT_MS, CLOSE_TIMEOUT_MS, CONSENT_SETTLE_MS, DELEGATION_SETTLE_MS, IDLE_CHECK_MS, PROGRESS_INTERVAL_MS,
  LiveCallBusyError, LiveCallController, LiveCallSignedOutError, type LiveActivity, type LiveCallDeps, type LiveSocket,
} from "./live-call-controller.ts";
import { LIVE_COPY } from "../shared/live-approval.ts";
import { LiveSessionError } from "./live-call.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { Message, StoreChange } from "./store.ts";

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

function setup(overrides: Partial<LiveCallDeps> = {}) {
  const listeners = new Set<(change: StoreChange) => void>();
  const sockets: FakeSocket[] = [];
  const frames: Array<LiveCallState | null> = [];
  const logs: string[] = [];
  let activity: LiveActivity = "idle";
  const settings = { key: "sk-test", voice: "sol", readTypedReplies: true, idleMinutes: 5 };
  /** the thread's queue: ids of sends still waiting there */
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

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("LiveCallController lifecycle", () => {
  it("creates the session with the key and voice, attaches the sideband and goes live", async () => {
    const t = setup();
    const result = await t.controller.start({ auth: owner, ...BOT, client: "ios", sdp: "offer-sdp" });
    expect(t.deps.createSession).toHaveBeenCalledWith({ key: "sk-test", sdp: "offer-sdp", botId: "bot1", threadId: "t1", voice: "sol" });
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

  it("asks for a key when none is set", async () => {
    const t = setup();
    t.settings.key = " ";
    await expect(t.controller.start({ auth: owner, ...BOT, client: "desktop", sdp: "a" })).rejects.toMatchObject({ status: 409 });
    expect(t.deps.createSession).not.toHaveBeenCalled();
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

  // Hung up (or the harness shut down) while OpenAI was creating the
  // session: nobody will ever attach to that session, so the harness closes
  // it instead of leaving it open until OpenAI gives up on it.
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
    // no client will attach to the session OpenAI made: it is closed
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

  // A phone's requests reach the harness as the computer's own (loopback), so
  // the sign-in check never fires for them. The call is bound to the paired
  // phone the companion vouches for instead, and ends when that phone is
  // unpaired.
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

describe("LiveCallController relay", () => {
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
      // a second request while the call ends is refused the same way, and not answered again
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

  it("sends the words since the last request to the bot, as the call's starter", async () => {
    const t = await live();
    hear(t, "what is on ", 100);
    hear(t, "my calendar", 200);
    await delegate(t, "del_1", 400);
    expect(t.deps.send).toHaveBeenCalledWith({ auth: owner, botId: "bot1", threadId: "t1", text: "what is on my calendar" });
    expect(t.socket().appends("thinking").at(-1)).toMatchObject({ delegation_id: "del_1", content: expect.stringContaining("You are working on the request") });
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

  // A request spoken while the bot works can wait in the thread's queue. It
  // holds back "the result is in the chat" until it is delivered. Edited or
  // cancelled in a client, it leaves the queue without ever arriving: from
  // then on it must hold nothing back.
  describe("a spoken request that waits in the queue", () => {
    const noAnswer = (t: ReturnType<typeof setup>) => t.socket().appends("commentary").filter((e) => e.content === LIVE_COPY.noAnswer);
    /** The next request is queued, the way the harness queues a send. */
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
      // the drain takes it out of the queue and onto the thread, and its turn answers
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
      // the first request's turn ends without an answer; the second still waits
      t.setActivity("idle");
      await vi.advanceTimersByTimeAsync(0);
      expect(noAnswer(t)).toHaveLength(0);
      expect(t.deps.queued).toHaveBeenCalledWith("bot1", "t1", "q1");
    });

    // A drain delivers every waiting line at once, as one turn whose request
    // is the last line. The spoken lines before it are answered by it too.
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
      // the person edits (or cancels) the waiting line: it leaves the queue and never arrives
      t.queue.delete("q1");
      t.setActivity("idle");
      await vi.advanceTimersByTimeAsync(0);
      // a later spoken request's turn ends without an answer
      hear(t, "do it", 2_000);
      await delegate(t, "del_2", 2_200);
      t.setActivity("working");
      await vi.advanceTimersByTimeAsync(0);
      t.setActivity("idle");
      await vi.advanceTimersByTimeAsync(0);
      expect(noAnswer(t)).toEqual([expect.objectContaining({ delegation_id: "del_2" })]);
    });
  });

  // Without facts about a long turn the voice guessed ("I see it is stuck").
  // While the bot works it now gets a quiet status note every 30 s.
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

  // A typed message goes to the bot, not to the voice. Mirroring it into the
  // voice when it is typed made GPT-Live answer it at once, and then again
  // when the bot's answer was relayed: the person heard two answers.
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

  // "Read replies to typed messages" off means nothing about a typed
  // exchange reaches OpenAI: not what was typed, not the answer, not the
  // steps the bot took for it.
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

  // A peer bot's words land as user-role lines too: an ask_bot request, or
  // context from the aside lane folded into the running turn. The person did
  // not type them, so neither they nor the bot's answer to them is relayed.
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

  // Only what the caller typed in a client is "what you typed": not a
  // member's line in a shared workspace, not a routine's or a webhook's
  // line, not a line sent through the local API.
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

  // A worker (the Slack relay, or any send through the guarded route) posts
  // for someone else as this computer: no sender, a sendId of its own, so it
  // looked exactly like the owner's typed line. Its line is marked relayed,
  // and neither it nor its answer is read back to the caller.
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

    it("accepts a yes heard in a quiet moment, without a delegation", async () => {
      const t = await live();
      t.message(approval());
      await vi.advanceTimersByTimeAsync(0);
      hear(t, "yes", 5_000);
      await vi.advanceTimersByTimeAsync(CONSENT_SETTLE_MS + 1);
      expect(t.deps.respond).toHaveBeenCalledWith(expect.objectContaining({ behavior: "allow" }));
    });

    // The voice's own opener ("Okay, I need your permission…") comes back
    // through a phone's speaker as input, and "okay…" is a hedge, not a yes.
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
      // an empty delegation well after the decision is a new, unheard request
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
        // the tap landed first: the card is settled, and the harness refuses without side effects
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

    // A connect-an-app or credential card waits on the person in the chat;
    // without a word the call went silent until the idle hang-up.
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
      expect(t.deps.respond).toHaveBeenCalledWith({ auth: owner, threadId: "t1", requestId: "r7", behavior: "answer", message: "savings" });
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
      expect(t.deps.respond).toHaveBeenCalledWith({ auth: owner, threadId: "t1", requestId: "r7", behavior: "answer", message: "savings" });
    });

    it("keeps an answer said over the voice", async () => {
      const t = await live();
      t.message({ id: "q1", kind: "options", card: { title: "Your bot has a question", subtitle: "Which account?", options: ["Main", "Savings"], requestId: "r7" } });
      await vi.advanceTimersByTimeAsync(0);
      t.socket().receive({ type: "session.output_transcript.delta", delta: "Which account? Main or Savings?", start_ms: 4_000, end_ms: 6_000 });
      hear(t, "savings", 5_000, 5_500);
      await delegate(t, "del_2", 5_600);
      expect(t.deps.respond).toHaveBeenCalledWith({ auth: owner, threadId: "t1", requestId: "r7", behavior: "answer", message: "savings" });
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
