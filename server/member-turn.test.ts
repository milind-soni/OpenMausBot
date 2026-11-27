import { describe, expect, it } from "vitest";

import { assertModelVariantSupported, memberTurnSelection } from "./member-turn.ts";

describe("memberTurnSelection", () => {
  it("rejects a saved variant when the returning engine cannot apply it, including room turns", () => {
    expect(() => assertModelVariantSupported({ variant: "low" }, {})).toThrow("saved model variant");
    expect(() => assertModelVariantSupported({ variant: "" }, { modelVariants: true })).toThrow("saved model variant");
    expect(() => assertModelVariantSupported({ variant: "low", effort: "high" }, { modelVariants: true })).toThrow("saved model variant");
    expect(() => assertModelVariantSupported({}, {})).not.toThrow();
    // The runtime ACP allowlist, not a global effort enum, governs these IDs.
    for (const variant of ["none", "minimal", "custom/Deep_mode"]) {
      expect(() => assertModelVariantSupported({ variant }, { modelVariants: true })).not.toThrow();
    }
  });
  it("carries an opaque model variant to bot-initiated turns without inventing effort", () => {
    expect(memberTurnSelection({ instanceId: "opencode", model: "provider/model", variant: "minimal" }))
      .toEqual({ model: "provider/model", variant: "minimal" });
    expect(memberTurnSelection({ instanceId: "opencode", model: "provider/model" }))
      .not.toHaveProperty("variant");
  });
  it("carries the picker model so a room turn injects the same host as 1:1", () => {
    expect(
      memberTurnSelection({ instanceId: "hermes", model: "omlx::gemma-4-31b-it-bf16" }),
    ).toEqual({ model: "omlx::gemma-4-31b-it-bf16" });
  });

  it("keeps a configured effort", () => {
    expect(
      memberTurnSelection({ instanceId: "qwen", model: "omlx::gemma-4-31b-it-bf16", effort: "high" }),
    ).toEqual({ model: "omlx::gemma-4-31b-it-bf16", effort: "high" });
  });
});
