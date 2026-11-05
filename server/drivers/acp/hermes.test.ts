import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetPathCache } from "../../env-path.ts";

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
  resolveHermesModels,
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
      // A custom-only agent's picker shows only custom-flagged options.
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
    // The shipped .env carries `# OPENROUTER_API_KEY=`; without config.yaml nothing proves a working provider.
    const env = home("# OPENROUTER_API_KEY=\n");
    expect(hermesConfiguredModel(env)).toBeNull();
  });

  it("treats a commented-out key with config.yaml as configured (Nous Portal)", () => {
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
    expect(hermesAcpModelId(HERMES_CONFIG_MODEL_ID)).toBeNull();
  });
});

describe("hermesAcpModelId", () => {
  it("forwards Hermes' own provider-scoped ids untouched", () => {
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

  // Minimal ACP CLI: initialize at once, session/new after FAKE_SESSION_DELAY_MS with a two-model catalog.
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

  function fakeCli(env: Record<string, string>, source = FAKE_CLI_SOURCE, name = "fake-hermes.ts"): { cli: string; env: Record<string, string> } {
    const home = mkdtempSync(join(tmpdir(), "omb-hermes-probe-"));
    dirs.push(home);
    const cli = join(home, name);
    writeFileSync(cli, source, { mode: 0o755 });
    // The spawn gets exactly this env, so PATH must survive for the `/usr/bin/env node` shebang.
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
    // Resolving at all before a realistic default proves the override was rejected.
    await expect(fetchHermesAcpModels(cli, env)).resolves.toEqual(CATALOG);
  });

  // Answers initialize, closes its stdin, and stays alive: a child that exits makes Node destroy the
  // parent's stdin socket, but with fd 0 closed and the child alive a write reports EPIPE and emits 'error'.
  const CLOSES_STDIN_AND_LIVES = `#!/usr/bin/env node
import { closeSync } from "node:fs";
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += String(chunk);
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      closeSync(0);
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
      // Outlive the probe's deadline: exiting would destroy the socket and
      // hide the very write this reproduces.
      setTimeout(() => process.exit(0), 5_000);
    }
  }
});
`;

  it("resolves [] instead of crashing when the CLI closes its stdin mid-handshake", async () => {
    const { cli, env } = fakeCli({ [HERMES_ACP_MODELS_TIMEOUT_ENV]: "2000" }, CLOSES_STDIN_AND_LIVES, "fake-hermes.mjs");
    await expect(fetchHermesAcpModels(cli, env)).resolves.toEqual([]);
    // An EPIPE emitted a tick after settling is still an uncaught exception: wait until it would fire.
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
});

describe("resolveHermesModels when Hermes has no model to list", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await removeTempDir(d);
  });

  const DEFAULT = { id: HERMES_CONFIG_MODEL_ID, label: "Hermes default (config)", custom: true };

  // A Hermes home plus a stand-in `hermes` that never answers, so a catalog probe ends at its deadline.
  function setup(dotenv: string, configYaml?: string): { cli: string; missing: string; env: Record<string, string> } {
    const root = mkdtempSync(join(tmpdir(), "omb-hermes-models-"));
    dirs.push(root);
    const home = join(root, ".hermes");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".env"), dotenv);
    if (configYaml !== undefined) writeFileSync(join(home, "config.yaml"), configYaml);
    const cli = join(root, "fake-hermes.ts");
    writeFileSync(cli, "#!/usr/bin/env node\nprocess.stdin.resume();\n", { mode: 0o755 });
    return {
      cli,
      missing: join(root, "not-installed", "hermes"),
      env: {
        PATH: process.env.PATH ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: root, USERPROFILE: root, HERMES_HOME: home, [HERMES_ACP_MODELS_TIMEOUT_ENV]: "300",
      },
    };
  }

  it("offers Hermes' own default when config.yaml uses a custom endpoint and nothing local answers", async () => {
    const { cli, env } = setup("", "model:\n  provider: custom\n  default: gpt-6.1-sol\n  base_url: http://127.0.0.1:9/v1\n");
    await expect(resolveHermesModels(env, { cli })).resolves.toEqual({ default: HERMES_CONFIG_MODEL_ID, options: [DEFAULT] });
  });

  it("offers Hermes' own default when there is no config.yaml and no key (Hermes set up elsewhere, e.g. WSL)", async () => {
    const { cli, env } = setup("");
    await expect(resolveHermesModels(env, { cli })).resolves.toEqual({ default: HERMES_CONFIG_MODEL_ID, options: [DEFAULT] });
  });

  it("offers nothing when Hermes is not installed", async () => {
    const { missing, env } = setup("");
    await expect(resolveHermesModels(env, { cli: missing })).resolves.toEqual({ default: "", options: [] });
  });

  it("offers nothing when the Hermes path is a directory or can't run", async () => {
    const { cli, env } = setup("");
    await expect(resolveHermesModels(env, { cli: dirname(cli) })).resolves.toEqual({ default: "", options: [] });
    if (process.platform === "win32") return;
    const plain = join(dirname(cli), "plain-hermes");
    writeFileSync(plain, "", { mode: 0o644 });
    await expect(resolveHermesModels(env, { cli: plain })).resolves.toEqual({ default: "", options: [] });
  });

  it("answers empty for an Ollama or LM Studio setup whose server is down, so earlier models stay", async () => {
    for (const provider of ["ollama", "lmstudio"]) {
      const { cli, env } = setup("", `model:\n  provider: ${provider}\n  default: llama3\n`);
      await expect(resolveHermesModels(env, { cli })).resolves.toEqual({ default: "", options: [] });
    }
  });

  it("offers the default for an Ollama base_url the local probe never checks (another host or port)", async () => {
    for (const baseUrl of ["http://192.168.1.20:11434/v1", "http://127.0.0.1:11500/v1"]) {
      const { cli, env } = setup("", `model:\n  provider: ollama\n  default: llama3\n  base_url: ${baseUrl}\n`);
      await expect(resolveHermesModels(env, { cli })).resolves.toEqual({ default: HERMES_CONFIG_MODEL_ID, options: [DEFAULT] });
    }
    const { cli, env } = setup("", "model:\n  provider: lmstudio\n  default: qwen\nproviders:\n  lmstudio:\n    base_url: http://localhost:1234/v1\n");
    await expect(resolveHermesModels(env, { cli })).resolves.toEqual({ default: "", options: [] });
  });

  it("finds Hermes behind a wrapper command, as it is launched", async () => {
    const { cli, env } = setup("");
    await expect(resolveHermesModels(env, { cli: `${cli} hermes` })).resolves.toEqual({ default: HERMES_CONFIG_MODEL_ID, options: [DEFAULT] });
  });

  it.skipIf(process.platform === "win32")("looks past a PATH entry that can't run to a later runnable hermes", async () => {
    const { cli, env } = setup("");
    const blocked = join(dirname(cli), "blocked");
    const runnable = join(dirname(cli), "runnable");
    mkdirSync(blocked);
    mkdirSync(runnable);
    writeFileSync(join(blocked, "hermes"), "", { mode: 0o644 });
    writeFileSync(join(runnable, "hermes"), "#!/bin/sh\n", { mode: 0o755 });
    vi.stubEnv("PATH", [blocked, runnable].join(delimiter));
    resetPathCache();
    try {
      await expect(resolveHermesModels(env, { cli: "hermes" })).resolves.toEqual({ default: HERMES_CONFIG_MODEL_ID, options: [DEFAULT] });
    } finally {
      vi.unstubAllEnvs();
      resetPathCache();
    }
  });

  it("keeps today's list when a hosted provider is configured", async () => {
    const { cli, env } = setup("OPENROUTER_API_KEY=sk-or-v1-test\n", "model:\n  default: anthropic/claude-opus-4.6\n");
    await expect(resolveHermesModels(env, { cli })).resolves.toEqual({
      default: HERMES_CONFIG_MODEL_ID,
      options: [{ id: HERMES_CONFIG_MODEL_ID, label: "anthropic/claude-opus-4.6 (Hermes config)", custom: true }],
    });
  });

  it("starts Hermes without choosing a model for the default entry", () => {
    expect(hermesAcpModelId(HERMES_CONFIG_MODEL_ID)).toBeNull();
  });
});
