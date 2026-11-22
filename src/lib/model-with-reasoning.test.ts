import { describe, expect, it } from "vitest";

import type { EffortLevel } from "../../shared/wire";
import type { InstanceInfo } from "@/state/store";
import { botModelWords, modelWithReasoning } from "./model-with-reasoning";

const engine = (effortLevels?: readonly EffortLevel[], modelVariants = false) => ({
  instanceId: "claude", displayName: "Claude", driverKind: "claudeAgent", enabled: true,
  snapshot: { state: "available", version: "1", authenticated: true },
  models: { default: "opus", options: [{ id: "opus", label: "Opus 5" }] },
  capabilities: { ...(effortLevels ? { effortLevels } : {}), ...(modelVariants ? { modelVariants } : {}) },
}) as unknown as InstanceInfo;
const at = (effort?: EffortLevel) => ({ instanceId: "claude", model: "opus", ...(effort ? { effort } : {}) });
const full = engine(["low", "medium", "high", "xhigh", "max"]);
const variants = engine(["low", "high"], true);

describe("modelWithReasoning", () => {
  it("names the model with its reasoning level, Default when none is sent, and the model alone where there are no levels", () => {
    expect(modelWithReasoning(at("high"), full)).toBe("Opus 5 · High reasoning");
    expect(modelWithReasoning(at(), full)).toBe("Opus 5 · Default reasoning");
    expect(modelWithReasoning(at(), engine())).toBe("Opus 5");
    expect(modelWithReasoning(at("high"), variants)).toBe("Opus 5");
    expect(botModelWords(at("low"), [full])).toBe("Opus 5 · Low reasoning");
  });
});
