import { describe, expect, it, vi } from "vitest";
import { createSpeechSegments } from "./transcription";

const voice = new Float32Array(16000).fill(.1), silence = new Float32Array(16000);
function fixture(transcribe = vi.fn(async (_pcm: ArrayBuffer) => "recognized")) {
  const onText = vi.fn(), onError = vi.fn();
  return { transcribe, onText, onError, audio: createSpeechSegments({ transcribe, onText, onError }) };
}
describe("speech segmentation", () => {
  it("does not upload silence", async () => {
    const f = fixture(); f.audio.push(silence, 16000); await f.audio.finish(); expect(f.transcribe).not.toHaveBeenCalled();
  });
  it("preserves segment order and flushes trailing speech when stopped", async () => {
    const f = fixture(vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second"));
    f.audio.push(voice, 16000); f.audio.push(silence, 16000); f.audio.push(voice, 16000);
    expect(await f.audio.finish()).toBe("first second"); expect(f.onText).toHaveBeenLastCalledWith("first second");
    expect(f.transcribe).toHaveBeenCalledTimes(2);
  });
  it("ignores late responses after cancellation", async () => {
    let resolve!: (text: string) => void;
    const f = fixture(vi.fn(() => new Promise<string>(done => { resolve = done; })));
    f.audio.push(voice, 16000); const done = f.audio.finish(); await Promise.resolve();
    f.audio.cancel(); resolve("late text"); await done; expect(f.onText).not.toHaveBeenCalled();
  });
  it("reports provider failure and does not submit further queued segments", async () => {
    const f = fixture(vi.fn().mockRejectedValue(new Error("service unavailable")));
    f.audio.push(voice, 16000); f.audio.push(silence, 16000); f.audio.push(voice, 16000); await f.audio.finish();
    expect(f.onError).toHaveBeenCalledWith("service unavailable"); expect(f.transcribe).toHaveBeenCalledTimes(1);
  });
  it("downsamples 48kHz input and bounds each upload", async () => {
    const f = fixture(); f.audio.push(new Float32Array(48000).fill(.2), 48000); await f.audio.finish();
    expect(f.transcribe.mock.calls[0]![0].byteLength).toBe(32000);
  });
});
