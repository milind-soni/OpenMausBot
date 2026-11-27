import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderDriver, ProviderInstance, TextGenerationUsage } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import * as procs from "../../procs.ts";
import { BACKGROUND_TEXT_TIMEOUT_MS } from "./background-text.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";
import { CursorAgentDriver } from "./cursor.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import { GrokAgentDriver } from "./grok.ts";
import { QwenAgentDriver } from "./qwen.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const ENV_KEYS = ["FAKE_ACP_MODE", "FAKE_ACP_DUMP", "FAKE_ACP_TEXT_REPLY", "FAKE_ACP_MODELS", "FAKE_ACP_SESSION_MODELS", "FAKE_ACP_MODEL_STICKS"];

describe("ACP memory one-shot (generateMemoryText)", () => {
  let instance: ProviderInstance | undefined;
  let scratch: string;

  const create = async (driver: ProviderDriver<AcpConfig>) => {
    instance = await driver.create({ instanceId: "acp-memory-test", displayName: "ACP memory", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: true } });
    return instance;
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-acp-memory-test-"));
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    await instance?.dispose();
    instance = undefined;
    await removeTempDir(scratch);
  });

  it.each([
    ["grok cli", GrokAgentDriver],
    ["gemini", GeminiAgentDriver],
    ["cursor", CursorAgentDriver],
    ["qwen", QwenAgentDriver],
  ])("answers with the engine's own text on %s, in a fresh session with no MCP servers", async (_name, driver) => {
    process.env.FAKE_ACP_TEXT_REPLY = '[{"text":"The person likes jazz","kind":"preference"}]';
    process.env.FAKE_ACP_DUMP = join(scratch, "dump.json");
    const engine = await create(driver);
    expect(engine.generateText).toBeUndefined();
    const usage: TextGenerationUsage[] = [];
    const answer = await engine.generateMemoryText!("You are the CAPTURE step", { onUsage: (row) => usage.push(row) });
    expect(answer).toBe('[{"text":"The person likes jazz","kind":"preference"}]');
    const session = JSON.parse(readFileSync(`${process.env.FAKE_ACP_DUMP}.session.json`, "utf8"));
    expect(session.mcpServers).toEqual([]);
    expect(session.cwd).toMatch(/omb-acp-memory-/);
    expect(existsSync(session.cwd)).toBe(false);
    expect(usage).toEqual([expect.objectContaining({ input: 12, output: 4 })]);
  });

  it("runs in the interactive mode even on an instance set to full auto", async () => {
    process.env.FAKE_ACP_TEXT_REPLY = "[]";
    process.env.FAKE_ACP_DUMP = join(scratch, "dump.json");
    await (await create(GrokAgentDriver)).generateMemoryText!("prompt");
    const { argv } = JSON.parse(readFileSync(process.env.FAKE_ACP_DUMP, "utf8"));
    expect(argv.slice(0, 2)).toEqual(["--permission-mode", "default"]);
  });

  it("fails closed when the agent reaches for a tool", async () => {
    const engine = await create(GrokAgentDriver);
    // the default fake turn streams text and then a tool call
    await expect(engine.generateMemoryText!("prompt")).rejects.toThrow(/tried to use a tool/);
  });

  it("refuses a permission request instead of answering it", async () => {
    process.env.FAKE_ACP_MODE = "permission";
    const engine = await create(GrokAgentDriver);
    await expect(engine.generateMemoryText!("prompt")).rejects.toThrow(/may not use|tried to use a tool/);
  });

  it("waits as long as the caller's options say", async () => {
    process.env.FAKE_ACP_MODE = "hang";
    const engine = await create(GrokAgentDriver);
    const started = Date.now();
    await expect(engine.generateMemoryText!("prompt", { timeoutMs: 500 })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(BACKGROUND_TEXT_TIMEOUT_MS);
  });

  it("stops on abort", async () => {
    process.env.FAKE_ACP_MODE = "hang";
    const engine = await create(GrokAgentDriver);
    const controller = new AbortController();
    const pending = engine.generateMemoryText!("prompt", { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it.each([false, true])("waits for process shutdown before removing its folder (tool refusal: %s)", async (refused) => {
    if (!refused) process.env.FAKE_ACP_TEXT_REPLY = "[]";
    const engine = await create(GrokAgentDriver);
    const kill = procs.killCliTree;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stop = vi.spyOn(procs, "killCliTree").mockImplementation(async (child, timeout) => {
      await gate;
      return kill(child, timeout);
    });
    let settled = false;
    const pending = engine.generateMemoryText!("prompt").then(
      (text) => { settled = true; return text; },
      (error: Error) => { settled = true; return error; },
    );
    try {
      await expect.poll(() => stop.mock.calls.length).toBe(1);
      expect(settled).toBe(false);
    } finally {
      release();
      await pending;
      await Promise.all(stop.mock.calls.map(([child]) => kill(child)));
      stop.mockRestore();
    }
    const outcome = await pending;
    if (refused) expect(outcome).toEqual(expect.objectContaining({ message: expect.stringMatching(/tried to use a tool/) }));
    else expect(outcome).toBe("[]");
  });

  describe("on an engine that picks its model in the session", () => {
    const support: AcpSupport = {
      driverKind: "session-model-test", displayName: "Session model", models: { default: "m-default", options: [{ id: "m-default", label: "m-default" }, { id: "m-bot", label: "m-bot" }] },
      defaultCli: FAKE_CLI, nativeSource: "session-model-test.acp", loginNote: "sign in", spawnArgs: () => [],
      pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true, selectModel: { configId: "model" },
    };
    const promptedModels = () => readFileSync(`${process.env.FAKE_ACP_DUMP}.prompts.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line).model);
    beforeEach(() => {
      process.env.FAKE_ACP_TEXT_REPLY = "[]";
      process.env.FAKE_ACP_MODELS = "m-default,m-bot";
      process.env.FAKE_ACP_DUMP = join(scratch, "dump.json");
    });

    it("runs on the bot's own model, not the session's default, and books it there", async () => {
      const usage: TextGenerationUsage[] = [];
      await (await create(createAcpDriver(support))).generateMemoryText!("prompt", { fallback: { model: "m-bot", refused: new Set<string>(), onRefused: () => {} }, onUsage: (row) => usage.push(row) });
      expect(promptedModels()).toEqual(["m-bot"]);
      expect(usage).toEqual([expect.objectContaining({ model: "m-bot" })]);
    });

    it("keeps the session's default when the session does not offer the bot's model", async () => {
      await (await create(createAcpDriver(support))).generateMemoryText!("prompt", { fallback: { model: "m-gone", refused: new Set<string>(), onRefused: () => {} } });
      expect(promptedModels()).toEqual(["m-default"]);
    });

    it("stops before the prompt when the session stays on another model after the switch", async () => {
      process.env.FAKE_ACP_MODEL_STICKS = "1";
      const engine = await create(createAcpDriver(support));
      await expect(engine.generateMemoryText!("prompt", { fallback: { model: "m-bot", refused: new Set<string>(), onRefused: () => {} } })).rejects.toThrow("did not switch to m-bot (still m-default)");
      expect(existsSync(`${process.env.FAKE_ACP_DUMP}.prompts.jsonl`)).toBe(false);
    });

    it("keeps the session's default when the engine can no longer route the bot's model", async () => {
      const resolveTurnModel = () => { throw new Error("model is no longer configured"); };
      await (await create(createAcpDriver({ ...support, resolveTurnModel }))).generateMemoryText!("prompt", { fallback: { model: "m-bot", refused: new Set<string>(), onRefused: () => {} } });
      expect(promptedModels()).toEqual(["m-default"]);
    });
  });

  describe("on Grok (slug via -m and session/set_model)", () => {
    const botModel = (model: string) => ({ model, refused: new Set<string>(), onRefused: () => {} });

    beforeEach(() => {
      process.env.FAKE_ACP_TEXT_REPLY = "[]";
      process.env.FAKE_ACP_DUMP = join(scratch, "dump.json");
      process.env.FAKE_ACP_SESSION_MODELS = "grok-4.7,omni-combo-fast,explicit-combo";
    });

    it("carries the bot's configured model via -m and session/set_model and books usage to it", async () => {
      const usage: TextGenerationUsage[] = [];
      await (await create(GrokAgentDriver)).generateMemoryText!("prompt", { fallback: botModel("omni-combo-fast"), onUsage: (row) => usage.push(row) });
      const { argv } = JSON.parse(readFileSync(process.env.FAKE_ACP_DUMP!, "utf8"));
      expect(argv).toContain("-m");
      expect(argv[argv.indexOf("-m") + 1]).toBe("omni-combo-fast");
      const configCalls = JSON.parse(readFileSync(`${process.env.FAKE_ACP_DUMP}.config.json`, "utf8"));
      expect(configCalls).toContainEqual(expect.objectContaining({ method: "session/set_model", params: expect.objectContaining({ modelId: "omni-combo-fast" }) }));
      expect(usage).toEqual([expect.objectContaining({ model: "omni-combo-fast" })]);
    });

    it("skips session/set_model when session/new already starts on the requested model", async () => {
      process.env.FAKE_ACP_SESSION_MODELS = "omni-combo-fast,grok-4.7";
      const usage: TextGenerationUsage[] = [];
      await (await create(GrokAgentDriver)).generateMemoryText!("prompt", { fallback: botModel("omni-combo-fast"), onUsage: (row) => usage.push(row) });
      expect(existsSync(`${process.env.FAKE_ACP_DUMP}.config.json`)).toBe(false);
      expect(usage).toEqual([expect.objectContaining({ model: "omni-combo-fast" })]);
    });

    it("surfaces offered models when Grok rejects session/set_model with -32602 Invalid params", async () => {
      process.env.FAKE_ACP_MODE = "set-model-invalid-params";
      const engine = await create(GrokAgentDriver);
      await expect(engine.generateMemoryText!("prompt", { fallback: botModel("unlisted-slug") }))
        .rejects.toThrow("this Grok sign-in offers grok-4.7, omni-combo-fast and explicit-combo");
    });

    it("lets an explicit model override the bot fallback", async () => {
      await (await create(GrokAgentDriver)).generateMemoryText!("prompt", { model: "explicit-combo", fallback: botModel("omni-combo-fast") });
      const { argv } = JSON.parse(readFileSync(process.env.FAKE_ACP_DUMP!, "utf8"));
      expect(argv).toContain("-m");
      expect(argv[argv.indexOf("-m") + 1]).toBe("explicit-combo");
    });

    it("omits -m when neither model nor fallback is supplied", async () => {
      await (await create(GrokAgentDriver)).generateMemoryText!("prompt");
      const { argv } = JSON.parse(readFileSync(process.env.FAKE_ACP_DUMP!, "utf8"));
      expect(argv).not.toContain("-m");
      expect(existsSync(`${process.env.FAKE_ACP_DUMP}.config.json`)).toBe(false);
    });

    it.each(["--evil", "bad model", "../x", "default", ""])("never passes an unsafe slug (%j) to -m or session/set_model", async (bad) => {
      await (await create(GrokAgentDriver)).generateMemoryText!("prompt", { model: bad, fallback: botModel(bad) });
      const { argv } = JSON.parse(readFileSync(process.env.FAKE_ACP_DUMP!, "utf8"));
      expect(argv).not.toContain("-m");
      expect(existsSync(`${process.env.FAKE_ACP_DUMP}.config.json`)).toBe(false);
    });

    it("leaves other non-selectModel engines (Gemini) unchanged", async () => {
      await (await create(GeminiAgentDriver)).generateMemoryText!("prompt", { model: "omni-combo-fast", fallback: botModel("omni-combo-fast") });
      const { argv } = JSON.parse(readFileSync(process.env.FAKE_ACP_DUMP!, "utf8"));
      expect(argv).not.toContain("-m");
    });

    it("ignores a throwing oneShotModel hook and falls back to the stock turn", async () => {
      const support: AcpSupport = {
        driverKind: "oneshot-throw-test", displayName: "OneShot throw", models: { default: "m-default", options: [{ id: "m-default", label: "m-default" }] },
        defaultCli: FAKE_CLI, nativeSource: "oneshot-throw-test.acp", loginNote: "sign in",
        spawnArgs: (_c, turn) => (turn.model ? ["-m", turn.model] : []),
        pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true,
        oneShotModel: () => { throw new Error("boom"); },
      };
      await (await create(createAcpDriver(support))).generateMemoryText!("prompt", { fallback: botModel("m-bot") });
      const { argv } = JSON.parse(readFileSync(process.env.FAKE_ACP_DUMP!, "utf8"));
      expect(argv).not.toContain("-m");
    });
  });

  it("is absent on an engine that opts out", async () => {
    const support: AcpSupport = {
      driverKind: "opt-out-test", displayName: "Opt out", models: { default: "m", options: [{ id: "m", label: "m" }] },
      defaultCli: FAKE_CLI, nativeSource: "opt-out-test.acp", loginNote: "sign in", spawnArgs: () => [],
      pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true, backgroundText: false,
    };
    expect((await create(createAcpDriver(support))).generateMemoryText).toBeUndefined();
  });
});
