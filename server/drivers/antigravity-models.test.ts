import { describe, expect, it } from "vitest";
import type { ModelCatalog } from "../contracts.ts";
import { antigravityRateModel, splitAntigravityThinking, withAntigravityThinking } from "./antigravity-models.ts";

const levels = (...ids: string[]) => ids.map((id) => ({ id, label: id }));
const catalog: ModelCatalog = {
  default: "gemini-3.8-flash",
  options: [
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", variants: levels("low", "medium", "high") },
    { id: "gemini-4-neon", label: "Gemini 4 Neon", variants: levels("medium", "high") },
    { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", variants: levels("extra-low", "low", "high") },
    { id: "gemini-4-argon", label: "Gemini 4 Argon" },
    { id: "gemini-4-carbon-high", label: "Gemini 4 Carbon (High)" },
  ],
};
const antigravity = { driverKind: "antigravityAgent", models: catalog };

describe("Antigravity ids with a thinking level", () => {
  it("splits a level the base model advertises, and only that", () => {
    expect(splitAntigravityThinking("gemini-4-neon-high", catalog.options)).toEqual({ model: "gemini-4-neon", variant: "high" });
    expect(splitAntigravityThinking("gemini-4-neon-low", catalog.options)).toBeNull();
    expect(splitAntigravityThinking("gemini-4-hydrogen-extra-low", catalog.options)).toEqual({ model: "gemini-4-hydrogen", variant: "extra-low" });
  });

  it("takes the legacy levels for a model whose levels are not known yet only when asked", () => {
    expect(splitAntigravityThinking("gemini-4-argon-medium", catalog.options)).toBeNull();
    expect(splitAntigravityThinking("gemini-4-argon-medium", catalog.options, true)).toEqual({ model: "gemini-4-argon", variant: "medium" });
    expect(splitAntigravityThinking("gemini-4-argon-extra-low", catalog.options, true)).toBeNull();
    expect(splitAntigravityThinking("gemini-4-neon-low", catalog.options, true)).toBeNull();
  });

  it("keeps an id the catalog lists, and one whose base it lacks", () => {
    expect(splitAntigravityThinking("gemini-4-carbon-high", catalog.options)).toBeNull();
    expect(splitAntigravityThinking("gemini-4-neon", catalog.options)).toBeNull();
    expect(splitAntigravityThinking("gemini-4-xenon-high", catalog.options)).toBeNull();
  });

  it("runs a suffixed selection as its base model at that level, unless a level was chosen", () => {
    const selection = { instanceId: "antigravity", model: "gemini-4-neon-high" };
    expect(withAntigravityThinking(antigravity, selection, false)).toEqual({ instanceId: "antigravity", model: "gemini-4-neon", variant: "high" });
    expect(withAntigravityThinking(antigravity, selection, true)).toEqual({ instanceId: "antigravity", model: "gemini-4-neon" });
    expect(withAntigravityThinking({ ...antigravity, driverKind: "cursor" }, selection, false)).toBe(selection);
    expect(withAntigravityThinking(null, selection, false)).toBe(selection);
    const unknownLevels = { instanceId: "antigravity", model: "gemini-4-argon-high" };
    expect(withAntigravityThinking(antigravity, unknownLevels, false)).toBe(unknownLevels);
    const listed = { instanceId: "antigravity", model: "gemini-4-neon" };
    expect(withAntigravityThinking(antigravity, listed, false)).toBe(listed);
  });
});

describe("the price an Antigravity id pays", () => {
  it("is its base model's for effort and routing variants", () => {
    expect(antigravityRateModel("gemini-4-neon-high")).toBe("gemini-4-neon");
    expect(antigravityRateModel("gemini-3.5-flash-extra-low")).toBe("gemini-3.5-flash");
    expect(antigravityRateModel("gemini-4-hydrogen-orchestrator")).toBe("gemini-4-hydrogen");
    expect(antigravityRateModel("gemini-4-neon")).toBe("gemini-4-neon");
  });

  it("is the Gemini 4 model an Orchestrator runs on", () => {
    expect(antigravityRateModel("gemini-pro-orchestrator-neon")).toBe("gemini-4-neon");
    expect(antigravityRateModel("gemini-pro-orchestrator-g1-pro")).toBe("gemini-4-argon");
  });
});
