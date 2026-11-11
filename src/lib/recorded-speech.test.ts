import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/state/api")>()), api: sent.api }));

import { ApiError } from "@/state/api";
import { t } from "./i18n";
import { createClip, createEndpointer, encodeWav, recordedSpeech, rms } from "./recorded-speech";

const FRAME_MS = 64;
const loud = () => new Float32Array(1024).fill(0.2);
const quiet = () => new Float32Array(1024);
const heardFor = (feed: (level: number) => string, level: number, frames: number) => {
  let last = "";
  for (let i = 0; i < frames; i += 1) last = feed(level);
  return last;
};

describe("endpointer", () => {
  it("hears speech only after a few loud frames in a row", () => {
    const feed = createEndpointer(850);
    expect(feed(0.2)).toBe("waiting");
    expect(feed(0)).toBe("waiting");
    expect(heardFor(feed, 0.2, 2)).toBe("waiting");
    expect(feed(0.2)).toBe("speaking");
  });

  it("ends a call turn after the endpoint of quiet that follows speech", () => {
    const feed = createEndpointer(850);
    heardFor(feed, 0.2, 5);
    expect(heardFor(feed, 0, Math.ceil(850 / FRAME_MS) - 1)).toBe("speaking");
    expect(feed(0)).toBe("done");
  });

  it("never ends on quiet alone before speech, and stops a call turn at 60 s", () => {
    const feed = createEndpointer(850);
    expect(heardFor(feed, 0, Math.floor(60_000 / FRAME_MS) - 1)).toBe("waiting");
    expect(heardFor(feed, 0, 2)).toBe("done");
  });

  it("keeps a manual capture going through quiet and stops it at 5 minutes", () => {
    const feed = createEndpointer(undefined);
    heardFor(feed, 0.2, 5);
    expect(heardFor(feed, 0, Math.floor(10_000 / FRAME_MS))).toBe("speaking");
    expect(heardFor(feed, 0, Math.ceil(300_000 / FRAME_MS))).toBe("done");
  });
});

describe("clip", () => {
  const fill = (clip: ReturnType<typeof createClip>, feed: ReturnType<typeof createEndpointer>, levels: number[]) => {
    for (const level of levels) clip.push(level ? loud() : quiet(), level, feed(level));
  };

  it("is empty when nothing was said", () => {
    const clip = createClip();
    fill(clip, createEndpointer(850), Array(40).fill(0));
    expect(clip.spoke).toBe(false);
    expect(clip.frames()).toEqual([]);
  });

  it("keeps about 400 ms before speech and a short tail after it", () => {
    const clip = createClip();
    fill(clip, createEndpointer(850), [...Array(60).fill(0), ...Array(10).fill(0.2), ...Array(14).fill(0)]);
    expect(clip.spoke).toBe(true);
    const levels = clip.frames().map(rms);
    const first = levels.findIndex((level) => level > 0);
    const last = levels.findLastIndex((level) => level > 0);
    expect(first).toBeGreaterThanOrEqual(Math.ceil(400 / FRAME_MS));
    expect(first).toBeLessThan(Math.ceil(600 / FRAME_MS));
    expect(levels.length - 1 - last).toBe(Math.ceil(400 / FRAME_MS));
  });
});

describe("encodeWav", () => {
  it("writes 16-bit mono PCM at the given rate, clamped", () => {
    const wav = encodeWav([new Float32Array([0, 1, -1, 2])], 16_000);
    const view = new DataView(wav.buffer);
    const text = (at: number) => String.fromCharCode(...wav.slice(at, at + 4));
    expect([text(0), text(8), text(36)]).toEqual(["RIFF", "WAVE", "data"]);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767]);
  });
});

describe("Fish Audio listener", () => {
  let process: ((frame: Float32Array) => void) | undefined;
  let tracksStopped: number;
  let contextsClosed: number;
  let getUserMedia: ReturnType<typeof vi.fn>;
  const lines: unknown[] = [];
  const ends: unknown[] = [];
  const offs: Array<() => void> = [];

  class FakeProcessor {
    onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null = null;
    connect() {}
    disconnect() {}
  }
  class FakeContext {
    destination = {};
    constructor(readonly options: { sampleRate: number }) {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      const processor = new FakeProcessor();
      process = (frame) => processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame } });
      return processor;
    }
    async resume() {}
    async close() { contextsClosed += 1; }
  }
  const stream = () => ({ getTracks: () => [{ stop: () => { tracksStopped += 1; } }] });

  beforeEach(() => {
    process = undefined;
    tracksStopped = 0;
    contextsClosed = 0;
    lines.length = 0;
    ends.length = 0;
    sent.api.mockReset();
    sent.api.mockResolvedValue({ text: "hello bot" });
    getUserMedia = vi.fn(async () => stream());
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("AudioContext", FakeContext);
    offs.push(recordedSpeech.onSpeechTranscript((line) => lines.push(line)), recordedSpeech.onSpeechEnd((info) => ends.push(info)));
  });

  afterEach(async () => {
    await recordedSpeech.speechStop();
    offs.splice(0).forEach((off) => off());
    vi.unstubAllGlobals();
  });

  const feed = (frame: () => Float32Array, count: number) => { for (let i = 0; i < count; i += 1) process!(frame()); };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("hears a call turn: one 'hearing you' line, the clip uploaded as WAV, then the text and a completed end", async () => {
    await recordedSpeech.speechStart({ endpointMs: 850 });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    feed(quiet, 5);
    feed(loud, 10);
    expect(lines).toEqual([{ partial: true, text: "…" }]);
    feed(quiet, 14);
    await settle();
    const [path, init] = sent.api.mock.calls[0]!;
    expect(path).toBe("/api/tts/transcribe");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "audio/wav" });
    expect(new TextDecoder().decode(init.body.slice(0, 4))).toBe("RIFF");
    expect(lines).toEqual([{ partial: true, text: "…" }, { partial: false, text: "hello bot" }]);
    expect(ends).toEqual([{ code: 0, reason: "completed" }]);
    expect(tracksStopped).toBe(1);
    expect(contextsClosed).toBe(1);
  });

  it("uploads the clip naming the destination it was recorded for", async () => {
    await recordedSpeech.speechStart({ endpointMs: 850, destination: "openai http://localhost:8000/v1" });
    feed(loud, 10);
    feed(quiet, 14);
    await settle();
    expect(sent.api.mock.calls[0]![1].headers).toEqual({
      "content-type": "audio/wav", "x-omb-stt-destination": encodeURIComponent("openai http://localhost:8000/v1"),
    });
  });

  it("ends a turn that heard no speech without sending anything", async () => {
    await recordedSpeech.speechStart({ endpointMs: 850 });
    feed(quiet, 20);
    await recordedSpeech.speechFinish();
    expect(sent.api).not.toHaveBeenCalled();
    expect(ends).toEqual([{ code: 0, reason: "completed" }]);
    expect(tracksStopped).toBe(1);
  });

  it("ends a turn with no text without a final line, so a call listens once", async () => {
    sent.api.mockResolvedValue({ text: "  " });
    await recordedSpeech.speechStart({ endpointMs: 850 });
    feed(loud, 5);
    await recordedSpeech.speechFinish();
    await settle();
    expect(lines.filter((line) => (line as { partial: boolean }).partial === false)).toEqual([]);
    expect(ends).toEqual([{ code: 0, reason: "completed" }]);
  });

  it("captures a manual clip until it is finished, with no partial line", async () => {
    await recordedSpeech.speechStart();
    feed(loud, 5);
    feed(quiet, 40);
    expect(sent.api).not.toHaveBeenCalled();
    await recordedSpeech.speechFinish();
    await settle();
    expect(sent.api).toHaveBeenCalledOnce();
    expect(lines).toEqual([{ partial: false, text: "hello bot" }]);
    expect(ends).toEqual([{ code: 0, reason: "completed" }]);
  });

  it("emits nothing when stopped while listening", async () => {
    await recordedSpeech.speechStart({ endpointMs: 850 });
    feed(loud, 5);
    lines.length = 0;
    await recordedSpeech.speechStop();
    await settle();
    expect(sent.api).not.toHaveBeenCalled();
    expect({ lines, ends }).toEqual({ lines: [], ends: [] });
    expect(tracksStopped).toBe(1);
  });

  it("aborts the upload and emits nothing when stopped while it is in flight", async () => {
    let signal: AbortSignal | undefined;
    sent.api.mockImplementation((_path, init) => new Promise((_resolve, reject) => {
      signal = init.signal;
      signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    await recordedSpeech.speechStart();
    feed(loud, 5);
    await recordedSpeech.speechFinish();
    await recordedSpeech.speechStop();
    await settle();
    expect(signal!.aborted).toBe(true);
    expect({ lines, ends }).toEqual({ lines: [], ends: [] });
  });

  it("never speaks for a session that was replaced during the upload", async () => {
    let release!: (value: { text: string }) => void;
    sent.api.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await recordedSpeech.speechStart();
    feed(loud, 5);
    await recordedSpeech.speechFinish();
    await recordedSpeech.speechStart({ endpointMs: 850 });
    release({ text: "stale" });
    await settle();
    expect({ lines, ends }).toEqual({ lines: [], ends: [] });
  });

  it("releases a microphone that was granted after the session was stopped", async () => {
    let grant!: (value: ReturnType<typeof stream>) => void;
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => { grant = resolve; }));
    const started = recordedSpeech.speechStart({ endpointMs: 850 });
    await recordedSpeech.speechStop();
    grant(stream());
    await started;
    expect(tracksStopped).toBe(1);
    expect(contextsClosed).toBe(1);
    expect({ lines, ends }).toEqual({ lines: [], ends: [] });
  });

  it("ends a finish that arrives before the microphone opened", async () => {
    getUserMedia.mockImplementationOnce(() => new Promise(() => {}));
    void recordedSpeech.speechStart();
    await recordedSpeech.speechFinish();
    expect(ends).toEqual([{ code: 0, reason: "completed" }]);
  });

  it.each([
    ["NotAllowedError", { code: 1, reason: "microphone-blocked", message: t("call.live.micBlocked") }],
    ["NotFoundError", { code: 1, reason: "microphone-missing", message: t("call.live.micMissing") }],
    ["AbortError", { code: 1, reason: "microphone-failed" }],
  ])("ends a %s microphone failure with a reason", async (name, end) => {
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error(name), { name }));
    await recordedSpeech.speechStart({ endpointMs: 850 });
    expect(ends).toEqual([end]);
  });

  it("reports the server's message when the upload fails", async () => {
    sent.api.mockRejectedValue(new ApiError("Fish Audio rejected that API key.", 502));
    await recordedSpeech.speechStart();
    feed(loud, 5);
    await recordedSpeech.speechFinish();
    await settle();
    expect(ends).toEqual([{ code: 1, reason: "transcribe-failed", message: "Fish Audio rejected that API key." }]);
  });
});
