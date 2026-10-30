import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { flatten } from "./geometry.ts";
import { HALLOWEEN_BODIES, HALLOWEEN_BODY_IDS } from "../../shared/halloween-bodies.ts";
import { MASCOT_BODY_IDS } from "../../shared/mascot-bodies.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const CATALOG = new URL("../../shared/halloween-bodies.ts", import.meta.url);
const read = () => readFileSync(CATALOG, "utf8").replace(/\r\n/g, "\n");

/** Even-odd point-in-path over the flattened outline. */
function inside(d, x, y) {
  let hit = false;
  for (const line of flatten(d)) {
    for (let i = 0, j = line.length - 1; i < line.length; j = i++) {
      const [xi, yi] = line[i];
      const [xj, yj] = line[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

describe("Halloween catalog", () => {
  it("matches a fresh run of the generator", () => {
    const before = read();
    try {
      execFileSync(process.execPath, ["--experimental-strip-types", "scripts/gen-halloween-bodies.ts"], { cwd: root, stdio: "pipe" });
    } catch (err) {
      writeFileSync(CATALOG, before);
      throw new Error(`\`pnpm gen:halloween\` failed: ${err.stderr?.toString() ?? err.message}`);
    }
    const after = read();
    writeFileSync(CATALOG, before);
    expect(after === before, "shared/halloween-bodies.ts was hand-edited or the generator is non-deterministic").toBe(true);
  }, 120_000);

  it("uses ids that never collide with the gradient catalog", () => {
    expect(new Set(HALLOWEEN_BODY_IDS).size).toBe(HALLOWEEN_BODY_IDS.length);
    for (const id of HALLOWEEN_BODY_IDS) {
      expect(MASCOT_BODY_IDS).not.toContain(id);
      expect(HALLOWEEN_BODIES[id].id).toBe(id);
    }
  });

  it("emits cubic-only path data the phone parsers can read", () => {
    for (const id of HALLOWEEN_BODY_IDS) {
      const body = HALLOWEEN_BODIES[id];
      for (const d of [body.clip, ...body.parts.map((part) => part.d)]) {
        expect(d.length, `${id} has an empty path`).toBeGreaterThan(0);
        expect(d, `${id} uses a command other than M, C or Z`).toMatch(/^[MCZ\d\s.-]+$/);
      }
    }
  });

  it("keeps every drawing inside its 240-unit square, with room for the viewBox margin", () => {
    for (const id of HALLOWEEN_BODY_IDS) {
      for (const part of HALLOWEEN_BODIES[id].parts) {
        for (const line of flatten(part.d)) {
          for (const [x, y] of line) {
            expect(x, id).toBeGreaterThan(-14);
            expect(x, id).toBeLessThan(254);
            expect(y, id).toBeGreaterThan(-14);
            expect(y, id).toBeLessThan(254);
          }
        }
      }
    }
  });

  it("rests both eyes inside the face, and any smile on a light part of the drawing", () => {
    for (const id of HALLOWEEN_BODY_IDS) {
      const { clip, eyes, parts } = HALLOWEEN_BODIES[id];
      expect(inside(clip, eyes.cx - eyes.dx, eyes.cy), `${id} left eye`).toBe(true);
      expect(inside(clip, eyes.cx + eyes.dx, eyes.cy), `${id} right eye`).toBe(true);
      if (!eyes.mouth) continue;
      const my = eyes.mouthY ?? eyes.cy + eyes.h * 0.5 + eyes.dx * 0.42;
      const onBody = parts.some((part) => part.fill !== eyes.mouthInk && inside(part.d, eyes.cx, my));
      expect(onBody, `${id} smile`).toBe(true);
    }
  });
});
