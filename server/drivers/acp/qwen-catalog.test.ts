import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { QwenAgentDriver, readQwenModelCatalog, resolveQwenTurnModel } from "./qwen.ts";
import { recordEvents } from "../../testing/events.ts";
const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");

const scratchDirs: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  // Windows can keep the fake CLI's working directory open briefly while
  // taskkill finishes. Yield and retry cleanup without hiding a persistent leak.
  for (const dir of scratchDirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
      providerProtocol: { customProvider: "anthropic" },
    });

    const catalog = readQwenModelCatalog(homeEnv(home));
    expect(catalog).toEqual({
      default: "qwen3.7-plus(openai)",
      options: [
        { id: "qwen3.7-plus(openai)", label: "qwen3.7-plus — Qwen Plus", custom: true, provider: "openai" },
        { id: "qwen3.8-max(openai)", label: "qwen3.8-max", custom: true, provider: "openai" },
        { id: "fallback-label(openai)", label: "fallback-label", custom: true, provider: "openai" },
        { id: "custom/model(anthropic)", label: "custom/model — Custom Model", custom: true, provider: "customProvider" },
      ],
    });
    expect(JSON.stringify(catalog)).not.toContain("must-not-leak");
    expect(JSON.stringify(catalog)).not.toContain("SECRET_ENV");
    expect(JSON.stringify(catalog)).not.toContain("also-secret");
    expect(JSON.stringify(catalog)).not.toContain("https://example.test");
  });

  it("preserves model IDs across protocols and endpoints, deduplicating only identical routes", () => {
    const home = scratchSettings({
      modelProviders: {
        openai: [{ id: "same-model", name: "First Label" }, { id: "same-model", name: "Duplicate" }],
        anthropic: [
          { id: "same-model", name: "Second Label" },
          { id: "unique-model", name: "Unique" },
        ],
      },
    });

    expect(readQwenModelCatalog(homeEnv(home)).options).toEqual([
      { id: "same-model(openai)", label: "same-model — First Label", custom: true, provider: "openai" },
      { id: "same-model(anthropic)", label: "same-model — Second Label", custom: true, provider: "anthropic" },
      { id: "unique-model(anthropic)", label: "unique-model — Unique", custom: true, provider: "anthropic" },
    ]);
  });

  it("uses USERPROFILE on Windows and HOME on other platforms", () => {
    const home = scratchSettings({ modelProviders: { openai: [{ id: "from-home" }] } });
    const userProfile = scratchSettings({ modelProviders: { openai: [{ id: "from-userprofile" }] } });
    const catalog = readQwenModelCatalog({ HOME: home, USERPROFILE: userProfile });
    expect(catalog.default).toBe(process.platform === "win32" ? "from-userprofile(openai)" : "from-home(openai)");
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
      expect(instance.models.default).toBe("configured-qwen(openai)");
      expect(instance.models.options).toContainEqual({
        id: "configured-qwen(openai)",
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
          { id: "local-qwen", name: "Stale local row", baseUrl: "http://127.0.0.1:8080/v1" },
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
      expect(instance.models.default).toBe("cloud-qwen(openai)");
      expect(instance.models.options.map((option) => option.id)).toEqual([
        "cloud-qwen(openai)",
        "omlx::local-qwen",
      ]);
    } finally {
      globalThis.fetch = previousFetch;
      await instance.dispose();
    }
  });
});

describe("Qwen route selection", () => {
  it("does not list invalid providers or dedicated non-chat models", () => {
    const home = scratchSettings({ modelProviders: {
      typo: [{ id: "not-routable" }],
      openai: [{ id: "image", imageOnly: true }, { id: "voice", voiceOnly: true }, { id: "fast", fastOnly: true },
        { id: "fast" }],
      "qwen-oauth": [{ id: "cannot-override-oauth" }],
    } });
    expect(readQwenModelCatalog(homeEnv(home)).options).toEqual([]);
  });

  it("uses opaque endpoint selectors without exposing URL credentials or env keys", () => {
    const home = scratchSettings({ modelProviders: { openai: [
      { id: "same", name: "Direct", baseUrl: "https://user:secret@one.example/v1?key=secret", envKey: "PRIVATE_KEY" },
      { id: "same", name: "Proxy", baseUrl: "https://two.example/v1", envKey: "PROXY_KEY" },
    ] } });
    const catalog = readQwenModelCatalog(homeEnv(home));
    expect(catalog.options).toHaveLength(2);
    expect(new Set(catalog.options.map((option) => option.id)).size).toBe(2);
    expect(catalog.options.map((option) => option.id)).toEqual([
      "qwen-route:v1:Pl6RmcKiXIXqx00n", "qwen-route:v1:J2FxmHQ8xLDRQvCK",
    ]);
    for (const option of catalog.options) expect(option.id).toMatch(/^qwen-route:v1:[\w-]{16}$/);
    for (const secret of ["secret", "one.example", "two.example", "PRIVATE_KEY", "PROXY_KEY"]) {
      expect(JSON.stringify(catalog)).not.toContain(secret);
    }
    expect(() => resolveQwenTurnModel("same", homeEnv(home))).toThrow("multiple providers");
  });

  it("rejects unknown selections and routes whose public identities collide", () => {
    const empty = scratchSettings({});
    expect(() => resolveQwenTurnModel("deleted", homeEnv(empty))).toThrow("no longer configured");
    const colliding = scratchSettings({ modelProviders: { openai: [
      { id: "same", baseUrl: "https://proxy.example/v1?key=one" },
      { id: "same", baseUrl: "https://proxy.example/v1?key=two" },
    ] } });
    expect(() => readQwenModelCatalog(homeEnv(colliding))).toThrow("indistinguishable");
    const invalid = scratchSettings({ modelProviders: { openai: [{ id: "same", baseUrl: "not a url" }] } });
    expect(() => readQwenModelCatalog(homeEnv(invalid))).toThrow("invalid endpoint");
  });

  it("preserves a default when its exact local route is replaced by discovery", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => String(url).includes(":8080")
      ? new Response(JSON.stringify({ data: [{ id: "local-qwen" }] })) : new Response("offline", { status: 500 })) as typeof fetch;
    const home = scratchSettings({ modelProviders: { openai: [
      { id: "local-qwen", baseUrl: "http://127.0.0.1:8080/v1" },
      { id: "local-qwen", baseUrl: "https://cloud.example/v1" },
    ] } });
    const instance = await QwenAgentDriver.create({ instanceId: "qwen-default", displayName: "Qwen", enabled: true,
      environment: { ...homeEnv(home), OPENMAUSBOT_PROBE_LOCAL_INJECT: "1" }, config: { cli: FAKE_CLI, fullAuto: false } });
    try {
      expect(instance.models.default).toBe("omlx::local-qwen");
      expect(instance.models.options).toHaveLength(2);
      expect(instance.models.options.map((option) => option.id)).toContain(instance.models.default);
    } finally {
      globalThis.fetch = previousFetch;
      await instance.dispose();
    }
  });

  it.each([false, true])("pins the selected provider before prompting (rejected switch: %s)", async (rejectSwitch) => {
    const home = scratchSettings({ modelProviders: {
      openai: [{ id: "same" }], anthropic: [{ id: "same" }],
    } });
    const rpc = join(home, "rpc.json");
    const dump = join(home, "spawn.json");
    const instance = await QwenAgentDriver.create({ instanceId: "qwen-routes", displayName: "Qwen", enabled: true,
      environment: { ...homeEnv(home), FAKE_ACP_MODELS: "same(openai),same(anthropic)",
        FAKE_ACP_MODEL_STICKS: rejectSwitch ? "1" : "", FAKE_ACP_RPC_DUMP: rpc, FAKE_ACP_DUMP: dump },
      config: { cli: FAKE_CLI, fullAuto: false } });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "routes", text: "hello", model: "same(anthropic)", cwd: home });
      await recorder.until((event) => event.type === "turn.completed");
      const calls = JSON.parse(readFileSync(`${dump}.config.json`, "utf8"));
      expect(calls).toContainEqual({ method: "session/set_config_option", params: {
        sessionId: "fake-acp-session", configId: "model", value: "same(anthropic)",
      } });
      const methods = JSON.parse(readFileSync(rpc, "utf8")) as string[];
      expect(methods.includes("session/prompt")).toBe(!rejectSwitch);
      if (!rejectSwitch) expect(methods.indexOf("session/set_config_option")).toBeLessThan(methods.indexOf("session/prompt"));
      expect(JSON.parse(readFileSync(dump, "utf8")).argv).toEqual(["--acp"]);
      expect(recorder.events.find((event) => event.type === "turn.completed")).toMatchObject({ ok: !rejectSwitch });
    } finally { await instance.dispose(); }
  });
});
