// Quiet text (timestamps, hints, placeholders, calendar hours) used to be
// drawn as `text-ink-secondary/70` and friends: the secondary ink with an
// opacity modifier on top. The secondary ink is already tuned to sit just
// above WCAG AA on the light skins, so any fade takes it below: /70 measured
// 2.6–3.1:1 on Atelier and Linen, /60 down to 2.2:1. The contrast script
// only sees whole tokens, so none of that was ever measured.
//
// Quiet text now has its own token, `--color-ink-tertiary`, tuned per skin
// and checked by `pnpm check:contrast`. This file keeps the two halves
// honest: every skin defines it at a readable strength, and nothing fades
// the secondary ink with an opacity modifier again.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SKIN_IDS } from "./skins";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(src, "styles.css"), "utf8");

function declarations(body: string): Record<string, string> {
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

const theme = declarations(css.match(/@theme\s*\{([^}]*)\}/)?.[1] ?? "");
const skin = (id: string) => ({ ...theme, ...declarations(css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "") });

type Rgba = { r: number; g: number; b: number; a: number };
function parseHex(value: string | undefined): Rgba {
  const hex = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value?.trim() ?? "")?.[1];
  if (!hex) throw new Error(`not a 6- or 8-digit hex colour: ${value}`);
  const channel = (at: number) => parseInt(hex.slice(at, at + 2), 16);
  return { r: channel(0), g: channel(2), b: channel(4), a: hex.length === 8 ? channel(6) / 255 : 1 };
}
function luminance({ r, g, b }: Rgba): number {
  const linear = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
/** WCAG contrast of a (possibly translucent) ink composited over an opaque surface. */
function contrast(ink: Rgba, surface: Rgba): number {
  const over = (f: number, b: number) => f * ink.a + b * (1 - ink.a);
  const flat = { r: over(ink.r, surface.r), g: over(ink.g, surface.g), b: over(ink.b, surface.b), a: 1 };
  const [hi, lo] = [luminance(flat), luminance(surface)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The same eight surfaces the contrast script measures body text on.
const SURFACES = ["app", "panel", "raised", "raised-hover", "card", "inset", "composer", "menu"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// Faint graphics that stay faint on purpose. WCAG 1.4.11 asks nothing of a
// purely decorative mark, so these keep their opacity; each is named so a
// new one has to be argued for here. (A disabled control's text is exempt
// from 1.4.3 too, and is skipped by its `disabled:` variant below.)
const DECORATIVE: Record<string, string> = {
  // aria-hidden arrow between the chiefs and members columns of a team map
  "components/TeamCanvas.tsx text-ink-secondary/35": "decorative connector",
  // aria-hidden drag grip; the row itself is labelled "Drag <bot> onto the schedule"
  "components/routines/CalendarSidebar.tsx text-ink-secondary/35": "decorative drag grip",
  // film glyph on an unplayed video tile; the tile's own name is the file chip under it
  "components/AttachmentGallery.tsx text-ink-secondary/50": "decorative placeholder glyph",
};

describe("faded text", () => {
  it("declares a tertiary ink in the theme, so Tailwind generates text-ink-tertiary", () => {
    expect(theme["--color-ink-tertiary"]).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i);
  });

  it.each([...SKIN_IDS])("gives %s a tertiary ink that clears 4.5:1 on every text surface", (id) => {
    const tokens = skin(id);
    const ink = parseHex(tokens["--color-ink-tertiary"]);
    for (const surface of SURFACES) {
      const ratio = contrast(ink, parseHex(tokens[`--color-${surface}`]));
      expect(ratio, `${id} ink-tertiary on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the tertiary ink quieter than the secondary ink on the app ground", () => {
    for (const id of SKIN_IDS) {
      const tokens = skin(id);
      const app = parseHex(tokens["--color-app"]);
      expect(contrast(parseHex(tokens["--color-ink-tertiary"]), app), id).toBeLessThanOrEqual(contrast(parseHex(tokens["--color-ink-secondary"]), app));
    }
  });

  it("repaints the tertiary ink inside Daylight's inverted bubble", () => {
    const bubble = css.match(/@scope \(\[data-skin="daylight"\]\) to \(\[data-skin\]\)\s*\{\s*\.bg-bubble-user\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(declarations(bubble)["--color-ink-tertiary"]).toBeDefined();
  });

  it("never fades the secondary ink with an opacity modifier", () => {
    const faded: string[] = [];
    for (const file of sources(src)) {
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        for (const [utility, variants] of line.matchAll(/(?<![\w-])((?:[\w-]+:)*)text-ink-secondary\/[\w.[\]]+/g)) {
          // WCAG 1.4.3 exempts a disabled control's text
          if (variants.split(":").includes("disabled")) continue;
          if (`${relative(src, file)} ${utility}` in DECORATIVE) continue;
          faded.push(`${relative(src, file)}:${index + 1} ${utility}`);
        }
      });
    }
    expect(faded).toEqual([]);
  });
});
