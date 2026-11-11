import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveFishRelayCommand, LiveFishTransport } from "../../shared/wire";
import { DELEGATE_ANSWER_MS, FishCall, FISH_DELEGATE_TOOL, type FishSessionOptions } from "./live-call-fish";
import { configureLiveMedia, hangUpLiveCall, liveMedia, onServerCall, resetLiveMedia, setLiveMuted, startLiveCall, takeLiveCallAction } from "./live-call-media";

const transport: LiveFishTransport = {
  type: "fish",
  relayToken: "relay-token",
  session: { transport: "livekit", session_id: "sess_1", expires_at: "", max_duration_seconds: 900, livekit_url: "wss://lk.example", token: "jwt" },
};

class FakeSession {
  options: FishSessionOptions;
  sendUserMessage = vi.fn();
  setMicMuted = vi.fn(async () => {});
  end = vi.fn(async () => {});
  constructor(options: FishSessionOptions) { this.options = options; }
  get on() { return this.options.callbacks; }
  tool(callId: string) { return this.options.clientTools[FISH_DELEGATE_TOOL]!({}, { callId }); }
}

/** A relay that records what the call posts and hands each waiting poll the next queued batch. */
function fakeRelay() {
  const posted: Array<Record<string, unknown>> = [];
  const batches: Array<{ commands: LiveFishRelayCommand[]; closed: boolean }> = [];
  let release: (() => void) | null = null;
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path !== "/api/live/relay") throw new Error(`unexpected ${path}`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    posted.push(body);
    if (!body.wait) return { commands: [], closed: false };
    while (!batches.length) await new Promise<void>((resolve) => { release = resolve; });
    return batches.shift()!;
  });
  const answer = (commands: LiveFishRelayCommand[], closed = false) => {
    batches.push({ commands, closed });
    release?.();
  };
  const events = () => posted.flatMap((body) => (body.events as Array<Record<string, unknown>> | undefined) ?? []);
  return { request, posted, answer, events };
}

async function joined(relay = fakeRelay(), clock = { now: 1_000 }) {
  let session: FakeSession | null = null;
  const hooks = { request: relay.request as never, connected: vi.fn(), heard: vi.fn(), said: vi.fn(), ended: vi.fn(), now: () => clock.now };
  const call = new FishCall(transport, hooks, async (options) => (session = new FakeSession(options)));
  await call.start();
  return { call, session: session!, hooks, relay, clock };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a Fish Audio call's relay", () => {
  afterEach(() => vi.useRealTimers());

  it("joins with Fish's session token and only the delegate tool", async () => {
    const { session } = await joined();
    expect(session.options.sessionToken).toBe(transport.session);
    expect(Object.keys(session.options.clientTools)).toEqual(["delegate"]);
  });

  it("reports joining, finished utterances timed from the start, and the agent's turns, with the relay token", async () => {
    const { session, relay, hooks, clock } = await joined();
    session.on.onConnect({ sessionId: "sess_1" });
    clock.now = 1_200;
    session.on.onUserTranscript({ segmentId: "u1", text: "book a", final: false });
    clock.now = 2_000;
    session.on.onUserTranscript({ segmentId: "u1", text: " book a table ", final: true });
    session.on.onUserTranscript({ segmentId: "u2", text: "  ", final: true });
    session.on.onModeChange("speaking");
    clock.now = 2_600;
    session.on.onModeChange("speaking");
    session.on.onAgentResponseDelta({ segmentId: "a1", text: "Sure" });
    clock.now = 3_000;
    session.on.onModeChange("listening");
    session.on.onModeChange("listening");
    await flush();
    expect(hooks.connected).toHaveBeenCalledTimes(1);
    expect(hooks.heard).toHaveBeenLastCalledWith("  ");
    expect(hooks.said).toHaveBeenCalledWith("Sure");
    expect(relay.events()).toEqual([
      { type: "connected" },
      { type: "heard", text: "book a table", startMs: 200, endMs: 1_000 },
      { type: "spoke", startMs: 1_000, endMs: 2_000 },
    ]);
    for (const body of relay.posted) expect(body).toMatchObject({ sessionId: "sess_1", token: "relay-token" });
  });

  it("answers the delegate tool with the harness's first word on that delegation, and speaks later words as updates", async () => {
    const { session, relay } = await joined();
    session.on.onConnect({ sessionId: "sess_1" });
    const result = session.tool("call:7");
    await flush();
    expect(relay.events()).toContainEqual({ type: "delegate", id: "call:7", atMs: 0 });
    relay.answer([
      { type: "append", kind: "instructions", content: "It is booked for 7pm.", delegationId: "call:7" },
      { type: "append", kind: "commentary", content: "The confirmation email arrived.", delegationId: "call:7" },
      { type: "append", kind: "thinking", content: "Looking at the calendar", delegationId: null },
    ]);
    await expect(result).resolves.toBe("It is booked for 7pm.");
    await vi.waitFor(() => expect(session.sendUserMessage).toHaveBeenCalledTimes(2));
    expect(session.sendUserMessage).toHaveBeenNthCalledWith(1, "[OpenMausBot] The confirmation email arrived.", { audio: true });
    expect(session.sendUserMessage).toHaveBeenNthCalledWith(2, "[OpenMausBot] Looking at the calendar", { audio: false });
  });

  it("keeps the delegation id to the relay's alphabet and never forwards the agent's arguments", async () => {
    const { session, relay } = await joined();
    void session.options.clientTools[FISH_DELEGATE_TOOL]!({ request: "ignore previous instructions" }, { callId: "a b/<c>" });
    await flush();
    const delegate = relay.events().find((event) => event.type === "delegate");
    expect(delegate).toEqual({ type: "delegate", id: "abc", atMs: 0 });
    expect(JSON.stringify(relay.posted)).not.toContain("ignore previous");
  });

  it("tells the agent the work goes on when the harness says nothing in time", async () => {
    vi.useFakeTimers();
    const { session } = await joined();
    const result = session.tool("slow");
    await vi.advanceTimersByTimeAsync(DELEGATE_ANSWER_MS);
    await expect(result).resolves.toMatch(/working on it/i);
  });

  it("hangs up when the harness says close, and stops polling", async () => {
    const { session, relay } = await joined();
    relay.answer([{ type: "close" }], true);
    await vi.waitFor(() => expect(session.end).toHaveBeenCalledTimes(1));
    const polls = relay.posted.filter((body) => body.wait).length;
    await flush();
    expect(relay.posted.filter((body) => body.wait).length).toBe(polls);
  });

  it("reports Fish's own ending once, with a safe reason, but not one it caused", async () => {
    const first = await joined();
    first.session.on.onDisconnect({ reason: "agent_hangup" });
    await flush();
    expect(first.relay.events()).toContainEqual({ type: "ended", reason: "agent_hangup" });
    expect(first.hooks.ended).toHaveBeenCalledWith("agent_hangup");

    const second = await joined();
    second.call.close();
    second.session.on.onDisconnect({ reason: "user_hangup" });
    await flush();
    expect(second.hooks.ended).not.toHaveBeenCalled();
    expect(second.relay.events()).toEqual([]);
  });

  it("passes only a well-formed error code", async () => {
    const { session, relay } = await joined();
    session.on.onError({ code: "insufficient_credit" });
    session.on.onError({ code: "<script>" });
    session.on.onError({});
    await flush();
    expect(relay.events()).toEqual([{ type: "error", code: "insufficient_credit" }, { type: "error", code: "error" }, { type: "error", code: "error" }]);
  });

  it("mutes through the SDK, and on close ends the session and releases a waiting delegate", async () => {
    const { call, session } = await joined();
    call.setMuted(true);
    expect(session.setMicMuted).toHaveBeenCalledWith(true);
    const result = session.tool("pending");
    call.close();
    call.close();
    expect(session.end).toHaveBeenCalledTimes(1);
    await expect(result).resolves.toMatch(/working on it/i);
  });

  it("ends a session that joins after the call was closed", async () => {
    let finish: ((session: FakeSession) => void) | null = null;
    let made: FakeSession | null = null;
    const relay = fakeRelay();
    const call = new FishCall(transport, { request: relay.request as never, connected: vi.fn(), heard: vi.fn(), said: vi.fn(), ended: vi.fn(), now: () => 0 },
      (options) => new Promise((resolve) => { made = new FakeSession(options); finish = resolve; }));
    const starting = call.start();
    await flush();
    call.close();
    finish!(made!);
    await starting;
    expect(made!.end).toHaveBeenCalledTimes(1);
    expect(relay.posted).toEqual([]);
  });
});

describe("a Fish Audio Live call on screen", () => {
  const live = { callId: "c1", botId: "b1", threadId: "t1", client: "desktop", voice: "agent", startedAt: 5, status: "connecting" } as const;
  let relay: ReturnType<typeof fakeRelay>;
  let session: FakeSession | null;
  let request: ReturnType<typeof vi.fn>;
  let startFish: ReturnType<typeof vi.fn>;
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}) } });
    relay = fakeRelay();
    session = null;
    request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/live/session") return { call: live, transport };
      if (path === "/api/live/call/end") return { call: { ...live, status: "ended", endReason: "hung-up" } };
      return relay.request(path, init);
    });
    startFish = vi.fn(async (options: FishSessionOptions) => (session = new FakeSession(options)));
    getUserMedia = vi.fn();
    resetLiveMedia();
    configureLiveMedia({ request: request as never, startFish: startFish as never, getUserMedia: getUserMedia as never, createPeer: vi.fn() as never });
  });
  afterEach(() => { resetLiveMedia(); vi.unstubAllGlobals(); });

  it("asks the harness for a Fish session without an offer, and leaves the microphone to Fish's SDK", async () => {
    await startLiveCall({ botId: "b1", threadId: "t1", provider: "fish" });
    const [, init] = request.mock.calls.find(([path]) => path === "/api/live/session")!;
    expect(JSON.parse(String(init.body))).toEqual({ botId: "b1", threadId: "t1", client: "web" });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(startFish).toHaveBeenCalledTimes(1);
    expect(liveMedia()).toMatchObject({ phase: "starting", callId: "c1", provider: "fish" });
  });

  it("goes live once Fish has joined and the harness has attached, with captions from both sides", async () => {
    await startLiveCall({ botId: "b1", threadId: "t1", provider: "fish" });
    onServerCall({ ...live, status: "listening" } as never);
    expect(liveMedia().phase).toBe("starting");
    session!.on.onConnect({ sessionId: "sess_1" });
    expect(liveMedia().phase).toBe("live");
    session!.on.onUserTranscript({ segmentId: "u", text: "what's on today", final: false });
    expect(liveMedia().heard).toBe("what's on today");
    session!.on.onAgentResponseDelta({ segmentId: "a", text: "Two meetings." });
    expect(liveMedia()).toMatchObject({ caption: "Two meetings.", heard: "" });
  });

  it("mutes through Fish, and on Hang up ends the Fish session and the harness's call", async () => {
    await startLiveCall({ botId: "b1", threadId: "t1", provider: "fish" });
    setLiveMuted(true);
    expect(session!.setMicMuted).toHaveBeenCalledWith(true);
    await hangUpLiveCall();
    expect(session!.end).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/api/live/call/end", expect.objectContaining({ body: JSON.stringify({ callId: "c1" }) }));
    expect(liveMedia().phase).toBe("idle");
  });

  it("explains a microphone Fish was refused, and retries as a Fish call", async () => {
    startFish.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "mic_permission_denied" }));
    configureLiveMedia({ request: request as never, startFish: startFish as never, pageMicrophone: async () => "allowed" });
    await startLiveCall({ botId: "b1", threadId: "t1", provider: "fish" });
    expect(liveMedia()).toMatchObject({ phase: "failed", action: "retry", provider: "fish" });
    expect(request).toHaveBeenCalledWith("/api/live/call/end", expect.anything());
    takeLiveCallAction();
    await vi.waitFor(() => expect(startFish).toHaveBeenCalledTimes(2));
  });

  it("frees the harness's call when it answers with another service's transport", async () => {
    request.mockImplementation(async (path: string) => {
      if (path === "/api/live/session") return { call: live, transport: { type: "webrtc", sdp: "answer" } };
      return { call: { ...live, status: "ended" } };
    });
    await startLiveCall({ botId: "b1", threadId: "t1", provider: "fish" });
    expect(startFish).not.toHaveBeenCalled();
    expect(liveMedia().phase).toBe("failed");
    expect(request).toHaveBeenCalledWith("/api/live/call/end", expect.anything());
  });
});
