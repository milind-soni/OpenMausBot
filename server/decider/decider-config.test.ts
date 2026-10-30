import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  changedInstanceIds, DATA_DIR, instanceConfigs, loadConfig, parseConfigPatch, parseStoredConfig, saveConfig, stripWorkspaceCredentialEnv, syncCredentialEnv,
} from "../config.ts";
import { createDecider, deciderSavePatch, describeDecider } from "./index.ts";

const KEY = "tsk_config_secret_0123456789";
const OR_KEY = "sk-or-v1-config-secret-0123456789";

describe("decider config", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    delete process.env.OMB_JEV_API_KEY;
    delete process.env.OMB_OPENROUTER_DECIDER_KEY;
  });
  afterEach(() => {
    delete process.env.OMB_JEV_API_KEY;
    delete process.env.OMB_OPENROUTER_DECIDER_KEY;
  });

  it("saving decision-model settings never reloads the engine fleet", () => {
    const decider = { enabled: true, key: KEY, jobs: { roomRouting: false } };
    expect(changedInstanceIds(instanceConfigs({}), instanceConfigs({ decider }))).toEqual([]);
  });

  it("engines never inherit the key, nor Cloud Pro's included token", () => {
    const childEnv: Record<string, string | undefined> = {
      OMB_JEV_API_KEY: KEY, OMB_OPENROUTER_DECIDER_KEY: OR_KEY, OMB_CLOUD_DECIDER_TOKEN: "omb_decide_included", PATH: "/usr/bin",
    };
    stripWorkspaceCredentialEnv(childEnv);
    expect(childEnv).toEqual({ PATH: "/usr/bin" });
  });

  it("on Cloud Pro, a key in the environment is the person's own and wins over the included decisions", async () => {
    const relay = "https://cloud.example.test/api/cloud/services/decider";
    vi.stubEnv("OMB_CLOUD_DECIDER_URL", relay);
    vi.stubEnv("OMB_CLOUD_DECIDER_TOKEN", "omb_decide_included");
    try {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ answers: { answer: { type: "noul", noul: 0.9 } } })));
      const decider = createDecider({ config: loadConfig, fetch: fetchImpl });
      expect(describeDecider(loadConfig())).toMatchObject({ configured: true, included: true, enabled: true });
      await decider.testKey();
      // the desktop hands the saved key over as env: now it is the one in use
      process.env.OMB_JEV_API_KEY = KEY;
      saveConfig({ decider: { enabled: true } });
      expect(describeDecider(loadConfig())).toEqual({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } });
      await decider.testKey();
      const calls = fetchImpl.mock.calls.map(([url, init]) => [String(url), (init!.headers as Record<string, string>).authorization]);
      expect(calls).toEqual([[`${relay}/v1/systemone`, "Bearer omb_decide_included"], ["https://api.typesafe.ai/v1/systemone", `Bearer ${KEY}`]]);
      expect(readFileSync(join(DATA_DIR, "config.json"), "utf8")).not.toContain("omb_decide_included");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the env key wins over the file, and a save keeps the env in step", () => {
    writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ decider: { enabled: true, key: "" } }));
    process.env.OMB_JEV_API_KEY = KEY;
    expect(loadConfig().decider?.key).toBe(KEY);
    syncCredentialEnv({ decider: { key: "tsk_new" } });
    expect(process.env.OMB_JEV_API_KEY).toBe("tsk_new");
    syncCredentialEnv({ decider: { key: "" } });
    expect(process.env.OMB_JEV_API_KEY).toBeUndefined();
  });

  it("saving a key persists the switch and the room job on, merged into the section", () => {
    saveConfig({ decider: { jobs: { roomRouting: false } } });
    const planned = deciderSavePatch({ key: KEY }, loadConfig().decider);
    if (!planned.ok) throw new Error(planned.error);
    saveConfig({ decider: planned.patch });
    const disk = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
    expect(disk.decider).toEqual({ key: KEY, enabled: true, jobs: { roomRouting: true } });
    expect(describeDecider(loadConfig())).toEqual({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } });
  });

  it("the OpenRouter key is its own: env wins over the file, a save keeps env in step, the engine's key is untouched", () => {
    writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ decider: { provider: "openrouter", openrouterKey: "" }, openrouter: { key: "engine-key" } }));
    process.env.OMB_OPENROUTER_DECIDER_KEY = OR_KEY;
    expect(loadConfig().decider?.openrouterKey).toBe(OR_KEY);
    expect(loadConfig().openrouter?.key).toBe("engine-key");
    syncCredentialEnv({ decider: { openrouterKey: "sk-or-new" } });
    expect(process.env.OMB_OPENROUTER_DECIDER_KEY).toBe("sk-or-new");
    expect(process.env.OMB_JEV_API_KEY).toBeUndefined();
    syncCredentialEnv({ decider: { openrouterKey: "" } });
    expect(process.env.OMB_OPENROUTER_DECIDER_KEY).toBeUndefined();
  });

  it("saving the OpenRouter key persists provider, model, switch and room job, merged into the section", () => {
    saveConfig({ decider: { jobs: { roomRouting: false } } });
    const planned = deciderSavePatch({ provider: "openrouter", openrouterModel: "openai/gpt-4o-mini", openrouterKey: OR_KEY }, loadConfig().decider);
    if (!planned.ok) throw new Error(planned.error);
    saveConfig({ decider: planned.patch });
    const disk = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
    expect(disk.decider).toEqual({
      provider: "openrouter", openrouterModel: "openai/gpt-4o-mini", openrouterApi: "chat", openrouterKey: OR_KEY, enabled: true, jobs: { roomRouting: true },
    });
    expect(describeDecider(loadConfig())).toEqual({
      provider: "openrouter", model: "openai/gpt-4o-mini", api: "chat", configured: true, keySource: "own", enabled: true, jobs: { roomRouting: true },
    });
  });

  it("the OpenRouter key under API keys, from the file or the environment, backs the decision model until it has its own", async () => {
    delete process.env.OMB_OPENROUTER_API_KEY;
    writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ decider: { provider: "openrouter", enabled: true }, openrouter: { key: OR_KEY } }));
    const described = () => describeDecider(loadConfig());
    expect(described()).toMatchObject({ provider: "openrouter", configured: true, keySource: "shared", sharedKey: true, enabled: true });
    expect(JSON.stringify(described())).not.toContain(OR_KEY);

    saveConfig({ decider: { openrouterKey: "sk-or-own" } });
    expect(described()).toMatchObject({ configured: true, keySource: "own", sharedKey: true });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers: { answer: { noul: 0.97 } } }) } }] })));
    const decider = createDecider({ config: loadConfig, fetch: fetchImpl });
    await decider.testKey();
    saveConfig({ decider: { openrouterKey: "" } });
    await decider.testKey();
    const bearers = fetchImpl.mock.calls.map(([, init]) => (init!.headers as Record<string, string>).authorization);
    expect(bearers).toEqual(["Bearer sk-or-own", `Bearer ${OR_KEY}`]);

    saveConfig({ openrouter: { key: "" } });
    expect(described()).toMatchObject({ configured: false, enabled: false });
    vi.stubEnv("OMB_OPENROUTER_API_KEY", OR_KEY);
    try {
      expect(described()).toMatchObject({ configured: true, keySource: "shared", enabled: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("an existing Jev-only config file keeps resolving to Jev, and an old OpenRouter choice never moves it off the own Jev key", () => {
    writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ decider: { enabled: true, key: KEY } }));
    expect(describeDecider(loadConfig())).toEqual({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } });
    saveConfig({ decider: { provider: "openrouter" } });
    expect(loadConfig().decider).toMatchObject({ provider: "openrouter", key: KEY, enabled: true });
    expect(describeDecider(loadConfig())).toMatchObject({ provider: "jev", configured: true, enabled: true });
    saveConfig({ decider: { provider: "jev" } });
    expect(describeDecider(loadConfig())).toMatchObject({ provider: "jev", configured: true, enabled: true });
  });

  it("validates the OpenRouter fields: a model id is vendor/model, the address http(s), the provider known", () => {
    expect(parseConfigPatch({ decider: { provider: "openrouter", openrouterModel: " meta-llama/llama-3.3-70b-instruct ", openrouterBaseUrl: "http://127.0.0.1:9000/v1" } }).decider)
      .toEqual({ provider: "openrouter", openrouterModel: "meta-llama/llama-3.3-70b-instruct", openrouterBaseUrl: "http://127.0.0.1:9000/v1" });
    expect(parseConfigPatch({ decider: { openrouterModel: "qwen/qwen3-30b-a3b-instruct-2507" } }).decider?.openrouterModel).toBe("qwen/qwen3-30b-a3b-instruct-2507");
    for (const bad of ["gpt-4o", "openai/", "/gpt", "openai/gpt 4", "-openai/gpt", "a".repeat(129) + "/b"]) {
      expect(() => parseConfigPatch({ decider: { openrouterModel: bad } }), bad).toThrow();
    }
    expect(() => parseConfigPatch({ decider: { openrouterBaseUrl: "file:///etc/passwd" } })).toThrow();
  });

  it("validates the section: a base URL must be http(s), the provider known", () => {
    expect(parseConfigPatch({ decider: { baseUrl: "http://127.0.0.1:9000", enabled: true } }).decider).toEqual({ baseUrl: "http://127.0.0.1:9000", enabled: true });
    expect(() => parseConfigPatch({ decider: { baseUrl: "file:///etc/passwd" } })).toThrow();
    expect(() => parseConfigPatch({ decider: { provider: "someone-else" } })).toThrow();
    expect(parseStoredConfig({ tts: { voice: "narrator" } }).decider).toBeUndefined();
  });
});
