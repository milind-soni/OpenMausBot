import { describe, expect, it } from "vitest";
import { liveConfigSchema, liveSavePatch } from "./live-config.ts";
import { liveCallEndpoint, liveCallKey, liveCallSettings, liveSettingsFor, liveSettingsSavePatch } from "./live-settings.ts";
import { nestedKeyStatus } from "./key-hint.ts";
import { qwenLiveEndpoint, requireQwenKeyTarget } from "./qwen-live-config.ts";
import { redactSecrets } from "./redact.ts";
import type { AppConfig } from "./config.ts";

describe("Qwen Live configuration", () => {
  it("requires the credential's captured destination for writes and clears without trusting keyFor", () => {
    const current = { region: "ap-southeast-1" as const, workspace: "other-workspace", key: "kept-fixture", keyFor: "qwen:other-workspace.ap-southeast-1.maas.aliyuncs.com" };
    for (const key of ["new-fixture", ""]) {
      for (const expected of [undefined, { region: "cn-beijing", workspace: "" }, { region: "ap-southeast-1", workspace: "" }, { region: "ap-southeast-1", workspace: "other-workspace", keyFor: current.keyFor }]) {
        expect(() => requireQwenKeyTarget(current, { key, keyFor: current.keyFor }, expected)).toThrow(expect.objectContaining({ status: 409 }));
      }
      expect(() => requireQwenKeyTarget(current, { key, workspace: "changed-workspace" }, { region: current.region, workspace: current.workspace })).toThrow(expect.objectContaining({ status: 409 }));
      expect(() => requireQwenKeyTarget(current, { key, keyFor: "qwen:evil.invalid" }, { region: current.region, workspace: current.workspace })).not.toThrow();
    }
    expect(() => requireQwenKeyTarget(undefined, { key: "initial-fixture" }, { region: "cn-beijing", workspace: "" })).not.toThrow();
    expect(() => requireQwenKeyTarget(current, { voice: "longanqian_v3.1" }, undefined)).not.toThrow();
    expect(current.key).toBe("kept-fixture");
  });

  it("persists the effective selection without poisoning the official provider enum or sharing native keys", () => {
    const original = { provider: "azure" as const, key: "native", keyFor: "azure:a.openai.azure.com", azureEndpoint: "https://a.openai.azure.com", voice: "marin" };
    const patch = liveSettingsSavePatch(original, { provider: "qwen", qwenRegion: "cn-beijing", qwenVoice: "longanqian_v3.1" });
    const chosen = { ...original, ...patch };
    expect(chosen).toMatchObject({ provider: "azure", key: "native", voice: "marin", qwen: { enabled: true, region: "cn-beijing", voice: "longanqian_v3.1" } });
    const saved = liveSavePatch(chosen, { qwen: { key: "synthetic-qwen-key-1234", keyFor: "qwen:evil.invalid" } });
    const cfg = { live: { ...chosen, ...saved } } as AppConfig;
    expect(cfg.live?.qwen?.keyFor).toBe("qwen:dashscope.aliyuncs.com");
    expect(nestedKeyStatus(cfg)).toHaveProperty("qwenLiveKey", { configured: true });
    expect(JSON.stringify(redactSecrets(cfg))).not.toContain("synthetic-qwen-key-1234");
    expect(liveSettingsSavePatch(cfg.live, { provider: "openai" })).toMatchObject({ provider: "openai", qwen: { enabled: false } });
    const moved = liveSavePatch(cfg.live, { qwen: { workspace: "team-1" } });
    expect(moved.qwen).toMatchObject({ workspace: "team-1", key: "", keyFor: "nowhere", enabled: true });
    expect(liveCallKey({ ...cfg, live: { ...cfg.live, ...moved } })).toBeNull();
  });
  it("accepts only trusted region, workspace, model and provider-specific voice fields", () => {
    expect(qwenLiveEndpoint({ region: "ap-southeast-1", workspace: "team-1" })).toMatchObject({ apiBase: "wss://team-1.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime" });
    for (const qwen of [{ workspace: "https://evil.invalid" }, { workspace: "a.evil" }, { region: "us-east-1" }, { model: "arbitrary" }, { endpoint: "wss://evil.invalid" }, { voice: "a\nAuthorization: evil" }]) {
      expect(liveConfigSchema.safeParse({ qwen }).success, JSON.stringify(qwen)).toBe(false);
    }
    expect(liveConfigSchema.safeParse({ voice: "longanqian_v3.1" }).success).toBe(false);
    expect(liveConfigSchema.safeParse({ provider: "qwen" }).success).toBe(false);
  });
  it("uses only a separately bound Qwen key and an official endpoint", () => {
    const live = liveConfigSchema.parse({ provider: "azure", key: "native-fixture", qwen: {
      enabled: true, region: "cn-beijing", workspace: "", model: "qwen-audio-3.1-realtime-flash", voice: "longanqian_v3.1",
      key: "qwen-fixture", keyFor: "qwen:dashscope.aliyuncs.com",
    } });
    const cfg = { live, openai: { key: "global-fixture" } } as AppConfig;
    expect(liveCallKey(cfg)).toEqual({ key: "qwen-fixture", source: "live" });
    expect(liveCallEndpoint(cfg, { OMB_OPENAI_LIVE_URL: "http://127.0.0.1:1" })).toEqual({
      provider: "qwen", apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash",
    });
    expect(liveCallSettings(cfg)).toMatchObject({ provider: "qwen", qwenVoice: "longanqian_v3.1", setupProblem: null });
    expect(liveSettingsFor(cfg)).toMatchObject({ provider: "qwen", qwenKeyConfigured: true });
    expect(JSON.stringify(liveSettingsFor(cfg))).not.toContain("qwen-fixture");
    expect(liveCallKey({ ...cfg, live: { ...live, qwen: { ...live.qwen, key: "" } } })).toBeNull();
  });
});
