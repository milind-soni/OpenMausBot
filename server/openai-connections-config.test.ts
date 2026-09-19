import { afterEach, describe, expect, it, vi } from "vitest";
import { instanceConfigs, persistableInstanceConfigs, stripWorkspaceCredentialEnv, type AppConfig } from "./config.ts";
import { OpenAICompatDriver, resolveOpenAICompatKey } from "./drivers/openai-compat.ts";

const globals = { key: "workspace-secret", url: "https://global.example/v1", model: "global-model", provider: "global-provider" };
const own = { auth: "bearer", url: "https://own.example/v1" };
afterEach(() => vi.unstubAllEnvs());

describe("independent API connection configuration", () => {
  it("does not inject workspace URL, key, model or upstream routing into explicit instances", () => {
    vi.stubEnv("OPENAI_COMPAT_API_KEY", "parent-secret");
    vi.stubEnv("OPENAI_COMPAT_MODEL", "parent-model");
    vi.stubEnv("OPENAI_COMPAT_PROVIDER", "parent-provider");
    const cfg: AppConfig = { openaiCompat: globals, instances: { own: { driver: "openai-compat", config: own } } };
    const effective = instanceConfigs(cfg).own;
    expect(effective.config).toEqual(own);
    expect(effective.environment).toEqual({});
    const decoded = OpenAICompatDriver.decodeConfig(effective.config);
    expect(decoded).toMatchObject({ url: own.url, model: undefined, provider: undefined });
    expect(resolveOpenAICompatKey(decoded, effective.environment!)).toBe("");
    expect(cfg.instances!.own.config).toBe(own);
  });

  it("preserves the original singleton's legacy effective values and persistence shape", () => {
    const cfg: AppConfig = { openaiCompat: globals, instances: { openaiCompat: { driver: "openai-compat" } } };
    expect(instanceConfigs(cfg).openaiCompat).toMatchObject({
      config: { url: globals.url, model: globals.model, provider: globals.provider },
      environment: { OPENAI_COMPAT_API_KEY: globals.key, OPENAI_COMPAT_URL: globals.url },
    });
    expect(persistableInstanceConfigs(cfg)).toEqual(cfg.instances);
  });

  it("injects desktop keys into only their matching runtime instance without freezing secrets on disk", () => {
    vi.stubEnv("OPENMAUS_OPENAI_CONNECTION_KEYS", JSON.stringify({ one: { key: "one-key", url: own.url }, two: { key: "two-key", url: "https://two.example/v1" } }));
    const cfg: AppConfig = { openaiCompat: globals, instances: {
      one: { driver: "openai-compat", config: { ...own, secretStorage: "external" } },
      two: { driver: "openai-compat", config: { ...own, url: "https://two.example/v1", secretStorage: "external" } },
    } };
    const effective = instanceConfigs(cfg);
    expect(effective.one.config).toMatchObject({ key: "one-key" });
    expect(effective.two.config).toMatchObject({ key: "two-key" });
    expect(persistableInstanceConfigs(cfg)).toEqual(cfg.instances);
    expect(JSON.stringify(cfg)).not.toContain("one-key");
    expect(JSON.stringify(cfg)).not.toContain("two-key");
    expect(JSON.stringify(persistableInstanceConfigs(cfg))).not.toContain("OPENMAUS_OPENAI_CONNECTION_KEYS");
  });

  it("fails closed when an external credential is absent, even with a stale inline or global key", () => {
    vi.stubEnv("OPENMAUS_OPENAI_CONNECTION_KEYS", "{}");
    vi.stubEnv("OPENAI_COMPAT_API_KEY", "parent-secret");
    const cfg: AppConfig = { openaiCompat: globals, instances: {
      own: { driver: "openai-compat", config: { ...own, secretStorage: "external", key: "obsolete-inline-key" } },
    } };
    const effective = instanceConfigs(cfg).own;
    expect(effective.config).toMatchObject({ key: "" });
    expect(resolveOpenAICompatKey(OpenAICompatDriver.decodeConfig(effective.config), effective.environment!)).toBe("");
  });

  it("refuses an external key bound to another endpoint after an interrupted edit", () => {
    vi.stubEnv("OPENMAUS_OPENAI_CONNECTION_KEYS", JSON.stringify({ own: { key: "next-endpoint-key", url: "https://next.example/v1" } }));
    const cfg: AppConfig = { openaiCompat: globals, instances: {
      own: { driver: "openai-compat", config: { ...own, secretStorage: "external" } },
    } };
    const effective = instanceConfigs(cfg).own;
    expect(effective.config).toMatchObject({ url: own.url, key: "" });
    expect(resolveOpenAICompatKey(OpenAICompatDriver.decodeConfig(effective.config), effective.environment!)).toBe("");
  });

  it("normalizes equivalent URLs when matching the external credential binding", () => {
    vi.stubEnv("OPENMAUS_OPENAI_CONNECTION_KEYS", JSON.stringify({ own: { key: "own-key", url: "https://OWN.example:443/v1/" } }));
    const cfg: AppConfig = { instances: {
      own: { driver: "openai-compat", config: { ...own, secretStorage: "external" } },
    } };
    expect(instanceConfigs(cfg).own.config).toMatchObject({ key: "own-key" });
  });

  it("never injects stored credentials into a keyless endpoint", () => {
    vi.stubEnv("OPENMAUS_OPENAI_CONNECTION_KEYS", JSON.stringify({ local: { key: "stale-key", url: "http://localhost:1234/v1" } }));
    const cfg: AppConfig = { openaiCompat: globals, instances: {
      local: { driver: "openai-compat", config: { auth: "none", url: "http://localhost:1234/v1", secretStorage: "external" } },
    } };
    expect(instanceConfigs(cfg).local).toMatchObject({ config: { key: "", auth: "none" }, environment: {} });
  });

  it("strips the full desktop credential map before spawning unrelated child runtimes", () => {
    const childEnv = { OPENMAUS_OPENAI_CONNECTION_KEYS: JSON.stringify({ own: { key: "secret", url: own.url } }), KEEP_ME: "setting" };
    stripWorkspaceCredentialEnv(childEnv);
    expect(childEnv).toEqual({ KEEP_ME: "setting" });
  });
});
