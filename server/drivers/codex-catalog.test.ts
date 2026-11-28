import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { CodexDriver } from "./codex.ts";
import {
  decodeCodexSelection,
  encodeCodexSelection,
  OFFICIAL_CODEX_PROVIDER,
  readCodexModelCatalog,
  STATIC_CODEX_MODELS,
} from "./codex-catalog.ts";

const scratchDirs: string[] = [];
const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchHome(files: Record<string, string>, parent = tmpdir()): string {
  const home = mkdtempSync(join(parent, "omb-codex-catalog-"));
  scratchDirs.push(home);
  const root = join(home, ".codex");
  mkdirSync(root, { recursive: true });
  for (const [relative, body] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
  return home;
}

describe("decodeCodexSelection", () => {
  it("forces official rows onto the ChatGPT provider", () => {
    expect(decodeCodexSelection("gpt-5.6-sol")).toEqual({
      model: "gpt-5.6-sol",
      modelProvider: OFFICIAL_CODEX_PROVIDER,
    });
  });

  it("forces newly discovered bare ids onto the ChatGPT provider too", () => {
    expect(decodeCodexSelection("gpt-future-codex")).toEqual({
      model: "gpt-future-codex",
      modelProvider: OFFICIAL_CODEX_PROVIDER,
    });
  });

  it("reads a Fast or Ultrafast row as its base model on that service tier", () => {
    expect(decodeCodexSelection("gpt-5.6-sol+priority")).toEqual({
      model: "gpt-5.6-sol",
      modelProvider: OFFICIAL_CODEX_PROVIDER,
      serviceTier: "priority",
    });
    expect(decodeCodexSelection("gpt-6.2-sol+ultrafast")).toEqual({
      model: "gpt-6.2-sol",
      modelProvider: OFFICIAL_CODEX_PROVIDER,
      serviceTier: "ultrafast",
    });
  });

  it("splits provider-encoded custom ids", () => {
    expect(decodeCodexSelection("omlx::Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning")).toEqual({
      model: "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning",
      modelProvider: "omlx",
    });
  });
});

describe("readCodexModelCatalog", () => {
  it("returns the static cloud fallback when there is no config or CLI probe", async () => {
    expect(await readCodexModelCatalog({ HOME: join(tmpdir(), "omb-codex-missing-home") })).toEqual(
      STATIC_CODEX_MODELS,
    );
  });

  it("lists GPT-6.2 Astra and Sol first when the static cloud fallback is used", async () => {
    const catalog = await readCodexModelCatalog({ HOME: join(tmpdir(), "omb-codex-missing-home") });
    expect(catalog.options.slice(0, 2)).toEqual([
      { id: "gpt-6.2-astra", label: "GPT-6.2 Astra (availability unverified)" },
      { id: "gpt-6.2-sol", label: "GPT-6.2 Sol (availability unverified)" },
    ]);
    expect(catalog.default).toBe("gpt-5.6-sol");
  });

  it("uses every visible page from the installed Codex app-server catalog", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const catalog = await readCodexModelCatalog(
      { HOME: join(tmpdir(), "omb-codex-app-server-models"), PATH: process.env.PATH },
      fetch,
      FAKE_CLI,
    );

    expect(catalog).toEqual({
      default: "gpt-fake-default",
      options: [
        { id: "gpt-fake-default", label: "GPT Fake Default" },
        { id: "gpt-page-two", label: "GPT Page Two" },
      ],
    });
  });

  it("reads the app-server catalog again when the first listing fails", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const home = scratchHome({});
    const attempts = join(home, "catalog-attempts");
    const catalog = await readCodexModelCatalog(
      { HOME: home, PATH: process.env.PATH, FAKE_CODEX_CATALOG_FAILURES: "1", FAKE_CODEX_STATE: attempts },
      fetch,
      FAKE_CLI,
    );

    expect(catalog).toEqual({
      default: "gpt-fake-default",
      options: [
        { id: "gpt-fake-default", label: "GPT Fake Default" },
        { id: "gpt-page-two", label: "GPT Page Two" },
      ],
    });
    expect(readFileSync(attempts, "utf8")).toBe("2");
  });

  it("falls back to the static catalog when the second listing also fails", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const home = scratchHome({});
    const attempts = join(home, "catalog-attempts");
    const catalog = await readCodexModelCatalog(
      { HOME: home, PATH: process.env.PATH, FAKE_CODEX_CATALOG_FAILURES: "2", FAKE_CODEX_STATE: attempts },
      fetch,
      FAKE_CLI,
    );

    expect(catalog).toEqual(STATIC_CODEX_MODELS);
    expect(readFileSync(attempts, "utf8")).toBe("2");
  });

  it("sends a model_catalog_json listing to the provider that serves it", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const home = scratchHome({
      "config.toml": [
        'model = "gpt-fake-default"',
        'model_provider = "gw"',
        "model_catalog_json = 'gw-models.json'",
        "",
        "[model_providers.gw]",
        'name = "My gateway"',
        'base_url = "http://127.0.0.1:9/v1"',
        "",
      ].join("\n"),
    });

    const catalog = await readCodexModelCatalog({ HOME: home, PATH: process.env.PATH, FAKE_CODEX_TIERS: "1" }, fetch, FAKE_CLI);

    expect(catalog.default).toBe("gw::gpt-fake-default");
    expect(catalog.options.map((option) => option.id)).toEqual(["gw::gpt-fake-default", "gw::gpt-page-two"]);
    expect(catalog.options.every((option) => option.custom)).toBe(true);
    expect(catalog.options.map((option) => decodeCodexSelection(option.id).modelProvider)).toEqual(["gw", "gw"]);
  });

  it("keeps a model_catalog_json listing on OpenAI when OpenAI serves it", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const home = scratchHome({ "config.toml": "model_catalog_json = 'models.json'\n" });

    const catalog = await readCodexModelCatalog({ HOME: home, PATH: process.env.PATH }, fetch, FAKE_CLI);

    expect(catalog.options.map((option) => option.id)).toEqual(["gpt-fake-default", "gpt-page-two"]);
  });

  it("keeps OpenAI's listing beside a local provider that has no model_catalog_json", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const home = scratchHome({
      "config.toml": 'model = "local-model"\nmodel_provider = "gw"\n\n[model_providers.gw]\nname = "My gateway"\nbase_url = "http://127.0.0.1:9/v1"\n',
    });

    const catalog = await readCodexModelCatalog({ HOME: home, PATH: process.env.PATH }, fetch, FAKE_CLI);

    expect(catalog.options.map((option) => option.id)).toEqual(["gpt-fake-default", "gpt-page-two", "gw::local-model"]);
  });

  it("adds a Fast row after each model that offers Fast and does not already run on it", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const catalog = await readCodexModelCatalog(
      { HOME: join(tmpdir(), "omb-codex-app-server-tiers"), PATH: process.env.PATH, FAKE_CODEX_TIERS: "1" },
      fetch,
      FAKE_CLI,
    );

    expect(catalog).toEqual({
      default: "gpt-fake-default",
      options: [
        { id: "gpt-fake-default", label: "GPT Fake Default" },
        { id: "gpt-fake-default+priority", label: "GPT Fake Default · Fast" },
        { id: "gpt-page-two", label: "GPT Page Two" },
      ],
    });
  });

  it("reads per-model supportedReasoningEfforts so only supporting models advertise ultra", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const catalog = await readCodexModelCatalog(
      { HOME: join(tmpdir(), "omb-codex-app-server-efforts"), PATH: process.env.PATH, FAKE_CODEX_TIERS: "1", FAKE_CODEX_EFFORTS: "1" },
      fetch,
      FAKE_CLI,
    );

    expect(catalog).toEqual({
      default: "gpt-fake-default",
      options: [
        {
          id: "gpt-fake-default",
          label: "GPT Fake Default",
          effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
        {
          id: "gpt-fake-default+priority",
          label: "GPT Fake Default · Fast",
          effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
        {
          id: "gpt-page-two",
          label: "GPT Page Two",
          effortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
      ],
    });
  });

  it("preserves CLI-listed effortLevels when model_catalog_json also matches the configured model", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const home = scratchHome({
      "config.toml": `
model_provider = "omlx"
model = "gpt-fake-default"
model_catalog_json = "omlx-catalog.json"

[model_providers.omlx]
name = "oMLX"
`,
      "omlx-catalog.json": JSON.stringify({ models: [{ slug: "gpt-fake-default" }] }),
    });
    const catalog = await readCodexModelCatalog(
      { HOME: home, PATH: process.env.PATH, FAKE_CODEX_EFFORTS: "1" },
      fetch,
      FAKE_CLI,
    );

    expect(catalog.options).toContainEqual({
      id: encodeCodexSelection("omlx", "gpt-fake-default"),
      label: "gpt-fake-default (oMLX)",
      custom: true,
      effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    });
    expect(catalog.options).toContainEqual({
      id: encodeCodexSelection("omlx", "gpt-page-two"),
      label: "gpt-page-two (oMLX)",
      custom: true,
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
    });
  });

  it("emits every distinct non-default fast tier (Fast and Ultrafast) without dropping later tiers", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const catalog = await readCodexModelCatalog(
      {
        HOME: join(tmpdir(), "omb-codex-app-server-ultrafast"),
        PATH: process.env.PATH,
        FAKE_CODEX_TIERS: "1",
        FAKE_CODEX_ULTRAFAST: "1",
      },
      fetch,
      FAKE_CLI,
    );

    expect(catalog).toEqual({
      default: "gpt-fake-default",
      options: [
        { id: "gpt-fake-default", label: "GPT Fake Default" },
        { id: "gpt-fake-default+priority", label: "GPT Fake Default · Fast" },
        { id: "gpt-fake-default+ultrafast", label: "GPT Fake Default · Ultrafast" },
        { id: "gpt-page-two", label: "GPT Page Two" },
        { id: "gpt-page-two+ultrafast", label: "GPT Page Two · Ultrafast" },
      ],
    });
  });

  it("strips all tiered options when model_catalog_json routes models to a custom provider", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const home = scratchHome({
      "config.toml": [
        'model = "gpt-fake-default"',
        'model_provider = "gw"',
        "model_catalog_json = 'gw-models.json'",
        "",
        "[model_providers.gw]",
        'name = "My gateway"',
        'base_url = "http://127.0.0.1:9/v1"',
        "",
      ].join("\n"),
    });

    const catalog = await readCodexModelCatalog(
      { HOME: home, PATH: process.env.PATH, FAKE_CODEX_TIERS: "1", FAKE_CODEX_ULTRAFAST: "1" },
      fetch,
      FAKE_CLI,
    );

    expect(catalog.options.map((option) => option.id)).toEqual(["gw::gpt-fake-default", "gw::gpt-page-two"]);
  });

  it("appends the configured local model and cached catalog slugs as custom", async () => {
    const home = scratchHome({
      "config.toml": `
model_provider = "omlx"
model = "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning"

[model_providers.omlx]
name = "oMLX"
base_url = "http://127.0.0.1:9/v1"
`,
      "omlx.config.toml": `
model_provider = "omlx"
model = "GLM-5.2-mxfp4"
`,
      "model-catalogs/omlx-models.json": JSON.stringify({
        models: [{ slug: "GLM-5.2-mxfp4", display_name: "GLM-5.2-mxfp4 (oMLX)" }],
      }),
    });

    const catalog = await readCodexModelCatalog({ HOME: home }, async () => {
      throw new Error("live probe should not be required");
    });

    expect(catalog.default).toBe(encodeCodexSelection("omlx", "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning"));
    expect(catalog.options.slice(0, STATIC_CODEX_MODELS.options.length)).toEqual(STATIC_CODEX_MODELS.options);
    expect(catalog.options.filter((option) => option.custom).map((option) => option.id)).toEqual([
      encodeCodexSelection("omlx", "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning"),
      encodeCodexSelection("omlx", "GLM-5.2-mxfp4"),
    ]);
    expect(catalog.options.find((option) => option.id.endsWith("GLM-5.2-mxfp4"))?.label).toBe("GLM-5.2-mxfp4 (oMLX)");
  });

  it("keeps an official-looking model slug bound to its configured local provider", async () => {
    const home = scratchHome({
      "config.toml": `
model_provider = "omlx"
model = "gpt-5.4"

[model_providers.omlx]
name = "oMLX"
`,
    });

    const catalog = await readCodexModelCatalog({ HOME: home });
    const local = encodeCodexSelection("omlx", "gpt-5.4");

    expect(catalog.default).toBe(local);
    expect(catalog.options).toContainEqual({
      id: local,
      label: "gpt-5.4 (oMLX)",
      custom: true,
    });
    expect(decodeCodexSelection(catalog.default)).toEqual({
      model: "gpt-5.4",
      modelProvider: "omlx",
    });
  });

  it("honors CODEX_HOME over HOME and merges live /v1/models", async () => {
    const ignored = scratchHome({
      "config.toml": `model_provider = "omlx"\nmodel = "ignored"\n`,
    });
    const parent = mkdtempSync(join(tmpdir(), "omb-codex-home-"));
    scratchDirs.push(parent);
    const codexHome = join(parent, "codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, "config.toml"),
      `
model_provider = "unsloth_api"
model = "unsloth/gemma-4-26B-A4B-it-GGUF"

[model_providers.unsloth_api]
name = "Unsloth Studio"
base_url = "http://127.0.0.1:8888/v1"
env_key = "UNSLOTH_STUDIO_AUTH_TOKEN"
`,
    );

    const catalog = await readCodexModelCatalog(
      { HOME: ignored, CODEX_HOME: codexHome, UNSLOTH_STUDIO_AUTH_TOKEN: "sk-test" },
      async (url, init) => {
        expect(String(url)).toBe("http://127.0.0.1:8888/v1/models");
        expect((init as RequestInit | undefined)?.headers).toMatchObject({ Authorization: "Bearer sk-test" });
        return new Response(JSON.stringify({ data: [{ id: "unsloth/extra-live" }, { id: "bad id" }] }), { status: 200 });
      },
    );

    expect(catalog.options.map((option) => option.id)).toContain(
      encodeCodexSelection("unsloth_api", "unsloth/gemma-4-26B-A4B-it-GGUF"),
    );
    expect(catalog.options.map((option) => option.id)).toContain(encodeCodexSelection("unsloth_api", "unsloth/extra-live"));
    expect(catalog.options.map((option) => option.id)).not.toContain(encodeCodexSelection("omlx", "ignored"));
  });

  it("refuses a relative CODEX_HOME instead of falling back to ~/.codex", async () => {
    const home = scratchHome({
      "config.toml": `
model_provider = "omlx"
model = "leaked-default"

[model_providers.omlx]
name = "oMLX"
base_url = "http://127.0.0.1:9/v1"
`,
    });

    const catalog = await readCodexModelCatalog({ HOME: home, CODEX_HOME: "relative-codex" });

    expect(catalog.default).toBe(STATIC_CODEX_MODELS.default);
    expect(catalog.options.map((option) => option.id)).not.toContain(
      encodeCodexSelection("omlx", "leaked-default"),
    );
  });

  it("refuses a relative user home just like the identity lookup", async () => {
    // Windows cannot express a relative path across different drives.
    const home = scratchHome({
      "config.toml": 'model_provider = "omlx"\nmodel = "relative-home-model"\n[model_providers.omlx]\nname = "Fixture"\nbase_url = "http://127.0.0.1:9/v1"\n',
    }, process.cwd());
    const relativeHome = relative(process.cwd(), home);
    expect(isAbsolute(relativeHome)).toBe(false);
    const catalog = await readCodexModelCatalog({ HOME: relativeHome, USERPROFILE: relativeHome });
    expect(catalog.options.map((option) => option.id)).not.toContain(
      encodeCodexSelection("omlx", "relative-home-model"),
    );
  });

  it("ignores invalid slugs and a default that is not in the catalog", async () => {
    const home = scratchHome({
      "config.toml": `
model_provider = "nope!"
model = "not installed"

[model_providers.omlx]
name = "oMLX"
`,
    });
    const catalog = await readCodexModelCatalog({ HOME: home });
    expect(catalog.default).toBe("gpt-5.6-sol");
    expect(catalog.options.every((option) => !option.custom)).toBe(true);
  });
});

describe("CodexDriver catalog", () => {
  it("loads the config catalog when the instance is created", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const home = scratchHome({
      "config.toml": `
model_provider = "omlx"
model = "MiniMax-M3-4bit"

[model_providers.omlx]
name = "oMLX"
`,
    });
    const instance = await CodexDriver.create({
      instanceId: "codex-catalog",
      displayName: "Codex",
      environment: { HOME: home, USERPROFILE: home },
      enabled: true,
      config: { ...CodexDriver.defaultConfig(), cli: FAKE_CLI },
    });
    try {
      expect(instance.models.options.some((option) => option.id === "omlx::MiniMax-M3-4bit" && option.custom)).toBe(true);
      expect(instance.refreshModels).toEqual(expect.any(Function));
    } finally {
      await instance.dispose();
    }
  });
});
