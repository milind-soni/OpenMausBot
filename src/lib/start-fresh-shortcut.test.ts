import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  chordFromKeyboardEvent,
  DEFAULT_START_FRESH_CHORD,
  DEFAULT_START_FRESH_SHORTCUT,
  formatCanonicalChord,
  isDefaultStartFreshShortcut,
  matchesShortcutChord,
  parseShortcutChord,
  readStartFreshShortcut,
  resetStartFreshShortcut,
  resetStartFreshShortcutCache,
  setStartFreshShortcut,
  shortcutChordKeys,
  shortcutConflict,
  START_FRESH_SHORTCUT_KEY,
} from "./start-fresh-shortcut";

const keyEvent = (overrides: Partial<KeyboardEvent> = {}) => ({
  key: "k",
  code: "KeyK",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  defaultPrevented: false,
  isComposing: false,
  keyCode: 0,
  ...overrides,
});

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear() { data.clear(); },
    getItem(key: string) { return data.get(key) ?? null; },
    key(index: number) { return [...data.keys()][index] ?? null; },
    removeItem(key: string) { data.delete(key); },
    setItem(key: string, value: string) { data.set(key, String(value)); },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  resetStartFreshShortcutCache();
});

afterEach(() => {
  resetStartFreshShortcutCache();
  vi.unstubAllGlobals();
});

describe("parseShortcutChord and formatting", () => {
  it("parses valid modifier chords into canonical strings and platform labels", () => {
    const chord = parseShortcutChord("MOD+Shift+k")!;
    expect(chord).toEqual({ mod: true, ctrl: false, alt: false, shift: true, key: "k" });
    expect(formatCanonicalChord(chord)).toBe(DEFAULT_START_FRESH_SHORTCUT);
    expect(shortcutChordKeys(chord, true)).toEqual(["⌘", "⇧", "K"]);
    expect(shortcutChordKeys(chord, false)).toEqual(["Ctrl", "Shift", "K"]);
    expect(isDefaultStartFreshShortcut(chord)).toBe(true);

    const bs = parseShortcutChord("mod+backspace")!;
    expect(shortcutChordKeys(bs, true)).toEqual(["⌘", "⌫"]);
    expect(shortcutChordKeys(bs, false)).toEqual(["Ctrl", "Backspace"]);
  });

  it("rejects empty, off, modifier-only, and unmodified keys", () => {
    expect(parseShortcutChord(null)).toBeNull();
    expect(parseShortcutChord("")).toBeNull();
    expect(parseShortcutChord("off")).toBeNull();
    expect(parseShortcutChord("k")).toBeNull();
    expect(parseShortcutChord("alt+k")).toBeNull();
    expect(parseShortcutChord("shift+escape")).toBeNull();
    expect(parseShortcutChord("mod+unknownkey")).toBeNull();
  });
});

describe("chordFromKeyboardEvent", () => {
  it("captures valid modifier chords on macOS and non-macOS", () => {
    expect(chordFromKeyboardEvent(keyEvent({ key: "L", code: "KeyL", metaKey: true, shiftKey: true }), true)).toEqual({
      ok: true,
      chord: { mod: true, ctrl: false, alt: false, shift: true, key: "l" },
    });
    expect(chordFromKeyboardEvent(keyEvent({ key: "L", code: "KeyL", ctrlKey: true, shiftKey: true }), false)).toEqual({
      ok: true,
      chord: { mod: true, ctrl: false, alt: false, shift: true, key: "l" },
    });
  });

  it("recovers physical letter/digit when Option produces symbol glyphs or layout is non-Latin", () => {
    expect(chordFromKeyboardEvent(keyEvent({ key: "˚", code: "KeyK", metaKey: true, altKey: true }), true)).toEqual({
      ok: true,
      chord: { mod: true, ctrl: false, alt: true, shift: false, key: "k" },
    });
    expect(chordFromKeyboardEvent(keyEvent({ key: "л", code: "KeyK", ctrlKey: true, shiftKey: true }), false)).toEqual({
      ok: true,
      chord: { mod: true, ctrl: false, alt: false, shift: true, key: "k" },
    });
  });

  it("distinguishes modifier-only vs missing primary modifier", () => {
    expect(chordFromKeyboardEvent(keyEvent({ key: "Shift", shiftKey: true }), true)).toEqual({ ok: false, reason: "modifier-only" });
    expect(chordFromKeyboardEvent(keyEvent({ key: "r" }), true)).toEqual({ ok: false, reason: "need-modifier" });
    expect(chordFromKeyboardEvent(keyEvent({ key: "k", altKey: true }), false)).toEqual({ ok: false, reason: "need-modifier" });
  });
});

describe("matchesShortcutChord", () => {
  it("matches exact modifiers and ignores composing, prevented, or extra modifiers", () => {
    expect(matchesShortcutChord(keyEvent({ key: "K", metaKey: true, shiftKey: true }), DEFAULT_START_FRESH_CHORD, true)).toBe(true);
    expect(matchesShortcutChord(keyEvent({ key: "K", ctrlKey: true, shiftKey: true }), DEFAULT_START_FRESH_CHORD, false)).toBe(true);
    expect(matchesShortcutChord(keyEvent({ key: "K", metaKey: true }), DEFAULT_START_FRESH_CHORD, true)).toBe(false);
    expect(matchesShortcutChord(keyEvent({ key: "K", metaKey: true, shiftKey: true, altKey: true }), DEFAULT_START_FRESH_CHORD, true)).toBe(false);
    expect(matchesShortcutChord(keyEvent({ key: "K", metaKey: true, shiftKey: true, isComposing: true }), DEFAULT_START_FRESH_CHORD, true)).toBe(false);
    expect(matchesShortcutChord(keyEvent({ key: "K", metaKey: true, shiftKey: true, keyCode: 229 }), DEFAULT_START_FRESH_CHORD, true)).toBe(false);
    expect(matchesShortcutChord(keyEvent({ key: "K", metaKey: true, shiftKey: true, defaultPrevented: true }), DEFAULT_START_FRESH_CHORD, true)).toBe(false);
    expect(matchesShortcutChord(keyEvent({ key: "л", code: "KeyK", ctrlKey: true, shiftKey: true }), DEFAULT_START_FRESH_CHORD, false)).toBe(true);
    // Dvorak: key "e" on physical KeyD must not match KeyD unless key is non-Latin.
    const modD = parseShortcutChord("mod+d")!;
    expect(matchesShortcutChord(keyEvent({ key: "e", code: "KeyD", metaKey: true }), modD, true)).toBe(false);
  });
});

describe("shortcutConflict", () => {
  it("flags built-in app shortcuts and reserved accelerators, while leaving default clear", () => {
    expect(shortcutConflict(DEFAULT_START_FRESH_CHORD, true)).toBeNull();
    expect(shortcutConflict(DEFAULT_START_FRESH_CHORD, false)).toBeNull();
    expect(shortcutConflict(parseShortcutChord("mod+k")!, true)).toEqual({ kind: "builtin", itemId: "command-palette" });
    expect(shortcutConflict(parseShortcutChord("ctrl+k")!, false)).toEqual({ kind: "builtin", itemId: "command-palette" });
    expect(shortcutConflict(parseShortcutChord("mod+shift+n")!, true)).toEqual({ kind: "builtin", itemId: "new-thread" });
    expect(shortcutConflict(parseShortcutChord("mod+r")!, true)).toEqual({ kind: "reserved" });
    expect(shortcutConflict(parseShortcutChord("mod+w")!, false)).toEqual({ kind: "reserved" });
  });
});

describe("persistence", () => {
  it("defaults to mod+shift+k, supports custom chords, clearing to null, and resetting", () => {
    expect(formatCanonicalChord(readStartFreshShortcut()!)).toBe(DEFAULT_START_FRESH_SHORTCUT);

    const custom = parseShortcutChord("mod+shift+l")!;
    setStartFreshShortcut(custom);
    expect(localStorage.getItem(START_FRESH_SHORTCUT_KEY)).toBe("mod+shift+l");
    resetStartFreshShortcutCache();
    expect(formatCanonicalChord(readStartFreshShortcut()!)).toBe("mod+shift+l");

    setStartFreshShortcut(null);
    expect(localStorage.getItem(START_FRESH_SHORTCUT_KEY)).toBe("off");
    resetStartFreshShortcutCache();
    expect(readStartFreshShortcut()).toBeNull();

    resetStartFreshShortcut();
    expect(localStorage.getItem(START_FRESH_SHORTCUT_KEY)).toBeNull();
    expect(formatCanonicalChord(readStartFreshShortcut()!)).toBe(DEFAULT_START_FRESH_SHORTCUT);
  });

  it("falls back to default if localStorage contains corrupt data", () => {
    localStorage.setItem(START_FRESH_SHORTCUT_KEY, "invalid-stuff");
    resetStartFreshShortcutCache();
    expect(formatCanonicalChord(readStartFreshShortcut()!)).toBe(DEFAULT_START_FRESH_SHORTCUT);
  });
});
