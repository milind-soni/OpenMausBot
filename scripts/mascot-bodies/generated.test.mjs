import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BODY_DEFS } from "./builders.ts";
import { maskFromPolylines } from "../../shared/mascot-geometry/raster.ts";
import { applyFit, boundsOf, fitTransform, flatten } from "../../shared/mascot-geometry/geometry.ts";
import { fieldFromMask } from "../../shared/mascot-geometry/sdf.ts";
import { buildClouds, report } from "../../shared/mascot-geometry/solve.ts";
import { MASCOT_BODIES, MASCOT_BODY_IDS } from "../../shared/mascot-bodies.ts";

// fileURLToPath, not `.pathname`: on Windows the latter yields "/C:/…" with a
// leading slash, which is not a usable cwd — spawnSync then fails ENOENT.
const root = fileURLToPath(new URL("../../", import.meta.url));

// Guards the TypeScript catalog the desktop and web apps use. The generator writes
// the native catalogs only when given their paths (`--swift`, `--kotlin`).
const TS_PATH = "../../shared/mascot-bodies.ts";

// Normalised to LF: a clone whose git config disagrees with .gitattributes must
// fail over generated content, not line endings.
const read = (p) =>
  readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const write = (p, contents) => writeFileSync(new URL(p, import.meta.url), contents);

/** Which lines differ, bounded so the message stays readable against ~100KB. */
function describeDrift(label, before, after) {
  if (before === after) return null;
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const max = Math.max(beforeLines.length, afterLines.length);
  const diffs = [];
  for (let i = 0; i < max && diffs.length < 8; i++) {
    if (beforeLines[i] !== afterLines[i]) {
      diffs.push(`  line ${i + 1}:\n    checked-in: ${JSON.stringify(beforeLines[i] ?? "<missing>")}\n    fresh run:  ${JSON.stringify(afterLines[i] ?? "<missing>")}`);
    }
  }
  const more = diffs.length >= 8 ? "\n  ...(more lines differ, truncated)" : "";
  return `${label} diverged from a fresh generator run at ${diffs.length}${diffs.length >= 8 ? "+" : ""} line(s):\n${diffs.join("\n")}${more}`;
}

describe("generated catalogs", () => {
  it("match a fresh run of the generator", () => {
    const before = {
      ts: read(TS_PATH),
    };

    try {
      // process.execPath, not "node": runs the same interpreter as the test and does
      // not depend on `node` being resolvable on PATH.
      execFileSync(process.execPath, ["--experimental-strip-types", "scripts/gen-mascot-bodies.ts"], {
        cwd: root,
        stdio: "pipe",
      });
    } catch (err) {
      throw new Error(
        `Running \`pnpm gen:bodies\` failed while checking the catalogs for drift. ` +
          `The working tree may now hold a partially-written or reverted file — run ` +
          `\`git status\` / \`git diff -- shared/mascot-bodies.ts\` ` +
          `before trusting either file. Original error:\n${err.stderr?.toString() ?? err.message}`
      );
    }

    const after = {
      ts: read(TS_PATH),
    };

    // The generator rewrote both tracked files: restore the checked-in bytes
    // whether or not this passes, so a failure never leaves the tree dirty.
    write(TS_PATH, before.ts);

    const drifts = [
      describeDrift("shared/mascot-bodies.ts", before.ts, after.ts),
    ].filter(Boolean);

    if (drifts.length > 0) {
      throw new Error(
        `A fresh \`pnpm gen:bodies\` run produced output that does not match the ` +
          `checked-in catalog(s). Either a catalog was hand-edited after it was ` +
          `generated, or the generator is non-deterministic — in either case, fix the ` +
          `cause, never this assertion. The working tree has been restored to the ` +
          `checked-in bytes; the divergence was:\n\n${drifts.join("\n\n")}`
      );
    }
  }, 120_000);
});

describe("every baked anchor", () => {
  /** The four extreme pointer aims the generator solves against. */
  const AIMS = [
    { x: -1, y: -1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: 1, y: 1 },
  ];

  it("clears the silhouette across every expression and every gaze", () => {
    for (const id of MASCOT_BODY_IDS) {
      const def = BODY_DEFS.find(s => s.id === id);
      const polylines = flatten(def.d);
      const fit = fitTransform(boundsOf(polylines));
      const sdf = fieldFromMask(maskFromPolylines(applyFit(polylines, fit), 256), 256);

      for (const aim of AIMS) {
        const result = report(buildClouds(0, undefined, aim), sdf, MASCOT_BODIES[id].anchor);
        expect(result.clipping, `${id} clips looking (${aim.x}, ${aim.y})`).toEqual([]);
      }
    }
  }, 120_000);
});
