import { describe, expect, it } from "vitest";

import { isEffortLevel, type EffortLevel } from "../../server/contracts";
import { clearUnsupportedEffort, effortLevelsForModel } from "./model-effort";

describe("model effort", () => {
  it("recognizes minimal and uses a selected model's exact levels", () => {
    const driverLevels: readonly EffortLevel[] = ["low", "high"];

    expect(isEffortLevel("minimal")).toBe(true);
    expect(
      effortLevelsForModel(
        [{ id: "deepseek-reasoner", effortLevels: ["minimal", "medium"] }],
        "deepseek-reasoner",
        driverLevels,
      ),
    ).toEqual(["minimal", "medium"]);
  });

  it("falls back to driver levels when a selected model has no metadata", () => {
    const driverLevels: readonly EffortLevel[] = ["low", "high"];

    expect(effortLevelsForModel([{ id: "legacy-model" }], "legacy-model", driverLevels)).toEqual(["low", "high"]);
  });

  it("keeps an explicit empty level list instead of falling back", () => {
    expect(effortLevelsForModel([{ id: "plain", effortLevels: [] }], "plain", ["low", "high"])).toEqual([]);
    expect(
      clearUnsupportedEffort({ model: "plain", effort: "low" }, [{ id: "plain", effortLevels: [] }], ["low"]),
    ).toEqual({ model: "plain", effort: undefined });
  });

  it("clears an effort the newly selected exact model does not accept", () => {
    expect(
      clearUnsupportedEffort(
        { instanceId: "dsh", model: "fast", effort: "high" },
        [{ id: "fast", effortLevels: ["minimal", "low"] }],
        ["low", "high"],
      ),
    ).toEqual({ instanceId: "dsh", model: "fast", effort: undefined });
  });
});
