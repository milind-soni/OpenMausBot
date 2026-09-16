import { describe, expect, it } from "vitest";

import {
  encodeWav,
  isSilentFrame,
  shouldFinalize,
  stepSilence,
  ENDPOINT_SILENCE_FRAMES,
  MAX_UTTERANCE_MS,
  MAX_UTTERANCE_SAMPLES,
  PCM_SAMPLE_RATE,
} from "./offline-call-stt";

describe("offline call STT endpointer", () => {
  it("counts silence and resets on voice", () => {
    expect(stepSilence(0, true)).toBe(1);
    expect(stepSilence(2, true)).toBe(3);
    expect(stepSilence(2, false)).toBe(0);
  });

  it("finalizes only after speech followed by the silence run", () => {
    expect(shouldFinalize(ENDPOINT_SILENCE_FRAMES, false)).toBe(false);
    expect(shouldFinalize(0, true)).toBe(false);
    expect(shouldFinalize(ENDPOINT_SILENCE_FRAMES, true)).toBe(true);
  });

  it("classifies loud frames as speech", () => {
    const loud = new Float32Array(256).fill(0.5);
    const quiet = new Float32Array(256).fill(0.0001);
    expect(isSilentFrame(loud)).toBe(false);
    expect(isSilentFrame(quiet)).toBe(true);
  });

  it("caps an utterance after MAX_UTTERANCE_MS of audio, not after one frame", () => {
    // Regression: the cap once multiplied captured SAMPLES by FRAME_MS,
    // force-finalizing after the first 4096-sample frame (~0.26 s) and
    // shredding every spoken turn into per-frame shards.
    expect(MAX_UTTERANCE_SAMPLES).toBe(Math.round((MAX_UTTERANCE_MS / 1000) * PCM_SAMPLE_RATE));
    expect(MAX_UTTERANCE_SAMPLES).toBe(960_000); // 60 s × 16 kHz
    // A single capture frame is far below the cap.
    expect(4096).toBeLessThan(MAX_UTTERANCE_SAMPLES);
  });
});

describe("offline call STT WAV encoding", () => {
  it("writes a valid 16 kHz mono 16-bit WAV header", () => {
    const samples = new Float32Array(1600).fill(0.25); // 100 ms
    const view = new DataView(encodeWav(samples));
    const magic = (offset: number, length: number) =>
      String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)));
    expect(magic(0, 4)).toBe("RIFF");
    expect(magic(8, 4)).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint16(34, true)).toBe(16); // bits
    expect(view.getUint32(40, true)).toBe(3200); // 1600 samples × 2 bytes
    expect(view.getUint32(4, true)).toBe(36 + 3200);
    // 0.25 positive → 0.25 × 0x7fff ≈ 8192
    expect(Math.abs(view.getInt16(44, true))).toBeGreaterThan(8000);
  });

  it("clamps out-of-range samples", () => {
    const view = new DataView(encodeWav(new Float32Array([2, -2])));
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
  });
});
