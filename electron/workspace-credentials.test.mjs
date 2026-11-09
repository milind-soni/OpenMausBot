import { describe, expect, it } from "vitest";

import {
  migrateWorkspaceCredentials,
  workspaceCredentialEnv,
  WORKSPACE_CREDENTIALS,
} from "./workspace-credentials.mjs";

describe("workspace credential migration", () => {
  it("stores the router key separately while keeping provider settings", () => {
    const result = migrateWorkspaceCredentials({ imageGen: {
      provider: "custom", key: "openai-only", customApiKey: "router-only",
      customUrl: "http://127.0.0.1:4000/v1", customModel: "local/image",
    } }, {});
    expect(result.credentials).toEqual({ openaiImageApiKey: "openai-only", customImageApiKey: "router-only" });
    expect(result.config.imageGen).toEqual({ provider: "custom", customUrl: "http://127.0.0.1:4000/v1", customModel: "local/image" });
    expect(workspaceCredentialEnv(result.credentials)).toEqual({ OMB_OPENAI_IMAGE_KEY: "openai-only", OMB_CUSTOM_IMAGE_KEY: "router-only" });
  });
  it("moves every plaintext secret into the store and deletes the field", () => {
    const config = {
      xai: { key: "xai-secret", url: "https://api.example.test/v1" },
      box: { token: "boat-secret" },
      tts: { key: "tts-secret", fishKey: "fish-secret", voice: "narrator" },
      imageGen: { key: "image-secret" },
      opencodeGo: { apiKey: "ocg-secret" },
      profile: { name: "Ada" },
    };
    const result = migrateWorkspaceCredentials(config, {});
    expect(result.configChanged).toBe(true);
    expect(result.credentialsChanged).toBe(true);
    expect(result.credentials).toEqual({
      xaiApiKey: "xai-secret",
      boxToken: "boat-secret",
      ttsKey: "tts-secret",
      fishAudioKey: "fish-secret",
      opencodeGoApiKey: "ocg-secret",
      openaiImageApiKey: "image-secret",
    });
    expect(result.config).toEqual({
      xai: { url: "https://api.example.test/v1" },
      box: {},
      tts: { voice: "narrator" },
      imageGen: {},
      opencodeGo: {},
      profile: { name: "Ada" },
    });
    expect(config.xai.key).toBe("xai-secret");
  });

  it("keeps the Jev and OpenRouter decision keys apart, with the model and provider left in the file", () => {
    const result = migrateWorkspaceCredentials({
      decider: { provider: "openrouter", openrouterModel: "openai/gpt-4o-mini", key: "jev-secret", openrouterKey: "sk-or-secret", enabled: true },
      openrouter: { key: "engine-openrouter-key" },
    }, {});
    expect(result.credentials).toEqual({ jevApiKey: "jev-secret", openrouterDeciderKey: "sk-or-secret" });
    expect(result.config.decider).toEqual({ provider: "openrouter", openrouterModel: "openai/gpt-4o-mini", enabled: true });
    expect(result.config.openrouter).toEqual({ key: "engine-openrouter-key" });
    expect(workspaceCredentialEnv(result.credentials)).toEqual({
      OMB_JEV_API_KEY: "jev-secret",
      OMB_OPENROUTER_DECIDER_KEY: "sk-or-secret",
    });
  });

  it("moves a custom endpoint's key to the store and leaves its address, model and protocol in the file", () => {
    const result = migrateWorkspaceCredentials({
      decider: { provider: "custom", customKey: "gw-secret", customBaseUrl: "https://gw.example.com/v1", customModel: "m-1", customApi: "decisions" },
    }, {});
    expect(result.credentials).toEqual({ customDeciderKey: "gw-secret" });
    expect(result.config.decider).toEqual({ provider: "custom", customBaseUrl: "https://gw.example.com/v1", customModel: "m-1", customApi: "decisions" });
    expect(workspaceCredentialEnv(result.credentials)).toEqual({ OMB_CUSTOM_DECIDER_KEY: "gw-secret" });
  });

  it("is idempotent: a second boot over migrated output changes nothing", () => {
    const first = migrateWorkspaceCredentials(
      { xai: { key: "xai-secret" }, tts: { key: "tts-secret", voice: "narrator" } },
      {},
    );
    const second = migrateWorkspaceCredentials(first.config, first.credentials);
    expect(second.configChanged).toBe(false);
    expect(second.credentialsChanged).toBe(false);
    expect(second.credentials).toEqual(first.credentials);
    expect(second.config).toEqual(first.config);
  });

  it("treats a saved non-empty value as newest intent and overwrites the store", () => {
    const result = migrateWorkspaceCredentials(
      { box: { token: "box-NEW" } },
      { boxToken: "box-OLD", xaiApiKey: "xai-keep" },
    );
    expect(result.credentials).toEqual({ boxToken: "box-NEW", xaiApiKey: "xai-keep" });
    expect(result.config.box).toEqual({});
  });

  it("treats an empty saved value as no information and keeps the stored secret", () => {
    // The packaged app tombstones every external-mode save as "" in config.json while the key goes to credentials.bin.
    const result = migrateWorkspaceCredentials(
      { xai: { key: "" }, tts: { key: "   " } },
      { xaiApiKey: "xai-OLD", ttsKey: "tts-OLD", boxToken: "box-keep" },
    );
    expect(result.credentialsChanged).toBe(false);
    expect(result.credentials).toEqual({ xaiApiKey: "xai-OLD", ttsKey: "tts-OLD", boxToken: "box-keep" });
    expect(result.config).toEqual({ xai: {}, tts: {} });
    expect(result.configChanged).toBe(true);
  });

  it("keeps the packaged save → restart cycle lossless end to end", () => {
    const boot = migrateWorkspaceCredentials({ opencodeGo: { apiKey: "ocg-secret" } }, {});
    expect(boot.credentials).toEqual({ opencodeGoApiKey: "ocg-secret" });

    const afterTombstone = migrateWorkspaceCredentials(
      { opencodeGo: { apiKey: "" }, profile: { name: "Ada" } },
      { opencodeGoApiKey: "ocg-secret" },
    );
    expect(afterTombstone.credentials).toEqual({ opencodeGoApiKey: "ocg-secret" });
    expect(afterTombstone.credentialsChanged).toBe(false);
  });

  it("keeps stored secrets when the field is absent (already migrated)", () => {
    const stored = { xaiApiKey: "xai-keep", boxToken: "box-keep" };
    const result = migrateWorkspaceCredentials({ profile: { name: "Ada" } }, stored);
    expect(result.configChanged).toBe(false);
    expect(result.credentialsChanged).toBe(false);
    expect(result.credentials).toEqual(stored);
  });

  it("leaves non-string junk for the server's schema instead of destroying it", () => {
    const result = migrateWorkspaceCredentials({ xai: { key: 42 }, box: "not-an-object" }, {});
    expect(result.configChanged).toBe(false);
    expect(result.credentialsChanged).toBe(false);
    expect(result.config.xai.key).toBe(42);
  });
});

describe("workspace credential env", () => {
  it("maps each stored secret to exactly its server env var", () => {
    expect(
      workspaceCredentialEnv({
        xaiApiKey: "xai-secret",
        boxToken: "boat-secret",
        ttsKey: "tts-secret",
        fishAudioKey: "fish-secret",
        opencodeGoApiKey: "ocg-secret",
        openaiImageApiKey: "image-secret",
        composioApiKey: "ak_handled-separately",
      }),
    ).toEqual({
      XAI_API_KEY: "xai-secret",
      BOX_TOKEN: "boat-secret",
      OMB_TTS_KEY: "tts-secret",
      OMB_FISH_AUDIO_API_KEY: "fish-secret",
      OPENCODE_API_KEY: "ocg-secret",
      OMB_OPENAI_IMAGE_KEY: "image-secret",
    });
  });

  it("emits nothing for absent or empty secrets", () => {
    expect(workspaceCredentialEnv({})).toEqual({});
    expect(workspaceCredentialEnv({ xaiApiKey: "" })).toEqual({});
    expect(workspaceCredentialEnv(undefined)).toEqual({});
  });

  it("covers every credential the migration table declares", () => {
    const credentials = Object.fromEntries(WORKSPACE_CREDENTIALS.map((c) => [c.name, `v-${c.name}`]));
    const env = workspaceCredentialEnv(credentials);
    expect(Object.keys(env).sort()).toEqual(WORKSPACE_CREDENTIALS.map((c) => c.env).sort());
  });
});
