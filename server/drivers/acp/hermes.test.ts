import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { resetPathCache } from "../../env-path.ts";

import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import {
  HERMES_ACP_MODELS_TIMEOUT_ENV,
  HERMES_ACP_MODELS_DEFAULT_TIMEOUT_MS,
  HERMES_CONFIG_MODEL_ID,
  HERMES_OPENMAUS_SCREENSHOT_COMPAT,
  HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL,
  HermesAgentDriver,
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

  it("finds a Windows Hermes path given without its .exe, as it is launched", async () => {
    const { cli, env } = setup("");
    const bare = join(dirname(cli), "hermes");
    writeFileSync(`${bare}.EXE`, "#!/usr/bin/env node\nprocess.stdin.resume();\n", { mode: 0o755 });
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("PATHEXT", ".EXE");
    try {
      await expect(resolveHermesModels(env, { cli: bare })).resolves.toEqual({ default: HERMES_CONFIG_MODEL_ID, options: [DEFAULT] });
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
      vi.unstubAllEnvs();
    }
  });

  it("offers the default for an https endpoint on the probe's port, which the http probe can't list", async () => {
    const { cli, env } = setup("", "model:\n  provider: ollama\n  default: llama3\n  base_url: https://localhost:11434/v1\n");
    await expect(resolveHermesModels(env, { cli })).resolves.toEqual({ default: HERMES_CONFIG_MODEL_ID, options: [DEFAULT] });
  });

  it("offers the default for an Ollama on IPv6 loopback, which the 127.0.0.1 probe can't reach", async () => {
    const { cli, env } = setup("", "model:\n  provider: ollama\n  default: llama3\n  base_url: http://[::1]:11434/v1\n");
    await expect(resolveHermesModels(env, { cli })).resolves.toEqual({ default: HERMES_CONFIG_MODEL_ID, options: [DEFAULT] });
  });

  it("does not offer the default for a Windows .cmd shim that can't launch without a shell", async () => {
    const { cli, env } = setup("");
    const bare = join(dirname(cli), "hermes");
    writeFileSync(`${bare}.CMD`, "@echo off\r\nsomething-unknown %*\r\n");
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("PATHEXT", ".CMD");
    try {
      await expect(resolveHermesModels(env, { cli: bare })).resolves.toEqual({ default: "", options: [] });
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
      vi.unstubAllEnvs();
    }
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
});

const FAKE_ACP_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");
const HERMES_SESSION_MODES = "default,accept_edits,dont_ask";

describe("Hermes advertised ACP edit modes", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "omb-hermes-modes-"));
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
    await removeTempDir(scratch);
  });

  async function create(environment: Record<string, string> = {}) {
    const hermesHome = join(scratch, ".hermes");
    mkdirSync(hermesHome, { recursive: true });
    instance = await HermesAgentDriver.create({
      instanceId: `hermes-modes-${Math.random().toString(36).slice(2)}`,
      displayName: "Hermes",
      enabled: true,
      environment: {
        HOME: scratch,
        USERPROFILE: scratch,
        HERMES_HOME: hermesHome,
        OPENMAUSBOT_PROBE_LOCAL_INJECT: "0",
        FAKE_ACP_DUMP: join(scratch, "launch.json"),
        ...environment,
      },
      config: { cli: FAKE_ACP_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    return { instance, recorder };
  }

  const dumpFile = () => join(scratch, "launch.json");
  const configCalls = () =>
    existsSync(`${dumpFile()}.config.json`)
      ? (JSON.parse(readFileSync(`${dumpFile()}.config.json`, "utf8")) as Array<{ method: string; params: any }>)
      : [];
  const modeCalls = () => configCalls().filter((call) => call.method === "session/set_mode").map((call) => call.params.modeId);

  it("maps approval modes onto advertised Hermes session modes across pooled turns without respawning", async () => {
    const launches = join(scratch, "launches");
    const { instance, recorder } = await create({
      FAKE_ACP_SESSION_MODES: HERMES_SESSION_MODES,
      FAKE_ACP_LAUNCH_COUNT_FILE: launches,
    });
    const runTurn = async (approvalMode: "edits" | "ask" | "auto" | "full") => {
      const { turnId } = await instance.adapter.sendTurn({
        threadId: "t-hermes-modes",
        text: `turn-${approvalMode}`,
        cwd: scratch,
        approvalMode,
      });
      const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      expect(done).toMatchObject({ ok: true });
    };

    await runTurn("edits");
    expect(modeCalls()).toEqual(["accept_edits"]);
    // Same level on the pooled session already matches currentModeId, so no redundant RPC.
    await runTurn("edits");
    expect(modeCalls()).toEqual(["accept_edits"]);

    await runTurn("ask");
    expect(modeCalls()).toEqual(["accept_edits", "default"]);

    // Full access keeps Hermes' default mode, so every request still reaches the app and its safety floor.
    await runTurn("full");
    expect(modeCalls()).toEqual(["accept_edits", "default"]);

    // Engines without a native auto reviewer stay in ask/default rather than escalating.
    await runTurn("auto");
    expect(modeCalls()).toEqual(["accept_edits", "default"]);

    expect(Number(readFileSync(launches, "utf8"))).toBe(1);
  });

  it("applies the target mode when resuming a session via session/load", async () => {
    const { instance, recorder } = await create({ FAKE_ACP_SESSION_MODES: HERMES_SESSION_MODES });
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-hermes-resume",
      text: "resume with edits",
      cwd: scratch,
      approvalMode: "edits",
      resumeCursor: "fake-acp-session",
    });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(done).toMatchObject({ ok: true });
    expect(configCalls()).toContainEqual({
      method: "session/set_mode",
      params: { sessionId: "fake-acp-session", modeId: "accept_edits" },
    });
  });

  it("leaves behavior unchanged when Hermes advertises no session modes", async () => {
    const { instance, recorder } = await create();
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-hermes-legacy",
      text: "legacy session",
      cwd: scratch,
      approvalMode: "edits",
    });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(done).toMatchObject({ ok: true });
    expect(modeCalls()).toEqual([]);
  });

  it("fails closed and retires the session when session/set_mode is rejected", async () => {
    const launches = join(scratch, "launches-fail");
    const { instance, recorder } = await create({
      FAKE_ACP_SESSION_MODES: HERMES_SESSION_MODES,
      FAKE_ACP_MODE: "no-session-config",
      FAKE_ACP_LAUNCH_COUNT_FILE: launches,
    });
    const first = await instance.adapter.sendTurn({
      threadId: "t-hermes-mode-fail",
      text: "first",
      cwd: scratch,
      approvalMode: "edits",
    });
    const done1 = await recorder.until((event) => event.type === "turn.completed" && event.turnId === first.turnId);
    expect(done1).toMatchObject({ ok: false, stopReason: "rpc_error" });
    expect(recorder.events.some((event) => event.type === "runtime.error" && event.message.includes("session/set_mode"))).toBe(true);

    // Next turn must spawn a fresh process because approvalUnconfirmed retired the session.
    const second = await instance.adapter.sendTurn({
      threadId: "t-hermes-mode-fail",
      text: "second",
      cwd: scratch,
      approvalMode: "edits",
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === second.turnId);
    expect(Number(readFileSync(launches, "utf8"))).toBe(2);
  });

  it("refreshes cached currentModeId from idle current_mode_update notifications and ignores replays", async () => {
    const { instance, recorder } = await create({
      FAKE_ACP_SESSION_MODES: HERMES_SESSION_MODES,
      FAKE_ACP_IDLE_MODE_UPDATE: "dont_ask",
    });
    const first = await instance.adapter.sendTurn({
      threadId: "t-hermes-idle-update",
      text: "turn-1",
      cwd: scratch,
      approvalMode: "ask",
    });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === first.turnId)).toMatchObject({ ok: true });
    expect(modeCalls()).toEqual([]);

    // Wait for the out-of-band notification emitted while idle after turn 1 settles.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const second = await instance.adapter.sendTurn({
      threadId: "t-hermes-idle-update",
      text: "turn-2",
      cwd: scratch,
      approvalMode: "ask",
    });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === second.turnId)).toMatchObject({ ok: true });
    expect(modeCalls()).toEqual(["default"]);

    await instance.dispose();
    recorder.stop();

    const replayDump = join(scratch, "replay.json");
    const replayUpdates = join(scratch, "replay-updates.json");
    writeFileSync(replayUpdates, JSON.stringify([
      { sessionId: "fake-acp-session", _meta: { isReplay: true }, update: { sessionUpdate: "current_mode_update", currentModeId: "dont_ask" } },
    ]));
    const replayRun = await create({
      FAKE_ACP_DUMP: replayDump,
      FAKE_ACP_SESSION_MODES: HERMES_SESSION_MODES,
      FAKE_ACP_UPDATES_FILE: replayUpdates,
    });
    for (const text of ["replay-1", "replay-2"]) {
      const turn = await replayRun.instance.adapter.sendTurn({
        threadId: "t-hermes-replay-mode",
        text,
        cwd: scratch,
        approvalMode: "ask",
      });
      expect(await replayRun.recorder.until((event) => event.type === "turn.completed" && event.turnId === turn.turnId)).toMatchObject({ ok: true });
    }
    replayRun.recorder.stop();
    expect(existsSync(`${replayDump}.config.json`)).toBe(false);
  });

  it("fails closed and retires the pooled session when advertised modes omit the requested level", async () => {
    const launches = join(scratch, "launches-unmatched");
    const { instance, recorder } = await create({
      FAKE_ACP_SESSION_MODES: "default,dont_ask",
      FAKE_ACP_LAUNCH_COUNT_FILE: launches,
    });

    const fullTurn = await instance.adapter.sendTurn({
      threadId: "t-hermes-unmatched",
      text: "run full",
      cwd: scratch,
      approvalMode: "full",
    });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === fullTurn.turnId)).toMatchObject({ ok: true });
    expect(modeCalls()).toEqual([]);

    const editsTurn = await instance.adapter.sendTurn({
      threadId: "t-hermes-unmatched",
      text: "try edits",
      cwd: scratch,
      approvalMode: "edits",
    });
    const failed = await recorder.until((event) => event.type === "turn.completed" && event.turnId === editsTurn.turnId);
    expect(failed).toMatchObject({ ok: false, stopReason: "rpc_error" });
    expect(recorder.events.some((event) => event.type === "runtime.error" && event.message.includes("did not advertise an ACP mode"))).toBe(true);
    expect(modeCalls()).toEqual([]);

    // Pooled process must have been retired so the next turn starts a fresh session.
    const askTurn = await instance.adapter.sendTurn({
      threadId: "t-hermes-unmatched",
      text: "back to ask",
      cwd: scratch,
      approvalMode: "ask",
    });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === askTurn.turnId)).toMatchObject({ ok: true });
    expect(Number(readFileSync(launches, "utf8"))).toBe(2);
  });

  it("keeps a same-chunk current_mode_update after session/set_mode and aborts session/prompt when mode drifts", async () => {
    const rpcLog = join(scratch, "rpc-same-chunk.jsonl");
    const promptCount = () => existsSync(rpcLog)
      ? readFileSync(rpcLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string }).filter((e) => e.method === "session/prompt").length
      : 0;
    const { instance, recorder } = await create({
      FAKE_ACP_SESSION_MODES: HERMES_SESSION_MODES,
      FAKE_ACP_MODE_UPDATE_AFTER_SET_MODE: "default:dont_ask",
      FAKE_ACP_RPC_APPEND_FILE: rpcLog,
    });

    const editsTurn = await instance.adapter.sendTurn({
      threadId: "t-hermes-same-chunk",
      text: "turn-edits",
      cwd: scratch,
      approvalMode: "edits",
    });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === editsTurn.turnId)).toMatchObject({ ok: true });
    expect(promptCount()).toBe(1);

    const askDriftTurn = await instance.adapter.sendTurn({
      threadId: "t-hermes-same-chunk",
      text: "turn-ask-drift",
      cwd: scratch,
      approvalMode: "ask",
    });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === askDriftTurn.turnId)).toMatchObject({ ok: false, stopReason: "rpc_error" });
    expect(recorder.events.some((event) => event.type === "runtime.error" && event.message.includes("changed mode before the prompt"))).toBe(true);
    expect(promptCount()).toBe(1);

    const askRecoveredTurn = await instance.adapter.sendTurn({
      threadId: "t-hermes-same-chunk",
      text: "turn-ask-recover",
      cwd: scratch,
      approvalMode: "ask",
    });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === askRecoveredTurn.turnId)).toMatchObject({ ok: true });
    expect(promptCount()).toBe(2);
    expect(modeCalls()).toEqual(["accept_edits", "default", "default"]);
  });

  it("rechecks currentModeId after configureSession before dispatching session/prompt when mode drifts during set_model", async () => {
    const rpcLog = join(scratch, "rpc-set-model.jsonl");
    const promptCount = () => existsSync(rpcLog)
      ? readFileSync(rpcLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string }).filter((e) => e.method === "session/prompt").length
      : 0;
    const { instance, recorder } = await create({
      FAKE_ACP_SESSION_MODES: HERMES_SESSION_MODES,
      FAKE_ACP_MODE_UPDATE_ON_SET_MODEL: "dont_ask",
      FAKE_ACP_RPC_APPEND_FILE: rpcLog,
    });

    const driftedTurn = await instance.adapter.sendTurn({
      threadId: "t-hermes-set-model-drift",
      text: "turn-1",
      cwd: scratch,
      approvalMode: "ask",
      model: "openrouter:qwen/qwen3.8-max",
    });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === driftedTurn.turnId)).toMatchObject({ ok: false, stopReason: "rpc_error" });
    expect(recorder.events.some((event) => event.type === "runtime.error" && event.message.includes("changed mode before the prompt"))).toBe(true);
    expect(promptCount()).toBe(0);
    expect(modeCalls()).toEqual([]);

    const recoveredTurn = await instance.adapter.sendTurn({
      threadId: "t-hermes-set-model-drift",
      text: "turn-2",
      cwd: scratch,
      approvalMode: "ask",
      model: "openrouter:qwen/qwen3.8-max",
    });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === recoveredTurn.turnId)).toMatchObject({ ok: true });
    expect(promptCount()).toBe(1);
    expect(modeCalls()).toEqual(["default"]);
  });
});
