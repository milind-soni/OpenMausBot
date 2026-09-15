import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MASCOT_BODIES, MASCOT_BODY_IDS } from "../../shared/mascot-bodies";
import { MASCOT_MOTION_POINT_COUNT, MASCOT_MOTION_POINTS } from "../../shared/mascot-motion-points";
import { bodyMotionPath, createBodyMotion, springStep, stepBodyMotion } from "./mascot-body-motion";

function signedArea(points: readonly number[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 2) {
    const j = (i + 2) % points.length;
    area += points[i] * points[j + 1] - points[j] * points[i + 1];
  }
  return area / 2;
}

function intersects(points: readonly number[]): boolean {
  const count = points.length / 2;
  const cross = (a: number, b: number, c: number) =>
    (points[b * 2] - points[a * 2]) * (points[c * 2 + 1] - points[a * 2 + 1]) -
    (points[b * 2 + 1] - points[a * 2 + 1]) * (points[c * 2] - points[a * 2]);
  for (let a = 0; a < count; a++) {
    const b = (a + 1) % count;
    for (let c = a + 2; c < count; c++) {
      const d = (c + 1) % count;
      if (a === d) continue;
      if (cross(a, b, c) * cross(a, b, d) < -1e-8 && cross(c, d, a) * cross(c, d, b) < -1e-8) return true;
    }
  }
  return false;
}

describe("catalog body transitions", () => {
  it("keeps the generated contours synchronized with the shipped artwork", () => {
    execFileSync(process.execPath, ["--experimental-strip-types", "scripts/gen-mascot-motion.ts", "--check"], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      stdio: "pipe",
    });
  });

  it("covers every selectable body with matching topology in face space", () => {
    expect(Object.keys(MASCOT_MOTION_POINTS)).toEqual([...MASCOT_BODY_IDS]);
    for (const id of MASCOT_BODY_IDS) {
      const points = MASCOT_MOTION_POINTS[id];
      expect(points, id).toHaveLength(MASCOT_MOTION_POINT_COUNT * 2);
      expect(points.every(Number.isFinite), id).toBe(true);
      expect(signedArea(points), id).toBeGreaterThan(0);
      expect(points[1], id).toBe(Math.min(...points.filter((_, i) => i % 2 === 1)));
      expect(intersects(points), id).toBe(false);
      const path = bodyMotionPath(points);
      expect(path.startsWith("M"), id).toBe(true);
      expect(path.endsWith("Z"), id).toBe(true);
      expect(path.match(/L/g), id).toHaveLength(MASCOT_MOTION_POINT_COUNT - 1);
    }
  });

  it("does not fold the contour inside out while changing between any two bodies", () => {
    for (const from of MASCOT_BODY_IDS) {
      for (const to of MASCOT_BODY_IDS) {
        const motion = createBodyMotion(from);
        for (let frame = 0; frame < 24; frame++) {
          stepBodyMotion(motion, to, 1 / 30);
          expect(intersects(motion.points), `${from} -> ${to}, frame ${frame}`).toBe(false);
          expect(signedArea(motion.points)).toBeGreaterThan(0);
        }
      }
    }
  });

  it("moves the face anchor with the same spring as the body", () => {
    const motion = createBodyMotion("cursor");
    const start = MASCOT_BODIES.cursor.anchor;
    const end = MASCOT_BODIES.star.anchor;
    stepBodyMotion(motion, "star", 0.1);
    const progress = 1 - (1 + 18 * 0.1) * Math.exp(-18 * 0.1);
    for (const axis of ["x", "y", "scale"] as const) {
      expect(motion.anchor[axis]).toBeCloseTo(start[axis] + (end[axis] - start[axis]) * progress, 10);
    }
    expect(motion.points[0]).toBeCloseTo(MASCOT_MOTION_POINTS.cursor[0] +
      (MASCOT_MOTION_POINTS.star[0] - MASCOT_MOTION_POINTS.cursor[0]) * progress, 10);
  });

  it("preserves position and velocity when the user changes shape mid-transition", () => {
    const motion = createBodyMotion("cursor");
    stepBodyMotion(motion, "star", 0.1);
    const points = [...motion.points];
    const velocity = [...motion.velocity];
    const anchor = { ...motion.anchor };
    stepBodyMotion(motion, "circle", 0);
    expect(motion.points).toEqual(points);
    expect(motion.velocity).toEqual(velocity);
    expect(motion.anchor).toEqual(anchor);
    for (let i = 0; i < 120; i++) stepBodyMotion(motion, "circle", 1 / 60);
    expect(motion.settled).toBe(true);
    expect(motion.points).toEqual(MASCOT_MOTION_POINTS.circle);
    expect(motion.anchor).toEqual(MASCOT_BODIES.circle.anchor);
  });

  it("stays finite and unfolded when the user browses shapes faster than they settle", () => {
    const motion = createBodyMotion("cursor");
    for (let frame = 0; frame < 240; frame++) {
      const id = MASCOT_BODY_IDS[Math.floor(frame / 3) % MASCOT_BODY_IDS.length];
      stepBodyMotion(motion, id, 1 / 60);
      expect(motion.points.every(Number.isFinite)).toBe(true);
      expect(intersects(motion.points)).toBe(false);
      expect(signedArea(motion.points)).toBeGreaterThan(0);
    }
  });

  it("converges at the same speed on 30, 60 and 120 Hz displays", () => {
    const positions = [30, 60, 120].map(fps => {
      let position = 0;
      let velocity = 0;
      for (let frame = 0; frame < fps / 2; frame++) [position, velocity] = springStep(position, velocity, 1, 1 / fps);
      return position;
    });
    expect(positions[0]).toBeCloseTo(positions[1], 12);
    expect(positions[0]).toBeCloseTo(positions[2], 12);
    expect(positions[0]).toBeGreaterThan(0.998);
    expect(positions[0]).toBeLessThan(1);
    const motion = createBodyMotion("cursor");
    stepBodyMotion(motion, "star", 120);
    expect(motion.settled).toBe(true);
    expect(motion.points).toEqual(MASCOT_MOTION_POINTS.star);
    expect(stepBodyMotion(motion, "star", 1 / 60)).toBe(false);
  });
});
