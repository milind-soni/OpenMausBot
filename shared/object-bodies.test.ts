import { describe, expect, it } from "vitest";

import { validateAvatar } from "../packages/phone-protocol/src/open-bot-avatar/validate.ts";
import { MASCOT_BODY_IDS } from "./mascot-bodies.ts";
import { OBJECT_BODIES, OBJECT_BODY_IDS, SHAPE_BODIES, engineBody } from "./object-bodies.ts";

describe("object bodies", () => {
  it("holds a valid definition under each id, named for it", () => {
    expect(Object.keys(OBJECT_BODIES)).toEqual([...OBJECT_BODY_IDS]);
    for (const id of OBJECT_BODY_IDS) {
      const definition = OBJECT_BODIES[id];
      expect(id).toBe(`obj-${definition.id}`);
      const result = validateAvatar(definition);
      expect(result.ok ? [] : result.errors).toEqual([]);
    }
  });

  it("carries every starter and gallery avatar once, leaving Shield and Star to our shapes", () => {
    expect(OBJECT_BODY_IDS).toHaveLength(21);
    expect(new Set(OBJECT_BODY_IDS).size).toBe(21);
    expect(OBJECT_BODY_IDS).not.toContain("obj-shield");
  });

  it("draws every shape but the cursor with a valid definition", () => {
    expect(Object.keys(SHAPE_BODIES).sort()).toEqual(MASCOT_BODY_IDS.filter((id) => id !== "cursor").sort());
    for (const definition of Object.values(SHAPE_BODIES)) {
      const result = validateAvatar(definition);
      expect(result.ok ? [] : result.errors).toEqual([]);
    }
  });

  it("finds an engine definition only for engine bodies", () => {
    expect(engineBody("circle")?.id).toBe("circle");
    expect(engineBody("obj-mug")?.id).toBe("mug");
    for (const id of ["cursor", "pumpkin", "toString", "constructor", 3, null]) expect(engineBody(id)).toBeUndefined();
  });
});
