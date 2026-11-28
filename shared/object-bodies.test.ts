import { describe, expect, it } from "vitest";

import { MOODBOARD_BODIES } from "../packages/phone-protocol/src/moodboard-bodies.ts";
import { FACES } from "../packages/phone-protocol/src/open-bot-avatar/face.ts";
import { renderAvatarSvg } from "../packages/phone-protocol/src/open-bot-avatar/render.ts";
import { analyzeBody, validateAvatar } from "../packages/phone-protocol/src/open-bot-avatar/validate.ts";
import { buildVolume } from "../packages/phone-protocol/src/open-bot-avatar/volume.ts";
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

  it("carries every starter, gallery and moodboard avatar once, leaving Shield and Star to our shapes", () => {
    expect(OBJECT_BODY_IDS).toHaveLength(34);
    expect(new Set(OBJECT_BODY_IDS).size).toBe(34);
    expect(OBJECT_BODY_IDS).not.toContain("obj-shield");
  });

  it("draws every shape but the cursor with a valid definition", () => {
    expect(Object.keys(SHAPE_BODIES).sort()).toEqual(MASCOT_BODY_IDS.filter((id) => id !== "cursor").sort());
    for (const definition of Object.values(SHAPE_BODIES)) {
      const result = validateAvatar(definition);
      expect(result.ok ? [] : result.errors).toEqual([]);
    }
  });

  it("gives every moodboard body its own face, with no smile", () => {
    for (const { id } of MOODBOARD_BODIES) expect(FACES.get(id)?.mouth).toBe(false);
    for (const { id } of MOODBOARD_BODIES) expect(FACES.get(id)?.front).toBe(true);
    const svg = renderAvatarSvg(OBJECT_BODIES["obj-chibi-ninja"], { color: "#151515", time: 0 });
    expect(svg).toContain('fill="#e0a36a"');
  });

  it("sets a face part into a hood: the hole cuts the hood, a shallow part fills it in its own colour", () => {
    const hood = OBJECT_BODIES["obj-maus-hood"];
    expect(analyzeBody(hood.body.path).subpaths.map((s) => s.hole)).toEqual([false, true, false]);
    const volume = buildVolume(hood);
    expect(volume.parts.map((part) => part.kind)).toEqual(["inflate", "inflate"]);
    expect(volume.eyePart).toBe(1);
    expect(volume.parts[1]!.depth).toBeLessThan(volume.parts[0]!.depth);
    expect(renderAvatarSvg(hood, { color: "#f2f4f3", time: 0 })).toContain('fill="#111111"');
  });

  it("finds an engine definition only for engine bodies", () => {
    expect(engineBody("circle")?.id).toBe("circle");
    expect(engineBody("obj-mug")?.id).toBe("mug");
    for (const id of ["cursor", "pumpkin", "toString", "constructor", 3, null]) expect(engineBody(id)).toBeUndefined();
  });
});
