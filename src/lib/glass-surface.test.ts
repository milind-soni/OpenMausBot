// The liquid-glass pop-up surface is built only from each skin's own tokens:
// no skin block changes, no colour is written down twice, and people who ask
// their system for less transparency get the opaque menu colour back.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { glassPopupTopInset } from "./glass-popup";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(src, "styles.css"), "utf8");

/** The body of the first rule whose selector is exactly `selector`, at the
 * given starting offset. */
function rule(selector: string, from = 0): string {
  const start = css.indexOf(`${selector} {`, from);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
}

function skinBlocks(): string[] {
  return [...css.matchAll(/\[data-skin="[a-z]+"\] \{[\s\S]*?\n\}/g)].map((match) => match[0]);
}

describe("glass surface", () => {
  it("derives the pane from the skin's menu, ink and card tokens", () => {
    const surface = rule(".glass-surface");
    expect(surface).toContain("color-mix(in srgb, var(--color-menu) 62%, transparent)");
    expect(surface).toContain("backdrop-filter: blur(28px) saturate(170%)");
    expect(surface).toContain("-webkit-backdrop-filter: blur(28px) saturate(170%)");
    expect(surface).toContain("var(--color-ink) 10%");
    expect(surface).toMatch(/inset 0 1px 0/);
    expect(rule(".glass-card")).toContain("var(--color-card) 60%");
    expect(rule(".glass-scrim")).toContain("backdrop-filter");
    for (const selector of [".glass-surface", ".glass-card", ".glass-scrim", ".glass-rail"]) {
      expect(rule(selector), selector).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });

  it("falls back to the opaque menu colour when transparency is reduced", () => {
    const at = css.indexOf("@media (prefers-reduced-transparency: reduce)");
    expect(at).toBeGreaterThan(0);
    const surface = rule(".glass-surface", at);
    expect(surface).toContain("background: var(--color-menu)");
    expect(surface).toContain("backdrop-filter: none");
  });

  it("lives outside every skin block, and every skin still defines the tokens it reads", () => {
    const blocks = skinBlocks();
    expect(blocks).toHaveLength(9);
    for (const block of blocks) {
      expect(block).not.toContain("glass");
      for (const token of ["--color-menu", "--color-card", "--color-ink"]) expect(block).toContain(`${token}:`);
    }
  });

  it("is what the Settings, Apps and Triggers pop-ups are drawn on", () => {
    for (const file of ["SettingsModal.tsx", "PluginsPanel.tsx", "TriggersPanel.tsx"]) {
      const source = readFileSync(join(src, "components", file), "utf8");
      expect(source, file).toContain("glass-surface");
      // the scrim is a sibling: a backdrop-filter on an ancestor would hide
      // the app from the pane's own blur
      expect(source, file).toContain('className="glass-scrim pointer-events-none absolute inset-0"');
    }
  });

  it("sits in a safe area clear of the window's own buttons, at every window size", () => {
    const frame = rule(".glass-popup-frame");
    expect(frame).toContain("position: fixed");
    expect(frame).toContain("padding: var(--glass-popup-top, 24px) 24px 24px");
    const pane = rule(".glass-popup");
    // min(1040px, 100% - 48px) by min(760px, 100% - top - 24px): the frame's
    // padding has already taken the insets off
    expect(pane).toContain("width: min(1040px, 100%)");
    expect(pane).toContain("height: min(760px, 100%)");
    // macOS traffic lights and the Windows caption buttons get a 56px top
    expect(glassPopupTopInset("mac-inset")).toBe(56);
    expect(glassPopupTopInset("win-caption")).toBe(56);
    expect(glassPopupTopInset("native")).toBe(24);
    for (const file of ["SettingsModal.tsx", "PluginsPanel.tsx", "TriggersPanel.tsx"]) {
      const source = readFileSync(join(src, "components", file), "utf8");
      expect(source, file).toContain('className="glass-popup-frame"');
      expect(source, file).toContain("style={glassPopupFrameStyle()}");
      expect(source, file).toMatch(/className="glass-surface glass-popup /);
      // no viewport-sized caps left fighting the safe area
      expect(source, file).not.toMatch(/100dvh/);
    }
  });

  it("lets the Apps contents reflow inside the pop-up rather than overflow it", () => {
    const apps = readFileSync(join(src, "components", "PluginsPanel.tsx"), "utf8");
    expect(apps).toContain('data-apps-grid className="@container flex flex-col gap-7 pt-1"');
    expect(apps).toContain("grid grid-cols-1 items-start gap-x-6 gap-y-1 @xl:grid-cols-2");
    const mcp = readFileSync(join(src, "components", "McpServersPanel.tsx"), "utf8");
    expect(mcp).toContain('data-mcp-row className="flex flex-wrap items-center gap-3"');
    expect(mcp).toContain('data-mcp-row-actions className="ml-auto flex flex-wrap items-center justify-end gap-1"');
  });
});
