import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import {
  HERMES_ACP_MODELS_TIMEOUT_ENV,
  HERMES_ACP_MODELS_DEFAULT_TIMEOUT_MS,
  HERMES_CONFIG_MODEL_ID,
  HERMES_OPENMAUS_SCREENSHOT_COMPAT,
  HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL,
  bindHermesScreenshotCompat,
  fetchHermesAcpModels,
  hermesAcpModelId,
  hermesConfiguredModel,
} from "./hermes.ts";

describe("Hermes OpenMaus screenshot compatibility binding", () => {
  it("binds the exact leaf model for an injected local picker model", () => {
    const env = {
      [HERMES_OPENMAUS_SCREENSHOT_COMPAT]: undefined,
      [HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL]: undefined,
    };

    bindHermesScreenshotCompat(env, "omlx::gemma-4-31b-it-bf16");

    expect(env[HERMES_OPENMAUS_SCREENSHOT_COMPAT]).toBe("1");
    expect(env[HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL]).toBe("gemma-4-31b-it-bf16");
  });

  it.each([undefined, "", "anthropic/claude-opus-4.6", "unknown::model"])(
    "clears inherited compatibility for an unbound model %s",
    (model) => {
      const env = {
        [HERMES_OPENMAUS_SCREENSHOT_COMPAT]: "1",
        [HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL]: "stale/model",
      };

      bindHermesScreenshotCompat(env, model);

      expect(env[HERMES_OPENMAUS_SCREENSHOT_COMPAT]).toBeUndefined();
      expect(env[HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL]).toBeUndefined();
    },
  );
});

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

describe("fetchHermesAcpModels probe deadline", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await removeTempDir(d);
  });

  // Minimal ACP CLI: answers initialize at once, then session/new after
  // FAKE_SESSION_DELAY_MS with a two-model catalog. Plain JS in a .ts file so
  // the node shebang runs it on every supported runtime.
  const FAKE_CLI_SOURCE = `#!/usr/bin/env node
let buf = "";
const delay = Number(process.env.FAKE_SESSION_DELAY_MS || "0");
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.stdin.on("data", (chunk) => {
  buf += String(chunk);
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      reply(msg.id, { protocolVersion: 1 });
    } else if (msg.method === "session/new") {
      setTimeout(() => reply(msg.id, {
        models: { availableModels: [
          { modelId: "openrouter:qwen/qwen3.8-max", name: "OpenRouter · Qwen 3.8 Max" },
          { modelId: "openrouter:beta", name: "  " },
          { modelId: "", name: "dropped" },
        ] },
      }), delay);
    }
  }
});
`;

  const CATALOG = [
    { id: "openrouter:qwen/qwen3.8-max", label: "OpenRouter · Qwen 3.8 Max", custom: true },
    { id: "openrouter:beta", label: "openrouter:beta", custom: true },
  ];

  function fakeCli(env: Record<string, string>): { cli: string; env: Record<string, string> } {
    const home = mkdtempSync(join(tmpdir(), "omb-hermes-probe-"));
    dirs.push(home);
    const cli = join(home, "fake-hermes.ts");
    writeFileSync(cli, FAKE_CLI_SOURCE, { mode: 0o755 });
    // The spawn gets exactly this env, so PATH has to survive for the
    // script's /usr/bin/env node shebang to resolve.
    return { cli, env: { PATH: process.env.PATH ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: home, USERPROFILE: home, ...env } };
  }

  it("returns the advertised catalog when session/new answers inside the deadline", async () => {
    const { cli, env } = fakeCli({ FAKE_SESSION_DELAY_MS: "150", [HERMES_ACP_MODELS_TIMEOUT_ENV]: "2000" });
    await expect(fetchHermesAcpModels(cli, env)).resolves.toEqual(CATALOG);
  });

  it("finds the catalog CLI on the supplied PATH, including a Windows npm shim", async () => {
    const { cli, env } = fakeCli({ [HERMES_ACP_MODELS_TIMEOUT_ENV]: "2000" });
    const root = dirname(cli);
    const command = "omb-hermes-probe";
    if (process.platform === "win32") {
      writeFileSync(join(root, "probe.js"), FAKE_CLI_SOURCE);
      writeFileSync(join(root, `${command}.cmd`), '@echo off\nnode "%~dp0\\probe.js" %*\n');
    } else {
      writeFileSync(join(root, command), FAKE_CLI_SOURCE, { mode: 0o755 });
    }
    await expect(fetchHermesAcpModels(command, {
      ...env,
      PATH: [root, dirname(process.execPath)].join(delimiter),
      PATHEXT: ".CMD;.EXE",
    })).resolves.toEqual(CATALOG);
  });

  it("returns [] when session/new outlives the deadline, without waiting for it", async () => {
    const { cli, env } = fakeCli({ FAKE_SESSION_DELAY_MS: "2000", [HERMES_ACP_MODELS_TIMEOUT_ENV]: "150" });
    const started = Date.now();
    await expect(fetchHermesAcpModels(cli, env)).resolves.toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(125);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it.each(["not-a-number", "0", "-1", "0.5", "Infinity", "2147483648"])("ignores invalid timeout %s and falls back to the 15s default", async (timeout) => {
    expect(HERMES_ACP_MODELS_DEFAULT_TIMEOUT_MS).toBe(15_000);
    const { cli, env } = fakeCli({ FAKE_SESSION_DELAY_MS: "150", [HERMES_ACP_MODELS_TIMEOUT_ENV]: timeout });
    // Resolving at all before any realistic default proves the override was
    // rejected; a 0/NaN deadline would have returned [] immediately.
    await expect(fetchHermesAcpModels(cli, env)).resolves.toEqual(CATALOG);
  });
});
