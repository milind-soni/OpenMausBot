import { describe, expect, it } from "vitest";
import { GEMINI_PREBUILT_VOICES, GEMINI_TTS_DEFAULT_MODEL, listVoices } from "./gemini.ts";

describe("gemini tts", () => {
  it("exports prebuilt voices with ids and labels", () => {
    expect(GEMINI_PREBUILT_VOICES.length).toBeGreaterThan(10);
    const puck = GEMINI_PREBUILT_VOICES.find((v) => v.id === "Puck");
    expect(puck).toBeDefined();
    expect(puck?.label).toBe("Puck");
    expect(puck?.description).toBe("Upbeat");
  });

  it("defaults to gemini-3.8-flash-lite-tts", () => {
    expect(GEMINI_TTS_DEFAULT_MODEL).toBe("gemini-3.8-flash-lite-tts");
  });

  it("returns fallback prebuilt voices when remote list fails", async () => {
    // Calling with an invalid key / non-mocked unreachable endpoint falls back gracefully
    const voices = await listVoices("invalid-dummy-key");
    expect(voices.length).toBe(GEMINI_PREBUILT_VOICES.length);
    expect(voices[0].id).toBe("Puck");
  });
});
