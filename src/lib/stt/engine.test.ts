import { beforeEach, describe, expect, it, vi } from "vitest";

import { SttRequestError, UniversalSpeechEngine, type SpeechEndInfo, type TranscriptLine } from "./engine";

type Sink = ((pcm: Int16Array, rms: number) => void) | null;

function fakeMic(options: { fail?: DOMException } = {}) {
  const mic = {
    sink: null as Sink,
    opened: 0,
    closed: 0,
    open: vi.fn(async () => {
      if (options.fail) throw options.fail;
      mic.opened += 1;
    }),
    attach: vi.fn((sink: Sink) => {
      mic.sink = sink;
    }),
    close: vi.fn(() => {
      mic.closed += 1;
      mic.sink = null;
    }),
  };
  return mic;
}

function frames(mic: ReturnType<typeof fakeMic>, rms: number, ms: number) {
  for (let t = 0; t < ms; t += 20) mic.sink?.(new Int16Array(320), rms);
}

/** Calibrate, speak, then fall silent long enough to end the turn. */
function speakTurn(mic: ReturnType<typeof fakeMic>) {
  frames(mic, 0.002, 400);
  frames(mic, 0.2, 800);
  frames(mic, 0.002, 1000);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("UniversalSpeechEngine", () => {
  let mic: ReturnType<typeof fakeMic>;
  let transport: ReturnType<typeof vi.fn<(wav: Uint8Array, signal: AbortSignal) => Promise<string>>>;
  let engine: UniversalSpeechEngine;
  let lines: TranscriptLine[];
  let ends: SpeechEndInfo[];

  beforeEach(() => {
    mic = fakeMic();
    transport = vi.fn(async () => "hello there");
    engine = new UniversalSpeechEngine({ transport, microphone: () => mic, warmHoldMs: 50 });
    lines = [];
    ends = [];
    engine.onTranscript((line) => lines.push(line));
    engine.onEnd((info) => ends.push(info));
  });

  it("ends a call-mode turn on silence with a final transcript, then end", async () => {
    await engine.start({ endpointMs: 800 });
    speakTurn(mic);
    await flush();
    expect(transport).toHaveBeenCalledTimes(1);
    const wav = transport.mock.calls[0]![0];
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(lines).toEqual([{ partial: false, text: "hello there" }]);
    expect(ends).toEqual([{ code: 0, reason: "completed" }]);
  });

  it("gates the mic the moment the turn ends (half-duplex)", async () => {
    let release!: (text: string) => void;
    transport.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    await engine.start({ endpointMs: 800 });
    speakTurn(mic);
    expect(mic.attach).toHaveBeenLastCalledWith(null);
    release("ok");
    await flush();
    expect(ends).toHaveLength(1);
  });

  it("stop() is silent even when a transcription lands afterwards", async () => {
    let release!: (text: string) => void;
    transport.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    await engine.start({ endpointMs: 800 });
    speakTurn(mic);
    await engine.stop();
    release("late words");
    await flush();
    expect(lines).toEqual([]);
    expect(ends).toEqual([]);
  });

  it("a restart from inside the final-transcript callback suppresses the old end", async () => {
    transport.mockResolvedValue("");
    engine.onTranscript((line) => {
      if (line.partial === false && !line.text) void engine.start({ endpointMs: 800 });
    });
    await engine.start({ endpointMs: 800 });
    speakTurn(mic);
    await flush();
    expect(lines).toEqual([{ partial: false, text: "" }]);
    expect(ends).toEqual([]);
    expect(mic.sink).not.toBeNull(); // listening again
  });

  it("manual mode runs until finish() and returns the whole text", async () => {
    await engine.start();
    frames(mic, 0.002, 400);
    frames(mic, 0.2, 800);
    frames(mic, 0.002, 3000); // long pause: manual mode must not end
    expect(transport).not.toHaveBeenCalled();
    await engine.finish();
    expect(lines.at(-1)).toEqual({ partial: false, text: "hello there" });
    expect(ends).toEqual([{ code: 0, reason: "completed" }]);
    expect(mic.closed).toBe(1); // dictation releases the device at once
  });

  it("drops the classic whisper hallucination on a short clip", async () => {
    transport.mockResolvedValue("Thanks for watching!");
    await engine.start({ endpointMs: 800 });
    speakTurn(mic);
    await flush();
    expect(lines).toEqual([{ partial: false, text: "" }]);
  });

  it("keeps a genuine short thank-you", async () => {
    transport.mockResolvedValue("Thank you.");
    await engine.start({ endpointMs: 800 });
    speakTurn(mic);
    await flush();
    expect(lines).toEqual([{ partial: false, text: "Thank you." }]);
  });

  it("reports an unconfigured provider as a distinct end reason", async () => {
    transport.mockRejectedValue(new SttRequestError(409, "Choose a provider.", "provider"));
    await engine.start({ endpointMs: 800 });
    speakTurn(mic);
    await flush();
    expect(ends).toEqual([{ code: 1, reason: "stt-not-configured", message: "Choose a provider." }]);
  });

  it("reports a blocked microphone", async () => {
    const denied = fakeMic({ fail: new DOMException("no", "NotAllowedError") });
    const e = new UniversalSpeechEngine({ transport, microphone: () => denied });
    const got: SpeechEndInfo[] = [];
    e.onEnd((info) => got.push(info));
    await e.start({ endpointMs: 800 });
    expect(got[0]?.reason).toBe("mic-permission");
  });

  it("keeps the call mic warm between turns and closes it on release()", async () => {
    await engine.start({ endpointMs: 800 });
    await engine.stop();
    await engine.start({ endpointMs: 800 });
    expect(mic.opened).toBe(2); // same device object re-opened, never closed
    expect(mic.closed).toBe(0);
    engine.release();
    expect(mic.closed).toBe(1);
  });
});

/** Stubs getUserMedia / AudioContext / AudioWorkletNode; getUserMedia stays
 * pending until `resolveMedia()` so tests can race it against close()/attach(). */
function fakeMediaStack() {
  let resolveMedia: (stream: unknown) => void = () => {};
  const mediaPromise = new Promise((resolve) => {
    resolveMedia = resolve;
  });
  const track = { stop: vi.fn(), enabled: true };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };

  const globals = globalThis as unknown as { AudioContext: unknown; AudioWorkletNode: unknown };
  const originalMediaDevices = navigator.mediaDevices;
  const originalAudioContext = globals.AudioContext;
  const originalAudioWorkletNode = globals.AudioWorkletNode;

  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: vi.fn(() => mediaPromise) },
    configurable: true,
  });
  globals.AudioContext = class {
    sampleRate = 16000;
    state = "running";
    audioWorklet = { addModule: vi.fn(async () => {}) };
    createMediaStreamSource() {
      return { connect: vi.fn() };
    }
    close = vi.fn(async () => {});
  };
  globals.AudioWorkletNode = class {
    port = { onmessage: null, close: vi.fn() };
    disconnect = vi.fn();
  };

  return {
    track,
    resolveMedia: () => resolveMedia(stream),
    restore() {
      Object.defineProperty(navigator, "mediaDevices", { value: originalMediaDevices, configurable: true });
      globals.AudioContext = originalAudioContext;
      globals.AudioWorkletNode = originalAudioWorkletNode;
    },
  };
}

describe("Microphone lifecycle", () => {
  it("serializes concurrent open() calls and invalidates in-flight acquisitions on close()", async () => {
    const { Microphone } = await import("./engine");
    const media = fakeMediaStack();
    try {
      const mic = new Microphone();
      const p1 = mic.open();
      const p2 = mic.open();
      expect(p1).toBe(p2);

      mic.close();

      media.resolveMedia();
      await p1;

      expect(media.track.stop).toHaveBeenCalledTimes(1);
    } finally {
      media.restore();
    }
  });

  it("keeps a stream acquired after stop() gated until a session attaches", async () => {
    const { Microphone } = await import("./engine");
    const media = fakeMediaStack();
    try {
      const mic = new Microphone();
      const opening = mic.open();
      mic.attach(null); // stop() while getUserMedia is still pending

      media.resolveMedia();
      await opening;

      expect(media.track.stop).not.toHaveBeenCalled(); // warm, not released
      expect(media.track.enabled).toBe(false);

      mic.attach(() => {});
      expect(media.track.enabled).toBe(true);
      mic.attach(null);
      expect(media.track.enabled).toBe(false);
    } finally {
      media.restore();
    }
  });
});
