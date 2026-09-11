import { describe, expect, it } from "vitest";

import { floatToPcm16, isDictationPress, isDictationRelease } from "./clipboard-dictation";

describe("isDictationPress", () => {
  it("starts only on a plain Ctrl+Space keydown", () => {
    expect(isDictationPress({ code: "Space", ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, repeat: false })).toBe(true);
    expect(isDictationPress({ code: "Space", ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, repeat: false })).toBe(false);
    expect(isDictationPress({ code: "Space", ctrlKey: true, altKey: false, metaKey: true, shiftKey: false, repeat: false })).toBe(false);
    expect(isDictationPress({ code: "Space", ctrlKey: true, altKey: false, metaKey: false, shiftKey: true, repeat: false })).toBe(false);
    expect(isDictationPress({ code: "Space", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, repeat: false })).toBe(false);
    expect(isDictationPress({ code: "Space", ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, repeat: true })).toBe(false);
    // other keys with ctrl held (⌘K, ⌘F, ⌘1-9 …) stay free for their owners
    expect(isDictationPress({ code: "KeyK", ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, repeat: false })).toBe(false);
    expect(isDictationPress({ code: "ControlLeft", ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, repeat: false })).toBe(false);
  });
});

describe("isDictationRelease", () => {
  it("finalizes on Space or either Control keyup — the combo releases in either order", () => {
    expect(isDictationRelease({ code: "Space", ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, repeat: false })).toBe(true);
    expect(isDictationRelease({ code: "ControlLeft", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, repeat: false })).toBe(true);
    expect(isDictationRelease({ code: "ControlRight", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, repeat: false })).toBe(true);
    expect(isDictationRelease({ code: "KeyA", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, repeat: false })).toBe(false);
  });
});

describe("floatToPcm16", () => {
  it("converts float samples to little-endian PCM16 with clamping", () => {
    const pcm = new DataView(floatToPcm16(new Float32Array([0, 0.5, -0.5, 2, -2])));
    expect(pcm.getInt16(0, true)).toBe(0);
    // Positive scales by 0x7fff (16383.5 rounds half toward zero to 16383);
    // negative by 0x8000, the standard PCM16 convention (-0.5 → -16384).
    expect(pcm.getInt16(2, true)).toBe(16383);
    expect(pcm.getInt16(4, true)).toBe(-16384);
    // out-of-range inputs clamp to the rails
    expect(pcm.getInt16(6, true)).toBe(32767);
    expect(pcm.getInt16(8, true)).toBe(-32768);
  });

  it("emits exactly two bytes per sample", () => {
    expect(floatToPcm16(new Float32Array(64)).byteLength).toBe(128);
    expect(floatToPcm16(new Float32Array(0)).byteLength).toBe(0);
  });
});
