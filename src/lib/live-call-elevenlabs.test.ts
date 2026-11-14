import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveElevenLabsSession, LiveElevenLabsTransport } from "../../shared/wire";
import { FISH_DELEGATE_TOOL, type FishSessionOptions } from "./live-call-fish";
import type { GeminiAudio } from "./live-call-gemini-audio";
import type { GeminiSocket } from "./live-call-gemini";
import { elevenLabsPlaybackRate, elevenLabsSessionStarter } from "./live-call-elevenlabs";
import { configureLiveMedia, liveMedia, resetLiveMedia, startLiveCall } from "./live-call-media";

const SESSION: LiveElevenLabsSession = {
  session_id: "elevenlabs_1", signed_url: "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=a&conversation_signature=s",
  instructions: "You are Rigel. Be brief.", expires_at: "",
};
const METADATA = { type: "conversation_initiation_metadata", conversation_initiation_metadata_event: { conversation_id: "conv_1", agent_output_audio_format: "pcm_16000" } };

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
  receive(message: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(message) }); }
  drop(code = 1011) { this.readyState = 3; this.onclose?.({ code }); }
}

class FakeAudio implements GeminiAudio {
  onIdle: (() => void) | null = null;
  played: number[] = [];
  playing = 0;
  flushed = 0;
  closed = false;
  mic: ((pcm: ArrayBuffer) => void) | null = null;
  /** Set while the microphone permission prompt is still open; calling it answers the prompt. */
  allowMic: (() => void) | null = null;
  constructor(readonly rate: number, readonly denied = false, readonly held = false) {}
  async startMic(onChunk: (pcm: ArrayBuffer) => void) {
    if (this.denied) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    if (this.held) await new Promise<void>((resolve) => { this.allowMic = resolve; });
    this.mic = onChunk;
  }
  play(pcm: ArrayBuffer) { this.played.push(pcm.byteLength); this.playing += 1; }
  flush() { this.flushed += 1; this.playing = 0; }
  idle() { return this.playing === 0; }
  finish() { this.playing = 0; this.onIdle?.(); }
  close() { this.closed = true; }
}

function harness({ denied = false, held = false } = {}) {
  const sockets: FakeSocket[] = [];
  const audios: FakeAudio[] = [];
  const start = elevenLabsSessionStarter({
    openSocket: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
    audio: (rate) => { const audio = new FakeAudio(rate, denied, held); audios.push(audio); return audio; },
  });
  const callbacks = {
    onConnect: vi.fn(), onDisconnect: vi.fn(), onModeChange: vi.fn(), onUserTranscript: vi.fn(), onAgentResponseDelta: vi.fn(), onError: vi.fn(),
  };
  const delegate = vi.fn(async (_params: Record<string, unknown>, _context: { callId: string }) => "On it.");
  const options: FishSessionOptions<LiveElevenLabsSession> = { sessionToken: SESSION, clientTools: { [FISH_DELEGATE_TOOL]: delegate }, clientToolTimeoutMs: 12_000, callbacks };
  const starting = start(options);
  const socket = () => sockets.at(-1)!;
  const connect = async () => {
    socket().open();
    socket().receive(METADATA);
    return await starting;
  };
  return { sockets, audios, callbacks, delegate, starting, socket, connect, audio: () => audios.at(-1)! };
}

const AUDIO = btoa(String.fromCharCode(1, 0, 2, 0));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Longer than the pause that ends the agent's turn. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 350));

describe("an ElevenLabs Live session", () => {
  it("opens the signed URL, sends the call's instructions first, and joins once ElevenLabs and the microphone are ready", async () => {
    const t = harness();
    expect(t.socket().url).toBe(SESSION.signed_url);
    t.socket().open();
    expect(t.socket().sent).toEqual([{
      type: "conversation_initiation_client_data",
      conversation_config_override: { agent: { prompt: { prompt: SESSION.instructions } } },
    }]);
    expect(t.callbacks.onConnect).not.toHaveBeenCalled();
    t.socket().receive(METADATA);
    await t.starting;
    expect(t.callbacks.onConnect).toHaveBeenCalledWith({ sessionId: "elevenlabs_1" });
    expect(t.audio().rate).toBe(16_000);
    t.audio().mic!(new Int16Array([1, 2]).buffer);
    expect(t.socket().sent.at(-1)).toEqual({ user_audio_chunk: AUDIO });
  });

  it("plays the agent at the rate ElevenLabs names", () => {
    expect(elevenLabsPlaybackRate("pcm_24000")).toBe(24_000);
    expect(elevenLabsPlaybackRate("ulaw_8000")).toBe(16_000);
    expect(elevenLabsPlaybackRate(undefined)).toBe(16_000);
  });

  it("rejects as the browser does when the microphone is refused, and closes the connection", async () => {
    const t = harness({ denied: true });
    t.socket().open();
    t.socket().receive(METADATA);
    await expect(t.starting).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(t.socket().closed).toBe(1000);
    expect(t.audio().closed).toBe(true);
    expect(t.callbacks.onConnect).not.toHaveBeenCalled();
  });

  it("rejects when ElevenLabs closes before the conversation starts", async () => {
    const t = harness();
    t.socket().open();
    t.socket().drop(1008);
    await expect(t.starting).rejects.toMatchObject({ code: "elevenlabs_1008" });
  });

  it("rejects at once when ElevenLabs closes while the microphone prompt is still open, and never reports a connection", async () => {
    const t = harness({ held: true });
    t.socket().open();
    t.socket().receive(METADATA);
    t.socket().drop(1011);
    await expect(t.starting).rejects.toMatchObject({ code: "elevenlabs_1011" });
    t.audio().allowMic?.();
    await settle();
    expect(t.callbacks.onConnect).not.toHaveBeenCalled();
  });

  it("answers ElevenLabs' pings so the conversation stays open", async () => {
    const t = harness();
    await t.connect();
    t.socket().receive({ type: "ping", ping_event: { event_id: 7, ping_ms: 50 } });
    expect(t.socket().sent.at(-1)).toEqual({ type: "pong", event_id: 7 });
  });

  it("plays the agent, speaking until its audio has played, captions both sides, and stops at an interruption", async () => {
    const t = harness();
    await t.connect();
    t.socket().receive({ type: "user_transcript", user_transcription_event: { user_transcript: " check my mail " } });
    expect(t.callbacks.onUserTranscript).toHaveBeenCalledWith({ segmentId: "s0", text: "check my mail", final: true });
    t.socket().receive({ type: "agent_response", agent_response_event: { agent_response: "Checking now." } });
    expect(t.callbacks.onAgentResponseDelta).toHaveBeenCalledWith({ segmentId: "a1", text: "Checking now." });
    t.socket().receive({ type: "audio", audio_event: { audio_base_64: AUDIO, event_id: 1 } });
    expect(t.audio().played).toEqual([4]);
    expect(t.callbacks.onModeChange).toHaveBeenLastCalledWith("speaking");
    t.audio().finish();
    await pause();
    expect(t.callbacks.onModeChange).toHaveBeenLastCalledWith("listening");
    t.socket().receive({ type: "audio", audio_event: { audio_base_64: AUDIO, event_id: 2 } });
    t.socket().receive({ type: "interruption", interruption_event: { event_id: 3 } });
    expect(t.audio().flushed).toBe(1);
    expect(t.callbacks.onModeChange).toHaveBeenLastCalledWith("listening");
    // The interrupted answer's audio still on its way is not played; the next answer's is.
    t.socket().receive({ type: "audio", audio_event: { audio_base_64: AUDIO, event_id: 3 } });
    expect(t.audio().played).toEqual([4, 4]);
    t.socket().receive({ type: "audio", audio_event: { audio_base_64: AUDIO, event_id: 4 } });
    expect(t.audio().played).toEqual([4, 4, 4]);
  });

  it("keeps speaking through a short gap between the agent's audio chunks", async () => {
    const t = harness();
    const session = await t.connect();
    t.socket().receive({ type: "audio", audio_event: { audio_base_64: AUDIO, event_id: 1 } });
    session.sendUserMessage("[OpenMausBot] You have two new emails.");
    t.audio().finish();
    t.socket().receive({ type: "audio", audio_event: { audio_base_64: AUDIO, event_id: 1 } });
    await pause();
    expect(t.callbacks.onModeChange).not.toHaveBeenCalledWith("listening");
    expect(t.socket().sent.map((m) => m.type)).not.toContain("user_message");
    t.audio().finish();
    await pause();
    expect(t.callbacks.onModeChange).toHaveBeenLastCalledWith("listening");
    expect(t.socket().sent.at(-1)).toEqual({ type: "user_message", text: "[OpenMausBot] You have two new emails." });
  });

  it("answers the delegate tool call with the harness's words", async () => {
    const t = harness();
    await t.connect();
    t.socket().receive({ type: "client_tool_call", client_tool_call: { tool_name: FISH_DELEGATE_TOOL, tool_call_id: "tc_1", parameters: { request: "check mail" } } });
    expect(t.delegate).toHaveBeenCalledWith({ request: "check mail" }, { callId: "tc_1" });
    await settle();
    expect(t.socket().sent.at(-1)).toEqual({ type: "client_tool_result", tool_call_id: "tc_1", result: "On it.", is_error: false });
    t.socket().receive({ type: "client_tool_call", client_tool_call: { tool_name: "other", tool_call_id: "tc_2", parameters: {} } });
    await settle();
    expect(t.socket().sent.at(-1)).toEqual({ type: "client_tool_result", tool_call_id: "tc_2", result: "There is no tool named other.", is_error: true });
    t.delegate.mockRejectedValueOnce(new Error("relay down"));
    t.socket().receive({ type: "client_tool_call", client_tool_call: { tool_name: FISH_DELEGATE_TOOL, tool_call_id: "tc_3", parameters: {} } });
    await settle();
    expect(t.socket().sent.at(-1)).toEqual({ type: "client_tool_result", tool_call_id: "tc_3", result: "The request failed.", is_error: true });
  });

  it("holds the bot's words while the agent speaks, and sends a quiet update as context", async () => {
    const t = harness();
    const session = await t.connect();
    t.socket().receive({ type: "audio", audio_event: { audio_base_64: AUDIO } });
    session.sendUserMessage("[OpenMausBot] You have two new emails.");
    expect(t.socket().sent.at(-1)).not.toHaveProperty("type", "user_message");
    session.sendUserMessage("[OpenMausBot] still looking", { audio: false });
    expect(t.socket().sent.at(-1)).not.toHaveProperty("type", "contextual_update");
    t.audio().finish();
    await pause();
    expect(t.socket().sent.slice(-2)).toEqual([
      { type: "user_message", text: "[OpenMausBot] You have two new emails." },
      { type: "contextual_update", text: "[OpenMausBot] still looking" },
    ]);
  });

  it("stops sending the microphone while muted", async () => {
    const t = harness();
    const session = await t.connect();
    await session.setMicMuted(true);
    const sent = t.socket().sent.length;
    t.audio().mic!(new Int16Array([1]).buffer);
    expect(t.socket().sent).toHaveLength(sent);
    await session.setMicMuted(false);
    t.audio().mic!(new Int16Array([1]).buffer);
    expect(t.socket().sent).toHaveLength(sent + 1);
  });

  it("ends the call when ElevenLabs closes the conversation", async () => {
    const t = harness();
    await t.connect();
    t.socket().drop(1000);
    expect(t.callbacks.onDisconnect).toHaveBeenCalledWith({ reason: "connection_lost" });
    expect(t.audio().closed).toBe(true);
  });

  it("on end closes the connection and the audio without reporting a disconnect", async () => {
    const t = harness();
    const session = await t.connect();
    await session.end();
    expect(t.socket().closed).toBe(1000);
    expect(t.audio().closed).toBe(true);
    session.sendUserMessage("late");
    expect(t.socket().sent.at(-1)).not.toHaveProperty("type", "user_message");
    expect(t.callbacks.onDisconnect).not.toHaveBeenCalled();
  });
});

describe("an ElevenLabs Live call on screen", () => {
  const live = { callId: "c1", botId: "b1", threadId: "t1", client: "web", voice: "agent", startedAt: 5, status: "connecting" } as const;
  const transport: LiveElevenLabsTransport = { type: "elevenlabs", session: SESSION, relayToken: "relay-token" };

  beforeEach(() => {
    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}) } });
    resetLiveMedia();
  });
  afterEach(() => { resetLiveMedia(); vi.unstubAllGlobals(); });

  it("asks the harness for a session without an offer and starts ElevenLabs', not Fish's or Gemini's", async () => {
    const request = vi.fn(async (path: string) => {
      if (path === "/api/live/session") return { call: live, transport };
      return { commands: [], closed: false };
    });
    const startFish = vi.fn();
    const startGemini = vi.fn();
    const startElevenLabs = vi.fn(async () => ({ sendUserMessage: vi.fn(), setMicMuted: vi.fn(async () => {}), end: vi.fn(async () => {}) }));
    const getUserMedia = vi.fn();
    configureLiveMedia({ request: request as never, startFish: startFish as never, startGemini: startGemini as never, startElevenLabs: startElevenLabs as never, getUserMedia: getUserMedia as never, createPeer: vi.fn() as never });
    await startLiveCall({ botId: "b1", threadId: "t1", provider: "elevenlabs" });
    const [, init] = request.mock.calls.find(([path]) => path === "/api/live/session")! as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ botId: "b1", threadId: "t1", client: "web" });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(startFish).not.toHaveBeenCalled();
    expect(startGemini).not.toHaveBeenCalled();
    expect(startElevenLabs).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: SESSION }));
    expect(liveMedia()).toMatchObject({ phase: "starting", callId: "c1", provider: "elevenlabs" });
  });
});
