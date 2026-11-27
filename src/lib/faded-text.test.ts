import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
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
function contrast(ink: Rgba, surface: Rgba): number {
  const over = (f: number, b: number) => f * ink.a + b * (1 - ink.a);
  const flat = { r: over(ink.r, surface.r), g: over(ink.g, surface.g), b: over(ink.b, surface.b), a: 1 };
  const [hi, lo] = [luminance(flat), luminance(surface)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ["app", "panel", "raised", "raised-hover", "card", "inset", "composer", "menu"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// WCAG 1.4.11 asks nothing of a purely decorative mark; each exemption is named so a new one must be argued for.
const DECORATIVE: Record<string, string> = {
  "components/TeamCanvas.tsx text-ink-secondary/35": "decorative connector",
  "components/routines/CalendarSidebar.tsx text-ink-secondary/35": "decorative drag grip",
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
      // DECORATIVE names files with "/"; relative() joins with "\" on Windows
      const where = relative(src, file).split(sep).join("/");
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        for (const [utility, variants] of line.matchAll(/(?<![\w-])((?:[\w-]+:)*)text-ink-secondary\/[\w.[\]]+/g)) {
          // WCAG 1.4.3 exempts a disabled control's text
          if (variants.split(":").includes("disabled")) continue;
          if (`${where} ${utility}` in DECORATIVE) continue;
          faded.push(`${where}:${index + 1} ${utility}`);
        }
      });
    }
    expect(faded).toEqual([]);
  });
});
