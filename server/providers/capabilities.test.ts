import { describe, expect, it } from "vitest";
import { capabilityLabels, providerCapabilities } from "./capabilities.js";

describe("provider capabilities", () => {
  it("marks hosted OpenAI-compatible presets as streaming/model-discovery capable without assuming reasoning or tool calls", () => {
    for (const provider of ["openai", "openrouter", "groq", "mistral", "nvidia-nim"] as const) {
      expect(providerCapabilities(provider)).toMatchObject({
        streaming: true,
        reasoning: false,
        modelDiscovery: true,
        toolCalls: false,
      });
    }
  });

  it("keeps generic custom endpoints conservative about model-specific capabilities", () => {
    expect(providerCapabilities("custom-openai-compatible")).toMatchObject({
      reasoning: false,
      toolCalls: false,
    });
  });

  it("accepts explicit endpoint capability overrides", () => {
    expect(capabilityLabels(providerCapabilities("mistral", { toolCalls: false }))).not.toContain("toolCalls");
  });
});
