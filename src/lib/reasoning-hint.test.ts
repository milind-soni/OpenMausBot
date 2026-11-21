import { describe, expect, it } from "vitest";

import type { EffortLevel } from "../../shared/wire";
import type { InstanceInfo } from "@/state/store";
import { botModelWords, modelWithReasoning, reasoningHintLevel } from "./reasoning-hint";

const engine = (effortLevels?: readonly EffortLevel[], modelVariants = false) => ({
  instanceId: "claude", displayName: "Claude", driverKind: "claudeAgent", enabled: true,
  snapshot: { state: "available", version: "1", authenticated: true },
  models: { default: "opus", options: [{ id: "opus", label: "Opus 5" }] },
  capabilities: { ...(effortLevels ? { effortLevels } : {}), ...(modelVariants ? { modelVariants } : {}) },
}) as unknown as InstanceInfo;
const at = (effort?: EffortLevel) => ({ instanceId: "claude", model: "opus", ...(effort ? { effort } : {}) });
const full = engine(["low", "medium", "high", "xhigh", "max"]);

describe("reasoningHintLevel", () => {
  it("names a low or unset level on a model that offers more", () => {
    expect(reasoningHintLevel(at("low"), full)).toBe("low");
    expect(reasoningHintLevel(at(), full)).toBe("default");
    expect(reasoningHintLevel(at("none"), engine(["none", "low", "medium"]))).toBe("none");
  });

  it("stays quiet at medium or above, where nothing higher is offered, without levels, and where reasoning is a model variant", () => {
    for (const effort of ["medium", "high", "xhigh", "max"] as const) expect(reasoningHintLevel(at(effort), full)).toBeNull();
    expect(reasoningHintLevel(at("low"), engine(["low"]))).toBeNull();
    expect(reasoningHintLevel(at(), engine(["low", "medium"]))).toBeNull();
    expect(reasoningHintLevel(at(), engine())).toBeNull();
    expect(reasoningHintLevel(at("low"), engine(["low", "high"], true))).toBeNull();
    expect(reasoningHintLevel(at("low"), undefined)).toBeNull();
  });
});

describe("modelWithReasoning", () => {
  it("names the model with its reasoning level, Default when none is sent, and the model alone where there are no levels", () => {
    expect(modelWithReasoning(at("high"), full)).toBe("Opus 5 · High reasoning");
    expect(modelWithReasoning(at(), full)).toBe("Opus 5 · Default reasoning");
    expect(modelWithReasoning(at(), engine())).toBe("Opus 5");
    expect(botModelWords(at("low"), [full])).toBe("Opus 5 · Low reasoning");
  });
});
