import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { augmentedPath } from "../env-path.ts";
import { PROVIDER_CREDENTIAL_ENV } from "../credential-env.ts";
import { CodexDriver } from "./codex.ts";
import { encodeInjectId } from "./local-inject.ts";
import * as procs from "../procs.ts";
import { recordEvents } from "../testing/events.ts";
import { ClaudeDriver } from "./claude.ts";
import { MuseCodeDriver } from "./muse-code.ts";
import { CopilotAgentDriver, copilotSignedIn } from "./acp/copilot.ts";
import { hasDeepSeekKey } from "./acp/deepseek.ts";
import { GeminiAgentDriver } from "./acp/gemini.ts";
import { ClineAgentDriver } from "./acp/cline.ts";
import { createCursorAgentDriver } from "./acp/cursor.ts";
import { applyDroidLocalAuthEnv, DroidAgentDriver } from "./acp/droid.ts";
import { createOpenCodeDriver } from "./acp/opencode-go.ts";

const cli = fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url));
const acpCli = fileURLToPath(new URL("../testing/fake-acp-cli.ts", import.meta.url));
const spellings = (key: string) => [key, key.toLowerCase(), key[0] + key.slice(1).toLowerCase()];

beforeEach(() => {
  for (const key of new Set([...Object.keys(process.env), ...PROVIDER_CREDENTIAL_ENV])) {
    if (PROVIDER_CREDENTIAL_ENV.some(name => name === key.toUpperCase())) vi.stubEnv(key, undefined);
  }
  vi.stubGlobal("fetch", vi.fn(async () => new Response("offline fixture", { status: 503 })));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

for (const key of ["ANTHROPIC_API_KEY", "anthropic_api_key", "Anthropic_Api_Key"]) {
  it.each(["snapshot", "sendTurn", "generateText"])("Claude API-only %s accepts " + key, async (check) => {
    const instance = await ClaudeDriver.create({
      instanceId: "credential-readiness", displayName: "Fixture", enabled: true,
      environment: { [key]: "explicit-synthetic-key" }, config: ClaudeDriver.decodeConfig({ cli, requireApiKey: true }),
    });
    const recorder = recordEvents(instance.adapter);
    try {
      if (check === "snapshot") expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true, billing: "metered" });
      if (check === "sendTurn") {
        await instance.adapter.sendTurn({ threadId: "credential-readiness", text: "hello" });
        expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
      }
      if (check === "generateText") expect(await instance.generateText!("hello")).toEqual(expect.any(String));
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("Claude snapshot bills explicit " + key + " as metered ahead of login", async () => {
    const instance = await ClaudeDriver.create({
      instanceId: "credential-billing", displayName: "Fixture", enabled: true,
      environment: { [key]: "explicit-synthetic-key" }, config: ClaudeDriver.decodeConfig({ cli }),
    });
    try {
      expect(await instance.snapshot()).toMatchObject({ state: "available", billing: "metered", account: { method: "api-key" } });
    } finally { await instance.dispose(); }
  });
}

for (const key of ["META_API_KEY", "meta_api_key", "Meta_Api_Key"]) {
  it.each([false, true])("Muse recognizes explicit " + key + ", saved login=%s", async (savedLogin) => {
    const home = join(homedir(), `muse-${key}-${savedLogin}`);
    const configHome = join(home, ".config");
    if (savedLogin) {
      mkdirSync(join(configHome, "muse"), { recursive: true });
      writeFileSync(join(configHome, "muse", "auth.json"), "{}");
    }
    const executed = vi.spyOn(procs, "execCli").mockImplementation((_cli, _args, _opts, callback) => callback(null, "1.4.6"));
    const instance = await MuseCodeDriver.create({
      instanceId: "muse-readiness", displayName: "Fixture", enabled: true,
      environment: { [key]: "explicit-synthetic-key", HOME: home, XDG_CONFIG_HOME: configHome },
      config: MuseCodeDriver.decodeConfig({ cli: "unused-fixture" }),
    });
    try {
      const snapshot = await instance.snapshot();
      expect(executed.mock.calls[0][2].env?.[key]).toBe("explicit-synthetic-key");
      expect(snapshot).toMatchObject({ state: "available", authenticated: true, billing: "metered", account: { method: "api-key" } });
    } finally { await instance.dispose(); }
  });
}

it.each([
  ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
  ["anthropic_api_key", "anthropic_base_url"],
  ["Anthropic_Api_Key", "Anthropic_Base_Url"],
])("Claude managed admission accepts %s and %s", async (key, baseUrl) => {
  const instance = await ClaudeDriver.create({
    instanceId: "managed-readiness", displayName: "Fixture", enabled: true,
    environment: { [key]: "synthetic-company-key", [baseUrl]: "http://127.0.0.1:9" },
    config: ClaudeDriver.decodeConfig({ cli, requireApiKey: true, managed: true, configDir: join(homedir(), "managed-account") }),
  });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "managed-readiness", text: "hello", model: "fixture-model" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
  } finally { recorder.stop(); await instance.dispose(); }
});

it("Claude keeps subscription billing without an explicit grant despite inherited aliases", async () => {
  for (const key of ["ANTHROPIC_API_KEY", "anthropic_api_key", "Anthropic_Api_Key"]) vi.stubEnv(key, "inherited-key");
  const instance = await ClaudeDriver.create({
    instanceId: "subscription-readiness", displayName: "Fixture", enabled: true,
    environment: {}, config: ClaudeDriver.decodeConfig({ cli }),
  });
  try { expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true, billing: "subscription" }); }
  finally { await instance.dispose(); }
});

it.each([false, true])("Muse requires an explicit grant or saved login, saved login=%s", async (savedLogin) => {
  for (const key of ["META_API_KEY", "meta_api_key", "Meta_Api_Key"]) vi.stubEnv(key, "inherited-key");
  const home = join(homedir(), `muse-control-${savedLogin}`);
  const configHome = join(home, ".config");
  if (savedLogin) {
    mkdirSync(join(configHome, "muse"), { recursive: true });
    writeFileSync(join(configHome, "muse", "auth.json"), "{}");
  }
  vi.spyOn(procs, "execCli").mockImplementation((_cli, _args, _opts, callback) => callback(null, "1.4.6"));
  const instance = await MuseCodeDriver.create({
    instanceId: "muse-control", displayName: "Fixture", enabled: true,
    environment: { HOME: home, XDG_CONFIG_HOME: configHome }, config: MuseCodeDriver.decodeConfig({ cli: "unused-fixture" }),
  });
  try {
    expect(await instance.snapshot()).toMatchObject(savedLogin
      ? { state: "available", authenticated: true, billing: "subscription", account: { method: "login" } }
      : { state: "unavailable", authenticated: false });
  } finally { await instance.dispose(); }
});

const freeCatalog = { default: "opencode/big-pickle", options: [{ id: "opencode/big-pickle", label: "Fixture" }] };
const acpDrivers = [
  { driver: GeminiAgentDriver, key: "GEMINI_API_KEY" },
  { driver: GeminiAgentDriver, key: "GOOGLE_API_KEY" },
  { driver: ClineAgentDriver, key: "CLINE_API_KEY" },
  { driver: createCursorAgentDriver(), key: "CURSOR_API_KEY" },
  { driver: createCursorAgentDriver(), key: "CURSOR_AUTH_TOKEN" },
  { driver: DroidAgentDriver, key: "FACTORY_API_KEY" },
  { driver: createOpenCodeDriver(async () => freeCatalog), key: "OPENCODE_API_KEY" },
  { driver: createOpenCodeDriver(async () => freeCatalog), key: "ANTHROPIC_API_KEY" },
];

for (const { driver, key: canonical } of acpDrivers) {
  it.each(spellings(canonical))(driver.driverKind + " recognizes explicit %s", async (key) => {
    for (const alias of spellings(canonical)) vi.stubEnv(alias, undefined);
    const home = join(homedir(), `${driver.driverKind}-${key}`);
    const instance = await driver.create({
      instanceId: `readiness-${key}`, displayName: "Fixture", enabled: true,
      environment: { [key]: "explicit-synthetic-key", HOME: home, USERPROFILE: home, XDG_DATA_HOME: join(home, "data"), FAKE_ACP_AUTH: "0" },
      config: driver.decodeConfig({ cli: acpCli }),
    });
    try {
      const snapshot = await instance.snapshot();
      expect(snapshot).toMatchObject({ state: "available", authenticated: true });
      expect(snapshot.freeFallback).toBeUndefined();
    } finally { await instance.dispose(); }
  });
}

it.each(["factory_api_key", "Factory_Api_Key"])("Droid local auth preserves explicit %s instead of adding a placeholder", (key) => {
  const env = { [key]: "explicit-synthetic-key", HOME: join(homedir(), "droid-local") };
  applyDroidLocalAuthEnv(env, encodeInjectId("ollama", "fixture-model"));
  expect(env).toEqual({ [key]: "explicit-synthetic-key", HOME: join(homedir(), "droid-local") });
});

for (const key of ["OPENMAUSBOT_COMPANY_API_KEY", "openmausbot_company_api_key", "Openmausbot_Company_Api_Key"]) {
  it.each(["snapshot", "sendTurn", "generateMemoryText"])("Codex managed %s accepts " + key, async (check) => {
    const codexCli = fileURLToPath(new URL("../testing/fake-codex-app-server.ts", import.meta.url));
    const instance = await CodexDriver.create({
      instanceId: "codex-managed-readiness", displayName: "Fixture", enabled: true,
      environment: { [key]: "explicit-synthetic-key", CODEX_HOME: join(homedir(), "codex-managed") },
      config: CodexDriver.decodeConfig({ cli: codexCli, managed: { url: "http://127.0.0.1:9/v1", models: ["fixture-model"] } }),
    });
    const recorder = recordEvents(instance.adapter);
    try {
      if (check === "snapshot") expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true, billing: "metered" });
      if (check === "sendTurn") {
        await instance.adapter.sendTurn({ threadId: "codex-managed-readiness", text: "hello", model: "fixture-model" });
        expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
      }
      if (check === "generateMemoryText") expect(await instance.generateMemoryText!("hello")).toEqual(expect.any(String));
    } finally { recorder.stop(); await instance.dispose(); }
  });
}

it.each(["anthropic_api_key", "Anthropic_Api_Key"])("Claude replaces a retained CLI when explicit %s rotates", async (key) => {
  const environment = { [key]: "synthetic-first-key" };
  const spawned = vi.spyOn(procs, "spawnCli");
  const instance = await ClaudeDriver.create({
    instanceId: "rotating-key", displayName: "Fixture", enabled: true,
    environment, config: ClaudeDriver.decodeConfig({ cli }),
  });
  const recorder = recordEvents(instance.adapter);
  try {
    for (const value of ["synthetic-first-key", "synthetic-next-key"]) {
      environment[key] = value;
      const { turnId } = await instance.adapter.sendTurn({ threadId: "rotating-key", text: "hi" });
      expect(await recorder.until(event => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ ok: true });
    }
    const launches = spawned.mock.calls.filter(call => call[3] === "bot");
    expect(launches).toHaveLength(2);
    expect(launches[1][2].env?.[key]).toBe("synthetic-next-key");
  } finally { recorder.stop(); await instance.dispose(); }
});

it.each([
  ["cursor_api_key", "cursor_login"], ["Cursor_Auth_Token", "cursor_login"],
  ["cline_api_key", "cline-pass"], ["Cline_Api_Key", "cline-pass"],
])("explicit %s prevents subscription authentication via %s", async (key, method) => {
  const driver = method === "cursor_login" ? createCursorAgentDriver() : ClineAgentDriver;
  const rpcFile = join(homedir(), `rpc-${key}.jsonl`);
  const instance = await driver.create({
    instanceId: "auth-method-readiness", displayName: "Fixture", enabled: true,
    environment: { [key]: "explicit-key", CLINE_PROVIDER: "cline-pass", FAKE_ACP_AUTH_METHOD: method, FAKE_ACP_RPC_APPEND_FILE: rpcFile },
    config: driver.decodeConfig({ cli: acpCli }),
  });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "auth-method-readiness", text: "hello" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
    const calls = readFileSync(rpcFile, "utf8").trim().split("\n").map(line => JSON.parse(line) as { method: string });
    expect(calls.filter(call => call.method === "authenticate")).toEqual([]);
  } finally { recorder.stop(); await instance.dispose(); }
});

it.each(["cline_api_key", "Cline_Api_Key"])("Cline prefers explicit %s over saved provider credentials", async (key) => {
  const data = join(homedir(), `cline-saved-${key}`);
  mkdirSync(join(data, "settings"), { recursive: true });
  writeFileSync(join(data, "settings", "providers.json"), JSON.stringify({
    version: 1, lastUsedProvider: "openai-compatible",
    providers: { "openai-compatible": { settings: { provider: "openai-compatible", apiKey: "saved-key" } } },
  }));
  const executed = vi.spyOn(procs, "execCli");
  const instance = await ClineAgentDriver.create({
    instanceId: "cline-saved-readiness", displayName: "Fixture", enabled: true,
    environment: { [key]: "explicit-key", CLINE_DATA_DIR: data }, config: ClineAgentDriver.decodeConfig({ cli: acpCli }),
  });
  try {
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
    const env = executed.mock.calls[0][2].env ?? {};
    expect(Object.fromEntries(Object.entries(env).filter(([name, value]) => name.toUpperCase() === "CLINE_API_KEY" && value)))
      .toEqual({ [key]: "explicit-key" });
  } finally { await instance.dispose(); }
});

it("Claude API-only rejects inherited aliases without an explicit grant", async () => {
  for (const key of ["ANTHROPIC_API_KEY", "anthropic_api_key", "Anthropic_Api_Key"]) vi.stubEnv(key, "inherited-key");
  const instance = await ClaudeDriver.create({
    instanceId: "no-explicit-key", displayName: "Fixture", enabled: true,
    environment: {}, config: ClaudeDriver.decodeConfig({ cli, requireApiKey: true }),
  });
  try {
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
    await expect(instance.adapter.sendTurn({ threadId: "no-explicit-key", text: "hello" })).rejects.toThrow("No Anthropic API key");
    await expect(instance.generateText!("hello")).rejects.toThrow("No Anthropic API key");
  } finally { await instance.dispose(); }
});

it("Claude managed admission rejects an inherited base URL without an explicit route", async () => {
  vi.stubEnv("ANTHROPIC_BASE_URL", "http://127.0.0.1:9");
  vi.stubEnv("anthropic_base_url", "http://127.0.0.1:9");
  const instance = await ClaudeDriver.create({
    instanceId: "no-explicit-route", displayName: "Fixture", enabled: true,
    environment: { ANTHROPIC_API_KEY: "explicit-key" },
    config: ClaudeDriver.decodeConfig({ cli, managed: true, requireApiKey: true, configDir: join(homedir(), "managed-no-route") }),
  });
  try {
    await expect(instance.adapter.sendTurn({ threadId: "no-explicit-route", text: "hello", model: "fixture-model" }))
      .rejects.toThrow("Company model access is unavailable");
  } finally { await instance.dispose(); }
});

it.each(spellings("DEEPSEEK_API_KEY"))("DeepSeek readiness accepts explicit %s", (key) => {
  expect(hasDeepSeekKey({ [key]: "explicit-key", HOME: join(homedir(), "deepseek-readiness"), DSH_HOME: join(homedir(), "deepseek-readiness") })).toBe(true);
});

for (const canonical of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
  it.each(spellings(canonical))("Copilot refreshes readiness when explicit %s rotates", async (key) => {
    const env: NodeJS.ProcessEnv = {
      PATH: augmentedPath(), HOME: homedir(), USERPROFILE: homedir(),
      COPILOT_GITHUB_TOKEN: "", GH_TOKEN: "", GITHUB_TOKEN: "",
      [key]: "synthetic-expired-token", COPILOT_HOME: join(homedir(), `copilot-${key}`), FAKE_ACP_MODE: "auth-required",
    };
    expect(await copilotSignedIn(env, { cli: acpCli }, 10_000)).toBe(false);
    env[key] = "synthetic-new-token";
    env.FAKE_ACP_MODE = "happy";
    expect(await copilotSignedIn(env, { cli: acpCli }, 10_000)).toBe(true);
  });
}

it.each(["gh_token", "Gh_Token", "github_token", "Github_Token"])("Copilot keeps only the explicit %s grant, without inherited aliases", async (key) => {
  for (const alias of ["GH_TOKEN", "gh_token", "Gh_Token", "GITHUB_TOKEN", "github_token", "Github_Token"]) vi.stubEnv(alias, "inherited-token");
  const spawned = vi.spyOn(procs, "spawnCli");
  const instance = await CopilotAgentDriver.create({
    instanceId: "copilot-grant", displayName: "Fixture", enabled: true,
    environment: { [key]: "explicit-token", FAKE_ACP_MODELS: "auto" }, config: CopilotAgentDriver.decodeConfig({ cli: acpCli }),
  });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "copilot-grant", text: "hello", model: "auto" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
    const launches = spawned.mock.calls.filter(call => call[3] === "bot");
    expect(launches.length).toBeGreaterThan(0);
    for (const call of launches) {
      expect(Object.fromEntries(Object.entries(call[2].env ?? {}).filter(([name]) => ["GH_TOKEN", "GITHUB_TOKEN"].includes(name.toUpperCase()))))
        .toEqual({ [key]: "explicit-token" });
    }
  } finally { recorder.stop(); await instance.dispose(); }
});
