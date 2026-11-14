import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio, relativeLuminance, toOklch } from "./color-contrast";
import { MAUS_COLORS, MAUS_COLOR_NAMES } from "./mascot";
import { SKIN_IDS } from "./skins";
import {
  BUBBLE_TEXT_MIN,
  mentionChipBackground,
  quoteSurface,
  selectionBackground,
  userBubbleStyle,
  userBubbleTone,
} from "./user-bubble-tone";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");

function declarations(body: string): Record<string, string> {
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

const theme = declarations(css.match(/@theme\s*\{([^}]*)\}/)?.[1] ?? "");
const skin = (id: string) => ({
  ...theme,
  ...declarations(css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? ""),
});

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

describe("user bubble tone", () => {
  it.each(MAUS_COLOR_NAMES)("fills %s with a gradient that stays on the bot's hue", (color) => {
    const tone = userBubbleTone(color);
    expect(tone.ink).toBe(color === "yellow" ? "#101410" : "#ffffff");
    expect(tone.gradient).toBe(`linear-gradient(to bottom left, ${tone.background}, ${tone.deep})`);
    expect(tone.deep).not.toBe(tone.background);
    expect(relativeLuminance(tone.deep)).toBeLessThan(relativeLuminance(tone.background));
    expect(hueDistance(toOklch(tone.background).h, toOklch(MAUS_COLORS[color]).h)).toBeLessThanOrEqual(8);
    expect(hueDistance(toOklch(tone.deep).h, toOklch(MAUS_COLORS[color]).h)).toBeLessThanOrEqual(20);
    if (tone.ink === "#ffffff" && contrastRatio("#ffffff", MAUS_COLORS[color]) >= BUBBLE_TEXT_MIN) {
      expect(tone.background).toBe(MAUS_COLORS[color]);
    }
  });

  it.each(MAUS_COLOR_NAMES)("gives %s a flat fill whose ink reads at 4.5:1, for the Simple bubble and the composer's round button", (color) => {
    const tone = userBubbleTone(color);
    expect(contrastRatio(tone.ink, tone.background)).toBeGreaterThanOrEqual(4.5);
    const flat = userBubbleStyle(color, { flat: true }) as Record<string, unknown>;
    expect(flat.backgroundColor).toBe(tone.background);
    expect(flat.backgroundImage).toBe("none");
    expect((userBubbleStyle(color) as Record<string, unknown>).backgroundImage).toBe(tone.gradient);
  });

  it("keeps yellow bright with dark text instead of darkening it to olive", () => {
    const tone = userBubbleTone("yellow");
    expect(toOklch(tone.background).l).toBeGreaterThan(toOklch(MAUS_COLORS.yellow).l);
    expect(contrastRatio(tone.ink, tone.deep)).toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
  });

  it.each(SKIN_IDS.flatMap((id) => MAUS_COLOR_NAMES.map((color) => [id, color] as const)))(
    "clears AA for %s × %s, including the pieces inside the bubble",
    (id, color) => {
      const tone = userBubbleTone(color);
      const page = skin(id)["--color-app"];
      expect(page, id).toMatch(/^#[0-9a-f]{6}$/i);
      for (const [end, fill] of [["light end", tone.background], ["deep end", tone.deep]] as const) {
        expect(contrastRatio(tone.ink, fill), `body, ${end}`).toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
        expect(contrastRatio(tone.secondary, fill), `secondary, ${end}`).toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
        expect(contrastRatio(tone.tertiary, fill), `tertiary, ${end}`).toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
        expect(contrastRatio(tone.accent, fill), `link, ${end}`).toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
        expect(contrastRatio(tone.danger, fill), `danger, ${end}`).toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
        expect(contrastRatio(tone.success, fill), `success, ${end}`).toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
        expect(contrastRatio(tone.hairline, fill), `hairline, ${end}`).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(tone.focus, fill), `focus, ${end}`).toBeGreaterThanOrEqual(3);
        const quote = quoteSurface(tone.inset, fill);
        expect(contrastRatio(tone.accent, quote), `quote name, ${end}`).toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
        expect(contrastRatio(tone.secondary, quote), `quote snippet, ${end}`).toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      }
      expect(contrastRatio(tone.tertiary, tone.background)).toBeLessThanOrEqual(contrastRatio(tone.secondary, tone.background));
      expect(contrastRatio(tone.ink, tone.inset), "code").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.secondary, tone.inset), "code secondary").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.ink, tone.raised), "hover").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.ink, tone.raisedHover), "hover stronger").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.accent, tone.raised), "link on hover").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.accentInk, tone.accent), "send").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.dangerInk, tone.danger), "danger fill").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.successInk, tone.success), "success fill").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.selectionInk, tone.selection), "selection").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      if (tone.ink === "#ffffff") expect(tone.selection).toBe(selectionBackground(tone.background));
      for (const mention of MAUS_COLOR_NAMES) {
        const chip = mentionChipBackground(MAUS_COLORS[mention], tone.inset);
        expect(contrastRatio(tone.ink, chip), `mention ${mention}`).toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      }
    },
  );
});
