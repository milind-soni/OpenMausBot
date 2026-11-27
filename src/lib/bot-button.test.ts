import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BOT_BUTTON, botButton, botButtonStyle, botButtonTone } from "./bot-button";
import { contrastRatio, mixSrgb } from "./color-contrast";
import { MAUS_COLOR_NAMES } from "./mascot";
import { SKIN_IDS, THEME_SKINS } from "./skins";
import { userBubbleTone } from "./user-bubble-tone";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");

function declarations(body: string): Record<string, string> {
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

const theme = declarations(css.match(/@theme\s*\{([^}]*)\}/)?.[1] ?? "");
const skin = (id: string) => ({
  ...theme,
  ...declarations(css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? ""),
});

/** A token with alpha, as the eye sees it over `background`. */
function over(color: string, background: string): string {
  const alpha = /^#[0-9a-f]{8}$/i.test(color) ? parseInt(color.slice(7), 16) / 255 : 1;
  return mixSrgb(color.slice(0, 7), background, alpha);
}

/** The label and icon are 13px or 14px: normal text, so 4.5:1. */
const LABEL_MIN = 4.5;
/** A focus ring against what it sits on: WCAG 1.4.11. */
const RING_MIN = 3;

function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`) + 1;
  expect(at, selector).toBeGreaterThan(0);
  const before = css.slice(0, at).replace(/\/\*[\s\S]*?\*\//g, "");
  expect(before.split("{").length - before.split("}").length, `${selector} sits outside any @layer`).toBe(0);
  return css.slice(at, css.indexOf("}", at));
}

describe("a bot's own button", () => {
  it.each(MAUS_COLOR_NAMES)("paints %s with the very fill and ink of its Simple bubble", (color) => {
    const bubble = userBubbleTone(color);
    const tone = botButtonTone(color);
    expect(tone.fill).toBe(bubble.background);
    expect(tone.ink).toBe(bubble.ink);
    expect(new Set([tone.fill, tone.hover, tone.pressed]).size).toBe(3);
  });

  it("covers a light bot colour that needs dark ink", () => {
    expect(botButtonTone("yellow").ink).toBe("#101410");
    expect(MAUS_COLOR_NAMES.filter((color) => botButtonTone(color).ink !== "#ffffff")).toEqual(["yellow"]);
  });

  it("is a light and a dark theme by default, and every skin is checked below", () => {
    expect(SKIN_IDS).toEqual(expect.arrayContaining([THEME_SKINS.light, THEME_SKINS.dark]));
  });

  it.each(SKIN_IDS.flatMap((id) => MAUS_COLOR_NAMES.map((color) => [id, color] as const)))(
    "reads at AA for %s × %s, resting, hovered, pressed, focused and disabled",
    (id, color) => {
      const tokens = skin(id);
      const tone = botButtonTone(color);
      for (const [state, fill] of [["resting", tone.fill], ["hover", tone.hover], ["pressed", tone.pressed]] as const) {
        expect(contrastRatio(tone.ink, fill), `${state} label`).toBeGreaterThanOrEqual(LABEL_MIN);
      }
      expect(contrastRatio(tone.ink, tone.hover)).toBeGreaterThan(contrastRatio(tone.ink, tone.fill));
      expect(contrastRatio(tone.ink, tone.pressed)).toBeGreaterThan(contrastRatio(tone.ink, tone.hover));
      for (const surface of ["--color-app", "--color-card", "--color-composer", "--color-panel"]) {
        expect(tokens[surface], `${id} ${surface}`).toMatch(/^#[0-9a-f]{6}$/i);
        expect(contrastRatio(tokens["--color-focus"]!, tokens[surface]!), `focus ring on ${surface}`).toBeGreaterThanOrEqual(RING_MIN);
      }
      const disabled = tokens["--color-raised-hover"]!;
      expect(contrastRatio(over(tokens["--color-ink-secondary"]!, disabled), disabled), "disabled label").toBeGreaterThanOrEqual(RING_MIN);
      expect(disabled).not.toBe(tokens["--color-composer"]);
    },
  );

  it("is painted by an unlayered rule from the four properties botButtonStyle sets", () => {
    expect(rule(".bot-button")).toMatch(/background-color:\s*var\(--bot-button\);[\s\S]*color:\s*var\(--bot-button-ink\);/);
    expect(rule(".bot-button:enabled:hover")).toContain("background-color: var(--bot-button-hover);");
    expect(rule(".bot-button:enabled:active")).toContain("background-color: var(--bot-button-pressed);");
    expect(rule(":focus-visible")).toMatch(/outline:\s*2px solid var\(--color-focus\);[\s\S]*outline-offset:\s*2px;/);
    expect(css).not.toMatch(/\.bot-button[^{]*:focus-visible/);
    expect(rule(".bot-button:disabled")).toMatch(/background-color:\s*var\(--color-raised-hover\);[\s\S]*color:\s*var\(--color-ink-secondary\);/);
    const tone = botButtonTone("blue");
    expect(botButtonStyle("blue")).toEqual({
      "--bot-button": tone.fill, "--bot-button-ink": tone.ink, "--bot-button-hover": tone.hover, "--bot-button-pressed": tone.pressed,
    });
  });

  it("keeps the plain look when no single bot owns the button", () => {
    expect(botButton(undefined, "h-7 rounded-full", "bg-accent text-accent-ink")).toEqual({ className: "h-7 rounded-full bg-accent text-accent-ink" });
    const own = botButton("purple", "h-7 rounded-full", "bg-accent text-accent-ink");
    expect(own.className).toBe(`h-7 rounded-full ${BOT_BUTTON}`);
    expect(own.className).not.toContain("ui-button-primary");
    expect(own.style).toEqual(botButtonStyle("purple"));
  });
});
