import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./color-contrast";
import { MAUS_COLORS, MAUS_COLOR_NAMES } from "./mascot";
import { SKIN_IDS } from "./skins";
import {
  BUBBLE_TEXT_MIN,
  mentionChipBackground,
  quoteSurface,
  selectionBackground,
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

describe("user bubble tone", () => {
  it.each(MAUS_COLOR_NAMES)("keeps %s on the same hue and deep enough for white", (color) => {
    const tone = userBubbleTone(color);
    expect(tone.ink).toBe("#ffffff");
    expect(contrastRatio(tone.ink, tone.background)).toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
    // A swatch that already carries white is used as-is. One that does not is deepened, never swapped for black text.
    if (contrastRatio("#ffffff", MAUS_COLORS[color]) >= BUBBLE_TEXT_MIN) {
      expect(tone.background).toBe(MAUS_COLORS[color]);
    }
  });

  it.each(SKIN_IDS.flatMap((id) => MAUS_COLOR_NAMES.map((color) => [id, color] as const)))(
    "clears AA for %s × %s, including the pieces inside the bubble",
    (id, color) => {
      const tone = userBubbleTone(color);
      const page = skin(id)["--color-app"];
      expect(page, id).toMatch(/^#[0-9a-f]{6}$/i);
      // The fill is opaque, so the page behind it does not change these ratios. The loop still
      // pins every skin: a future skin-tinted fill has to keep the same bar.
      expect(contrastRatio("#ffffff", tone.background), "body").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.secondary, tone.background), "secondary").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.tertiary, tone.background), "tertiary").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.tertiary, tone.background)).toBeLessThanOrEqual(contrastRatio(tone.secondary, tone.background));
      expect(contrastRatio("#ffffff", tone.inset), "code").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.secondary, tone.inset), "code secondary").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio("#ffffff", tone.raised), "hover").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio("#ffffff", tone.raisedHover), "hover stronger").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.accent, tone.background), "link").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.accent, tone.raised), "link on hover").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.accentInk, tone.accent), "send").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.danger, tone.background), "danger").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.dangerInk, tone.danger), "danger fill").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.success, tone.background), "success").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.successInk, tone.success), "success fill").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.hairline, tone.background), "hairline").toBeGreaterThanOrEqual(3);
      expect(contrastRatio(tone.focus, tone.background), "focus").toBeGreaterThanOrEqual(3);
      const quote = quoteSurface(tone.inset, tone.background);
      expect(contrastRatio(tone.accent, quote), "quote name").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio(tone.secondary, quote), "quote snippet").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      expect(contrastRatio("#ffffff", selectionBackground(tone.background)), "selection").toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      for (const mention of MAUS_COLOR_NAMES) {
        const chip = mentionChipBackground(MAUS_COLORS[mention], tone.inset);
        expect(contrastRatio("#ffffff", chip), `mention ${mention}`).toBeGreaterThanOrEqual(BUBBLE_TEXT_MIN);
      }
    },
  );
});
