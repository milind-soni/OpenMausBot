import { describe, expect, it } from "vitest";
import {
  allocateProviderInstanceId,
  normalizeProviderConnectionInput,
  providerConnectionPresets,
} from "./catalog.js";

describe("provider connection catalog", () => {
  it("exposes the built-in OpenAI-compatible presets", () => {
    expect(providerConnectionPresets().map((preset) => preset.id)).toEqual([
      "openai",
      "openrouter",
      "groq",
      "mistral",
      "nvidia-nim",
      "custom-openai-compatible",
    ]);
  });

  it("normalizes an OpenAI API connection into an openai-compat instance", () => {
    const result = normalizeProviderConnectionInput({
      provider: "openai",
      name: "OpenAI Personal",
      apiKey: "sk-test",
      model: "gpt-5",
    });

    expect(result.instanceId).toBe("api-openai-personal");
    expect(result.instanceConfig.driver).toBe("openai-compat");
    expect(result.instanceConfig.config).toMatchObject({
      url: "https://api.openai.com/v1",
      apiKeyEnv: "OPENMAUSBOT_API_API_OPENAI_PERSONAL_KEY",
      model: "gpt-5",
    });
    expect(result.instanceConfig.environment.OPENMAUSBOT_API_API_OPENAI_PERSONAL_KEY).toBe("sk-test");
  });

  it("requires a base URL for NVIDIA NIM", () => {
    expect(() => normalizeProviderConnectionInput({
      provider: "nvidia-nim",
      name: "Local NIM",
      apiKey: "token",
    })).toThrow(/requires the base URL/i);
  });

  it("allocates collision-safe ids", () => {
    expect(allocateProviderInstanceId("My API", ["api-my-api"])).toBe("api-my-api-2");
  });
});
