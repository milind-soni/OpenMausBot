import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config.ts";
import { LIVE_NEEDS_AZURE, LIVE_NEEDS_KEY } from "./live-call.ts";
import { LIVE_IDLE_MINUTES_DEFAULT, liveCallEndpoint, liveCallKey, liveSettingsFor, liveSetupProblem } from "./live-settings.ts";

describe("live settings", () => {
  it("defaults to a 5 minute idle hang-up and reading typed replies, with no key", () => {
    expect(LIVE_IDLE_MINUTES_DEFAULT).toBe(5);
    expect(liveSettingsFor({} as AppConfig)).toEqual({ configured: false, voice: "", readTypedReplies: true, idleMinutes: 5 });
  });

  it("reports saved values and where the key comes from, never the key", () => {
    const settings = liveSettingsFor({ live: { key: "sk-test", voice: "sol", readTypedReplies: false, idleMinutes: 12 } } as AppConfig);
    expect(settings).toEqual({ configured: true, keySource: "live", voice: "sol", readTypedReplies: false, idleMinutes: 12 });
    expect(JSON.stringify(settings)).not.toContain("sk-test");
  });
});

describe("the key a Live call uses", () => {
  it("is the OpenAI API key from Settings → API keys when there is no separate Live key", () => {
    const cfg = { openai: { key: " sk-openai " } } as AppConfig;
    expect(liveCallKey(cfg)).toEqual({ key: "sk-openai", source: "openai" });
    for (const live of [{}, { key: "" }, { key: "  " }]) expect(liveCallKey({ ...cfg, live }), JSON.stringify(live)).toEqual({ key: "sk-openai", source: "openai" });
    const settings = liveSettingsFor(cfg);
    expect(settings).toMatchObject({ configured: true, keySource: "openai" });
    expect(JSON.stringify(settings)).not.toContain("sk-openai");
  });

  it("is the separate Live key whenever one is saved", () => {
    expect(liveCallKey({ live: { key: "sk-live" }, openai: { key: "sk-openai" } } as AppConfig)).toEqual({ key: "sk-live", source: "live" });
    expect(liveSettingsFor({ live: { key: "sk-live" }, openai: { key: "sk-openai" } } as AppConfig)).toMatchObject({ keySource: "live" });
  });

  it("is nothing without either key; never an image, compatible-server or other provider's key", () => {
    const others = { imageGen: { key: "sk-image" }, openaiCompat: { key: "sk-compat" }, openrouter: { key: "sk-or" }, xai: { key: "xai-key" } } as AppConfig;
    expect(liveCallKey(others)).toBeNull();
    expect(liveCallKey({ ...others, openai: { key: " " } })).toBeNull();
    expect(liveSettingsFor(others)).toEqual({ configured: false, voice: "", readTypedReplies: true, idleMinutes: 5 });
  });
});

describe("Live calls through Azure OpenAI", () => {
  const azure = { provider: "azure" as const, azureEndpoint: "https://my-res.openai.azure.com", azureDeployment: "live-prod" };

  it("never use the OpenAI API key as the Azure resource key", () => {
    const cfg = { live: azure, openai: { key: "sk-openai" } } as AppConfig;
    expect(liveCallKey(cfg)).toBeNull();
    expect(liveSetupProblem(cfg)).toBe(LIVE_NEEDS_AZURE);
    expect(liveSettingsFor(cfg)).toMatchObject({ configured: false, provider: "azure", azureEndpoint: azure.azureEndpoint, azureDeployment: "live-prod" });
  });

  it("are ready with the Live key, a valid endpoint and a deployment, and report none of the key", () => {
    const cfg = { live: { ...azure, key: "azure-secret" } } as AppConfig;
    expect(liveCallKey(cfg)).toEqual({ key: "azure-secret", source: "live" });
    expect(liveCallEndpoint(cfg)).toEqual({ provider: "azure", apiBase: "https://my-res.openai.azure.com/openai/v1", model: "live-prod" });
    expect(liveSetupProblem(cfg)).toBeNull();
    const settings = liveSettingsFor(cfg);
    expect(settings).toMatchObject({ configured: true, keySource: "live", provider: "azure" });
    expect(JSON.stringify(settings)).not.toContain("azure-secret");
  });

  it("are not ready with an endpoint that is not an Azure host", () => {
    const cfg = { live: { ...azure, key: "k", azureEndpoint: "https://evil.example" } } as AppConfig;
    expect(liveCallEndpoint(cfg)).toBeNull();
    expect(liveSetupProblem(cfg)).toBe(LIVE_NEEDS_AZURE);
    expect(liveSettingsFor(cfg).configured).toBe(false);
  });

  it("default to gpt-live-1 as the deployment name", () => {
    expect(liveCallEndpoint({ live: { ...azure, azureDeployment: "" } } as AppConfig)?.model).toBe("gpt-live-1");
  });

  it("leave OpenAI the default provider", () => {
    expect(liveCallEndpoint({ openai: { key: "sk" } } as AppConfig, {})).toEqual({ provider: "openai", apiBase: "https://api.openai.com/v1", model: "gpt-live-1" });
    expect(liveSetupProblem({} as AppConfig)).toBe(LIVE_NEEDS_KEY);
  });
});
