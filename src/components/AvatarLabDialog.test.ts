import { describe, expect, it } from "vitest";

import { MAUS_COLOR_NAMES, PICKABLE_STATES } from "@/lib/mascot";
import { AVATAR_LAB_BODY_IDS, randomizeAvatarLabDraft } from "@/lib/avatar-lab";
import { MASCOT_BODY_IDS } from "../../shared/mascot-bodies";

describe("Avatar Lab catalog", () => {
  it("keeps exactly one cursor and omits the retired hexagon and nonexistent moon", () => {
    expect(AVATAR_LAB_BODY_IDS.filter((id) => id === "cursor")).toHaveLength(1);
    expect(AVATAR_LAB_BODY_IDS).not.toContain("hexagon");
    expect(AVATAR_LAB_BODY_IDS).not.toContain("moon");
    expect(new Set(AVATAR_LAB_BODY_IDS).size).toBe(AVATAR_LAB_BODY_IDS.length);
  });

  it("keeps retired values valid in storage while hiding them from new choices", () => {
    expect(MASCOT_BODY_IDS).toContain("hexagon");
    expect(AVATAR_LAB_BODY_IDS).not.toContain("hexagon");
  });

  it("randomizes only visible bodies, supported colors, and distinct resting faces", () => {
    const draft = { bodyId: "cursor" as const, color: "green" as const, expression: "idle" as const };
    const values = [0.999, 0.999, 0.999];
    const next = randomizeAvatarLabDraft(draft, () => values.shift() ?? 0);

    expect(AVATAR_LAB_BODY_IDS).toContain(next.bodyId);
    expect(MAUS_COLOR_NAMES).toContain(next.color);
    expect(PICKABLE_STATES).toContain(next.expression);
  });
});
