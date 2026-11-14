import { describe, expect, it } from "vitest";

import { DEFAULT_MASCOT_BODY } from "../shared/mascot-bodies.ts";
import { freshLook, STARTER_COLORS } from "./bot-look.ts";

describe("a new bot's first look", () => {
  it("is always the mascot's own shape, never a metal colour", () => {
    expect(STARTER_COLORS).not.toContain("silver");
    expect(STARTER_COLORS).not.toContain("chrome");
    for (const roll of [0, 0.5, 0.999]) expect(freshLook([], () => roll).mascotBody).toBe(DEFAULT_MASCOT_BODY);
  });

  it("picks its colour at random, preferring one no bot here wears yet", () => {
    expect(freshLook([], () => 0).color).not.toBe(freshLook([], () => 0.999).color);
    const worn = [{ color: "red" as const }, { color: "blue" as const }];
    for (const roll of [0, 0.3, 0.6, 0.999]) expect(["red", "blue"]).not.toContain(freshLook(worn, () => roll).color);
  });
});
