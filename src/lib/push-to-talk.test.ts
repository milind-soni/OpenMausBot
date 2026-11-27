import { describe, expect, it } from "vitest";

import { isPushToTalkPress } from "./push-to-talk";

describe("isPushToTalkPress", () => {
  it("starts only when Control and Option are held on a modifier keydown", () => {
    expect(isPushToTalkPress({ code: "ControlLeft", ctrlKey: true, altKey: true, repeat: false })).toBe(true);
    expect(isPushToTalkPress({ code: "AltRight", ctrlKey: true, altKey: true, repeat: false })).toBe(true);
    expect(isPushToTalkPress({ code: "KeyK", ctrlKey: true, altKey: true, repeat: false })).toBe(false);
    expect(isPushToTalkPress({ code: "ControlLeft", ctrlKey: true, altKey: false, repeat: false })).toBe(false);
    expect(isPushToTalkPress({ code: "ControlLeft", ctrlKey: true, altKey: true, repeat: true })).toBe(false);
  });
});
