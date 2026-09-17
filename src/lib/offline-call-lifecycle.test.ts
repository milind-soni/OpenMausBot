import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfflineCallStt, MAX_UTTERANCE_SAMPLES } from "./offline-call-stt";

function harness(fail = false) {
  let allow!: (stream: MediaStream) => void;
  const permission = new Promise<MediaStream>((resolve) => { allow = resolve; });
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const processor = { ...node(), onaudioprocess: null as ((e: AudioProcessingEvent) => void) | null };
  const close = vi.fn().mockResolvedValue(undefined);
  const context = vi.fn(function () {
    if (fail) throw new Error("setup failed");
    return { close, destination: {}, createMediaStreamSource: node, createScriptProcessor: () => processor,
      createGain: () => ({ ...node(), gain: { value: 0 } }) };
  });
  const decodes: Array<(result: { ok: boolean; text: string }) => void> = [];
  const transcribe = vi.fn((_wav: ArrayBuffer) => new Promise<{ ok: boolean; text: string }>((resolve) => decodes.push(resolve)));
  const getUserMedia = vi.fn(() => permission);
  vi.stubGlobal("window", { ogb: { handyTranscribeFile: transcribe } });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("AudioContext", context);
  const onUtterance = vi.fn();
  const onError = vi.fn();
  const session = createOfflineCallStt({ onUtterance, onError })!;
  const frame = (value = 0.5) => processor.onaudioprocess?.({ inputBuffer: {
    getChannelData: () => new Float32Array(4096).fill(value),
  } } as unknown as AudioProcessingEvent);
  const endpoint = () => { frame(); frame(0); frame(0); frame(0); };
  return { session, allow: () => allow(stream), stop, close, context, getUserMedia, frame, endpoint, transcribe, decodes, onUtterance, onError };
}

afterEach(() => vi.unstubAllGlobals());

describe("offline call capture lifecycle", () => {
  it("releases late permission after hangup", async () => {
    const h = harness();
    const pending = h.session.start();
    h.session.stop(); h.allow(); await pending;
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.context).not.toHaveBeenCalled();
  });
  it("closes the microphone after audio setup fails", async () => {
    const h = harness(true); h.allow();
    await expect(h.session.start()).rejects.toThrow("setup failed");
    expect(h.stop).toHaveBeenCalledOnce();
  });
  it("reuses one graph across turns and respects mute/unmute", async () => {
    const h = harness(); h.allow(); await h.session.start();
    h.session.setMuted(true); h.endpoint();
    expect(h.transcribe).not.toHaveBeenCalled();
    h.session.setMuted(false); await h.session.start(); h.endpoint();
    expect(h.getUserMedia).toHaveBeenCalledOnce();
    expect(h.transcribe).toHaveBeenCalledOnce();
    h.session.stop(); h.decodes[0]({ ok: true, text: "late" });
    await Promise.resolve();
    expect(h.onUtterance).not.toHaveBeenCalled();
  });
  it("bounds the pending recording while Handy decodes", async () => {
    const h = harness(); h.allow(); await h.session.start(); h.endpoint();
    for (let n = 0; n < MAX_UTTERANCE_SAMPLES + 100_000; n += 4096) h.frame();
    expect(h.transcribe).toHaveBeenCalledOnce();
    h.decodes[0]({ ok: true, text: "first" }); await Promise.resolve();
    expect(h.transcribe).toHaveBeenCalledTimes(2);
    const wav = h.transcribe.mock.calls[1][0];
    expect(new DataView(wav).getUint32(40, true)).toBe(MAX_UTTERANCE_SAMPLES * 2);
    h.session.stop(); h.decodes[1]({ ok: true, text: "ignored" }); await Promise.resolve();
    expect(h.onUtterance).toHaveBeenCalledExactlyOnceWith("first");
  });

  it("holds the turn open past the silence endpointer, then finishes on release", async () => {
    const h = harness(); h.allow(); await h.session.start();
    h.session.holdTurn(true);
    // Voice followed by the full silence run: without the hold this is exactly
    // what finalizes a turn, and shipping it here would cut the user off at
    // their first pause.
    h.endpoint();
    expect(h.transcribe).not.toHaveBeenCalled();
    h.session.finishTurn();
    expect(h.transcribe).toHaveBeenCalledOnce();
    h.decodes[0]({ ok: true, text: "held turn" });
    await Promise.resolve();
    expect(h.onUtterance).toHaveBeenCalledWith("held turn");
  });
});
