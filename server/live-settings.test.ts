import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config.ts";
import { nestedKeyStatus } from "./key-hint.ts";
import { LIVE_NEEDS_AZURE, LIVE_NEEDS_FISH, LIVE_NEEDS_KEY } from "./live-call.ts";
import { LIVE_KEY_NEEDS_ENDPOINT, liveConfigWithEnv, liveKeyTarget, liveSavePatch, usableLiveKey, type LiveConfig } from "./live-config.ts";
import { LIVE_IDLE_MINUTES_DEFAULT, liveCallEndpoint, liveCallKey, liveCallSettings, liveSettingsFor, liveSettingsForClient, liveSetupProblem } from "./live-settings.ts";

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
  const keyFor = "azure:my-res.openai.azure.com";

  it("never use the OpenAI API key as the Azure resource key", () => {
    const cfg = { live: azure, openai: { key: "sk-openai" } } as AppConfig;
    expect(liveCallKey(cfg)).toBeNull();
    expect(liveSetupProblem(cfg)).toBe(LIVE_NEEDS_AZURE);
    expect(liveSettingsFor(cfg)).toMatchObject({ configured: false, provider: "azure", azureEndpoint: azure.azureEndpoint, azureDeployment: "live-prod" });
  });

  it("are ready with the Live key, a valid endpoint and a deployment, and report none of the key", () => {
    const cfg = { live: { ...azure, key: "azure-secret", keyFor } } as AppConfig;
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

  it("name the provider in what a call start reads, so the limit on Azure sees it even before setup is done", () => {
    expect(liveCallSettings({ live: { provider: "azure" } } as AppConfig)).toMatchObject({ provider: "azure", endpoint: null, key: "", setupProblem: LIVE_NEEDS_AZURE });
    expect(liveCallSettings({ live: { ...azure, key: "k", keyFor } } as AppConfig)).toMatchObject({ provider: "azure", key: "k", setupProblem: null, endpoint: { provider: "azure" } });
    expect(liveCallSettings({ openai: { key: "sk" } } as AppConfig).provider).toBeUndefined();
  });

  it("tell a caller without the admin scope the service, not which resource", () => {
    const client = liveSettingsForClient(liveSettingsFor({ live: { ...azure, key: "azure-secret", keyFor } } as AppConfig));
    expect(client).toEqual({ configured: true, keySource: "live", provider: "azure", voice: "", readTypedReplies: true, idleMinutes: 5 });
    expect(JSON.stringify(client)).not.toContain("my-res");
    expect(JSON.stringify(client)).not.toContain("live-prod");
  });

  it("default to gpt-live-1 as the deployment name", () => {
    expect(liveCallEndpoint({ live: { ...azure, azureDeployment: "" } } as AppConfig)?.model).toBe("gpt-live-1");
  });

  it("leave OpenAI the default provider", () => {
    expect(liveCallEndpoint({ openai: { key: "sk" } } as AppConfig, {})).toEqual({ provider: "openai", apiBase: "https://api.openai.com/v1", model: "gpt-live-1" });
    expect(liveSetupProblem({} as AppConfig)).toBe(LIVE_NEEDS_KEY);
  });
});

describe("Live calls through Fish Audio", () => {
  const fish = { provider: "fish" as const, fishAgentId: "agent_1" };

  it("never use the OpenAI API key, or a key saved for OpenAI or Azure, as the Fish key", () => {
    const openai = { key: "sk-openai" };
    for (const live of [fish, { ...fish, key: "k", keyFor: "openai" }, { ...fish, key: "k", keyFor: "azure:a.openai.azure.com" }, { ...fish, key: "old" }]) {
      const cfg = { live, openai } as AppConfig;
      expect(liveCallKey(cfg), JSON.stringify(live)).toBeNull();
      expect(liveSetupProblem(cfg)).toBe(LIVE_NEEDS_FISH);
    }
  });

  it("are ready with a key saved for Fish and a valid agent id, and report none of the key", () => {
    const cfg = { live: { ...fish, key: "fish-secret", keyFor: "fish" } } as AppConfig;
    expect(liveCallKey(cfg)).toEqual({ key: "fish-secret", source: "live" });
    expect(liveCallEndpoint(cfg, {})).toEqual({ provider: "fish", apiBase: "https://api.fish.audio/v1/agent", model: "agent_1" });
    expect(liveSetupProblem(cfg)).toBeNull();
    const settings = liveSettingsFor(cfg);
    expect(settings).toMatchObject({ configured: true, keySource: "live", provider: "fish", fishAgentId: "agent_1" });
    expect(JSON.stringify(settings)).not.toContain("fish-secret");
  });

  it("are not ready without a valid agent id", () => {
    for (const fishAgentId of [undefined, "", "../x"]) {
      const cfg = { live: { provider: "fish", fishAgentId, key: "k", keyFor: "fish" } } as AppConfig;
      expect(liveCallEndpoint(cfg, {}), String(fishAgentId)).toBeNull();
      expect(liveSetupProblem(cfg)).toBe(LIVE_NEEDS_FISH);
    }
  });

  it("name the provider in what a call start reads, so the Fish limit sees it before setup is done", () => {
    expect(liveCallSettings({ live: { provider: "fish" } } as AppConfig)).toMatchObject({ provider: "fish", endpoint: null, key: "", setupProblem: LIVE_NEEDS_FISH });
  });

  it("tell a caller without the admin scope the service, not which agent", () => {
    const client = liveSettingsForClient(liveSettingsFor({ live: { ...fish, key: "k", keyFor: "fish" } } as AppConfig));
    expect(client).toEqual({ configured: true, keySource: "live", provider: "fish", voice: "", readTypedReplies: true, idleMinutes: 5 });
    expect(JSON.stringify(client)).not.toContain("agent_1");
  });

  it("tie a key saved for Fish to Fish, and forget it on a switch either way", () => {
    expect(liveKeyTarget(fish)).toBe("fish");
    expect(liveSavePatch(fish, { key: "new" })).toEqual({ key: "new", keyFor: "fish" });
    expect(liveSavePatch({ ...fish, key: "k", keyFor: "fish" }, { fishAgentId: "agent_2" })).toEqual({ fishAgentId: "agent_2" });
    expect(liveSavePatch({ ...fish, key: "k", keyFor: "fish" }, { provider: "openai" })).toEqual({ provider: "openai", key: "", keyFor: "nowhere" });
    expect(liveSavePatch({ key: "k", keyFor: "openai" }, { provider: "fish" })).toEqual({ provider: "fish", key: "", keyFor: "nowhere" });
    expect(usableLiveKey({ ...fish, key: "k", keyFor: "fish", provider: "openai" })).toBeUndefined();
  });

  it("are set up from the environment by an operator, pairing the key only when key, provider and agent are set together", () => {
    const env = { OMB_OPENAI_LIVE_KEY: "operators", OMB_LIVE_PROVIDER: "fish", OMB_FISH_LIVE_AGENT_ID: " agent_9 " };
    expect(liveConfigWithEnv(undefined, env)).toEqual({ key: "operators", provider: "fish", fishAgentId: "agent_9", keyFor: "fish" });
    expect(liveConfigWithEnv(undefined, { ...env, OMB_FISH_LIVE_AGENT_ID: undefined }).keyFor).toBeUndefined();
    expect(usableLiveKey(liveConfigWithEnv({ key: "", keyFor: "nowhere" }, env))).toBeUndefined();
  });
});

describe("a saved Live key", () => {
  const A = "https://a.openai.azure.com", B = "https://b.openai.azure.com";
  const onA: LiveConfig = { provider: "azure", azureEndpoint: A, key: "k", keyFor: "azure:a.openai.azure.com" };

  it("is tied to the service and the endpoint's host, not its path", () => {
    expect(liveKeyTarget(undefined)).toBe("openai");
    expect(liveKeyTarget({ provider: "openai", azureEndpoint: A })).toBe("openai");
    expect(liveKeyTarget({ provider: "azure", azureEndpoint: A })).toBe("azure:a.openai.azure.com");
    expect(liveKeyTarget({ provider: "azure", azureEndpoint: " https://A.OpenAI.Azure.com/openai/v1?x=1 " })).toBe("azure:a.openai.azure.com");
    expect(liveKeyTarget({ provider: "azure", azureEndpoint: "https://gw.azure-api.net/team-a" })).toBe("azure:gw.azure-api.net");
    expect(liveKeyTarget({ provider: "azure", azureEndpoint: `${A}:8443` })).toBe("azure:a.openai.azure.com:8443");
    for (const azureEndpoint of [undefined, "", "a.openai.azure.com"]) expect(liveKeyTarget({ provider: "azure", azureEndpoint }), String(azureEndpoint)).toBeNull();
  });

  it("goes only where it was saved for", () => {
    expect(usableLiveKey(onA)).toBe("k");
    expect(usableLiveKey({ ...onA, azureEndpoint: `${A}/openai/v1` })).toBe("k");
    expect(usableLiveKey({ ...onA, azureEndpoint: B })).toBeUndefined();
    expect(usableLiveKey({ ...onA, azureEndpoint: `${A}:8443` })).toBeUndefined();
    expect(usableLiveKey({ ...onA, provider: "openai" })).toBeUndefined();
    expect(usableLiveKey({ key: "k", keyFor: "openai" })).toBe("k");
    expect(usableLiveKey({ key: "k", keyFor: "openai", provider: "azure", azureEndpoint: A })).toBeUndefined();
    expect(usableLiveKey({ key: "k", keyFor: "nowhere" })).toBeUndefined();
    expect(usableLiveKey({ key: "k", keyFor: "nowhere", provider: "azure", azureEndpoint: A })).toBeUndefined();
    expect(usableLiveKey({ ...onA, key: "  " })).toBeUndefined();
  });

  it("from before Azure was offered is OpenAI's", () => {
    expect(usableLiveKey({ key: "old" })).toBe("old");
    expect(usableLiveKey({ key: "old", provider: "azure", azureEndpoint: A })).toBeUndefined();
  });

  it("never reaches the wrong provider through liveCallKey, whatever else is saved", () => {
    const openai = { key: "sk-openai" };
    expect(liveCallKey({ live: onA, openai } as AppConfig)).toEqual({ key: "k", source: "live" });
    expect(liveCallKey({ live: { ...onA, azureEndpoint: B }, openai } as AppConfig)).toBeNull();
    // Back on OpenAI the Azure key stays behind, and OpenAI's own key is OpenAI's to use.
    expect(liveCallKey({ live: { ...onA, provider: "openai" }, openai } as AppConfig)).toEqual({ key: "sk-openai", source: "openai" });
    expect(liveCallKey({ live: { ...onA, provider: "openai" } } as AppConfig)).toBeNull();
  });

  it("counts as saved only while it can be used", () => {
    expect(nestedKeyStatus({ live: onA } as AppConfig).openaiLiveKey.configured).toBe(true);
    expect(nestedKeyStatus({ live: { ...onA, azureEndpoint: B } } as AppConfig).openaiLiveKey.configured).toBe(false);
    expect(nestedKeyStatus({ live: { ...onA, keyFor: "nowhere" } } as AppConfig).openaiLiveKey.configured).toBe(false);
  });

  describe("saving", () => {
    const forgotten = { key: "", keyFor: "nowhere" };

    it("ties a new key to where calls go after this same save", () => {
      expect(liveSavePatch(undefined, { key: "new" })).toEqual({ key: "new", keyFor: "openai" });
      expect(liveSavePatch(onA, { key: "new" })).toEqual({ key: "new", keyFor: "azure:a.openai.azure.com" });
      expect(liveSavePatch(onA, { key: "new", azureEndpoint: B })).toEqual({ key: "new", azureEndpoint: B, keyFor: "azure:b.openai.azure.com" });
      expect(liveSavePatch(undefined, { key: "new", provider: "azure", azureEndpoint: B })).toEqual({ key: "new", provider: "azure", azureEndpoint: B, keyFor: "azure:b.openai.azure.com" });
    });

    it("refuses a key with Azure chosen and no endpoint to tie it to", () => {
      expect(() => liveSavePatch({ provider: "azure" }, { key: "new" })).toThrow(LIVE_KEY_NEEDS_ENDPOINT);
      expect(() => liveSavePatch(undefined, { provider: "azure", key: "new" })).toThrow(expect.objectContaining({ status: 400 }));
    });

    it("forgets the key when the service or the endpoint's host changes", () => {
      expect(liveSavePatch(onA, { azureEndpoint: B })).toEqual({ azureEndpoint: B, ...forgotten });
      expect(liveSavePatch(onA, { provider: "openai" })).toEqual({ provider: "openai", ...forgotten });
      expect(liveSavePatch(onA, { azureEndpoint: "" })).toEqual({ azureEndpoint: "", ...forgotten });
      expect(liveSavePatch(onA, { azureEndpoint: `${A}:8443` })).toEqual({ azureEndpoint: `${A}:8443`, ...forgotten });
      expect(liveSavePatch({ key: "old" }, { provider: "azure", azureEndpoint: A })).toEqual({ provider: "azure", azureEndpoint: A, ...forgotten });
    });

    it("keeps the key for anything else, including a new path or deployment on the same host", () => {
      for (const patch of [{ voice: "cedar" }, { idleMinutes: 9 }, { azureDeployment: "other" }, { provider: "azure" as const }, { azureEndpoint: `${A}/openai/v1` }]) {
        expect(liveSavePatch(onA, patch), JSON.stringify(patch)).toEqual(patch);
      }
      expect(liveSavePatch({ key: "old" }, { voice: "cedar" })).toEqual({ voice: "cedar" });
    });

    it("forgets it when asked to, so a copy in the desktop's store stays unusable", () => {
      expect(liveSavePatch(onA, { key: "" })).toEqual(forgotten);
    });

    it("never takes keyFor from a request", () => {
      expect(liveSavePatch(onA, { keyFor: "azure:evil.azure-api.net", voice: "cedar" })).toEqual({ voice: "cedar" });
      expect(liveSavePatch(onA, { keyFor: "azure:b.openai.azure.com", azureEndpoint: B })).toEqual({ azureEndpoint: B, ...forgotten });
      expect(liveSavePatch(onA, { keyFor: "azure:evil.azure-api.net", key: "new" })).toEqual({ key: "new", keyFor: "azure:a.openai.azure.com" });
    });
  });

  describe("from the environment", () => {
    const usable = (live: LiveConfig | undefined, env: NodeJS.ProcessEnv) => usableLiveKey(liveConfigWithEnv(live, env));

    it("is the desktop's copy from its store, usable where it was saved for and nowhere else", () => {
      const env = { OMB_OPENAI_LIVE_KEY: "from-the-store" };
      expect(usable({ ...onA, key: "" }, env)).toBe("from-the-store");
      expect(usable({ ...onA, key: "", azureEndpoint: B }, env)).toBeUndefined();
      expect(usable({ provider: "openai", key: "", keyFor: "nowhere" }, env)).toBeUndefined();
      expect(usable({ provider: "azure", azureEndpoint: A, key: "", keyFor: "nowhere" }, env)).toBeUndefined();
    });

    it("pairs a key and an Azure endpoint set together there, as an operator does", () => {
      const env = { OMB_OPENAI_LIVE_KEY: "operators", OMB_LIVE_PROVIDER: "azure", OMB_AZURE_OPENAI_LIVE_ENDPOINT: A };
      expect(usable(undefined, env)).toBe("operators");
      expect(liveConfigWithEnv(undefined, env).keyFor).toBe("azure:a.openai.azure.com");
    });

    it("cannot be paired by settings saved later: a save mirrors them into the environment", () => {
      // Repoint the endpoint (the key is forgotten), wait for a restart (the desktop's copy returns as OMB_OPENAI_LIVE_KEY),
      // then save the same service and endpoint again, which puts both in the environment beside that copy.
      const evil = "https://evil.azure-api.net";
      const afterMove: LiveConfig = { provider: "azure", azureEndpoint: evil, key: "", keyFor: "nowhere" };
      const mirrored = { OMB_OPENAI_LIVE_KEY: "from-the-store", OMB_LIVE_PROVIDER: "azure", OMB_AZURE_OPENAI_LIVE_ENDPOINT: evil };
      expect(liveSavePatch(liveConfigWithEnv(afterMove, { OMB_OPENAI_LIVE_KEY: "from-the-store" }), { provider: "azure" })).toEqual({ provider: "azure" });
      expect(usable(afterMove, mirrored)).toBeUndefined();
    });

    it("re-pairs an operator's different key with the endpoint set beside it", () => {
      expect(usable(onA, { OMB_OPENAI_LIVE_KEY: "operators", OMB_LIVE_PROVIDER: "azure", OMB_AZURE_OPENAI_LIVE_ENDPOINT: B })).toBe("operators");
    });

    it("does not pair a key there with an endpoint or service only the file names", () => {
      expect(usable({ provider: "azure", azureEndpoint: A }, { OMB_OPENAI_LIVE_KEY: "operators" })).toBeUndefined();
      expect(usable({ azureEndpoint: A }, { OMB_OPENAI_LIVE_KEY: "operators", OMB_LIVE_PROVIDER: "azure" })).toBeUndefined();
      expect(usable({ provider: "azure" }, { OMB_OPENAI_LIVE_KEY: "operators", OMB_AZURE_OPENAI_LIVE_ENDPOINT: A })).toBeUndefined();
      expect(usable(onA, { OMB_LIVE_PROVIDER: "azure", OMB_AZURE_OPENAI_LIVE_ENDPOINT: B })).toBeUndefined();
    });

    it("takes no binding from the file when it is a different key from the one saved there", () => {
      expect(usable(onA, { OMB_OPENAI_LIVE_KEY: "another" })).toBeUndefined();
      expect(usable({ ...onA, provider: "openai", keyFor: "openai" }, { OMB_OPENAI_LIVE_KEY: "another" })).toBe("another");
      expect(usable(onA, { OMB_OPENAI_LIVE_KEY: "k" })).toBe("k");
    });

    it("keeps OpenAI working as it did with only a key set", () => {
      expect(usable(undefined, { OMB_OPENAI_LIVE_KEY: "sk-env" })).toBe("sk-env");
      expect(usable({ voice: "cedar" }, { OMB_OPENAI_LIVE_KEY: "sk-env", OMB_LIVE_PROVIDER: "openai" })).toBe("sk-env");
    });
  });
});
