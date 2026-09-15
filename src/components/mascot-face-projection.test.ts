import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MASCOT_BODIES, MASCOT_BODY_IDS, type MascotBodyId } from "../../shared/mascot-bodies";
import { EXPRESSIONS, FACE_CENTRE, GAZE, GAZE_TRAVEL, MOUTHS, MOUTH_STROKE, mouthFrame, type Ring } from "./cursor-face-data";
import { createBodyMotion, stepBodyMotion } from "./mascot-body-motion";
import { containFace, createFaceBounds, getFaceBounds, mouthPoints, projectFace, type FacePart } from "./mascot-face-projection";

function parts(expression: number, turn: number, look = 1, gaze: [number, number] = [0, 0], mouth = false, scale = 0.72, mouthStroke = MOUTH_STROKE): FacePart[] {
  const rings = EXPRESSIONS[expression].map(ring => ring.map(([x, y]): [number, number] =>
    [x + GAZE[expression][0] * look, y + GAZE[expression][1] * look]));
  const radians = turn * Math.PI / 180, gx = gaze[0] * GAZE_TRAVEL.x, gy = gaze[1] * GAZE_TRAVEL.y;
  const result = rings.map(points => ({ points, projection: projectFace(
    points.reduce((n, p) => n + p[0], 0) / points.length,
    points.reduce((n, p) => n + p[1], 0) / points.length, radians, gx, gy, scale, scale,
  ) })) as FacePart[];
  if (mouth) {
    const frame = mouthFrame(rings, MOUTHS[expression]);
    result.push({ points: mouthPoints(frame, MOUTHS[expression]), padding: mouthStroke / 2,
      projection: projectFace(frame.x, frame.y, radians, gx, gy) });
  }
  return result;
}

// Use the artwork's full curves as independent ground truth, not the motion
// polygon used by the implementation. Build-time tools run under Node's TS loader.
const outlines: Record<MascotBodyId, Ring> = JSON.parse(execFileSync(process.execPath, [
  "--experimental-strip-types", "--input-type=module", "-e", String.raw`
  import { MASCOT_BODIES } from "./shared/mascot-bodies.ts";
  import { applyFit, flatten } from "./scripts/mascot-bodies/geometry.ts";
  const outlines = Object.fromEntries(Object.entries(MASCOT_BODIES).map(([id, body]) => {
    const d = body.clip.match(/ d="([^"]+)"/)[1];
    const fit = body.fit.match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/);
    return [id, applyFit(flatten(d, 0.02), { tx: +fit[1], ty: +fit[2], scale: +fit[3] })[0]];
  }));
  console.log(JSON.stringify(outlines));`,
], { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8" }));
const outline = (id: MascotBodyId) => outlines[id];

function inside(point: [number, number], polygon: Ring): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
      point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}

function clipped(face: FacePart[], offset: [number, number], anchor: { x: number; y: number; scale: number }, polygon: Ring): boolean {
  return face.some(({ points, projection: p, padding = 0 }) => p.visible && points.some(([x, y], i) => {
    // Check outlines between vertices too; the actual eyes use straight SVG segments.
    const next = points[(i + 1) % points.length];
    return [0, 0.5].some(t => {
      const px = x + (next[0] - x) * t, py = y + (next[1] - y) * t;
      return (padding ? [0, Math.PI / 2, Math.PI, Math.PI * 1.5] : [0]).some(angle => {
        const dx = padding * Math.cos(angle), dy = padding * Math.sin(angle);
        return !inside([
          anchor.x + (p.x + offset[0] + (px + dx - p.cx) * p.sx - FACE_CENTRE[0]) * anchor.scale,
          anchor.y + (p.y + offset[1] + (py + dy - p.cy) * p.sy - FACE_CENTRE[1]) * anchor.scale,
        ], polygon);
      });
    });
  }));
}

describe("shape-aware face projection", () => {
  it("keeps both front-facing eyes inside Cursor during its returning spin", () => {
    const face = parts(6, 285, 0), anchor = MASCOT_BODIES.cursor.anchor, polygon = outline("cursor");
    expect(face.every(p => p.projection.visible)).toBe(true);
    expect(clipped(face, [0, 0], anchor, polygon)).toBe(true);
    const projection = face.map(p => ({ ...p.projection }));
    const offset = containFace(face, getFaceBounds("cursor"), anchor);
    expect(clipped(face, offset, anchor, polygon)).toBe(false);
    expect(face.map(p => p.projection)).toEqual(projection);
  });

  it("preserves straight-ahead expressions at rest for all thirteen bodies", () => {
    for (const id of MASCOT_BODY_IDS) for (let expression = 0; expression < EXPRESSIONS.length; expression++) {
      for (const scale of [0.72, 1]) expect(containFace(parts(expression, 0, 0, [0, 0], false, scale), getFaceBounds(id), MASCOT_BODIES[id].anchor), `${id}/${expression}/${scale}`).toEqual([0, 0]);
    }
  });

  it("contains authored chat glances and turns without changing depth or eye spacing", () => {
    for (const id of MASCOT_BODY_IDS) {
      const polygon = outline(id), anchor = MASCOT_BODIES[id].anchor;
      for (let expression = 0; expression < EXPRESSIONS.length; expression++) {
        for (const turn of [0, 45, 75, 285, 315, 345]) for (const gaze of [[0, 0], [-1, -1], [1, 1], [-1, 1], [1, -1]] as [number, number][]) for (const scale of [0.72, 1]) {
          const face = parts(expression, turn, 1, gaze, false, scale);
          const offset = containFace(face, getFaceBounds(id), anchor);
          expect(clipped(face, offset, anchor, polygon), `${id}/${expression}/${turn}/${gaze}/${scale}/${offset}`).toBe(false);
        }
      }
    }
  });

  it("does not jerk the remaining eye when its partner crosses the back hemisphere", () => {
    const bounds = getFaceBounds("cursor"), anchor = MASCOT_BODIES.cursor.anchor;
    let previous = parts(20, 0), previousOffset = containFace(previous, bounds, anchor);
    for (let turn = 1; turn <= 360; turn++) {
      const face = parts(20, turn), offset = containFace(face, bounds, anchor);
      for (let eye = 0; eye < 2; eye++) {
        const p = face[eye].projection, last = previous[eye].projection;
        if (p.visible && last.visible) expect(Math.hypot(p.x + offset[0] - last.x - previousOffset[0],
          p.y + offset[1] - last.y - previousOffset[1]), `turn ${turn}, eye ${eye}`).toBeLessThan(1.84);
      }
      previous = face; previousOffset = offset;
    }
  });

  it("includes the optional mouth stroke in the same correction", () => {
    for (const id of MASCOT_BODY_IDS) {
      const polygon = outline(id), anchor = MASCOT_BODIES[id].anchor;
      for (let expression = 0; expression < EXPRESSIONS.length; expression++) for (const turn of [0, 45, 285, 315]) {
        const face = parts(expression, turn, 1, [0, 0], true, 0.72, 11);
        const offset = containFace(face, getFaceBounds(id), anchor);
        expect(clipped(face, offset, anchor, polygon), `${id}/${expression}/${turn}/${offset}`).toBe(false);
      }
    }
  });

  it("hides the legitimate rear hemisphere and needs no running clock when paused", () => {
    const face = parts(6, 180, 0);
    expect(face.every(p => !p.projection.visible)).toBe(true);
    expect(containFace(face, getFaceBounds("cursor"), MASCOT_BODIES.cursor.anchor)).toEqual([0, 0]);
    const paused = parts(11, 0, 1, [-1, -1]);
    const first = containFace(paused, getFaceBounds("cursor"), MASCOT_BODIES.cursor.anchor);
    expect(first).toEqual(containFace(paused, getFaceBounds("cursor"), MASCOT_BODIES.cursor.anchor));
    expect(clipped(paused, first, MASCOT_BODIES.cursor.anchor, outline("cursor"))).toBe(false);
  });

  it("uses the current contour and anchor through interrupted shape morphs", () => {
    const motion = createBodyMotion("cursor");
    for (let frame = 0; frame < 150; frame++) {
      const id = MASCOT_BODY_IDS[Math.floor(frame / 5) % MASCOT_BODY_IDS.length];
      stepBodyMotion(motion, id, 1 / 60);
      const face = parts([6, 8, 11, 16][frame % 4], 285, 1);
      const bounds = createFaceBounds(motion.points, motion.anchor.x);
      const offset = containFace(face, bounds, motion.anchor);
      const polygon = Array.from({ length: motion.points.length / 2 }, (_, i): [number, number] => [motion.points[2 * i], motion.points[2 * i + 1]]);
      expect(clipped(face, offset, motion.anchor, polygon), `${frame}/${id}`).toBe(false);
    }
  });
});
