import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { HERMES_CONFIG_MODEL_ID, hermesAcpModelId, hermesConfiguredModel } from "./hermes.ts";

describe("hermesConfiguredModel", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await removeTempDir(d);
  });

  const home = (env: string, cfg?: string) => {
    const root = mkdtempSync(join(tmpdir(), "omb-hermes-"));
    dirs.push(root);
    const h = join(root, ".hermes");
    mkdirSync(h, { recursive: true });
    writeFileSync(join(h, ".env"), env);
    if (cfg !== undefined) writeFileSync(join(h, "config.yaml"), cfg);
    return { HERMES_HOME: h };
  };

  it("offers the configured model when a hosted key is set", () => {
    const env = home("OPENROUTER_API_KEY=sk-or-v1-test\n", "model:\n  default: anthropic/claude-opus-4.6\n");
    expect(hermesConfiguredModel(env)).toEqual({
      id: HERMES_CONFIG_MODEL_ID,
      label: "anthropic/claude-opus-4.6 (Hermes config)",
      // ModelPicker shows a custom-only agent ONLY its custom-flagged options.
      custom: true,
    });
  });

  it.each(["GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"])(
    "offers Hermes for a key-only Z.AI setup using %s",
    (name) => {
      const env = home(`${name}=zai-test-key\n`);
      expect(hermesConfiguredModel(env)).toEqual({
        id: HERMES_CONFIG_MODEL_ID,
        label: "Hermes default (config)",
        custom: true,
      });
    },
  );

  it("treats a commented-out key with no config.yaml as not configured", () => {
    // The shipped .env carries `# OPENROUTER_API_KEY=`; without config.yaml
    // there's no evidence of a working provider, so it must not read as configured.
    const env = home("# OPENROUTER_API_KEY=\n");
    expect(hermesConfiguredModel(env)).toBeNull();
  });

  it("treats a commented-out key with config.yaml as configured (Nous Portal)", () => {
    // A Nous Portal user has OAuth tokens, not an OpenRouter API key.
    // config.yaml existing is sufficient evidence of a working provider.
    const env = home("# OPENROUTER_API_KEY=\n", "model:\n  default: z-ai/glm-5.2\n");
    expect(hermesConfiguredModel(env)).toEqual({
      id: HERMES_CONFIG_MODEL_ID,
      label: "z-ai/glm-5.2 (Hermes config)",
      custom: true,
    });
  });

  it.each([
    "OPENROUTER_API_KEY=\n",
    'OPENROUTER_API_KEY=""\n',
    "OPENROUTER_API_KEY='' # intentionally blank\n",
    "OPENROUTER_API_KEY=   # configured later\n",
  ])("does not treat a blank key with no config.yaml as configured: %j", (line) => {
    expect(hermesConfiguredModel(home(line))).toBeNull();
  });

  it("returns null when there is no .env and no config.yaml, leaving local-only setups unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-hermes-bare-"));
    dirs.push(root);
    mkdirSync(join(root, ".hermes"), { recursive: true });
    expect(hermesConfiguredModel({ HERMES_HOME: join(root, ".hermes") })).toBeNull();
  });

  it("offers the configured model when only config.yaml exists (Nous Portal OAuth)", () => {
    // A Nous Portal user logs in via OAuth — no API key in .env, but
    // config.yaml exists with a default model. This is the most common
    // setup for `hermes setup` / `hermes login` users.
    const root = mkdtempSync(join(tmpdir(), "omb-hermes-nous-"));
    dirs.push(root);
    const h = join(root, ".hermes");
    mkdirSync(h, { recursive: true });
    writeFileSync(join(h, "config.yaml"), "model:\n  default: z-ai/glm-5.2\n");
    expect(hermesConfiguredModel({ HERMES_HOME: h })).toEqual({
      id: HERMES_CONFIG_MODEL_ID,
      label: "z-ai/glm-5.2 (Hermes config)",
      custom: true,
    });
  });

  it("does not treat an inject-only config.yaml as hosted configuration", () => {
    const env = home("", "providers:\n  ollama:\n    base_url: http://127.0.0.1:11434/v1\n");
    expect(hermesConfiguredModel(env)).toBeNull();
  });

  it.each(["custom", "ollama", "vllm", "llamacpp", "lmstudio"])(
    "does not probe a model explicitly routed through the local %s provider",
    (provider) => {
      const env = home("", `model:\n  default: llama3.2 # local model\n  provider: ${provider}\n`);
      expect(hermesConfiguredModel(env)).toBeNull();
    },
  );

  it("keeps an explicit local provider even when a hosted key is also present", () => {
    const env = home(
      "OPENROUTER_API_KEY=stale-hosted-key\n",
      "model:\n  default: llama3.2\n  provider: ollama\n",
    );
    expect(hermesConfiguredModel(env)).toBeNull();
  });

  it("keeps a named custom provider even when a hosted key is also present", () => {
    const env = home(
      "OPENROUTER_API_KEY=stale-hosted-key\n",
      "model:\n  default: local-model\n  provider: custom:local\n",
    );
    expect(hermesConfiguredModel(env)).toBeNull();
  });

  it.each([
    ["scalar", "model: z-ai/glm-5.2 # selected by setup\n", "z-ai/glm-5.2"],
    ["default", "model:\n  default: z-ai/glm-5.2 # selected by setup\n", "z-ai/glm-5.2"],
    ["model alias", "model:\n  model: z-ai/glm-5.2\n", "z-ai/glm-5.2"],
    ["name alias", "model:\n  name: z-ai/glm-5.2\n", "z-ai/glm-5.2"],
    [
      "nested default",
      "model:\n  provider: auto\n  default:\n    provider: nous\n    model: z-ai/glm-5.2\n",
      "z-ai/glm-5.2",
    ],
    ["legacy root provider", "provider: nous\nmodel:\n  default: z-ai/glm-5.2\n", "z-ai/glm-5.2"],
  ])("supports Hermes' %s configuration schema", (_schema, cfg, expectedModel) => {
    const env = home("", cfg);
    expect(hermesConfiguredModel(env)).toEqual({
      id: HERMES_CONFIG_MODEL_ID,
      label: `${expectedModel} (Hermes config)`,
      custom: true,
    });
  });

  it("still offers the model when config.yaml is unreadable, with a generic label", () => {
    const env = home("OPENROUTER_API_KEY=sk-or-v1-test\n");
    mkdirSync(join(env.HERMES_HOME, "config.yaml"));
    expect(hermesConfiguredModel(env)).toEqual({
      id: HERMES_CONFIG_MODEL_ID,
      label: "Hermes default (config)",
      custom: true,
    });
  });

  it("does not map to an ACP model id, so no session/set_model is sent for it", () => {
    // This is what makes Hermes fall through to its own configured provider.
    expect(hermesAcpModelId(HERMES_CONFIG_MODEL_ID)).toBeNull();
  });
});

describe("hermesAcpModelId", () => {
  it("forwards Hermes' own provider-scoped ids untouched", () => {
    // These are what `session/new` advertises. Returning null for them is what
    // confined the picker to locally injected hosts.
    expect(hermesAcpModelId("openrouter:qwen/qwen3.8-max")).toBe("openrouter:qwen/qwen3.8-max");
    expect(hermesAcpModelId("openrouter:deepseek/deepseek-v4-flash")).toBe(
      "openrouter:deepseek/deepseek-v4-flash",
    );
  });

  it("still maps local inject ids to Hermes' custom:<host>:<model> form", () => {
    expect(hermesAcpModelId("ollama::llama3")).toBe("custom:ollama:llama3");
  });

  it("returns null for the config sentinel, so Hermes keeps its own default", () => {
    expect(hermesAcpModelId(HERMES_CONFIG_MODEL_ID)).toBeNull();
  });

  it("returns null for a bare word that names no provider", () => {
    expect(hermesAcpModelId("gpt-5")).toBeNull();
  });
});
