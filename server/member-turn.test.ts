import { describe, expect, it } from "vitest";

import { memberTurnSelection } from "./member-turn.ts";

describe("memberTurnSelection", () => {
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
