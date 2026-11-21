import { describe, expect, it } from "vitest";

import { validateAvatar } from "../packages/phone-protocol/src/open-bot-avatar/index.ts";
import { OBJECT_BODIES, OBJECT_BODY_IDS } from "./object-bodies.ts";

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

  it("carries every starter and gallery avatar once", () => {
    expect(OBJECT_BODY_IDS).toHaveLength(23);
    expect(new Set(OBJECT_BODY_IDS).size).toBe(23);
  });
});
