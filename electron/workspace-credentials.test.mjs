import { describe, expect, it } from "vitest";

import {
  migrateWorkspaceCredentials,
  workspaceCredentialEnv,
  WORKSPACE_CREDENTIALS,
  withOpenAIConnectionKey,
} from "./workspace-credentials.mjs";
import { createSecureCredentialState } from "./secure-credential-state.mjs";

const boundKeys = {
  "api-a": { key: "key-a", url: "https://a.example/v1" },
  "api-b": { key: "key-b", url: "https://b.example/v1" },
};

describe("OpenAI-compatible connection secrets", () => {
  it("migrates each explicit connection without mixing keys or changing the legacy singleton", () => {
    const config = {
      openaiCompat: { key: "legacy-key" },
      instances: {
        "api-a": { driver: "openai-compat", config: { auth: "bearer", key: "key-a", url: "https://a.example/v1" } },
        "api-b": { driver: "openai-compat", config: { auth: "bearer", key: "key-b", url: "https://b.example/v1", model: "shared/model" } },
        legacy: { driver: "openai-compat", config: { key: "legacy-cli-key" } },
        other: { driver: "claude", config: { key: "unchanged" } },
      },
    };
    const migrated = migrateWorkspaceCredentials(config, { xaiApiKey: "keep" });
    expect(migrated.credentials.openaiConnectionKeys).toEqual(boundKeys);
    expect(migrated.config.instances["api-a"].config).toEqual({ auth: "bearer", url: "https://a.example/v1", secretStorage: "external" });
    expect(migrated.config.instances.legacy).toEqual(config.instances.legacy);
    expect(migrated.config.openaiCompat).toEqual(config.openaiCompat);
    expect(migrated.config.instances.other).toEqual(config.instances.other);
    expect(config.instances["api-a"].config.key).toBe("key-a");
    const restarted = migrateWorkspaceCredentials(migrated.config, migrated.credentials);
    expect(restarted.configChanged).toBe(false);
    expect(restarted.credentialsChanged).toBe(false);
    expect(JSON.parse(workspaceCredentialEnv(restarted.credentials).OPENMAUS_OPENAI_CONNECTION_KEYS)).toEqual(boundKeys);
  });

  it("preserves stored keys when editing unrelated settings or sweeping an external tombstone", () => {
    const credentials = { openaiConnectionKeys: boundKeys };
    expect(withOpenAIConnectionKey(credentials, "api-a", undefined)).toEqual(credentials);
    const result = migrateWorkspaceCredentials({ instances: {
      "api-a": { driver: "openai-compat", config: { auth: "bearer", key: "", secretStorage: "external" } },
    } }, credentials);
    expect(result.credentials).toEqual(credentials);
    expect(result.config.instances["api-a"].config).toEqual({ auth: "bearer", secretStorage: "external" });
  });

  it("clears obsolete credentials for an explicitly unauthenticated connection", () => {
    const migrated = migrateWorkspaceCredentials({ instances: {
      local: { driver: "openai-compat", config: { auth: "none", key: "obsolete" } },
    } }, { openaiConnectionKeys: { local: { key: "obsolete", url: "http://localhost:1234/v1" }, ...boundKeys } });
    expect(migrated.credentials.openaiConnectionKeys).toEqual(boundKeys);
    expect(migrated.config.instances.local.config).toEqual({ auth: "none" });
  });

  it("restores the encrypted key if a referenced connection cannot be removed", async () => {
    const initial = { xaiApiKey: "keep", openaiConnectionKeys: boundKeys };
    const persisted = [];
    const state = createSecureCredentialState(initial, async value => persisted.push(value));
    await expect(state.update(
      credentials => withOpenAIConnectionKey(credentials, "api-a", ""),
      async () => { throw new Error("Connection is in use"); },
    )).rejects.toThrow("Connection is in use");
    expect(persisted[0].openaiConnectionKeys).toEqual({ "api-b": boundKeys["api-b"] });
    expect(persisted.at(-1)).toEqual(initial);
    expect(state.read()).toEqual(initial);
  });

  it("binds a newly stored credential to its canonical endpoint before config is updated", () => {
    const saved = withOpenAIConnectionKey({ openaiConnectionKeys: boundKeys }, "api-a", "new-key", "https://NEW.example:443/v1/");
    expect(saved.openaiConnectionKeys["api-a"]).toEqual({ key: "new-key", url: "https://new.example/v1" });
    expect(() => withOpenAIConnectionKey({}, "api-a", "key-a")).toThrow("valid API URL");
    expect(workspaceCredentialEnv({ openaiConnectionKeys: { legacyUnbound: "key" } })).toEqual({});
  });
});

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
      box: { token: "box-secret" },
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
      boxToken: "box-secret",
      ttsKey: "tts-secret",
      fishAudioKey: "fish-secret",
      opencodeGoApiKey: "ocg-secret",
      openaiImageApiKey: "image-secret",
    });
    // secrets are DELETED (not blanked) so "" stays meaningful as "cleared";
    // non-secret siblings (endpoint url, chosen voice) stay in the file
    expect(result.config).toEqual({
      xai: { url: "https://api.example.test/v1" },
      box: {},
      tts: { voice: "narrator" },
      imageGen: {},
      opencodeGo: {},
      profile: { name: "Ada" },
    });
    // inputs are never mutated — main.mjs decides which files to rewrite
    expect(config.xai.key).toBe("xai-secret");
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
    // mid-session key change: the server persisted the new key to config.json;
    // the stale stored secret must not win at the next boot
    const result = migrateWorkspaceCredentials(
      { box: { token: "box-NEW" } },
      { boxToken: "box-OLD", xaiApiKey: "xai-keep" },
    );
    expect(result.credentials).toEqual({ boxToken: "box-NEW", xaiApiKey: "xai-keep" });
    expect(result.config.box).toEqual({});
  });

  it("treats an empty saved value as no information and keeps the stored secret", () => {
    // The packaged app tombstones every external-mode save as "" in
    // config.json while the real key goes to credentials.bin — a boot that
    // read "" as "cleared" would delete freshly saved keys on every restart.
    const result = migrateWorkspaceCredentials(
      { xai: { key: "" }, tts: { key: "   " } },
      { xaiApiKey: "xai-OLD", ttsKey: "tts-OLD", boxToken: "box-keep" },
    );
    expect(result.credentialsChanged).toBe(false);
    expect(result.credentials).toEqual({ xaiApiKey: "xai-OLD", ttsKey: "tts-OLD", boxToken: "box-keep" });
    // the swept field itself is still removed from the file
    expect(result.config).toEqual({ xai: {}, tts: {} });
    expect(result.configChanged).toBe(true);
  });

  it("keeps the packaged save → restart cycle lossless end to end", () => {
    // first boot migrates the plaintext key in and sweeps the field
    const boot = migrateWorkspaceCredentials({ opencodeGo: { apiKey: "ocg-secret" } }, {});
    expect(boot.credentials).toEqual({ opencodeGoApiKey: "ocg-secret" });

    // an external-mode save commits the key to the store and leaves a ""
    // tombstone in config.json; the next boot must not read it as a clear
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
        boxToken: "box-secret",
        ttsKey: "tts-secret",
        fishAudioKey: "fish-secret",
        opencodeGoApiKey: "ocg-secret",
        openaiImageApiKey: "image-secret",
        composioApiKey: "ak_handled-separately",
      }),
    ).toEqual({
      XAI_API_KEY: "xai-secret",
      BOX_TOKEN: "box-secret",
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
