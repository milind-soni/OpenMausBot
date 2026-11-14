import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  migrateWorkspaceConfigFile,
  migrateWorkspaceCredentials,
  workspaceCredentialEnv,
  WORKSPACE_CREDENTIALS,
} from "./workspace-credentials.mjs";

describe("workspace credential migration", () => {
  it("keeps the Gemini decision secret encrypted and source references as settings", () => {
    const result = migrateWorkspaceCredentials({ decider: { provider: "gemini", geminiKeySource: "speech", geminiKey: "decision-secret" }, tts: { geminiKey: "speech-secret" } }, {});
    expect(result.credentials).toEqual({ geminiDeciderKey: "decision-secret", geminiTtsKey: "speech-secret" });
    expect(result.config.decider).toEqual({ provider: "gemini", geminiKeySource: "speech" });
    expect(workspaceCredentialEnv(result.credentials)).toMatchObject({ OMB_GEMINI_DECIDER_KEY: "decision-secret", OMB_GEMINI_API_KEY: "speech-secret" });
  });
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
    expect(result.credentials).toEqual({ jevApiKey: "jev-secret", openrouterDeciderKey: "sk-or-secret", openrouterApiKey: "engine-openrouter-key" });
    expect(result.config.decider).toEqual({ provider: "openrouter", openrouterModel: "openai/gpt-4o-mini", enabled: true });
    expect(result.config.openrouter).toEqual({});
    expect(workspaceCredentialEnv(result.credentials)).toEqual({
      OMB_JEV_API_KEY: "jev-secret",
      OMB_OPENROUTER_DECIDER_KEY: "sk-or-secret",
      OMB_OPENROUTER_API_KEY: "engine-openrouter-key",
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

const AI_PROVIDER_KEYS = [
  ["openai", "openaiApiKey", "OMB_OPENAI_API_KEY"],
  ["anthropic", "anthropicApiKey", "OMB_ANTHROPIC_API_KEY"],
  ["openrouter", "openrouterApiKey", "OMB_OPENROUTER_API_KEY"],
  ["mistral", "mistralApiKey", "MISTRAL_API_KEY"],
  ["cerebras", "cerebrasApiKey", "CEREBRAS_API_KEY"],
  ["groq", "groqApiKey", "OMB_GROQ_API_KEY"],
  ["greenference", "greenferenceApiKey", "OMB_GREENFERENCE_API_KEY"],
  ["modelgo", "modelgoApiKey", "OMB_MODELGO_API_KEY"],
  ["meta", "metaApiKey", "OMB_META_API_KEY"],
  ["deepseek", "deepseekApiKey", "OMB_DEEPSEEK_API_KEY"],
  ["openaiCompat", "openaiCompatApiKey", "OPENAI_COMPAT_API_KEY"],
];

describe("AI provider keys in the encrypted store", () => {
  it.each(AI_PROVIDER_KEYS)("moves %s into its slot and hands it to the server under its own variable", (section, name, env) => {
    const result = migrateWorkspaceCredentials({ [section]: { key: `fixture-${section}` } }, {});
    expect(result.credentials).toEqual({ [name]: `fixture-${section}` });
    expect(result.config).toEqual({ [section]: {} });
    expect(workspaceCredentialEnv(result.credentials)).toEqual({ [env]: `fixture-${section}` });
  });

  it("keeps the Anthropic and OpenAI-compatible settings that are not secrets", () => {
    const { config } = migrateWorkspaceCredentials({
      anthropic: { key: "ant", url: "https://claude.example.test", everyClaudeBot: false },
      openaiCompat: { key: "compat", url: "http://127.0.0.1:1234/v1", model: "local", provider: "pin" },
    }, {});
    expect(config).toEqual({
      anthropic: { url: "https://claude.example.test", everyClaudeBot: false },
      openaiCompat: { url: "http://127.0.0.1:1234/v1", model: "local", provider: "pin" },
    });
  });
});

describe("migrating config.json on disk", () => {
  const folders = [];
  const configFile = (config) => {
    const folder = mkdtempSync(join(tmpdir(), "omb-workspace-credentials-"));
    folders.push(folder);
    const path = join(folder, "config.json");
    writeFileSync(path, JSON.stringify(config));
    return path;
  };
  afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

  it("writes the encrypted store before it blanks the file", async () => {
    const path = configFile({ openai: { key: "openai-secret" }, profile: { name: "Ada" } });
    const save = vi.fn(async () => { expect(readFileSync(path, "utf8")).toContain("openai-secret"); });
    const credentials = await migrateWorkspaceConfigFile({ configPath: path, credentials: { boxToken: "kept" }, save, log: vi.fn() });
    expect(save).toHaveBeenCalledExactlyOnceWith({ boxToken: "kept", openaiApiKey: "openai-secret" });
    expect(credentials).toEqual({ boxToken: "kept", openaiApiKey: "openai-secret" });
    expect(readFileSync(path, "utf8")).not.toContain("openai-secret");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ openai: {}, profile: { name: "Ada" } });
    expect(readdirSync(join(path, ".."))).toEqual(["config.json"]);
  });

  it("leaves every key in the file and the store unchanged when encryption is unavailable", async () => {
    const before = { anthropic: { key: "ant-secret" }, groq: { key: "gsk-secret" } };
    const path = configFile(before);
    const log = vi.fn();
    const stored = { boxToken: "kept" };
    const save = vi.fn().mockRejectedValue(new Error("The operating-system credential store is unavailable"));
    const credentials = await migrateWorkspaceConfigFile({ configPath: path, credentials: stored, save, log });
    expect(credentials).toBe(stored);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(before);
    expect(log).toHaveBeenCalledExactlyOnceWith("credential migration failed: The operating-system credential store is unavailable");
  });

  it("keeps the encrypted copy when the file cannot be rewritten afterwards, so no key is lost", async () => {
    const path = configFile({ mistral: { key: "mistral-secret" } });
    const save = vi.fn(async () => { rmSync(join(path, ".."), { recursive: true, force: true }); });
    const credentials = await migrateWorkspaceConfigFile({ configPath: path, credentials: {}, save, log: vi.fn() });
    expect(save).toHaveBeenCalledOnce();
    expect(credentials).toEqual({ mistralApiKey: "mistral-secret" });
  });

  it("changes nothing when there is no config.json yet", async () => {
    const path = join(configFile({}), "..", "absent", "config.json");
    const log = vi.fn();
    const save = vi.fn();
    await expect(migrateWorkspaceConfigFile({ configPath: path, credentials: { boxToken: "kept" }, save, log })).resolves.toEqual({ boxToken: "kept" });
    expect(save).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
