import { describe, expect, it } from "vitest";

import { BOT_BODY_IDS, FESTIVAL_IDS, FESTIVALS, botBodyId, botBodySchema, isCarvedBody, isFestival, isObjectBody } from "./bot-body.ts";
import { CARVED_BODY_IDS } from "./carved-bodies.ts";
import { MASCOT_BODY_IDS } from "./mascot-bodies.ts";
import { OBJECT_BODY_IDS } from "./object-bodies.ts";
import { MAUS_COLOR_NAMES } from "./wire.ts";

describe("bot bodies", () => {
  it("accepts every gradient body, every festival body and every object body", () => {
    expect(BOT_BODY_IDS).toEqual([...MASCOT_BODY_IDS, ...CARVED_BODY_IDS, ...OBJECT_BODY_IDS]);
    expect(new Set(BOT_BODY_IDS).size).toBe(BOT_BODY_IDS.length);
    for (const id of BOT_BODY_IDS) expect(botBodySchema.safeParse(id).success).toBe(true);
  });

  it("falls back to the cursor for anything it does not know", () => {
    expect(botBodyId("pumpkin")).toBe("pumpkin");
    expect(botBodyId("laddu")).toBe("laddu");
    expect(botBodyId("star")).toBe("star");
    expect(botBodyId("hexagram")).toBe("cursor");
    expect(botBodyId(undefined)).toBe("cursor");
  });

  it("tells the festival bodies apart", () => {
    expect(isCarvedBody("ghost")).toBe(true);
    expect(isCarvedBody("jalebi")).toBe(true);
    expect(isCarvedBody("cursor")).toBe(false);
    expect(isCarvedBody(null)).toBe(false);
    expect(isCarvedBody("obj-ghost")).toBe(false);
    expect(isObjectBody("obj-ghost")).toBe(true);
    expect(isObjectBody("ghost")).toBe(false);
  });

  it("splits the festival bodies between the festivals, one pack each", () => {
    expect(FESTIVAL_IDS).toEqual(["halloween", "diwali"]);
    expect(FESTIVAL_IDS.flatMap((festival) => FESTIVALS[festival].bodies)).toEqual([...CARVED_BODY_IDS]);
    expect(isFestival("diwali")).toBe(true);
    expect(isFestival("midnight")).toBe(false);
    expect(isFestival("toString")).toBe(false);
  });

  it.each(FESTIVAL_IDS)("gives every bot colour but silver and chrome its own %s costume from that festival", (festival) => {
    const { bodies, costumes } = FESTIVALS[festival];
    const dressed = MAUS_COLOR_NAMES.filter((color) => color !== "silver" && color !== "chrome");
    expect(Object.keys(costumes).sort()).toEqual([...dressed].sort());
    expect(new Set(Object.values(costumes)).size).toBe(dressed.length);
    for (const body of Object.values(costumes)) expect(bodies).toContain(body);
  });
});
