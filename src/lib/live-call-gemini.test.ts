import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveGeminiSession, LiveGeminiTransport } from "../../shared/wire";
import { FISH_DELEGATE_TOOL, type FishSessionOptions } from "./live-call-fish";
import { MicResampler, pcm16ToFloat, type GeminiAudio } from "./live-call-gemini-audio";
import { geminiSessionStarter, type GeminiSocket } from "./live-call-gemini";
import { configureLiveMedia, liveMedia, resetLiveMedia, startLiveCall } from "./live-call-media";

const SESSION: LiveGeminiSession = {
  session_id: "gemini_1", token: "auth_tokens/a b", model: "models/gemini-3.8-live", expires_at: "",
  ws_url: "wss://gemini.example/ws/BidiGenerateContentConstrained",
};

class FakeSocket implements GeminiSocket {
  binaryType = "blob";
  readyState = 0;
  sent: Array<Record<string, any>> = [];
  closed: number | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code = 1000) { this.readyState = 3; this.closed = code; }
  open() { this.readyState = 1; this.onopen?.({}); }
  receive(message: Record<string, unknown>, binary = false) {
    const text = JSON.stringify(message);
    this.onmessage?.({ data: binary ? new TextEncoder().encode(text).buffer : text });
  }
  drop(code = 1011) { this.readyState = 3; this.onclose?.({ code }); }
}

class FakeAudio implements GeminiAudio {
  onIdle: (() => void) | null = null;
  played: number[] = [];
  playing = 0;
  flushed = 0;
  closed = false;
  mic: ((pcm: ArrayBuffer) => void) | null = null;
  constructor(readonly denied = false) {}
  async startMic(onChunk: (pcm: ArrayBuffer) => void) {
    if (this.denied) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    this.mic = onChunk;
  }
  play(pcm: ArrayBuffer) { this.played.push(pcm.byteLength); this.playing += 1; }
  flush() { this.flushed += 1; this.playing = 0; }
  idle() { return this.playing === 0; }
  finish() { this.playing = 0; this.onIdle?.(); }
  close() { this.closed = true; }
}

function harness({ denied = false } = {}) {
  const sockets: FakeSocket[] = [];
  const audios: FakeAudio[] = [];
  const start = geminiSessionStarter({
    openSocket: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
    audio: () => { const audio = new FakeAudio(denied); audios.push(audio); return audio; },
  });
  const callbacks = {
    onConnect: vi.fn(), onDisconnect: vi.fn(), onModeChange: vi.fn(), onUserTranscript: vi.fn(), onAgentResponseDelta: vi.fn(), onError: vi.fn(),
  };
  const delegate = vi.fn(async (_params: Record<string, unknown>, _context: { callId: string }) => "On it.");
  const options: FishSessionOptions<LiveGeminiSession> = { sessionToken: SESSION, clientTools: { [FISH_DELEGATE_TOOL]: delegate }, clientToolTimeoutMs: 12_000, callbacks };
  const starting = start(options);
  const socket = () => sockets.at(-1)!;
  const connect = async () => {
    socket().open();
    socket().receive({ setupComplete: {} });
    return await starting;
  };
  return { sockets, audios, callbacks, delegate, starting, socket, connect, audio: () => audios.at(-1)! };
}

const AUDIO = btoa(String.fromCharCode(1, 0, 2, 0));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a Gemini Live session", () => {
  it("connects with the token, sends only the model and resumption, and joins once Gemini and the microphone are ready", async () => {
    const t = harness();
    expect(t.socket().url).toBe(`${SESSION.ws_url}?access_token=auth_tokens%2Fa%20b`);
    expect(t.socket().binaryType).toBe("arraybuffer");
    t.socket().open();
    expect(t.socket().sent).toEqual([{ setup: { model: SESSION.model, sessionResumption: {} } }]);
    expect(t.callbacks.onConnect).not.toHaveBeenCalled();
    t.socket().receive({ setupComplete: {} }, true);
    await t.starting;
    expect(t.callbacks.onConnect).toHaveBeenCalledWith({ sessionId: "gemini_1" });
    t.audio().mic!(new Int16Array([1, 2]).buffer);
    expect(t.socket().sent.at(-1)).toEqual({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: btoa(String.fromCharCode(1, 0, 2, 0)) } } });
  });

  it("rejects as the browser does when the microphone is refused, and closes the connection", async () => {
    const t = harness({ denied: true });
    t.socket().open();
    t.socket().receive({ setupComplete: {} });
    await expect(t.starting).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(t.socket().closed).toBe(1000);
    expect(t.audio().closed).toBe(true);
    expect(t.callbacks.onConnect).not.toHaveBeenCalled();
  });

  it("rejects when Gemini closes before the setup is taken", async () => {
    const t = harness();
    t.socket().open();
    t.socket().drop(1008);
    await expect(t.starting).rejects.toMatchObject({ code: "gemini_1008" });
  });

  it("plays the agent, speaking until its turn is done and played, then listening", async () => {
    const t = harness();
    await t.connect();
    t.socket().receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: AUDIO } }] } } });
    expect(t.audio().played).toEqual([4]);
    expect(t.callbacks.onModeChange).toHaveBeenLastCalledWith("speaking");
    t.socket().receive({ serverContent: { turnComplete: true } });
    expect(t.callbacks.onModeChange).toHaveBeenCalledTimes(1);
    t.audio().finish();
    expect(t.callbacks.onModeChange).toHaveBeenLastCalledWith("listening");
  });

  it("stops the agent's audio when the person talks over it", async () => {
    const t = harness();
    await t.connect();
    t.socket().receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm", data: AUDIO } }] } } });
    t.socket().receive({ serverContent: { interrupted: true } });
    expect(t.audio().flushed).toBe(1);
    expect(t.callbacks.onModeChange).toHaveBeenLastCalledWith("listening");
  });

  it("captions the person as they speak, final once the agent answers, and the agent's whole turn", async () => {
    const t = harness();
    await t.connect();
    t.socket().receive({ serverContent: { inputTranscription: { text: "check " } } });
    t.socket().receive({ serverContent: { inputTranscription: { text: "my mail" } } });
    expect(t.callbacks.onUserTranscript).toHaveBeenLastCalledWith({ segmentId: "s0", text: "check my mail", final: false });
    t.socket().receive({ serverContent: { outputTranscription: { text: "Sure, " } } });
    expect(t.callbacks.onUserTranscript).toHaveBeenLastCalledWith({ segmentId: "s0", text: "check my mail", final: true });
    t.socket().receive({ serverContent: { outputTranscription: { text: "checking." } } });
    expect(t.callbacks.onAgentResponseDelta).toHaveBeenLastCalledWith({ segmentId: "a1", text: "Sure, checking." });
    t.socket().receive({ serverContent: { turnComplete: true } });
    t.socket().receive({ serverContent: { outputTranscription: { text: "Done." } } });
    expect(t.callbacks.onAgentResponseDelta).toHaveBeenLastCalledWith({ segmentId: "a1", text: "Done." });
  });

  it("hands a delegate call over once what was heard is final, and answers Gemini when the agent is idle", async () => {
    const t = harness();
    await t.connect();
    t.socket().receive({ serverContent: { inputTranscription: { text: "book a table" } } });
    t.socket().receive({ toolCall: { functionCalls: [{ id: "fc_1", name: FISH_DELEGATE_TOOL, args: { request: "book a table" } }] } });
    expect(t.callbacks.onUserTranscript).toHaveBeenLastCalledWith({ segmentId: "s0", text: "book a table", final: true });
    expect(t.delegate).toHaveBeenCalledWith({ request: "book a table" }, { callId: "fc_1" });
    await settle();
    expect(t.socket().sent.at(-1)).toEqual({ toolResponse: { functionResponses: [{ id: "fc_1", name: FISH_DELEGATE_TOOL, response: { result: "On it.", scheduling: "WHEN_IDLE" } }] } });
  });

  it("passes the bot's updates on, answering only those meant to be heard", async () => {
    const t = harness();
    const session = await t.connect();
    session.sendUserMessage("[OpenMausBot] two emails", { audio: true });
    session.sendUserMessage("[OpenMausBot] still looking", { audio: false });
    expect(t.socket().sent.slice(-2)).toEqual([
      { clientContent: { turns: [{ role: "user", parts: [{ text: "[OpenMausBot] two emails" }] }], turnComplete: true } },
      { clientContent: { turns: [{ role: "user", parts: [{ text: "[OpenMausBot] still looking" }] }], turnComplete: false } },
    ]);
  });

  it("holds the bot's updates while the agent speaks, so they do not cut it off", async () => {
    const t = harness();
    const session = await t.connect();
    t.socket().receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm", data: AUDIO } }] } } });
    session.sendUserMessage("[OpenMausBot] two emails", { audio: true });
    expect(t.socket().sent.at(-1)).not.toHaveProperty("clientContent");
    t.socket().receive({ serverContent: { turnComplete: true } });
    expect(t.socket().sent.at(-1)).not.toHaveProperty("clientContent");
    t.audio().finish();
    expect(t.socket().sent.at(-1)).toEqual({ clientContent: { turns: [{ role: "user", parts: [{ text: "[OpenMausBot] two emails" }] }], turnComplete: true } });
  });

  it("sends no microphone audio while muted", async () => {
    const t = harness();
    const session = await t.connect();
    await session.setMicMuted(true);
    expect(t.socket().sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } });
    const sent = t.socket().sent.length;
    t.audio().mic!(new Int16Array([1]).buffer);
    expect(t.socket().sent).toHaveLength(sent);
    await session.setMicMuted(false);
    t.audio().mic!(new Int16Array([1]).buffer);
    expect(t.socket().sent).toHaveLength(sent + 1);
  });

  it("goes on over a new connection with the resumption handle when Gemini ends one", async () => {
    const t = harness();
    await t.connect();
    t.socket().receive({ sessionResumptionUpdate: { newHandle: "h-2", resumable: true } });
    t.socket().receive({ goAway: { timeLeft: "5s" } });
    t.socket().drop(1000);
    expect(t.sockets).toHaveLength(2);
    t.socket().open();
    expect(t.socket().sent).toEqual([{ setup: { model: SESSION.model, sessionResumption: { handle: "h-2" } } }]);
    t.audio().mic!(new Int16Array([1]).buffer);
    expect(t.socket().sent, "nothing but the setup before Gemini takes it").toHaveLength(1);
    t.socket().receive({ setupComplete: {} });
    expect(t.callbacks.onDisconnect).not.toHaveBeenCalled();
    expect(t.callbacks.onConnect).toHaveBeenCalledTimes(1);
    expect(t.audios).toHaveLength(1);
    t.audio().mic!(new Int16Array([1]).buffer);
    expect(t.socket().sent.at(-1)).toHaveProperty("realtimeInput");
  });

  it("keeps tool answers and updates made between connections for the resumed one, in order", async () => {
    const t = harness();
    const session = await t.connect();
    t.socket().receive({ sessionResumptionUpdate: { newHandle: "h-2", resumable: true } });
    t.socket().receive({ toolCall: { functionCalls: [{ id: "fc_1", name: FISH_DELEGATE_TOOL, args: { request: "x" } }] } });
    t.socket().drop(1000);
    await settle();
    session.sendUserMessage("[OpenMausBot] done", { audio: true });
    t.socket().open();
    expect(t.socket().sent).toHaveLength(1);
    t.socket().receive({ setupComplete: {} });
    expect(t.socket().sent.slice(1).map((m) => Object.keys(m)[0])).toEqual(["toolResponse", "clientContent"]);
  });

  it("ends the call when a resumed connection is refused instead of trying again", async () => {
    const t = harness();
    await t.connect();
    t.socket().receive({ sessionResumptionUpdate: { newHandle: "h-2", resumable: true } });
    t.socket().receive({ goAway: { timeLeft: "1s" } });
    t.socket().drop(1000);
    t.socket().open();
    t.socket().drop(1008);
    expect(t.sockets).toHaveLength(2);
    expect(t.callbacks.onDisconnect).toHaveBeenCalledWith({ reason: "conversation_timeout" });
    expect(t.audio().closed).toBe(true);
  });

  it("ends the call when a connection drops with nothing to resume, saying whether Gemini's time ran out", async () => {
    const lost = harness();
    await lost.connect();
    lost.socket().drop();
    expect(lost.callbacks.onDisconnect).toHaveBeenCalledWith({ reason: "connection_lost" });
    expect(lost.audio().closed).toBe(true);
    const timedOut = harness();
    await timedOut.connect();
    timedOut.socket().receive({ goAway: { timeLeft: "1s" } });
    timedOut.socket().drop();
    expect(timedOut.callbacks.onDisconnect).toHaveBeenCalledWith({ reason: "conversation_timeout" });
  });

  it("on end closes the connection and the audio without reporting a disconnect", async () => {
    const t = harness();
    const session = await t.connect();
    await session.end();
    expect(t.socket().closed).toBe(1000);
    expect(t.audio().closed).toBe(true);
    session.sendUserMessage("late");
    expect(t.socket().sent.at(-1)).not.toHaveProperty("clientContent");
    expect(t.callbacks.onDisconnect).not.toHaveBeenCalled();
  });
});

describe("Gemini call audio", () => {
  it("resamples the microphone to 16 kHz in 100 ms chunks, across calls", () => {
    const resampler = new MicResampler(48_000);
    const input = new Float32Array(2_400).fill(0.5);
    expect(resampler.push(input)).toEqual([]);
    const chunks = resampler.push(input);
    expect(chunks).toHaveLength(1);
    const pcm = new Int16Array(chunks[0]!);
    expect(pcm).toHaveLength(1_600);
    expect(pcm.every((s) => s === Math.round(0.5 * 0x7fff) || s === Math.floor(0.5 * 0x7fff))).toBe(true);
  });

  it("reads Gemini's 16-bit little-endian PCM", () => {
    expect(Array.from(pcm16ToFloat(new Int16Array([0, 16384, -32768]).buffer))).toEqual([0, 0.5, -1]);
  });
});

describe("a Gemini Live call on screen", () => {
  const live = { callId: "c1", botId: "b1", threadId: "t1", client: "web", voice: "agent", startedAt: 5, status: "connecting" } as const;
  const transport: LiveGeminiTransport = { type: "gemini", session: SESSION, relayToken: "relay-token" };

  beforeEach(() => {
    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}) } });
    resetLiveMedia();
  });
  afterEach(() => { resetLiveMedia(); vi.unstubAllGlobals(); });

  it("asks the harness for a session without an offer and starts Gemini's, not Fish's", async () => {
    const request = vi.fn(async (path: string) => {
      if (path === "/api/live/session") return { call: live, transport };
      return { commands: [], closed: false };
    });
    const startFish = vi.fn();
    const startGemini = vi.fn(async () => ({ sendUserMessage: vi.fn(), setMicMuted: vi.fn(async () => {}), end: vi.fn(async () => {}) }));
    const getUserMedia = vi.fn();
    configureLiveMedia({ request: request as never, startFish: startFish as never, startGemini: startGemini as never, getUserMedia: getUserMedia as never, createPeer: vi.fn() as never });
    await startLiveCall({ botId: "b1", threadId: "t1", provider: "gemini" });
    const [, init] = request.mock.calls.find(([path]) => path === "/api/live/session")! as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ botId: "b1", threadId: "t1", client: "web" });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(startFish).not.toHaveBeenCalled();
    expect(startGemini).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: SESSION }));
    expect(liveMedia()).toMatchObject({ phase: "starting", callId: "c1", provider: "gemini" });
  });
});
