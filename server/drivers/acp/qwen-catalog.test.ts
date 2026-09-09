import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { QwenAgentDriver, readQwenModelCatalog } from "./qwen.ts";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchSettings(settings: unknown, raw = false): string {
  const home = mkdtempSync(join(tmpdir(), "omb-qwen-catalog-"));
  scratchDirs.push(home);
  const dir = join(home, ".qwen");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), raw ? String(settings) : JSON.stringify(settings));
  return home;
}

function homeEnv(home: string): Record<string, string> {
  return { HOME: home, USERPROFILE: home };
}

describe("readQwenModelCatalog", () => {
  it("returns an empty catalog for missing, malformed, or unsupported settings", () => {
    const missing = join(tmpdir(), "omb-qwen-missing-home");
    expect(readQwenModelCatalog(homeEnv(missing))).toEqual({ default: "", options: [] });

    const malformed = scratchSettings("{not-json", true);
    expect(readQwenModelCatalog(homeEnv(malformed))).toEqual({ default: "", options: [] });

    const noProviders = scratchSettings({ modelProviders: [] });
    expect(readQwenModelCatalog(homeEnv(noProviders))).toEqual({ default: "", options: [] });
  });

  it("reads id/name from every provider without exposing provider credentials", () => {
    const home = scratchSettings({
      modelProviders: {
        openai: [
          { id: "qwen3.7-plus", name: "Qwen Plus", apiKey: "must-not-leak", baseUrl: "https://example.test" },
          { id: "qwen3.8-max", name: "[ModelStudio Token Plan for Global/Intl] qwen3.8-max" },
          { id: "fallback-label", envKey: "SECRET_ENV" },
          { id: "  " },
          null,
        ],
        customProvider: [{ id: "custom/model", name: "Custom Model", token: "also-secret" }],
        malformedProvider: { id: "not-an-array" },
      },
    });

    const catalog = readQwenModelCatalog(homeEnv(home));
    expect(catalog).toEqual({
      default: "qwen3.7-plus",
      options: [
        { id: "qwen3.7-plus", label: "qwen3.7-plus — Qwen Plus", custom: true, provider: "openai" },
        { id: "qwen3.8-max", label: "qwen3.8-max", custom: true, provider: "openai" },
        { id: "fallback-label", label: "fallback-label", custom: true, provider: "openai" },
        { id: "custom/model", label: "custom/model — Custom Model", custom: true, provider: "customProvider" },
      ],
    });
    expect(JSON.stringify(catalog)).not.toContain("must-not-leak");
    expect(JSON.stringify(catalog)).not.toContain("SECRET_ENV");
    expect(JSON.stringify(catalog)).not.toContain("also-secret");
    expect(JSON.stringify(catalog)).not.toContain("https://example.test");
  });

  it("keeps the first row when providers repeat a model id", () => {
    const home = scratchSettings({
      modelProviders: {
        first: [{ id: "same-model", name: "First Label" }],
        second: [
          { id: "same-model", name: "Second Label" },
          { id: "unique-model", name: "Unique" },
        ],
      },
    });

    expect(readQwenModelCatalog(homeEnv(home)).options).toEqual([
      { id: "same-model", label: "same-model — First Label", custom: true, provider: "first" },
      { id: "unique-model", label: "unique-model — Unique", custom: true, provider: "second" },
    ]);
  });

  it("uses USERPROFILE on Windows and HOME on other platforms", () => {
    const home = scratchSettings({ modelProviders: { home: [{ id: "from-home" }] } });
    const userProfile = scratchSettings({ modelProviders: { profile: [{ id: "from-userprofile" }] } });
    const catalog = readQwenModelCatalog({ HOME: home, USERPROFILE: userProfile });
    expect(catalog.default).toBe(process.platform === "win32" ? "from-userprofile" : "from-home");
  });
});

describe("QwenAgentDriver catalog", () => {
  it("loads configured Qwen models when the instance is created", async () => {
    const home = scratchSettings({ modelProviders: { openai: [{ id: "configured-qwen", name: "Configured Qwen" }] } });
    const instance = await QwenAgentDriver.create({
      instanceId: "qwen-catalog",
      displayName: "Qwen",
      environment: homeEnv(home),
      enabled: true,
      config: QwenAgentDriver.defaultConfig(),
    });
    try {
      expect(instance.models.default).toBe("configured-qwen");
      expect(instance.models.options).toContainEqual({
        id: "configured-qwen",
        label: "configured-qwen — Configured Qwen",
        custom: true,
        provider: "openai",
      });
      expect(instance.refreshModels).toEqual(expect.any(Function));
    } finally {
      await instance.dispose();
    }
  });

  it("keeps live local inject discovery and removes its duplicate plain model id", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes(":8080")) {
        return new Response(JSON.stringify({ data: [{ id: "local-qwen" }] }), { status: 200 });
      }
      return new Response("unavailable", { status: 500 });
    }) as typeof fetch;
    const home = scratchSettings({
      modelProviders: {
        openai: [
          { id: "cloud-qwen", name: "Cloud Qwen" },
          { id: "local-qwen", name: "Stale local row" },
        ],
      },
    });
    const instance = await QwenAgentDriver.create({
      instanceId: "qwen-local-catalog",
      displayName: "Qwen",
      environment: { ...homeEnv(home), OPENMAUSBOT_PROBE_LOCAL_INJECT: "1" },
      enabled: true,
      config: QwenAgentDriver.defaultConfig(),
    });
    try {
      expect(instance.models.default).toBe("cloud-qwen");
      expect(instance.models.options.map((option) => option.id)).toEqual([
        "cloud-qwen",
        "omlx::local-qwen",
      ]);
    } finally {
      globalThis.fetch = previousFetch;
      await instance.dispose();
    }
  });
});
