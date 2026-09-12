import { describe, expect, it } from "vitest";
import { capabilityLabels, providerCapabilities } from "./capabilities.js";

describe("provider capabilities", () => {
  it("marks hosted OpenAI-compatible presets as streaming/model-discovery capable", () => {
    expect(providerCapabilities("openrouter")).toMatchObject({
      streaming: true,
      modelDiscovery: true,
      toolCalls: true,
    });
  });

  it("keeps generic custom endpoints conservative about tool calls", () => {
    expect(providerCapabilities("custom-openai-compatible").toolCalls).toBe(false);
  });

  it("accepts explicit endpoint capability overrides", () => {
    expect(capabilityLabels(providerCapabilities("mistral", { toolCalls: false }))).not.toContain("toolCalls");
  });
});
