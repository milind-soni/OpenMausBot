import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance, SmallModelFallback, TextGenerationUsage } from "../contracts.ts";
import { killCliTree, spawnCli } from "../procs.ts";
import { QuickModelFallback } from "../quick-model-fallback.ts";
import { createSideJobs } from "../side-jobs.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { CodexDriver } from "./codex.ts";
import {
  CODEX_BACKGROUND_EFFORT,
  CODEX_BACKGROUND_TIMEOUT_MS,
  codexBackgroundArgs,
  codexBackgroundModel,
  codexBackgroundRoute,
  runCodexOneShot,
} from "./codex-background-text.ts";

vi.mock("./codex-release.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./codex-release.ts")>(),
  readLatestCodexRelease: async () => null,
}));

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");

interface ExecCall { argv: string[]; cwd: string; prompt: string; env: Record<string, string> }

describe("codexBackgroundModel", () => {
  const row = (id: string, custom = false) => ({ id, label: id, ...(custom ? { custom } : {}) });

  it("picks the smallest model the account lists, in the documented order", () => {
    expect(codexBackgroundModel({ default: "gpt-6-astra", options: [row("gpt-6-astra"), row("gpt-5.6-luna"), row("gpt-6-luna")] })).toBe("gpt-6-luna");
    expect(codexBackgroundModel({ default: "gpt-6-astra", options: [row("gpt-6-astra"), row("gpt-5.4-mini"), row("gpt-5.6-luna")] })).toBe("gpt-5.6-luna");
    expect(codexBackgroundModel({ default: "gpt-7-sol", options: [row("gpt-7-sol"), row("gpt-7-luna")] })).toBe("gpt-7-luna");
  });

  it("never picks a model from the person's own providers, and falls back to the default", () => {
    expect(codexBackgroundModel({ default: "gpt-6-astra", options: [row("gpt-6-astra"), row("omlx::gpt-6-luna", true), row("omlx::tiny-mini", true)] })).toBe("gpt-6-astra");
    expect(codexBackgroundModel({ default: "company-large", options: [row("company-large"), row("company-small")] })).toBe("company-large");
    expect(codexBackgroundModel({ default: "", options: [] })).toBeNull();
  });

  it("never picks a small model this instance refused before", () => {
    const catalog = { default: "gpt-6-astra", options: [row("gpt-6-astra"), row("gpt-6-luna"), row("gpt-5.6-luna"), row("gpt-5.4-mini")] };
    expect(codexBackgroundModel(catalog, new Set(["gpt-6-luna"]))).toBe("gpt-5.6-luna");
    expect(codexBackgroundModel(catalog, new Set(["gpt-6-luna", "gpt-5.6-luna", "gpt-5.4-mini"]))).toBe("gpt-6-astra");
  });
});

describe("codexBackgroundRoute", () => {
  const row = (id: string) => ({ id, label: id });
  const catalog = { default: "gpt-6-astra", options: [row("gpt-6-astra"), row("gpt-6-sol"), row("gpt-5.4-mini")] };
  const fallback = (model?: string, refused: string[] = []): SmallModelFallback => ({ ...(model ? { model } : {}), refused: new Set(refused), onRefused: () => {} });

  it("writes on the bot's own model, or the account's default, for a sign-in that cannot use small models", () => {
    expect(codexBackgroundRoute(catalog, false, fallback("gpt-6-sol"))).toEqual({ model: "gpt-6-sol" });
    expect(codexBackgroundRoute(catalog, false)).toEqual({ model: "gpt-6-astra" });
    expect(codexBackgroundRoute({ default: "", options: [] }, false)).toBeNull();
  });

  it("keeps the small model otherwise, with the bot's own model to run once more on", () => {
    expect(codexBackgroundRoute(catalog, true, fallback("gpt-6-sol"))).toEqual({ model: "gpt-5.4-mini", retry: "gpt-6-sol" });
    expect(codexBackgroundRoute(catalog, true)).toEqual({ model: "gpt-5.4-mini", retry: "gpt-6-astra" });
    expect(codexBackgroundRoute(catalog, true, fallback("gpt-6-sol", ["gpt-5.4-mini"]))).toEqual({ model: "gpt-6-astra", retry: "gpt-6-sol" });
    expect(codexBackgroundRoute(catalog, true, fallback("gpt-6-astra", ["gpt-5.4-mini"]))).toEqual({ model: "gpt-6-astra" });
  });
});

describe("codexBackgroundArgs", () => {
  it("runs exec with no tools, no saved session, no user config and the prompt on stdin", () => {
    const argv = codexBackgroundArgs({ model: "gpt-6-luna", modelProvider: "openai", providerArgs: [], cwd: "/tmp/empty" });
    expect(argv[0]).toBe("exec");
    expect(argv.at(-1)).toBe("-");
    for (const flag of ["--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config"]) expect(argv).toContain(flag);
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(after("--sandbox")).toBe("read-only");
    expect(after("--cd")).toBe("/tmp/empty");
    expect(after("--model")).toBe("gpt-6-luna");
    const overrides = argv.filter((_, index) => argv[index - 1] === "-c");
    expect(overrides).toEqual(expect.arrayContaining([
      `model_reasoning_effort="${CODEX_BACKGROUND_EFFORT}"`, 'approval_policy="never"', 'web_search="disabled"', 'model_provider="openai"',
      "features.shell_tool=false", "features.unified_exec=false", "features.view_image=false", "features.apps=false",
      "features.plugins=false", "features.multi_agent=false", "features.hooks=false", "features.computer_use=false",
    ]));
    expect(CODEX_BACKGROUND_EFFORT).toBe("low");
    expect(argv.some((arg) => arg.startsWith("mcp_servers"))).toBe(false);
  });
});

describe("Codex generateMemoryText (fake CLI)", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let log: string;

  const calls = (): ExecCall[] => existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as ExecCall)
    : [];

  const signIn = (auth: object) => writeFileSync(join(scratch, ".codex", "auth.json"), JSON.stringify(auth));
  const chatgptLogin = () => signIn({ tokens: { refresh_token: "chatgpt-fixture" } });
  const apiKeyLogin = () => signIn({ auth_mode: "apikey", OPENAI_API_KEY: "sk-fixture", tokens: null });
  const modelsRun = () => calls().map((call) => call.argv[call.argv.indexOf("--model") + 1]);
  const ownModel = (model?: string, refused: string[] = []) => {
    const onRefused = vi.fn<(model: string) => void>();
    return { onRefused, fallback: { ...(model ? { model } : {}), refused: new Set(refused), onRefused } satisfies SmallModelFallback };
  };

  const create = async (environment: Record<string, string> = {}, managed = false) => {
    instance = await CodexDriver.create({
      instanceId: `codex-background-${Math.random().toString(36).slice(2)}`,
      displayName: "Codex",
      environment: {
        HOME: scratch,
        CODEX_HOME: join(scratch, ".codex"),
        FAKE_CODEX_TEXT_LOG: log,
        ...(managed ? { OPENMAUSBOT_COMPANY_API_KEY: "synthetic-company-fixture" } : {}),
        ...environment,
      },
      enabled: true,
      config: {
        cli: FAKE_CLI,
        fullAuto: false,
        ...(managed ? { managed: { url: "https://company.example/v1", models: ["company-large", "gpt-6-luna"] } } : {}),
      },
    });
    return instance;
  };

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-codex-bg-test-"));
    log = join(scratch, "exec.jsonl");
    mkdirSync(join(scratch, ".codex"), { recursive: true });
  });

  afterEach(async () => {
    await instance?.dispose();
    instance = undefined;
    await removeTempDir(scratch);
  });

  it("is offered only as the background variant: no titles, compaction or permission review", async () => {
    const codex = await create();
    expect(codex.generateMemoryText).toBeTypeOf("function");
    expect(codex.generateText).toBeUndefined();
    expect(codex.reviewPermission).toBeUndefined();
  });

  it("asks the cheapest listed model in an empty folder, with no MCP and the prompt only on stdin", async () => {
    // the person's own Codex config declares an MCP server and a notify program
    writeFileSync(join(scratch, ".codex", "config.toml"), 'notify = ["say", "done"]\n[mcp_servers.mine]\ncommand = "mine-mcp"\n');
    const codex = await create({ FAKE_CODEX_LUNA: "1", FAKE_CODEX_TEXT_REPLY: "the answer" });
    const usage: TextGenerationUsage[] = [];
    const prompt = "You are the CAPTURE step. Secret-ish words: hunter2";
    await expect(codex.generateMemoryText!(prompt, { onUsage: (entry) => usage.push(entry) })).resolves.toBe("the answer");

    const [call] = calls();
    expect(call).toBeDefined();
    expect(call!.prompt).toBe(prompt);
    expect(call!.argv.join(" ")).not.toContain("hunter2");
    expect(call!.argv[call!.argv.indexOf("--model") + 1]).toBe("gpt-6-luna");
    expect(call!.argv).toContain("--ignore-user-config");
    expect(call!.argv[call!.argv.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(call!.argv.some((arg) => arg.startsWith("mcp_servers"))).toBe(false);
    const folder = call!.argv[call!.argv.indexOf("--cd") + 1]!;
    expect(realpathSync.native(dirname(folder))).toBe(realpathSync.native(dirname(call!.cwd)));
    expect(basename(folder)).toBe(basename(call!.cwd));
    expect(basename(folder)).toMatch(/^omb-codex-background-/);
    expect(call!.cwd).not.toBe(scratch);
    expect(existsSync(call!.cwd)).toBe(false);
    expect(call!.env.CODEX_HOME).toBe(join(scratch, ".codex"));
    expect(call!.env.OPENAI_API_KEY).toBeUndefined();
    expect(usage).toEqual([{ model: "gpt-6-luna", input: 120, output: 7, cachedInput: 20 }]);
  });

  it("falls back to the account's default model when no small one is listed", async () => {
    const codex = await create();
    await codex.generateMemoryText!("hello");
    const [call] = calls();
    expect(call!.argv[call!.argv.indexOf("--model") + 1]).toBe(codex.models.default);
  });

  it("keeps a Company's routing and approved models, and refuses without its key", async () => {
    const codex = await create({}, true);
    await codex.generateMemoryText!("hello");
    const [call] = calls();
    expect(call!.argv[call!.argv.indexOf("--model") + 1]).toBe("gpt-6-luna");
    expect(call!.argv).toContain('model_provider="openmaus_company"');
    expect(call!.env.OPENMAUSBOT_COMPANY_API_KEY).toBe("synthetic-company-fixture");
    await codex.dispose();
    const keyless = await create({ OPENMAUSBOT_COMPANY_API_KEY: "" }, true);
    await expect(keyless.generateMemoryText!("hello")).rejects.toThrow(/Company model access is unavailable/);
  });

  it("writes on the bot's own model for a ChatGPT sign-in, which refuses the small models its catalog lists", async () => {
    chatgptLogin();
    const codex = await create({ FAKE_CODEX_LUNA: "1", FAKE_CODEX_ASTRA: "1", FAKE_CODEX_TEXT_REFUSE: "gpt-6-luna,gpt-5.4-mini" });
    const usage: TextGenerationUsage[] = [];
    await expect(codex.generateMemoryText!("hello", { fallback: ownModel("gpt-fake-default").fallback, onUsage: (entry) => usage.push(entry) })).resolves.toBe("fake background answer");
    await expect(codex.generateMemoryText!("hello")).resolves.toBe("fake background answer");
    expect(modelsRun()).toEqual(["gpt-fake-default", "gpt-6-astra"]);
    expect(usage).toEqual([expect.objectContaining({ model: "gpt-fake-default" })]);
  });

  it("keeps the small model for an API-key sign-in", async () => {
    apiKeyLogin();
    const codex = await create({ FAKE_CODEX_LUNA: "1", FAKE_CODEX_ASTRA: "1" });
    const { fallback, onRefused } = ownModel("gpt-6-astra");
    await codex.generateMemoryText!("hello", { fallback });
    expect(modelsRun()).toEqual(["gpt-6-luna"]);
    expect(onRefused).not.toHaveBeenCalled();
  });

  it("never picks a small model this instance already refused", async () => {
    apiKeyLogin();
    const codex = await create({ FAKE_CODEX_LUNA: "1", FAKE_CODEX_ASTRA: "1", FAKE_CODEX_TEXT_REFUSE: "gpt-6-luna" });
    const { fallback, onRefused } = ownModel("gpt-fake-default", ["gpt-6-luna"]);
    await codex.generateMemoryText!("hello", { fallback });
    expect(modelsRun()).toEqual(["gpt-6-astra"]);
    expect(onRefused).not.toHaveBeenCalled();
  });

  it("runs once more on the bot's own model when the provider refuses the small one, and reports the refusal", async () => {
    apiKeyLogin();
    const codex = await create({ FAKE_CODEX_LUNA: "1", FAKE_CODEX_ASTRA: "1", FAKE_CODEX_TEXT_REFUSE: "gpt-6-luna" });
    const { fallback, onRefused } = ownModel("gpt-fake-default");
    const usage: TextGenerationUsage[] = [];
    await expect(codex.generateMemoryText!("hello", { fallback, onUsage: (entry) => usage.push(entry) })).resolves.toBe("fake background answer");
    expect(modelsRun()).toEqual(["gpt-6-luna", "gpt-fake-default"]);
    expect(onRefused.mock.calls).toEqual([["gpt-6-luna"]]);
    expect(usage).toEqual([expect.objectContaining({ model: "gpt-fake-default" })]);
  });

  it("runs only once when the bot's own model is refused, or the call failed for another reason", async () => {
    chatgptLogin();
    const refusing = await create({ FAKE_CODEX_LUNA: "1", FAKE_CODEX_TEXT_REFUSE: "gpt-fake-default" });
    const { fallback, onRefused } = ownModel("gpt-fake-default");
    await expect(refusing.generateMemoryText!("hello", { fallback })).rejects.toThrow(/'gpt-fake-default' model is not supported/);
    await refusing.dispose();
    apiKeyLogin();
    const failing = await create({ FAKE_CODEX_LUNA: "1", FAKE_CODEX_TEXT_MODE: "fail" });
    await expect(failing.generateMemoryText!("hello", { fallback })).rejects.toThrow(/401/);
    expect(modelsRun()).toEqual(["gpt-fake-default", "gpt-6-luna"]);
    expect(onRefused).not.toHaveBeenCalled();
  });

  it("remembers a refused small model across the bot's background jobs and restarts", async () => {
    apiKeyLogin();
    const codex = await create({ FAKE_CODEX_LUNA: "1", FAKE_CODEX_ASTRA: "1", FAKE_CODEX_TEXT_REFUSE: "gpt-6-luna" });
    const file = join(scratch, "refused-quick-models.json");
    const jobs = (smallModels: QuickModelFallback) => createSideJobs({
      bot: () => ({ id: "b1", name: "Bot", threadId: "main-b1", modelSelection: { instanceId: codex.instanceId, model: "gpt-fake-default" } }),
      instance: () => codex,
      refusal: () => undefined,
      helper: () => null,
      smallModels,
      assertWithinBudget: () => {},
      book: () => {},
    });
    const memory = jobs(new QuickModelFallback({ file, publish: () => {}, stopped: () => false })).text("memory", "b1")!;
    await memory.generateText("first");
    await memory.generateText("second");
    await jobs(new QuickModelFallback({ file, publish: () => {}, stopped: () => false })).text("skill-review", "b1")!.generateText("after a restart");
    expect(modelsRun()).toEqual(["gpt-6-luna", "gpt-fake-default", "gpt-6-astra", "gpt-6-astra"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ [codex.instanceId]: ["gpt-6-luna"] });
  });

  it("reads past Codex's banners, notices and reasoning to the answer", async () => {
    const codex = await create({ FAKE_CODEX_TEXT_MODE: "noisy", FAKE_CODEX_TEXT_REPLY: "only this" });
    await expect(codex.generateMemoryText!("hello")).resolves.toBe("only this");
  });

  it("fails with Codex's own words when the turn fails or the process dies", async () => {
    const failing = await create({ FAKE_CODEX_TEXT_MODE: "fail" });
    await expect(failing.generateMemoryText!("hello")).rejects.toThrow(/Codex background call failed: unexpected status 401/);
    await failing.dispose();
    const dying = await create({ FAKE_CODEX_TEXT_MODE: "exit" });
    await expect(dying.generateMemoryText!("hello")).rejects.toThrow(/exited 1: Error: stream disconnected/);
  });

  it("fails closed on any tool item, before its result is read", async () => {
    const codex = await create({ FAKE_CODEX_TEXT_MODE: "tool" });
    const usage = vi.fn();
    await expect(codex.generateMemoryText!("hello", { onUsage: usage })).rejects.toThrow(/tried to use a tool \(command_execution\)/);
    expect(usage).not.toHaveBeenCalled();
  });

  it("waits as long as the caller's options say", async () => {
    const env = { ...process.env, FAKE_CODEX_TEXT_MODE: "hang", FAKE_CODEX_TEXT_LOG: log };
    const started = Date.now();
    await expect(runCodexOneShot({ spawn: spawnCli, kill: killCliTree, cli: FAKE_CLI, env, prompt: "hello", model: "gpt-6-luna", providerArgs: [], options: { timeoutMs: 1_500 } })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(CODEX_BACKGROUND_TIMEOUT_MS);
  });

  it("stops the process on timeout and on abort", async () => {
    const env = { ...process.env, FAKE_CODEX_TEXT_MODE: "hang", FAKE_CODEX_TEXT_LOG: log };
    const spawned: Array<ReturnType<typeof spawnCli>> = [];
    const spawn: typeof spawnCli = (...args) => {
      const child = spawnCli(...args);
      spawned.push(child);
      return child;
    };
    const base = { spawn, kill: killCliTree, cli: FAKE_CLI, env, prompt: "hello", model: "gpt-6-luna", providerArgs: [] };
    await expect(runCodexOneShot({ ...base, timeoutMs: 1_500 })).rejects.toThrow(/timed out/);
    const controller = new AbortController();
    const pending = runCodexOneShot({ ...base, options: { signal: controller.signal } });
    await vi.waitFor(() => expect(calls()).toHaveLength(2), { timeout: 10_000 });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(spawned).toHaveLength(2);
    for (const child of spawned) expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    for (const call of calls()) expect(existsSync(call.cwd)).toBe(false);
    const aborted = new AbortController();
    aborted.abort();
    await expect(runCodexOneShot({ ...base, options: { signal: aborted.signal } })).rejects.toThrow(/aborted/);
    expect(spawned).toHaveLength(2);
  }, 30_000);
});
