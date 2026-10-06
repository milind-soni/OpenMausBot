import { describe, expect, it } from "vitest";
import {
  DICTATION_LANGUAGES,
  WHISPER_MODEL,
  dictationClickAction,
  dictationLanguage,
  encodeWavPcm16,
  resampleLinear,
} from "./dictation-languages.ts";

describe("dictation languages", () => {
  it("starts with automatic detection and keeps whisper codes unique", () => {
    expect(DICTATION_LANGUAGES[0]).toMatchObject({ id: "auto", whisper: "auto", tag: "" });
    expect(new Set(DICTATION_LANGUAGES.map((language) => language.whisper)).size).toBe(DICTATION_LANGUAGES.length);
    expect(dictationLanguage("nope").id).toBe("auto");
    expect(dictationLanguage("he").tag).toBe("he-IL");
  });

  it("alerts instead of recording until the engine is ready, then starts and stops a session", () => {
    expect(dictationClickAction({ listening: false, engineReady: false })).toBe("alert");
    expect(dictationClickAction({ listening: false, engineReady: true })).toBe("start");
    expect(dictationClickAction({ listening: true, engineReady: true })).toBe("stop");
    expect(dictationClickAction({ listening: true, engineReady: false })).toBe("stop");
  });

  it("names the turbo model the microphone downloads", () => {
    expect(WHISPER_MODEL).toMatchObject({
      id: "whisper-large-v3-turbo",
      label: "Whisper Large v3 Turbo",
      fileName: "ggml-large-v3-turbo.bin",
    });
  });
});

describe("dictation audio", () => {
  it("writes a 16-bit mono wav header", () => {
    const wav = encodeWavPcm16(new Float32Array([0, 1, -1]), 16000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
  });

  it("halves the sample count when the rate is halved", () => {
    const input = new Float32Array([0, 1, 0, 1]);
    expect(resampleLinear(input, 32000, 16000)).toHaveLength(2);
    expect(resampleLinear(input, 16000, 16000)).toBe(input);
  });
});
