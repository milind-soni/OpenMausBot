import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseShortcutChord, resetStartFreshShortcutCache, setStartFreshShortcut } from "@/lib/start-fresh-shortcut";
import { ShortcutHint, shortcutLabel } from "./ShortcutHint";

afterEach(() => {
  resetStartFreshShortcutCache();
  vi.unstubAllGlobals();
});

describe("shortcut hints", () => {
  it.each([
    ["darwin", "⌘ N", "⌘ /", "⌘ ⇧ K"],
    ["win32", "Ctrl N", "Ctrl /", "Ctrl Shift K"],
    ["linux", "Ctrl N", "Ctrl /", "Ctrl Shift K"],
  ])("uses the existing bindings on %s", (platform, newBot, help, startFresh) => {
    vi.stubGlobal("window", { ogb: { platform } });
    expect(shortcutLabel("new-bot")).toBe(newBot);
    expect(shortcutLabel("shortcuts-cheat-sheet")).toBe(help);
    expect(shortcutLabel("start-fresh")).toBe(startFresh);
    expect(shortcutLabel("close-panel")).toBe("Esc");
    const html = renderToStaticMarkup(createElement(ShortcutHint, { id: "new-bot" }));
    expect(html).toContain('<kbd aria-hidden="true"');
    expect(html).toContain(newBot);
  });

  it("reflects customized or cleared Start fresh shortcuts", () => {
    vi.stubGlobal("window", { ogb: { platform: "darwin" } });
    setStartFreshShortcut(parseShortcutChord("mod+shift+l")!);
    expect(shortcutLabel("start-fresh")).toBe("⌘ ⇧ L");
    expect(renderToStaticMarkup(createElement(ShortcutHint, { id: "start-fresh" }))).toContain("⌘ ⇧ L");

    setStartFreshShortcut(null);
    expect(shortcutLabel("start-fresh")).toBeUndefined();
    expect(renderToStaticMarkup(createElement(ShortcutHint, { id: "start-fresh" }))).toBe("");
  });

  it("does not invent a hint for an unknown action", () => {
    expect(shortcutLabel("not-a-binding")).toBeUndefined();
    expect(renderToStaticMarkup(createElement(ShortcutHint, { id: "not-a-binding" }))).toBe("");
  });
});
