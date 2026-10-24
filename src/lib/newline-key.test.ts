// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { insertsNewline, NEWLINE_KEY_KEY, newlineKeyConflict, newlineKeyLabel, parseNewlineKey, setNewlineKey, useNewlineKey } from "./newline-key";
const event = (overrides: Partial<KeyboardEvent> = {}) => ({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 13, ...overrides });
afterEach(() => { setNewlineKey("auto"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("keeps existing behavior for absent or invalid settings", () => {
  for (const value of [null, undefined, "", "garbage"]) expect(parseNewlineKey(value)).toBe("auto");
  expect(insertsNewline(event(), "auto")).toBe(false);
});
it("requires exact modifiers and leaves IME confirmation alone", () => {
  expect(insertsNewline(event(), "enter")).toBe(true);
  expect(insertsNewline(event({ shiftKey: true }), "enter")).toBe(false);
  expect(insertsNewline(event({ shiftKey: true }), "shift-enter")).toBe(true);
  expect(insertsNewline(event({ ctrlKey: true, shiftKey: true }), "shift-enter")).toBe(false);
  expect(insertsNewline(event({ metaKey: true }), "mod")).toBe(true);
  expect(insertsNewline(event({ ctrlKey: true, shiftKey: true }), "mod-shift")).toBe(true);
  expect(insertsNewline(event({ altKey: true }), "alt")).toBe(true);
  for (const overrides of [{ isComposing: true }, { keyCode: 229 }, { key: "Process" }]) {
    expect(insertsNewline(event({ shiftKey: true, ...overrides }), "shift-enter")).toBe(false);
  }
});
it("finds only configured overlaps and labels both platforms", () => {
  expect(newlineKeyConflict("auto", "enter", "mod")).toBe(false);
  expect(newlineKeyConflict("enter", "enter", "mod")).toBe(true);
  expect(newlineKeyConflict("shift-enter", "shift-enter")).toBe(true);
  expect(newlineKeyConflict("mod", "mod-enter")).toBe(true);
  expect(newlineKeyConflict("alt", "enter", "alt")).toBe(true);
  expect(newlineKeyConflict("mod-shift", "enter", "mod")).toBe(false);
  expect(newlineKeyLabel("mod", true)).toBe("⌘+Enter");
  expect(newlineKeyLabel("alt", false)).toBe("Alt+Enter");
});
it("persists, updates mounted settings, and adopts another window's changes", () => {
  const memory = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
  });
  const host = document.createElement("div"); const root = createRoot(host);
  const Probe = () => createElement("span", null, useNewlineKey());
  try {
    flushSync(() => root.render(createElement(Probe)));
    flushSync(() => setNewlineKey("shift-enter"));
    expect(memory.get(NEWLINE_KEY_KEY)).toBe("shift-enter");
    expect(host.textContent).toBe("shift-enter");
    memory.set(NEWLINE_KEY_KEY, "alt");
    flushSync(() => window.dispatchEvent(new StorageEvent("storage", { key: NEWLINE_KEY_KEY })));
    expect(host.textContent).toBe("alt");
    memory.delete(NEWLINE_KEY_KEY);
    flushSync(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));
    expect(host.textContent).toBe("auto");
  } finally { flushSync(() => root.unmount()); }
});
