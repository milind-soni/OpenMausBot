import { afterEach, describe, expect, it, vi } from "vitest";
import { createDictationCapture, MAX_CAPTURE_SAMPLES } from "./dictation-capture";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(failAt = "") {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  const permission = deferred<MediaStream>();
  const decode = deferred<{ ok: boolean; text?: string; error?: string }>();
  const transcribe = vi.fn(() => decode.promise);
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const source = node();
  const processor = { ...node(), onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null };
  const gain = { ...node(), gain: { value: 1 } };
  const close = vi.fn().mockResolvedValue(undefined);
  const setup = (name: string, value: unknown) => {
    if (failAt === name) throw new Error("setup failed");
    return value;
  };
  const context = vi.fn(function () {
    setup("constructor", null);
    return { close, destination: {}, createMediaStreamSource: () => setup("source", source),
      createScriptProcessor: () => setup("processor", processor), createGain: () => setup("gain", gain) };
  });
  const getUserMedia = vi.fn(() => permission.promise);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("window", { ogb: { handyTranscribeFile: transcribe } });
  vi.stubGlobal("AudioContext", context);
  const onError = vi.fn();
  const capture = createDictationCapture({ onError })!;
  const frame = (length = 4096, value = 0.5) => processor.onaudioprocess?.({
    inputBuffer: { getChannelData: () => new Float32Array(length).fill(value) },
  } as unknown as AudioProcessingEvent);
  return { capture, permission, decode, stream, stop, context, close, source, processor, gain, frame, transcribe, onError, getUserMedia };
}

afterEach(() => vi.unstubAllGlobals());

describe("dictation capture lifecycle", () => {
  it("caps memory and closes the mic without an auto-stop callback", async () => {
    const h = harness();
    h.permission.resolve(h.stream);
    await h.capture.start();
    for (let n = 0; n < MAX_CAPTURE_SAMPLES + 8192; n += 4096) h.frame();
    expect(h.stop).toHaveBeenCalledTimes(1);
    const result = h.capture.transcribe();
    const wav = h.transcribe.mock.calls[0] as unknown as [ArrayBuffer];
    expect(new DataView(wav[0]).getUint32(40, true)).toBe(MAX_CAPTURE_SAMPLES * 2);
    h.decode.resolve({ ok: true, text: "bounded" });
    await expect(result).resolves.toBe("bounded");
  });
  it.each(["discard", "transcribe"] as const)("closes late permission after %s without opening a graph", async (action) => {
    const h = harness();
    const started = h.capture.start();
    expect(h.capture.start()).toBe(started);
    await h.capture[action]();
    h.permission.resolve(h.stream);
    await started;
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.context).not.toHaveBeenCalled();
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("ignores a permission denial after cancellation", async () => {
    const h = harness();
    const started = h.capture.start();
    h.capture.discard();
    h.permission.reject(new Error("denied"));
    await expect(started).resolves.toBeUndefined();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it.each(["constructor", "source", "processor", "gain"])("cleans up %s setup failure", async (stage) => {
    const h = harness(stage);
    const started = h.capture.start();
    h.permission.resolve(h.stream);
    await expect(started).rejects.toThrow("setup failed");
    expect(h.stop).toHaveBeenCalledTimes(1);
    if (stage !== "constructor") expect(h.close).toHaveBeenCalledTimes(1);
    if (stage === "gain") {
      expect(h.source.disconnect).toHaveBeenCalledTimes(1);
      expect(h.processor.disconnect).toHaveBeenCalledTimes(1);
      expect(h.processor.onaudioprocess).toBeNull();
    }
  });

  it("shares one decode and trims the result", async () => {
    const h = harness();
    h.permission.resolve(h.stream);
    await h.capture.start();
    h.frame();
    const first = h.capture.transcribe();
    expect(h.capture.transcribe()).toBe(first);
    await h.capture.start();
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
    h.decode.resolve({ ok: true, text: " hello " });
    await expect(first).resolves.toBe("hello");
    expect(h.transcribe).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "error", "reject"])("drops late decode %s after discard", async (result) => {
    const h = harness();
    h.permission.resolve(h.stream);
    await h.capture.start();
    h.frame();
    const pending = h.capture.transcribe();
    h.capture.discard();
    if (result === "reject") h.decode.reject(new Error("failed"));
    else h.decode.resolve({ ok: result === "success", text: "stale", error: "failed" });
    await expect(pending).resolves.toBe("");
    expect(h.onError).not.toHaveBeenCalled();
  });
});
