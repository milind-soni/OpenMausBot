import { expect, it } from "vitest";
import { parseSteerKey, shortcutConflict, steersMessage, steerKeyLabel } from "./steer-key";
const key = (overrides: Partial<KeyboardEvent> = {}) => ({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 13, ...overrides });
it("defaults to disabled, preserving existing modifier send behavior", () => {
  for (const value of [null, undefined, "", "unknown"]) expect(parseSteerKey(value)).toBe("off");
  expect(steersMessage(key({ metaKey: true }), "off")).toBe(false);
});
it("matches only the selected modifier combination", () => {
  expect(steersMessage(key({ metaKey: true }), "mod")).toBe(true);
  expect(steersMessage(key({ ctrlKey: true }), "mod")).toBe(true);
  expect(steersMessage(key({ metaKey: true, shiftKey: true }), "mod")).toBe(false);
  expect(steersMessage(key({ ctrlKey: true, shiftKey: true }), "mod-shift")).toBe(true);
  expect(steersMessage(key({ altKey: true }), "alt")).toBe(true);
  expect(steersMessage(key({ altKey: true, ctrlKey: true }), "alt")).toBe(false);
});
it("leaves IME conversion and non-Enter keys alone", () => {
  for (const overrides of [{ isComposing: true }, { keyCode: 229 }, { key: "Process" }]) expect(steersMessage(key({ metaKey: true, ...overrides }), "mod")).toBe(false);
});
it("detects ambiguous configured sends and names platform-specific keys", () => {
  expect(shortcutConflict("mod-enter", "mod")).toBe(true);
  expect(shortcutConflict("enter", "mod")).toBe(false);
  expect(steerKeyLabel("mod", true)).toBe("⌘+Enter");
  expect(steerKeyLabel("mod-shift", false)).toBe("Ctrl+Shift+Enter");
  expect(steerKeyLabel("alt", true)).toBe("Option+Enter");
});
