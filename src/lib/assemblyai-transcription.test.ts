import { describe, expect, it } from "vitest";

import {
  mergeAssemblyAITurn,
  pcm16FromFloat32,
  type AssemblyAITranscript,
} from "./assemblyai-transcription";

const empty = (): AssemblyAITranscript => ({ turns: new Map(), finalText: "", partialText: "" });

describe("AssemblyAI streaming transcription", () => {
  it("replaces a partial with the formatted final turn instead of duplicating it", () => {
    const partial = mergeAssemblyAITurn(empty(), { order: 0, text: "open settings", final: false });
    const final = mergeAssemblyAITurn(partial, { order: 0, text: "Open Settings.", final: true });
    expect(final.finalText).toBe("Open Settings.");
    expect(final.partialText).toBe("");
  });

  it("keeps finalized turns ordered when updates arrive out of order", () => {
    const second = mergeAssemblyAITurn(empty(), { order: 1, text: "Then save.", final: true });
    const first = mergeAssemblyAITurn(second, { order: 0, text: "Choose the file.", final: true });
    expect(first.finalText).toBe("Choose the file. Then save.");
  });

  it("resamples and clamps browser floats as signed little-endian PCM16", () => {
    const bytes = pcm16FromFloat32(new Float32Array([-2, 0, 2, 0]), 32_000, 16_000);
    const samples = new Int16Array(bytes);
    expect([...samples]).toEqual([-32768, 32767]);
  });
});
