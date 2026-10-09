import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio, mixSrgb, toneForSurface } from "./color-contrast";
import { MAUS_COLORS, MAUS_COLOR_NAMES } from "./mascot";
import { SKIN_IDS } from "./skins";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");

function declarations(body: string): Record<string, string> {
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

function skin(id: string): Record<string, string> {
  const theme = declarations(css.match(/@theme\s*\{([^}]*)\}/)?.[1] ?? "");
  const blocks = [...css.matchAll(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`, "g"))];
  return blocks.reduce((acc, match) => ({ ...acc, ...declarations(match[1] ?? "") }), theme);
}

describe("room speaker colors", () => {
  it("gives chat text a taller line box without changing the type size", () => {
    expect(css).toMatch(/\.chat-text,\s*\.chat-md\s*\{\s*line-height:\s*1\.75;/);
  });

  it("names each bot with a class that reads the skin token", () => {
    for (const color of MAUS_COLOR_NAMES) {
      expect(css).toContain(`.bot-identity[data-bot-color="${color}"] { color: var(--identity-${color}); }`);
    }
  });

  it.each(SKIN_IDS.flatMap((id) => MAUS_COLOR_NAMES.map((color) => [id, color] as const)))(
    "gives %s × %s a name color that clears 4.5:1 on the thread",
    (id, color) => {
      const tokens = skin(id);
      const ink = tokens[`--identity-${color}`];
      const app = tokens["--color-app"];
      expect(ink, id).toBe(toneForSurface(MAUS_COLORS[color], app!));
      expect(contrastRatio(ink!, app!)).toBeGreaterThanOrEqual(4.5);
      // the room avatar's highlight and shadow stay inside 18% of this tone
      const highlight = mixSrgb("#ffffff", ink!, 0.18);
      const shadow = mixSrgb("#000000", ink!, 0.18);
      expect(contrastRatio(highlight, app!)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(shadow, app!)).toBeGreaterThanOrEqual(3);
    },
  );
});
