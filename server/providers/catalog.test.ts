import { describe, expect, it } from "vitest";
import {
  allocateProviderInstanceId,
  normalizeProviderConnectionInput,
  providerConnectionPresets,
  validateProviderBaseUrl,
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

  it("requires a base URL for NVIDIA NIM and custom endpoints", () => {
    expect(() => normalizeProviderConnectionInput({
      provider: "nvidia-nim",
      name: "Local NIM",
      apiKey: "token",
    })).toThrow(/requires a base URL/i);
    expect(() => normalizeProviderConnectionInput({
      provider: "custom-openai-compatible",
      name: "Custom",
      apiKey: "token",
    })).toThrow(/requires a base URL/i);
  });

  it("accepts HTTPS and loopback HTTP but rejects remote HTTP and URL credentials", () => {
    expect(validateProviderBaseUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1");
    expect(validateProviderBaseUrl("http://localhost:8000/v1")).toBe("http://localhost:8000/v1");
    expect(() => validateProviderBaseUrl("http://api.example.com/v1")).toThrow(/HTTPS/i);
    expect(() => validateProviderBaseUrl("https://user:pass@example.com/v1")).toThrow(/credentials/i);
    expect(() => validateProviderBaseUrl("https://example.com/v1?token=secret")).toThrow(/query/i);
  });

  it("allocates collision-safe ids", () => {
    expect(allocateProviderInstanceId("My API", ["api-my-api"])).toBe("api-my-api-2");
  });
});
