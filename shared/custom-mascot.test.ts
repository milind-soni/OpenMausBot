import { describe, expect, it } from "vitest";

import { createCustomMascotFitContext, measureCustomMascotFit, suggestCustomMascotAnchor } from "./custom-mascot-fitting.ts";
import { buildClouds, report } from "./mascot-geometry/solve.ts";
import {
  addOrSelectCustomMascot,
  createMascotProfile,
  MascotProfileValidationError,
  MAX_CUSTOM_MASCOT_SHAPES,
  isSimpleClosedOutline,
  selectBuiltinMascot,
  type CustomMascotPoint,
  type CustomMascotShape,
} from "./mascot-profile.ts";
import { FACE_BOX, MOUTH_STROKE } from "./cursor-face-data.ts";

function circle(radius = 108, count = 96): CustomMascotPoint[] {
  const center = FACE_BOX / 2;
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2;
    return [center + Math.cos(angle) * radius, center + Math.sin(angle) * radius] as const;
  });
}

function shape(id: string, name: string, outline = circle()): CustomMascotShape {
  return { id, name, outline, anchor: { x: FACE_BOX / 2, y: FACE_BOX / 2, scale: 0.5 } };
}

describe("custom mascot face fitting", () => {
  it("suggests a safe interior anchor and checks the standard face at every gaze corner", () => {
    const context = createCustomMascotFitContext(circle());
    const anchor = suggestCustomMascotAnchor(context);

    expect(anchor.scale).toBeGreaterThan(0.02);
    expect(anchor.scale).toBeLessThanOrEqual(0.791);
    expect(measureCustomMascotFit(context, anchor).fits).toBe(true);
    expect(measureCustomMascotFit(context, { ...anchor, x: 20 }).fits).toBe(false);
  });

  it("rejects outlines that cross themselves", () => {
    const bowTie: CustomMascotPoint[] = [
      [20, 20], [110, 20], [200, 20], [200, 110],
      [110, 110], [20, 110], [20, 65], [200, 65],
    ];
    expect(isSimpleClosedOutline(bowTie)).toBe(false);
    expect(() => createCustomMascotFitContext(bowTie)).toThrow(/simple, closed shape/);
  });

  it("fits both forward and authored gaze modes on a wide, shallow ellipse", () => {
    const outline = Array.from({ length: 96 }, (_, index) => {
      const angle = (index / 96) * Math.PI * 2;
      return [FACE_BOX / 2 + Math.cos(angle) * (FACE_BOX / 2), FACE_BOX / 2 + Math.sin(angle) * 65.15] as const;
    });
    const context = createCustomMascotFitContext(outline);
    const formerlyAccepted = { x: 112.931, y: 113.824, scale: 0.791 };
    const downRight = { x: -1, y: 1 };

    expect(report(buildClouds(0, MOUTH_STROKE, downRight), context.sdf, formerlyAccepted).clipping).toEqual([]);
    expect(report(buildClouds(1, MOUTH_STROKE, downRight), context.sdf, formerlyAccepted).clearance).toBeLessThan(-13);
    expect(measureCustomMascotFit(context, formerlyAccepted).fits).toBe(false);

    const suggested = suggestCustomMascotAnchor(context);
    expect(measureCustomMascotFit(context, suggested).fits).toBe(true);
    for (const lookAround of [0, 1]) {
      for (const gaze of [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: 1, y: 1 }]) {
        expect(report(buildClouds(lookAround, MOUTH_STROKE, gaze), context.sdf, suggested).clipping).toEqual([]);
      }
    }
  });
});

describe("bot-owned mascot profile transitions", () => {
  it("keeps saved shapes when returning to a built-in and deduplicates a copied snapshot", () => {
    const first = shape("a".repeat(64), "Bunny");
    const profile = addOrSelectCustomMascot(createMascotProfile("kitten"), first);
    const copied = addOrSelectCustomMascot(profile, structuredClone(first));

    expect(copied.shapes).toHaveLength(1);
    expect(copied.selected).toEqual({ kind: "custom", shapeId: first.id });
    expect(selectBuiltinMascot(copied, "star")).toEqual({
      ...copied,
      selected: { kind: "builtin", bodyId: "star" },
    });
    expect(() => addOrSelectCustomMascot(copied, { ...first, anchor: { ...first.anchor, x: 100 } }))
      .toThrow(MascotProfileValidationError);
  });

  it("classifies custom mascot capacity as a caller-correctable profile error", () => {
    const fullProfile = {
      ...createMascotProfile(),
      shapes: Array.from({ length: MAX_CUSTOM_MASCOT_SHAPES }, (_, index) =>
        shape(index.toString(16).padStart(64, "0"), "Saved " + index)),
    };

    expect(() => addOrSelectCustomMascot(fullProfile, shape("f".repeat(64), "One too many")))
      .toThrow(MascotProfileValidationError);
  });
});
