import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  filterShortcutGroups,
  SHORTCUT_GROUPS,
  shouldOpenKeyboardShortcuts,
  shortcutKeysForPlatform,
} from "./keyboard-shortcuts";

describe("keyboard-shortcuts", () => {
  it("defines unique IDs and non-empty key lists for all shortcuts", () => {
    const ids = new Set<string>();

    for (const group of SHORTCUT_GROUPS) {
      expect(group.category.length).toBeGreaterThan(0);
      expect(group.items.length).toBeGreaterThan(0);

      for (const item of group.items) {
        expect(ids.has(item.id)).toBe(false);
        ids.add(item.id);

        expect(item.description.length).toBeGreaterThan(0);
        expect(item.macKeys.length).toBeGreaterThan(0);
        expect(item.winKeys.length).toBeGreaterThan(0);
      }
    }
  });

  it("resolves correct keys for Mac and Windows", () => {
    const sampleItem = {
      id: "test",
      description: "Test shortcut",
      macKeys: ["⌘", "K"],
      winKeys: ["Ctrl", "K"],
    };

    expect(shortcutKeysForPlatform(sampleItem, true)).toEqual(["⌘", "K"]);
    expect(shortcutKeysForPlatform(sampleItem, false)).toEqual(["Ctrl", "K"]);
  });

  it("filters shortcut groups by search query", () => {
    const all = filterShortcutGroups(SHORTCUT_GROUPS, "");
    expect(all.length).toBe(SHORTCUT_GROUPS.length);

    const nav = filterShortcutGroups(SHORTCUT_GROUPS, "palette");
    expect(nav.length).toBe(1);
    expect(nav[0]?.items[0]?.id).toBe("command-palette");

    const byKey = filterShortcutGroups(SHORTCUT_GROUPS, "Esc", true);
    expect(byKey.some((g) => g.items.some((i) => i.id === "close-panel"))).toBe(true);

    const empty = filterShortcutGroups(SHORTCUT_GROUPS, "nonexistent-query-12345");
    expect(empty.length).toBe(0);
  });

  it("lists previous/next in handler order and excludes pointer gestures", () => {
    const items = SHORTCUT_GROUPS.flatMap((group) => group.items);
    const switchBot = items.find((item) => item.id === "switch-bot")!;
    expect(switchBot.macKeys.at(-1)).toBe("[ / ]");
    expect(switchBot.winKeys.at(-1)).toBe("[ / ]");
    expect(items.some((item) => [...item.macKeys, ...item.winKeys].includes("Double-click"))).toBe(false);
  });
});

describe("keyboard shortcut opening guard", () => {
  class Target extends EventTarget {
    constructor(readonly selector: string | null = null, readonly isContentEditable = false) { super(); }
    closest(selectors: string) { return this.selector && selectors.split(", ").includes(this.selector) ? this : null; }
  }
  const event = (key: string, overrides: Partial<KeyboardEvent> = {}) => ({
    key, target: new Target(), defaultPrevented: false, isComposing: false,
    metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides,
  }) as KeyboardEvent;

  beforeEach(() => vi.stubGlobal("HTMLElement", Target));
  afterEach(() => vi.unstubAllGlobals());

  it("accepts help keys outside editing controls", () => {
    expect(shouldOpenKeyboardShortcuts(event("?", { shiftKey: true }))).toBe(true);
    expect(shouldOpenKeyboardShortcuts(event("/", { metaKey: true }))).toBe(true);
    expect(shouldOpenKeyboardShortcuts(event("/", { ctrlKey: true }))).toBe(true);
    expect(shouldOpenKeyboardShortcuts(event("/"))).toBe(false);
    expect(shouldOpenKeyboardShortcuts(event("k", { metaKey: true }))).toBe(false);
  });

  it.each(["input", "textarea", "select", "dialog", "[role=dialog]"])("does not open from %s", (selector) => {
    const target = new Target(selector);
    expect(shouldOpenKeyboardShortcuts(event("?", { target }))).toBe(false);
    expect(shouldOpenKeyboardShortcuts(event("/", { target, metaKey: true }))).toBe(false);
    expect(shouldOpenKeyboardShortcuts(event("/", { target, ctrlKey: true }))).toBe(false);
  });

  it("respects editable ancestors, composition, handled events, and extra modifiers", () => {
    for (const overrides of [
      { target: new Target(null, true) }, { isComposing: true },
      { defaultPrevented: true }, { altKey: true },
    ]) {
      expect(shouldOpenKeyboardShortcuts(event("?", overrides))).toBe(false);
      expect(shouldOpenKeyboardShortcuts(event("/", { metaKey: true, ...overrides }))).toBe(false);
    }
    expect(shouldOpenKeyboardShortcuts(event("?", { ctrlKey: true }))).toBe(false);
    expect(shouldOpenKeyboardShortcuts(event("/", { metaKey: true, shiftKey: true }))).toBe(false);
  });
});
