import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { FACE_BOX } from "../shared/cursor-face-data.ts";
import { createCustomMascotFitContext, measureCustomMascotFit, suggestCustomMascotAnchor } from "../shared/custom-mascot-fitting.ts";
import { customMascotDefinitionOf, type CustomMascotPoint } from "../shared/mascot-profile.ts";
import { validateCustomMascotDefinition, validateMascotProfile } from "./custom-mascot-validation.ts";

function circle(): CustomMascotPoint[] {
  const center = FACE_BOX / 2;
  return Array.from({ length: 96 }, (_, index) => {
    const angle = (index / 96) * Math.PI * 2;
    return [center + Math.cos(angle) * 108, center + Math.sin(angle) * 108] as const;
  });
}

describe("server custom mascot validation", () => {
  it("suggests and accepts a safe default anchor for the browser-imported Bunny outline", () => {
    const outline = JSON.parse(
      readFileSync(new URL("../shared/mascot-fixtures/bunny-outline.json", import.meta.url), "utf8"),
    ) as CustomMascotPoint[];
    const context = createCustomMascotFitContext(outline);
    const anchor = suggestCustomMascotAnchor(context);

    expect(outline).toHaveLength(512);
    expect(measureCustomMascotFit(context, anchor).fits).toBe(true);
    expect(validateCustomMascotDefinition({ name: "Bunny", outline, anchor }).anchor).toEqual(anchor);
  });

  it("normalizes and content-addresses a fitted numeric definition", () => {
    const outline = circle();
    const anchor = suggestCustomMascotAnchor(createCustomMascotFitContext(outline));
    const definition = { name: "  Bunny  ", outline, anchor };
    const shape = validateCustomMascotDefinition(definition);

    expect(shape.name).toBe("Bunny");
    expect(shape.id).toMatch(/^[a-f0-9]{64}$/);
    expect(validateCustomMascotDefinition(customMascotDefinitionOf(shape)).id).toBe(shape.id);
  });

  it("rejects a forward-only anchor that clips in the expressive face mode", () => {
    const outline: CustomMascotPoint[] = Array.from({ length: 96 }, (_, index) => {
      const angle = (index / 96) * Math.PI * 2;
      return [FACE_BOX / 2 + Math.cos(angle) * (FACE_BOX / 2), FACE_BOX / 2 + Math.sin(angle) * 65.15];
    });
    const formerlyAccepted = { x: 112.931, y: 113.824, scale: 0.791 };
    expect(() => validateCustomMascotDefinition({ name: "Shallow ellipse", outline, anchor: formerlyAccepted }))
      .toThrow(/clips outside this outline/);

    const safeAnchor = suggestCustomMascotAnchor(createCustomMascotFitContext(outline));
    expect(validateCustomMascotDefinition({ name: "Shallow ellipse", outline, anchor: safeAnchor }).anchor).toEqual(safeAnchor);
  });

  it("rechecks every imported snapshot and rejects stale fingerprints or clipped faces", () => {
    const outline = circle();
    const anchor = suggestCustomMascotAnchor(createCustomMascotFitContext(outline));
    const shape = validateCustomMascotDefinition({ name: "Bunny", outline, anchor });
    const profile = { version: 1 as const, shapes: [shape], selected: { kind: "custom" as const, shapeId: shape.id } };

    expect(validateMascotProfile(profile)).toEqual(profile);
    expect(() => validateMascotProfile({ ...profile, shapes: [{ ...shape, name: "Changed" }] })).toThrow(/fingerprint/);
    expect(() => validateCustomMascotDefinition({ ...customMascotDefinitionOf(shape), anchor: { x: 20, y: 20, scale: 0.791 } })).toThrow(/clips/);
  });
});
