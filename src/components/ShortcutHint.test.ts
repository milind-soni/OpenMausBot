import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutHint, shortcutLabel } from "./ShortcutHint";

afterEach(() => vi.unstubAllGlobals());

describe("shortcut hints", () => {
  it.each([
    ["darwin", "⌘ N", "⌘ /"],
    ["win32", "Ctrl N", "Ctrl /"],
    ["linux", "Ctrl N", "Ctrl /"],
  ])("uses the existing bindings on %s", (platform, newBot, help) => {
    vi.stubGlobal("window", { ogb: { platform } });
    expect(shortcutLabel("new-bot")).toBe(newBot);
    expect(shortcutLabel("shortcuts-cheat-sheet")).toBe(help);
    expect(shortcutLabel("close-panel")).toBe("Esc");
    const html = renderToStaticMarkup(createElement(ShortcutHint, { id: "new-bot" }));
    expect(html).toContain('<kbd aria-hidden="true"');
    expect(html).toContain(newBot);
  });

  it("does not invent a hint for an unknown action", () => {
    expect(shortcutLabel("not-a-binding")).toBeUndefined();
    expect(renderToStaticMarkup(createElement(ShortcutHint, { id: "not-a-binding" }))).toBe("");
  });
});
