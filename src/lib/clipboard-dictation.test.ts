import { describe, expect, it } from "vitest";

import { isDictationPress, isDictationRelease } from "./clipboard-dictation";

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
