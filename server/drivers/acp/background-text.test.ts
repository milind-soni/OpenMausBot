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
import { createOpenCodeDriver } from "./opencode-go.ts";
import { PERMISSION_REVIEW_SYSTEM_PROMPT } from "../../contracts.ts";
import { reviewApproval } from "../../approval-review.ts";
import { CursorAgentDriver } from "./cursor.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import { GrokAgentDriver } from "./grok.ts";
import { QwenAgentDriver } from "./qwen.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const ENV_KEYS = ["FAKE_ACP_MODE", "FAKE_ACP_DUMP", "FAKE_ACP_TEXT_REPLY", "FAKE_ACP_MODELS", "FAKE_ACP_VARIANTS",
  "FAKE_ACP_MODEL_STICKS", "FAKE_ACP_VARIANT_STICKS", "FAKE_ACP_DUMP_PROMPT"];

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

  it("is absent on an engine that opts out", async () => {
    const support: AcpSupport = {
      driverKind: "opt-out-test", displayName: "Opt out", models: { default: "m", options: [{ id: "m", label: "m" }] },
      defaultCli: FAKE_CLI, nativeSource: "opt-out-test.acp", loginNote: "sign in", spawnArgs: () => [],
      pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true, backgroundText: false,
    };
    expect((await create(createAcpDriver(support))).generateMemoryText).toBeUndefined();
  });

  it("reviews through OpenCode's exact model and variant in a tool-free session", async () => {
    process.env.FAKE_ACP_MODELS = "working-model,review-model";
    process.env.FAKE_ACP_VARIANTS = JSON.stringify({
      "review-model": { id: "effort", currentValue: "medium", options: [{ value: "medium" }, { value: "off" }] },
    });
    process.env.FAKE_ACP_TEXT_REPLY = '{"decision":"allow","reason":"The requested read is in scope."}';
    process.env.FAKE_ACP_DUMP = join(scratch, "review.json");
    process.env.FAKE_ACP_DUMP_PROMPT = "1";
    const driver = createOpenCodeDriver(async () => ({ default: "working-model", options: [
      { id: "working-model", label: "Working" }, { id: "review-model", label: "Review" },
    ] }));
    const engine = await create(driver);
    const usage: TextGenerationUsage[] = [];
    const result = await reviewApproval({
      action: { tool: "fixture_read", arguments: { path: "fixture.txt" } },
      session: { instanceId: engine.instanceId, model: "review-model", variant: "off" },
      settings: {},
      messages: [{ id: "request", role: "user", kind: "text", text: "Read the fixture file.", at: 1 }],
      getProvider: () => engine,
      isCurrent: () => true,
      onUsage: (_provider, row) => usage.push(row),
    });
    expect(result).toMatchObject({ decision: "allow", reviewer: { model: "review-model", variant: "off" } });
    const session = JSON.parse(readFileSync(`${process.env.FAKE_ACP_DUMP}.session.json`, "utf8"));
    const launch = JSON.parse(readFileSync(process.env.FAKE_ACP_DUMP, "utf8"));
    const selection = JSON.parse(readFileSync(`${process.env.FAKE_ACP_DUMP}.selection.json`, "utf8"));
    const prompt = JSON.parse(readFileSync(`${process.env.FAKE_ACP_DUMP}.prompt.json`, "utf8"));
    expect(session.mcpServers).toEqual([]);
    expect(existsSync(session.cwd)).toBe(false);
    expect(JSON.parse(launch.env.OPENCODE_PERMISSION)).toMatchObject({ "*": "deny", read: "deny", bash: "deny" });
    expect(launch.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    expect(selection).toMatchObject({ model: "review-model", variant: "off" });
    expect(prompt[0].text).toContain(PERMISSION_REVIEW_SYSTEM_PROMPT);
    expect(usage).toEqual([expect.objectContaining({ model: "review-model" })]);
  });

  it("refuses review if OpenCode does not apply the exact model or tries to use a tool", async () => {
    process.env.FAKE_ACP_MODELS = "working-model,review-model";
    const driver = createOpenCodeDriver(async () => ({ default: "working-model", options: [
      { id: "working-model", label: "Working" }, { id: "review-model", label: "Review" },
    ] }));
    const engine = await create(driver);
    process.env.FAKE_ACP_MODEL_STICKS = "1";
    await expect(engine.reviewPermission!("Review input", { model: "review-model" })).rejects.toThrow(/did not select the review model/);
    delete process.env.FAKE_ACP_MODEL_STICKS;
    process.env.FAKE_ACP_MODE = "permission";
    await expect(engine.reviewPermission!("Review input", { model: "review-model" })).rejects.toThrow(/may not use|tried to use a tool/);
  });
});
