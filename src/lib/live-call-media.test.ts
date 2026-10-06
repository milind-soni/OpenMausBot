import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentCall } from "./call";
import {
  applyCaption, checkLiveSignIn, configureLiveMedia, dismissKeyPrompt, endNotice, handleLiveCallKey, hangUpLiveCall, isLiveCallRunning, liveCallShortcut,
  liveMedia, onLiveStreamConnected, onServerCall, resetLiveMedia, setLiveMuted, startLiveCall, subscribeLiveMedia, takeLiveCallAction,
} from "./live-call-media";
import { ApiError } from "@/state/store";

class FakeTrack { enabled = true; stopped = false; stop() { this.stopped = true; } }
class FakeChannel {
  readyState = "open";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = "closed"; }
  /** the channel's own connection finishes */
  open() { this.readyState = "open"; this.onopen?.(); }
}
class FakePeer {
  channel = new FakeChannel();
  closed = false;
  remote: string | null = null;
  localDescription: { sdp: string } | null = null;
  iceGatheringState = "complete";
  connectionState = "new";
  ontrack: ((event: { track: FakeTrack }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  addTrack() {}
  createDataChannel() { return this.channel; }
  async createOffer() { return { type: "offer", sdp: "v=0\r\noffer\r\n" }; }
  async setLocalDescription(description: { sdp: string }) { this.localDescription = description; }
  async setRemoteDescription(description: { sdp: string }) { this.remote = description.sdp; }
  addEventListener() {}
  removeEventListener() {}
  close() { this.closed = true; }
}
/** A peer still gathering network candidates until the test says it is done. */
class GatheringPeer extends FakePeer {
  iceGatheringState = "gathering";
  waiting: (() => void) | null = null;
  addEventListener(_type?: string, listener?: () => void) { this.waiting = listener ?? null; }
  removeEventListener() { this.waiting = null; }
  finishGathering() { this.iceGatheringState = "complete"; this.waiting?.(); }
}

const call = { callId: "c1", botId: "b1", threadId: "t1", client: "desktop", voice: "marin", startedAt: 5, status: "connecting" } as const;
let peer: FakePeer;
let track: FakeTrack;
let request: ReturnType<typeof vi.fn>;
/** The call ids this window asked the harness to end, in order. */
const endRequests = () =>
  request.mock.calls.filter(([path]) => path === "/api/live/call/end").map(([, init]) => JSON.parse(String(init.body)).callId);

beforeEach(() => {
  vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}) } });
  peer = new FakePeer();
  track = new FakeTrack();
  request = vi.fn(async (path: string) => {
    if (path === "/api/live/session") return { call, transport: { type: "webrtc", sdp: "answer" } };
    if (path === "/api/live/call/end") return { call: { ...call, status: "ended", endReason: "hung-up" } };
    throw new Error(`unexpected ${path}`);
  });
  resetLiveMedia();
  configureLiveMedia(fakes());
});
/** The fake microphone, peer and harness every call here uses. */
const fakes = () => ({
  getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) as unknown as MediaStream,
  createPeer: () => peer as unknown as RTCPeerConnection,
  request: request as never,
  playRemote: () => {},
  stopRemote: () => {},
  iceTimeoutMs: 50,
});
/** What a window says it is, as desktopCapabilitiesNow reports it. */
const windowIs = (dictation: Partial<DesktopCapabilities["dictation"]>) => () =>
  ({ dictation: { available: false, engine: "none", onDevice: false, ...dictation } }) as DesktopCapabilities;
afterEach(() => { resetLiveMedia(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("live call media", () => {
  it("sends the offer as a desktop call and applies the answer", async () => {
    configureLiveMedia({ ...fakes(), capabilities: windowIs({ available: true, engine: "apple-speech", onDevice: true }) });
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(request).toHaveBeenCalledWith("/api/live/session", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse(String(request.mock.calls[0][1].body));
    expect(body).toEqual({ botId: "b1", threadId: "t1", sdp: "v=0\r\noffer\r\n", client: "desktop" });
    expect(peer.remote).toBe("answer");
    expect(liveMedia()).toMatchObject({ phase: "starting", callId: "c1", botId: "b1" });
    expect(currentCall()).toBe("b1");
    onServerCall({ ...call, status: "live" });
    expect(liveMedia().phase).toBe("live");
  });

  // The harness names where a running call is from what the starting
  // window said it is, so a busy line elsewhere reads true. A server's page
  // in the desktop app (My Cloud) is still the desktop app.
  it.each([
    ["the Mac app's own page", "desktop", { available: true, engine: "apple-speech", onDevice: true }],
    ["My Cloud in the desktop app", "desktop", { reasonCode: "remote-server" }],
    ["the Windows app", "desktop", { reasonCode: "unsupported-platform" }],
    ["a web browser", "web", { reasonCode: "desktop-app-required" }],
  ] as const)("from %s, starts a %s call", async (_where, client, dictation) => {
    configureLiveMedia({ ...fakes(), capabilities: windowIs(dictation) });
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(JSON.parse(String(request.mock.calls[0][1].body)).client).toBe(client);
  });

  it("in a web browser, with no desktop app around it, starts a web call", async () => {
    vi.stubGlobal("window", {});
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(JSON.parse(String(request.mock.calls[0][1].body)).client).toBe("web");
  });

  it("asks for a key and releases the microphone", async () => {
    request.mockRejectedValueOnce(new ApiError("Add an OpenAI API key to use Live calls.", 409, { needsKey: true }));
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(liveMedia()).toMatchObject({ phase: "idle", needsKey: true });
    expect(track.stopped).toBe(true);
    expect(currentCall()).toBeNull();
  });

  it("says who is on the line when another call runs", async () => {
    const other = { ...call, callId: "c0", client: "ios", status: "live" } as const;
    request.mockRejectedValueOnce(new ApiError("A Live call is already running.", 409, { activeCall: other }));
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(liveMedia()).toMatchObject({ phase: "failed", busyWith: other });
    expect(track.stopped).toBe(true);
    // the harness also runs on Ubuntu: "computer", not "Mac"
    request.mockRejectedValueOnce(new ApiError("A Live call is already running.", 409, { activeCall: { ...other, client: "desktop" } }));
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(liveMedia().notice).toBe("Another Live call is running on this computer. Hang up there first.");
    // a call from a web browser (a Cloud's page) is not "on this computer"
    request.mockRejectedValueOnce(new ApiError("A Live call is already running.", 409, { activeCall: { ...other, client: "web" } }));
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(liveMedia().notice).toBe("Another Live call is running in a web browser. Hang up there first.");
  });

  it("releases media when the server ends the call", async () => {
    await startLiveCall({ botId: "b1", threadId: "t1" });
    onServerCall({ ...call, status: "ended", endReason: "sideband-lost" });
    expect(peer.channel.sent.map((s) => JSON.parse(s).type)).toContain("session.close");
    expect(peer.closed).toBe(true);
    expect(track.stopped).toBe(true);
    expect(liveMedia()).toMatchObject({ phase: "failed", notice: "Call dropped." });
    expect(currentCall()).toBeNull();
  });

  it("ignores server frames for another call", async () => {
    await startLiveCall({ botId: "b1", threadId: "t1" });
    onServerCall({ ...call, callId: "zz", status: "ended", endReason: "hung-up" });
    expect(liveMedia().phase).toBe("starting");
  });

  it("hangs up through the server and releases everything", async () => {
    await startLiveCall({ botId: "b1", threadId: "t1" });
    await hangUpLiveCall();
    expect(request).toHaveBeenCalledWith("/api/live/call/end", expect.objectContaining({ body: JSON.stringify({ callId: "c1" }) }));
    expect(peer.closed).toBe(true);
    expect(liveMedia().phase).toBe("idle");
  });

  it("stops capturing immediately while the server's hang-up is still pending", async () => {
    await startLiveCall({ botId: "b1", threadId: "t1" });
    let confirm!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve; }));
    const hanging = hangUpLiveCall();

    expect(liveMedia()).toMatchObject({ phase: "ending", hangingUp: true });
    expect(track.stopped).toBe(true);
    expect(peer.channel.sent.map((value) => JSON.parse(value).type)).toContain("session.close");
    confirm({ call: { ...call, status: "ended", endReason: "hung-up" } });
    await hanging;
    expect(liveMedia().phase).toBe("idle");
  });

  it("cancels a call that is still starting", async () => {
    let release!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const starting = startLiveCall({ botId: "b1", threadId: "t1" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const hanging = hangUpLiveCall();
    release({ call, transport: { type: "webrtc", sdp: "answer" } });
    await Promise.all([starting, hanging]);
    expect(request).toHaveBeenCalledWith("/api/live/call/end", expect.objectContaining({ body: JSON.stringify({ callId: "c1" }) }));
    expect(liveMedia().phase).toBe("idle");
    expect(track.stopped).toBe(true);
  });

  it("mutes the microphone track", async () => {
    await startLiveCall({ botId: "b1", threadId: "t1" });
    setLiveMuted(true);
    expect(track.enabled).toBe(false);
    expect(liveMedia().muted).toBe(true);
  });

  it("reads ⌘⇧M and ⌘⇧H on a Mac and Ctrl+Shift+M/H elsewhere", () => {
    const key = (k: string, extra: Partial<KeyboardEvent> = {}) =>
      ({ key: k, metaKey: false, ctrlKey: false, shiftKey: true, altKey: false, isComposing: false, defaultPrevented: false, ...extra });
    expect(liveCallShortcut(key("M", { metaKey: true }), true)).toBe("mute");
    expect(liveCallShortcut(key("h", { metaKey: true }), true)).toBe("hangUp");
    expect(liveCallShortcut(key("M", { ctrlKey: true }), false)).toBe("mute");
    expect(liveCallShortcut(key("H", { ctrlKey: true }), false)).toBe("hangUp");
    expect(liveCallShortcut(key("M", { ctrlKey: true }), true)).toBeNull();
    expect(liveCallShortcut(key("M", { metaKey: true, shiftKey: false }), true)).toBeNull();
    expect(liveCallShortcut(key("M", { metaKey: true, altKey: true }), true)).toBeNull();
    expect(liveCallShortcut(key("M", { metaKey: true, isComposing: true }), true)).toBeNull();
    expect(liveCallShortcut(key("M", { metaKey: true, defaultPrevented: true }), true)).toBeNull();
    expect(liveCallShortcut(key("K", { metaKey: true }), true)).toBeNull();
  });

  it("mutes and hangs up from the keyboard only while this window has a call", async () => {
    const chord = (k: string) => ({ key: k, metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, isComposing: false, defaultPrevented: false });
    expect(handleLiveCallKey(chord("M"), true)).toBe(false);
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(handleLiveCallKey(chord("M"), true)).toBe(true);
    expect(liveMedia().muted).toBe(true);
    expect(track.enabled).toBe(false);
    expect(handleLiveCallKey(chord("M"), true)).toBe(true);
    expect(liveMedia().muted).toBe(false);
    expect(handleLiveCallKey(chord("H"), true)).toBe(true);
    await vi.waitFor(() => expect(liveMedia().phase).toBe("idle"));
    expect(request).toHaveBeenCalledWith("/api/live/call/end", expect.objectContaining({ body: JSON.stringify({ callId: "c1" }) }));
    expect(handleLiveCallKey(chord("H"), true)).toBe(false);
  });

  it("keeps a mute pressed while the call connects", async () => {
    const starting = startLiveCall({ botId: "b1", threadId: "t1" });
    setLiveMuted(true);
    await starting;
    expect(track.enabled).toBe(false);
    expect(liveMedia().muted).toBe(true);
  });

  it("builds captions from the data channel", async () => {
    let state = { caption: "", heard: "" };
    state = applyCaption(state, { type: "session.input_transcript.delta", delta: "what time " });
    state = applyCaption(state, { type: "session.input_transcript.delta", delta: "is it" });
    expect(state.heard).toBe("what time is it");
    state = applyCaption(state, { type: "session.output_transcript.delta", delta: "It is noon." });
    expect(state).toEqual({ caption: "It is noon.", heard: "" });
    expect(applyCaption({ caption: "x".repeat(300), heard: "" }, { type: "session.output_transcript.delta", delta: "y" }).caption).toHaveLength(240);
  });

  it("names why a call ended", () => {
    expect(endNotice("idle")).toEqual({ text: "Call ended after a long silence.", dropped: false });
    expect(endNotice("sideband-lost")).toEqual({ text: "Call dropped.", dropped: true });
    expect(endNotice("hung-up").dropped).toBe(false);
    // a retry cannot help a call whose sign-in ended
    expect(endNotice("signed-out")).toEqual({ text: "Call ended: you were signed out.", dropped: false });
  });

  it("shows the harness's own words first, keeping the reason's drop and retry", async () => {
    await startLiveCall({ botId: "b1", threadId: "t1" });
    onServerCall({ ...call, status: "ended", endReason: "signed-out", error: "The call has ended because the sign-in that started it has ended." });
    expect(liveMedia()).toMatchObject({ phase: "ended", notice: "The call has ended because the sign-in that started it has ended.", action: null });

    peer = new FakePeer();
    track = new FakeTrack();
    request.mockImplementationOnce(async () => ({ call: { ...call, callId: "c2" }, transport: { type: "webrtc", sdp: "answer" } }));
    await startLiveCall({ botId: "b1", threadId: "t1" });
    onServerCall({ ...call, callId: "c2", status: "ended", endReason: "sideband-lost", error: "The call connection to OpenAI dropped." });
    expect(liveMedia()).toMatchObject({ phase: "failed", notice: "The call connection to OpenAI dropped.", action: "retry" });
  });

  // Try again only where a retry can help: never for a busy line, a window
  // without WebRTC, or a refused sign-in. A microphone the browser or the
  // computer blocked can be allowed there, then tried again.
  describe("Try again", () => {
    it("is offered for a dropped call", async () => {
      await startLiveCall({ botId: "b1", threadId: "t1" });
      onServerCall({ ...call, status: "ended", endReason: "connection-lost" });
      expect(liveMedia()).toMatchObject({ phase: "failed", action: "retry" });
    });

    it("is offered when the computer blocked the microphone", async () => {
      configureLiveMedia({
        getUserMedia: async () => { throw new DOMException("denied", "NotAllowedError"); },
        createPeer: () => peer as unknown as RTCPeerConnection,
        request: request as never,
        iceTimeoutMs: 50,
      });
      await startLiveCall({ botId: "b1", threadId: "t1" });
      expect(liveMedia()).toMatchObject({ phase: "failed", notice: expect.stringContaining("microphone is blocked"), action: "retry" });
    });

    it("is not offered while another call holds the line, or in a window without WebRTC", async () => {
      const other = { ...call, callId: "c0", client: "ios", status: "live" } as const;
      request.mockRejectedValueOnce(new ApiError("A Live call is already running.", 409, { activeCall: other }));
      await startLiveCall({ botId: "b1", threadId: "t1" });
      expect(liveMedia()).toMatchObject({ phase: "failed", action: null });
      resetLiveMedia();
      await startLiveCall({ botId: "b1", threadId: "t1" });
      expect(liveMedia()).toMatchObject({ phase: "failed", action: null });
    });

    it("is not offered when the harness refuses this window's sign-in", async () => {
      request.mockRejectedValueOnce(new ApiError("unauthorized: this session has expired or was revoked; pair this device again", 401));
      await startLiveCall({ botId: "b1", threadId: "t1" });
      expect(liveMedia()).toMatchObject({ phase: "failed", notice: expect.stringContaining("expired or was revoked"), action: null });
    });

    it("is offered when OpenAI refused the call", async () => {
      request.mockRejectedValueOnce(new ApiError("OpenAI is limiting Live sessions right now (rate limit or quota). Try again in a moment.", 429));
      await startLiveCall({ botId: "b1", threadId: "t1" });
      expect(liveMedia()).toMatchObject({ phase: "failed", action: "retry" });
    });
  });

  // A revoked or signed-out browser sign-in cannot receive the harness's end
  // frame (its event stream is cut), so this window checks for itself.
  describe("a sign-in that ends mid-call", () => {
    const refuseSignIn = () => request.mockImplementation(async (path: string) => {
      if (path === "/api/live/call") throw new ApiError("unauthorized: this session has expired or was revoked; pair this device again", 401);
      throw new Error(`unexpected ${path}`);
    });

    it("hangs up at once when the harness refuses this window's sign-in", async () => {
      await startLiveCall({ botId: "b1", threadId: "t1" });
      onServerCall({ ...call, status: "live" });
      refuseSignIn();
      await checkLiveSignIn();
      expect(liveMedia()).toMatchObject({ phase: "ended", notice: "Call ended: you were signed out.", action: null });
      expect(track.stopped).toBe(true);
      expect(peer.channel.sent.map((sent) => JSON.parse(sent).type)).toContain("session.close");
      expect(currentCall()).toBeNull();
    });

    it("checks when the event stream drops, and keeps a call the harness merely cannot be reached for", async () => {
      await startLiveCall({ botId: "b1", threadId: "t1" });
      onServerCall({ ...call, status: "live" });
      request.mockImplementation(async (path: string) => {
        if (path === "/api/live/call") throw new TypeError("fetch failed");
        throw new Error(`unexpected ${path}`);
      });
      onLiveStreamConnected(false);
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("/api/live/call", expect.anything()));
      expect(liveMedia().phase).toBe("live");
      refuseSignIn();
      onLiveStreamConnected(true);
      await Promise.resolve();
      expect(liveMedia().phase).toBe("live");
      onLiveStreamConnected(false);
      await vi.waitFor(() => expect(liveMedia()).toMatchObject({ phase: "ended", notice: "Call ended: you were signed out." }));
    });

    it("says why when OpenAI closes the call because the sign-in ended", async () => {
      await startLiveCall({ botId: "b1", threadId: "t1" });
      onServerCall({ ...call, status: "live" });
      refuseSignIn();
      peer.channel.onmessage?.({ data: JSON.stringify({ type: "session.closed", reason: "close_requested" }) });
      await vi.waitFor(() => expect(liveMedia()).toMatchObject({ phase: "ended", notice: "Call ended: you were signed out." }));
    });

    it("does nothing without a call", async () => {
      refuseSignIn();
      await checkLiveSignIn();
      expect(request).not.toHaveBeenCalled();
      expect(liveMedia().phase).toBe("idle");
    });
  });

  // Non-trickle ICE: OpenAI takes one offer. Gathering that has not finished
  // in time sends what it found, as the phones do; a call whose audio then
  // never connects is dropped by the 20 s wait instead.
  it("sends the offer with the candidates gathered so far when gathering runs long", async () => {
    peer = new GatheringPeer();
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(request).toHaveBeenCalledWith("/api/live/session", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(request.mock.calls[0][1].body)).sdp).toBe("v=0\r\noffer\r\n");
    expect(liveMedia()).toMatchObject({ phase: "starting", callId: "c1", notice: null });
    expect(track.stopped).toBe(false);
    expect(currentCall()).toBe("b1");
  });

  // Going live needs both halves: the harness attached to the session, and
  // this window's own data channel open. The clock starts then, on this
  // computer's clock.
  it("goes live when the harness has attached and the data channel is open, and times the call from then", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    peer.channel.readyState = "connecting";
    await startLiveCall({ botId: "b1", threadId: "t1" });
    onServerCall({ ...call, status: "live", startedAt: 5 });
    expect(liveMedia()).toMatchObject({ phase: "starting", startedAt: null });
    vi.setSystemTime(1_004_000);
    peer.channel.open();
    expect(liveMedia()).toMatchObject({ phase: "live", startedAt: 1_004_000 });
  });

  it("waits for the harness when the data channel opens first", async () => {
    peer.channel.readyState = "connecting";
    await startLiveCall({ botId: "b1", threadId: "t1" });
    peer.channel.open();
    expect(liveMedia().phase).toBe("starting");
    onServerCall({ ...call, status: "live" });
    expect(liveMedia().phase).toBe("live");
    expect(liveMedia().startedAt).toEqual(expect.any(Number));
  });

  // A status this window does not know counts as running (ruling 11), so the
  // computer's side has attached: only "connecting" and "ended" say otherwise.
  it("counts any status but connecting and ended as the computer's attach", async () => {
    await startLiveCall({ botId: "b1", threadId: "t1" });
    onServerCall({ ...call, status: "connecting" });
    expect(liveMedia().phase).toBe("starting");
    onServerCall({ ...call, status: "on-hold" } as unknown as typeof call);
    expect(liveMedia()).toMatchObject({ phase: "live", startedAt: expect.any(Number) });
  });

  it("opens no session after a hang-up during setup", async () => {
    const gathering = new GatheringPeer();
    peer = gathering;
    const starting = startLiveCall({ botId: "b1", threadId: "t1" });
    await vi.waitFor(() => expect(gathering.waiting).not.toBeNull());
    await hangUpLiveCall();
    gathering.finishGathering();
    await starting;
    expect(request).not.toHaveBeenCalled();
    expect(liveMedia().phase).toBe("idle");
    expect(track.stopped).toBe(true);
  });

  it("catches up on a server frame that arrived before the session answer", async () => {
    request.mockImplementationOnce(async () => {
      onServerCall({ ...call, status: "live" });
      return { call, transport: { type: "webrtc", sdp: "answer" } };
    });
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(liveMedia().phase).toBe("live");
  });

  it("releases media when the call ended before the answer came back", async () => {
    request.mockImplementationOnce(async () => ({
      call: { ...call, status: "ended", endReason: "sideband-lost", error: "The call could not connect to OpenAI." },
      transport: { type: "webrtc", sdp: "answer" },
    }));
    await startLiveCall({ botId: "b1", threadId: "t1" });
    // the harness's own words come first, as on the phones
    expect(liveMedia()).toMatchObject({ phase: "failed", notice: "The call could not connect to OpenAI.", action: "retry" });
    expect(peer.remote).toBeNull();
    expect(track.stopped).toBe(true);
    expect(currentCall()).toBeNull();
  });

  it("frees the harness's call when the answer cannot be used", async () => {
    peer.setRemoteDescription = async () => { throw new Error("bad answer"); };
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(request).toHaveBeenCalledWith("/api/live/call/end", expect.objectContaining({ body: JSON.stringify({ callId: "c1" }) }));
    expect(liveMedia()).toMatchObject({ phase: "failed", notice: "bad answer" });
    expect(track.stopped).toBe(true);
    expect(currentCall()).toBeNull();
  });

  it("explains a window without microphone support", async () => {
    resetLiveMedia();
    await startLiveCall({ botId: "b1", threadId: "t1" });
    // in plain words, with what to do: no "WebRTC", and nothing to try again
    expect(liveMedia()).toMatchObject({
      phase: "failed",
      notice: "Live calls need a microphone, and this window can't use one. Open OpenMausBot at a secure https address to make the call.",
      action: null,
    });
    expect(currentCall()).toBeNull();
  });

  it("hangs up quietly when the server's end frame beats the reply", async () => {
    await startLiveCall({ botId: "b1", threadId: "t1" });
    let answer!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const hanging = hangUpLiveCall();
    onServerCall({ ...call, status: "ended", endReason: "hung-up" });
    expect(liveMedia()).toMatchObject({ phase: "idle", notice: null });
    expect(track.stopped).toBe(true);

    // a new call starts before the old hang-up's reply arrives
    const first = track;
    peer = new FakePeer();
    track = new FakeTrack();
    request.mockImplementationOnce(async () => ({ call: { ...call, callId: "c2" }, transport: { type: "webrtc", sdp: "answer" } }));
    await startLiveCall({ botId: "b1", threadId: "t1" });
    answer({ call: { ...call, status: "ended", endReason: "hung-up" } });
    await hanging;
    expect(first.stopped).toBe(true);
    expect(track.stopped).toBe(false);
    expect(peer.closed).toBe(false);
    expect(liveMedia()).toMatchObject({ phase: "starting", callId: "c2" });
    expect(currentCall()).toBe("b1");
  });

  it("counts a call as running from the first ring until it has ended", () => {
    expect((["idle", "starting", "live", "ending", "ended", "failed"] as const).filter(isLiveCallRunning)).toEqual(["starting", "live", "ending"]);
  });

  it("tells every watcher about a change until it unsubscribes", () => {
    const watcher = vi.fn();
    const unsubscribe = subscribeLiveMedia(watcher);
    setLiveMuted(true);
    expect(watcher).toHaveBeenCalledTimes(1);
    unsubscribe();
    setLiveMuted(false);
    expect(watcher).toHaveBeenCalledTimes(1);
  });

  it("drops the key prompt only for the bot it was left for", async () => {
    request.mockRejectedValueOnce(new ApiError("Add an OpenAI API key to use Live calls.", 409, { needsKey: true }));
    await startLiveCall({ botId: "b1", threadId: "t1" });
    dismissKeyPrompt("b2");
    expect(liveMedia()).toMatchObject({ needsKey: true, botId: "b1" });
    dismissKeyPrompt("b1");
    expect(liveMedia()).toMatchObject({ phase: "idle", needsKey: false, botId: null });
  });

  it("plays blocked audio on the next click and clears the hint", async () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal("document", {
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: (type: string, listener: () => void) => { if (listeners.get(type) === listener) listeners.delete(type); },
    });
    const playRemote = vi.fn().mockRejectedValueOnce(new Error("autoplay blocked")).mockResolvedValue(undefined);
    configureLiveMedia({
      getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) as unknown as MediaStream,
      createPeer: () => peer as unknown as RTCPeerConnection,
      request: request as never,
      playRemote,
      stopRemote: () => {},
      iceTimeoutMs: 50,
    });
    await startLiveCall({ botId: "b1", threadId: "t1" });
    onServerCall({ ...call, status: "live" });
    const remote = new FakeTrack();
    peer.ontrack!({ track: remote });
    await vi.waitFor(() => expect(liveMedia().notice).toBe("Click anywhere in the window to hear the call."));
    expect([...listeners.keys()].sort()).toEqual(["keydown", "pointerdown"]);

    listeners.get("pointerdown")!();
    await vi.waitFor(() => expect(liveMedia().notice).toBeNull());
    expect(playRemote).toHaveBeenLastCalledWith(remote);
    expect(listeners.size).toBe(0);
    expect(liveMedia().phase).toBe("live");
  });

  it("stops waiting for a click when the call ends", async () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal("document", {
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: (type: string, listener: () => void) => { if (listeners.get(type) === listener) listeners.delete(type); },
    });
    configureLiveMedia({
      getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) as unknown as MediaStream,
      createPeer: () => peer as unknown as RTCPeerConnection,
      request: request as never,
      playRemote: async () => { throw new Error("autoplay blocked"); },
      stopRemote: () => {},
      iceTimeoutMs: 50,
    });
    await startLiveCall({ botId: "b1", threadId: "t1" });
    peer.ontrack!({ track: new FakeTrack() });
    await vi.waitFor(() => expect(listeners.size).toBe(2));
    await hangUpLiveCall();
    expect(listeners.size).toBe(0);
  });
});

// "Hanging up…" and a quiet end belong to the window whose Hang up asked for
// them. Any other end keeps the call's title while the call ends, then says
// why in the reason's words.
describe("ending a call", () => {
  const live = async () => {
    await startLiveCall({ botId: "b1", threadId: "t1" });
    onServerCall({ ...call, status: "live" });
    expect(liveMedia().phase).toBe("live");
  };

  it("keeps a call another device hangs up on screen while it ends, then says Call ended.", async () => {
    await live();
    // the iPhone's remote bar hangs this window's call up
    onServerCall({ ...call, status: "ending" });
    expect(liveMedia()).toMatchObject({ phase: "ending", hangingUp: false, notice: null });
    expect(track.stopped).toBe(true);
    onServerCall({ ...call, status: "ended", endReason: "hung-up" });
    expect(liveMedia()).toMatchObject({ phase: "ended", notice: "Call ended.", action: null, hangingUp: false });
    expect(track.stopped).toBe(true);
    expect(currentCall()).toBeNull();
  });

  it("says why when the computer ends the call itself", async () => {
    await live();
    onServerCall({ ...call, status: "ending" });
    expect(liveMedia()).toMatchObject({ phase: "ending", hangingUp: false });
    onServerCall({ ...call, status: "ended", endReason: "idle" });
    expect(liveMedia()).toMatchObject({ phase: "ended", notice: "Call ended after a long silence.", action: null });
  });

  it("stops capturing as soon as OpenAI closes the call, before the reason grace period", async () => {
    vi.useFakeTimers();
    await live();
    peer.channel.onmessage?.({ data: JSON.stringify({ type: "session.closed" }) });
    expect(track.stopped).toBe(true);
    expect(liveMedia()).toMatchObject({ phase: "live", notice: null });
    onServerCall({ ...call, status: "ended", endReason: "idle" });
    expect(liveMedia()).toMatchObject({ phase: "ended", notice: "Call ended after a long silence." });
  });

  it("says Hanging up… after this window's own Hang up, and ends quietly on the computer's word", async () => {
    await live();
    let confirm!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve; }));
    const hanging = hangUpLiveCall();
    expect(liveMedia()).toMatchObject({ phase: "ending", hangingUp: true });
    onServerCall({ ...call, status: "ending" });
    expect(liveMedia()).toMatchObject({ phase: "ending", hangingUp: true });
    onServerCall({ ...call, status: "ended", endReason: "hung-up" });
    expect(liveMedia()).toMatchObject({ phase: "idle", notice: null, hangingUp: false });
    confirm({ call: { ...call, status: "ended", endReason: "hung-up" } });
    await hanging;
    expect(liveMedia()).toMatchObject({ phase: "idle", notice: null });
  });

  it("stays quiet when OpenAI's close reaches this window before the computer confirms its hang-up", async () => {
    vi.useFakeTimers();
    await live();
    let confirm!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve; }));
    const hanging = hangUpLiveCall();
    peer.channel.onmessage?.({ data: JSON.stringify({ type: "session.closed", reason: "close_requested" }) });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(liveMedia()).toMatchObject({ phase: "ending", hangingUp: true, notice: null });
    confirm({ call: { ...call, status: "ended", endReason: "hung-up" } });
    await hanging;
    expect(liveMedia()).toMatchObject({ phase: "idle", notice: null });
    expect(track.stopped).toBe(true);
  });
});

describe("waiting for a Live call's audio to connect", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it("drops a call whose audio never connects, 20 s after the answer", async () => {
    await startLiveCall({ botId: "b1", threadId: "t1" });
    // the harness is live on its own line to OpenAI; this window's audio is not
    onServerCall({ ...call, status: "live" });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(liveMedia()).toMatchObject({ phase: "live", notice: null });
    expect(endRequests()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(liveMedia()).toMatchObject({
      phase: "failed", botId: "b1", threadId: "t1", busyWith: null, notice: "Call dropped: the audio could not connect.",
    });
    expect(endRequests()).toEqual(["c1"]);
    expect(track.stopped).toBe(true);
    expect(peer.closed).toBe(true);
    expect(currentCall()).toBeNull();
  });

  it("keeps a call whose audio connects within 20 s", async () => {
    await startLiveCall({ botId: "b1", threadId: "t1" });
    onServerCall({ ...call, status: "live" });
    await vi.advanceTimersByTimeAsync(5_000);
    peer.connectionState = "connected";
    peer.onconnectionstatechange!();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(liveMedia()).toMatchObject({ phase: "live", callId: "c1", notice: null });
    expect(endRequests()).toEqual([]);
    expect(track.stopped).toBe(false);
    expect(peer.closed).toBe(false);
  });

  it("keeps a call whose audio connected before the answer finished applying", async () => {
    peer.setRemoteDescription = async (description) => {
      peer.remote = description.sdp;
      // the state change is reported before this promise resolves
      peer.connectionState = "connected";
      peer.onconnectionstatechange!();
    };
    await startLiveCall({ botId: "b1", threadId: "t1" });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(liveMedia()).toMatchObject({ phase: "starting", callId: "c1", notice: null });
    expect(endRequests()).toEqual([]);
    expect(track.stopped).toBe(false);
  });

  it("does not drop, or end again, a call hung up before 20 s", async () => {
    await startLiveCall({ botId: "b1", threadId: "t1" });
    await vi.advanceTimersByTimeAsync(15_000);
    // the harness confirms the hang-up only after the 20 s mark
    let confirm!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve; }));
    const hanging = hangUpLiveCall();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(liveMedia()).toMatchObject({ phase: "ending", notice: null });

    confirm({ call: { ...call, status: "ended", endReason: "hung-up" } });
    await hanging;
    await vi.advanceTimersByTimeAsync(25_000);
    expect(liveMedia()).toMatchObject({ phase: "idle", notice: null });
    expect(endRequests()).toEqual(["c1"]);
    expect(track.stopped).toBe(true);
  });

  it("gives a call started after a timed-out one its own 20 s", async () => {
    await startLiveCall({ botId: "b1", threadId: "t1" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(liveMedia().phase).toBe("failed");

    // Try again, on a fresh connection
    peer = new FakePeer();
    track = new FakeTrack();
    request.mockImplementationOnce(async () => ({ call: { ...call, callId: "c2" }, transport: { type: "webrtc", sdp: "answer" } }));
    await startLiveCall({ botId: "b1", threadId: "t1" });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(liveMedia()).toMatchObject({ phase: "starting", callId: "c2", notice: null });
    expect(track.stopped).toBe(false);
    expect(endRequests()).toEqual(["c1"]);

    await vi.advanceTimersByTimeAsync(1);
    expect(liveMedia()).toMatchObject({ phase: "failed", notice: "Call dropped: the audio could not connect." });
    expect(endRequests()).toEqual(["c1", "c2"]);
  });

  it("does not let a hung-up call's late answer disturb the next call's wait", async () => {
    let applied!: () => void;
    peer.setRemoteDescription = () => new Promise<void>((resolve) => { applied = resolve; });
    const first = startLiveCall({ botId: "b1", threadId: "t1" });
    await vi.waitFor(() => expect(applied).toBeDefined());
    await hangUpLiveCall();

    peer = new FakePeer();
    track = new FakeTrack();
    request.mockImplementationOnce(async () => ({ call: { ...call, callId: "c2" }, transport: { type: "webrtc", sdp: "answer" } }));
    await startLiveCall({ botId: "b1", threadId: "t1" });
    // the first call's answer finishes applying only now
    applied();
    await first;
    peer.connectionState = "connected";
    peer.onconnectionstatechange!();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(liveMedia()).toMatchObject({ phase: "starting", callId: "c2", notice: null });
    expect(endRequests()).toEqual(["c1"]);
  });

  it("stops waiting once the harness has ended the call", async () => {
    await startLiveCall({ botId: "b1", threadId: "t1" });
    onServerCall({ ...call, status: "ended", endReason: "sideband-lost" });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(liveMedia()).toMatchObject({ phase: "failed", notice: "Call dropped." });
    expect(endRequests()).toEqual([]);
  });
});

// A blocked microphone says who blocked it, with the one thing that helps.
// This app lets a server's page use the microphone only on the person's own
// Cloud: a page it refused can make the call in a web browser. A block by the
// browser or the computer is lifted there, then the call is tried again.
describe("a blocked microphone", () => {
  const APP_REFUSED = "The app didn't let this page use the microphone. Open it in your web browser to make the Live call.";
  const COMPUTER = "The microphone is blocked. Allow microphone access for this app in your computer's privacy settings, then try again.";
  const BROWSER = "The microphone is blocked. Allow it for this site in your browser, then try again.";
  const blockedIn = (
    dictation: Partial<DesktopCapabilities["dictation"]>,
    { reason = "NotAllowedError", pageMic }: { reason?: string; pageMic?: "allowed" | "refused" } = {},
  ) => configureLiveMedia({
    getUserMedia: async () => { throw new DOMException("denied", reason); },
    createPeer: () => peer as unknown as RTCPeerConnection,
    request: request as never,
    iceTimeoutMs: 50,
    capabilities: windowIs(dictation),
    pageMicrophone: async () => pageMic,
  });

  it("refused by this app on a server's page, sends the call to the web browser", async () => {
    blockedIn({ reasonCode: "remote-server" }, { pageMic: "refused" });
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(liveMedia()).toMatchObject({ phase: "failed", notice: APP_REFUSED, action: "open-in-browser" });
  });

  // A desktop app from before pageMic refused every server's page but its
  // verified Cloud, and cannot say which: the browser is the way that works.
  it("on a server's page in an older desktop app that does not say, sends the call to the web browser", async () => {
    blockedIn({ reasonCode: "remote-server" });
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(liveMedia()).toMatchObject({ phase: "failed", notice: APP_REFUSED, action: "open-in-browser" });
  });

  // A server reached over plain http (a LAN or VPN address) is no secure
  // page: neither the app nor a web browser gives it a microphone, so it is
  // never told a web browser can make the call.
  it("on a plain-http server's page, which has no microphone at all, offers no web browser", async () => {
    const pageMicrophone = vi.fn(async () => "refused" as const);
    configureLiveMedia({
      createPeer: () => peer as unknown as RTCPeerConnection,
      request: request as never,
      capabilities: () => ({ dictation: { available: false, engine: "none", onDevice: false, reasonCode: "remote-server" } }) as DesktopCapabilities,
      pageMicrophone,
    });
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(liveMedia()).toMatchObject({ phase: "failed", notice: "Live calls need a microphone, and this window can't use one. Open OpenMausBot at a secure https address to make the call.", action: null });
    expect(liveMedia().notice).not.toMatch(/browser/i);
    expect(pageMicrophone).not.toHaveBeenCalled();
  });

  it("allowed by this app on the person's Cloud, points at the computer's settings, then Try again", async () => {
    blockedIn({ reasonCode: "remote-server" }, { pageMic: "allowed" });
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(liveMedia()).toMatchObject({ phase: "failed", notice: COMPUTER, action: "retry" });
  });

  it("in a web browser, points at the site's microphone permission, then Try again", async () => {
    blockedIn({ reasonCode: "desktop-app-required" });
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(liveMedia()).toMatchObject({ phase: "failed", notice: BROWSER, action: "retry" });
  });

  it.each([
    ["the Mac app", { available: true, engine: "apple-speech", onDevice: true }, "allowed"],
    ["the Windows app", { reasonCode: "unsupported-platform" }, "allowed"],
    ["an older Mac app", { available: true, engine: "apple-speech", onDevice: true }, undefined],
  ] as const)("in %s's own window, points at the computer's settings, then Try again", async (_where, dictation, pageMic) => {
    blockedIn(dictation, { pageMic });
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(liveMedia()).toMatchObject({ phase: "failed", notice: COMPUTER, action: "retry" });
  });

  // No setting supplies a microphone that isn't there, in any window.
  it.each([
    ["another server's page", { reasonCode: "remote-server" }],
    ["a web browser", { reasonCode: "desktop-app-required" }],
    ["the Windows app", { reasonCode: "unsupported-platform" }],
  ] as const)("with no microphone at all, in %s, asks for one, then Try again", async (_where, dictation) => {
    blockedIn(dictation, { reason: "NotFoundError", pageMic: "refused" });
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(liveMedia()).toMatchObject({ phase: "failed", notice: "No microphone was found. Connect one, then try again.", action: "retry" });
  });

  it("Try again starts the call again", async () => {
    blockedIn({ reasonCode: "desktop-app-required" });
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(liveMedia().action).toBe("retry");
    // the person allowed the microphone for the site
    configureLiveMedia({
      getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) as unknown as MediaStream,
      createPeer: () => peer as unknown as RTCPeerConnection,
      request: request as never,
      iceTimeoutMs: 50,
    });
    takeLiveCallAction();
    await vi.waitFor(() => expect(liveMedia()).toMatchObject({ phase: "starting", callId: "c1", botId: "b1", threadId: "t1", notice: null }));
    expect(request).toHaveBeenCalledWith("/api/live/session", expect.objectContaining({ method: "POST" }));
  });

  it("Open in browser opens this very page in the web browser", async () => {
    vi.stubGlobal("location", { href: "https://omb-u-0123456789ab.fly.dev/?bot=b1" });
    const openInBrowser = vi.fn();
    configureLiveMedia({
      getUserMedia: async () => { throw new DOMException("denied", "NotAllowedError"); },
      capabilities: () => ({ dictation: { available: false, engine: "none", onDevice: false, reasonCode: "remote-server" } }) as DesktopCapabilities,
      pageMicrophone: async () => "refused",
      openInBrowser,
    });
    await startLiveCall({ botId: "b1", threadId: "t1" });
    takeLiveCallAction();
    expect(openInBrowser).toHaveBeenCalledExactlyOnceWith("https://omb-u-0123456789ab.fly.dev/?bot=b1");
    // no call starts in this window
    expect(request).not.toHaveBeenCalledWith("/api/live/session", expect.anything());
  });

  // The real wiring: the desktop app's answer comes from permStatus, and the
  // page opens through the window's link handler, which hands it to the browser.
  it("asks the desktop app through permStatus, and opens the page as a link", async () => {
    const open = vi.fn();
    const permStatus = vi.fn(async () => ({ mic: "granted", pageMic: "refused" }));
    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}), permStatus }, open });
    vi.stubGlobal("location", { href: "https://omb-u-0123456789ab.fly.dev/" });
    configureLiveMedia({
      getUserMedia: async () => { throw new DOMException("denied", "NotAllowedError"); },
      capabilities: () => ({ dictation: { available: false, engine: "none", onDevice: false, reasonCode: "remote-server" } }) as DesktopCapabilities,
    });
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(permStatus).toHaveBeenCalledOnce();
    expect(liveMedia()).toMatchObject({ notice: APP_REFUSED, action: "open-in-browser" });
    takeLiveCallAction();
    expect(open).toHaveBeenCalledExactlyOnceWith("https://omb-u-0123456789ab.fly.dev/", "_blank", "noopener,noreferrer");
  });

  it("treats a desktop app that cannot answer as one that does not say", async () => {
    const permStatus = vi.fn(async () => { throw new Error("no handler"); });
    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}), permStatus } });
    configureLiveMedia({
      getUserMedia: async () => { throw new DOMException("denied", "NotAllowedError"); },
      capabilities: () => ({ dictation: { available: true, engine: "apple-speech", onDevice: true } }) as DesktopCapabilities,
    });
    await startLiveCall({ botId: "b1", threadId: "t1" });
    expect(liveMedia()).toMatchObject({ phase: "failed", notice: COMPUTER, action: "retry" });
  });

  it("a call hung up while the app is asked about its microphone stays hung up", async () => {
    let answer!: (pageMic: "refused") => void;
    configureLiveMedia({
      getUserMedia: async () => { throw new DOMException("denied", "NotAllowedError"); },
      capabilities: () => ({ dictation: { available: false, engine: "none", onDevice: false, reasonCode: "remote-server" } }) as DesktopCapabilities,
      pageMicrophone: () => new Promise((resolve) => { answer = resolve; }),
    });
    const starting = startLiveCall({ botId: "b1", threadId: "t1" });
    await vi.waitFor(() => expect(answer).toBeDefined());
    await hangUpLiveCall();
    answer("refused");
    await starting;
    expect(liveMedia()).toMatchObject({ phase: "idle", notice: null, action: null });
  });
});
