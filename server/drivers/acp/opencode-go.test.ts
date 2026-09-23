import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import {
  classifyOpenCodeError,
  canListOpenCodeModels,
  createOpenCodeDriver,
  normalizeLegacyOpenCodeModel,
  parseOpenCodeModelsOutput,
} from "./opencode-go.ts";
import type { ModelCatalog, ProviderInstance, SendTurnInput } from "../../contracts.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

const catalog = (...ids: string[]): ModelCatalog => ({
  default: ids[0]!,
  options: ids.map((id) => ({ id, label: id })),
});

describe("OpenCode catalog", () => {
  it("keeps advertised opaque variants without inventing default or mapping minimal", () => {
    const parsed = parseOpenCodeModelsOutput([
      "opencode/reasoner",
      JSON.stringify({ variants: { minimal: {}, "custom/Deep_mode": {}, disabled: { disabled: true } } }, null, 2),
      "opencode/with-default",
      JSON.stringify({ variants: { default: {}, none: {} } }, null, 2),
      "opencode/plain",
      JSON.stringify({ capabilities: { reasoning: false } }, null, 2),
    ].join("\n"));
    expect(parsed?.options[0].variants?.map((option) => option.id)).toEqual(["minimal", "custom/Deep_mode"]);
    expect(parsed?.options[1].variants?.map((option) => option.id)).toEqual(["default", "none"]);
    expect(parsed?.options[2].variants).toBeUndefined();
  });
  it("parses Zen, Go, third-party, and local models using exact CLI slugs", () => {
    const models = parseOpenCodeModelsOutput([
      "openrouter/vendor/model-v2",
      JSON.stringify({ name: "Vendor Model", status: "active" }, null, 2),
      "opencode/x-preview-f-free",
      JSON.stringify({ name: "Ox Alpha Free", status: "active", limit: { context: 1_000_000 } }, null, 2),
      "opencode-go/minimax-m3",
      JSON.stringify({ name: "MiniMax M3", status: "active" }, null, 2),
      "ollama/qwen3",
      JSON.stringify({ name: "Qwen 3", api: { url: "http://127.0.0.1:11434/v1" } }, null, 2),
      "lmstudio/qwen3-ipv6",
      JSON.stringify({ name: "Qwen 3 IPv6", api: { url: "http://[::1]:1234/v1" } }, null, 2),
      "opencode/retired",
      JSON.stringify({ name: "Retired", status: "deprecated" }, null, 2),
    ].join("\n"));

    expect(models?.default).toBe("opencode/x-preview-f-free");
    expect(models?.options).toEqual([
      expect.objectContaining({ id: "openrouter/vendor/model-v2", label: "OpenRouter · Vendor Model" }),
      expect.objectContaining({
        id: "opencode/x-preview-f-free",
        label: "Zen · Ox Alpha Free",
        contextWindow: 1_000_000,
      }),
      expect.objectContaining({ id: "opencode-go/minimax-m3", label: "Go · MiniMax M3" }),
      expect.objectContaining({ id: "ollama/qwen3", custom: true, loaded: true }),
      expect.objectContaining({ id: "lmstudio/qwen3-ipv6", custom: true, loaded: true }),
    ]);
  });

  it("caches the anonymous model probe across authentication checks", async () => {
    const runModels = vi.fn(async () => "opencode/x-preview-f-free\n");

    await expect(canListOpenCodeModels({}, "counting-opencode", runModels)).resolves.toBe(true);
    await expect(canListOpenCodeModels({}, "counting-opencode", runModels)).resolves.toBe(true);

    expect(runModels).toHaveBeenCalledOnce();
  });

  it("accepts header-only output from older CLIs and rejects malformed lines", () => {
    const models = parseOpenCodeModelsOutput([
      "Available models",
      "opencode/x-preview-f-free",
      "bad model/with space",
      "openrouter/anthropic/claude-sonnet-5",
    ].join("\n"));

    expect(models?.options.map((option) => option.id)).toEqual([
      "opencode/x-preview-f-free",
      "openrouter/anthropic/claude-sonnet-5",
    ]);
  });

  it("refreshes the same instance catalog on each explicit refresh", async () => {
    let calls = 0;
    const driver = createOpenCodeDriver(async () => {
      calls += 1;
      const id = calls === 1
        ? "opencode/x-preview-f-free"
        : calls === 2
          ? "opencode-go/extra-two"
          : "openrouter/vendor/extra-three";
      return catalog(id);
    });
    const instance = await driver.create({
      instanceId: "opencode-refresh",
      displayName: "OpenCode",
      environment: {},
      enabled: true,
      config: driver.defaultConfig(),
    });

    expect(instance.models.default).toBe("opencode/x-preview-f-free");
    expect(instance.models.options.some((option) => option.custom)).toBe(false);
    await instance.refreshModels?.();
    expect(instance.models.options.some((option) => option.id === "opencode-go/extra-two" && !option.custom)).toBe(true);
    await instance.refreshModels?.();
    expect(instance.models.options.some((option) => option.id === "openrouter/vendor/extra-three" && !option.custom)).toBe(true);
    await instance.dispose();
  });

  it("keeps the driver optional and declares the OpenCode CLI setup", () => {
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    expect(driver.driverKind).toBe("opencodeGo");
    expect(driver.metadata.displayName).toBe("OpenCode");
    expect(driver.decodeConfig(undefined)).toEqual({ cli: "opencode", fullAuto: false, workspace: undefined });
    expect(driver.install?.docsUrl).toContain("opencode.ai");
    expect(driver.install?.signInCommand).toBe("opencode auth login");
  });

  it("migrates the retired Ox preview id without changing current ids", () => {
    expect(normalizeLegacyOpenCodeModel("opencode-go/ox-alpha-free", {})).toBe(
      "opencode/x-preview-f-free",
    );
    expect(normalizeLegacyOpenCodeModel("opencode-go/ox-alpha-free", { OPENCODE_API_KEY: "configured" })).toBe(
      "opencode-go/x-preview-f-free",
    );
    expect(normalizeLegacyOpenCodeModel("opencode/gpt-5.6-sol", {})).toBe("opencode/gpt-5.6-sol");
  });

  it("recognizes an OpenCode Go login stored by the CLI", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-auth-"));
    const authDir = join(scratch, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      "opencode-go": { type: "api", key: "stored-secret" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode-go/minimax-m3"));
    const instance = await driver.create({
      instanceId: "opencode-auth",
      displayName: "OpenCode",
      environment: { XDG_DATA_HOME: scratch, OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("finds the CLI's login at ~/.local/share on every platform, macOS included", async () => {
    // `opencode auth list` prints ~/.local/share/opencode/auth.json on macOS —
    // the CLI is xdg-flavoured everywhere. Looking only in Library/Application
    // Support is the bug that told signed-in users to sign in. No XDG override
    // here on purpose: this is the exact real-world shape.
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-home-"));
    const authDir = join(scratch, ".local", "share", "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      "opencode-go": { type: "api", key: "stored-secret" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode-go/minimax-m3"));
    const instance = await driver.create({
      instanceId: "opencode-home-auth",
      displayName: "OpenCode",
      environment: { HOME: scratch, USERPROFILE: scratch, XDG_DATA_HOME: "", OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("recognizes an existing OpenCode Zen login", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-oauth-"));
    const authDir = join(scratch, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      opencode: { type: "oauth", access: "acc-token", refresh: "ref-token" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    const instance = await driver.create({
      instanceId: "opencode-oauth-auth",
      displayName: "OpenCode",
      environment: { XDG_DATA_HOME: scratch, OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("treats OpenCode's anonymous free catalog as runnable without a saved key", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-free-"));
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    const instance = await driver.create({
      instanceId: "opencode-free",
      displayName: "OpenCode",
      environment: {
        HOME: scratch,
        USERPROFILE: scratch,
        XDG_DATA_HOME: join(scratch, "data"),
        FAKE_ACP_MODELS: "opencode/x-preview-f-free",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("runs a Zen model through ACP using the exact discovered id", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-zen-only-"));
    const authDir = join(scratch, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      opencode: { type: "api", key: "zen-only-secret" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    const instance = await driver.create({
      instanceId: "opencode-zen-only",
      displayName: "OpenCode",
      environment: {
        XDG_DATA_HOME: scratch,
        OPENCODE_API_KEY: "",
        FAKE_ACP_MODELS: "opencode/x-preview-f-free",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "t-opencode-zen-only",
        text: "hello",
        model: "opencode/x-preview-f-free",
      });
      const done = await recorder.until((event) => event.type === "turn.completed");
      expect(done).toMatchObject({ ok: true });
      expect(recorder.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "session.started", model: "opencode/x-preview-f-free" }),
      ]));
    } finally {
      recorder.stop();
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("classifies ACP's standard authentication error", () => {
    expect(classifyOpenCodeError({ code: -32000 })).toBe("invalid_credentials");
  });

  it("keeps the OpenCode key in the child environment only", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-go-"));
    try {
      const dump = join(scratch, "env.json");
      const driver = createOpenCodeDriver(async () => catalog("opencode-go/minimax-m3"));
      const instance = await driver.create({
        instanceId: "opencode-go",
        displayName: "OpenCode",
        environment: {
          OPENCODE_API_KEY: "secret-value",
          OPENAI_API_KEY: "wrong-provider-secret",
          ANTHROPIC_API_KEY: "wrong-provider-secret",
          FAKE_ACP_DUMP: dump,
        },
        enabled: true,
        config: { cli: FAKE_CLI, fullAuto: false },
      });
      await instance.snapshot();
      const child = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> };
      expect(child.env.OPENCODE_API_KEY).toBe("secret-value");
      expect(child.env.OPENAI_API_KEY).toBeUndefined();
      expect(child.env.ANTHROPIC_API_KEY).toBeUndefined();
      await instance.dispose();
    } finally {
      await removeTempDir(scratch);
    }
  });
});

describe("OpenCode session variants", () => {
  const model = "opencode/reasoner";
  const secondModel = "opencode/other";
  const plainModel = "opencode/plain";
  const variantConfig = (ids: string[], currentValue = ids[0], id = "effort") => ({
    id, currentValue, options: ids.map((value) => ({ value, name: value })),
  });
  const sessionOptions = (ids: string[], currentValue = ids[0]) => [
    { id: "model", type: "select", currentValue: model, options: [{ value: model, name: model }] },
    { ...variantConfig(ids, currentValue), type: "select", category: "thought_level" },
  ];
  const fixtures: Array<{ scratch: string; instance: ProviderInstance; recorder: EventRecorder }> = [];
  const fixture = async (variants: Record<string, unknown>, environment: Record<string, string> = {}) => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-variants-"));
    const dump = join(scratch, "rpc");
    const driver = createOpenCodeDriver(async () => catalog(model, secondModel, plainModel, "opencode-go/x-preview-f-free"));
    const instance = await driver.create({
      instanceId: "opencode-variant-test", displayName: "OpenCode", enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: scratch },
      environment: {
        HOME: scratch, XDG_CONFIG_HOME: scratch, XDG_DATA_HOME: scratch,
        OPENCODE_API_KEY: "fixture-key", FAKE_ACP_MODELS: [model, secondModel, plainModel, "opencode-go/x-preview-f-free"].join(","),
        FAKE_ACP_VARIANTS: JSON.stringify(variants), FAKE_ACP_DUMP: dump,
        FAKE_ACP_RPC_DUMP: `${dump}.methods.json`, ...environment,
      },
    });
    const recorder = recordEvents(instance.adapter);
    fixtures.push({ scratch, instance, recorder });
    const run = async (input: Partial<SendTurnInput> = {}) => {
      promptsBefore = promptCount();
      pidBefore = dumpPid();
      const { turnId } = await instance.adapter.sendTurn({ threadId: "variant-thread", text: "fixture", model, ...input });
      const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      return { done, events: recorder.events.filter((event) => event.turnId === turnId) };
    };
    const calls = (): Array<{ params: { sessionId: string; configId: string; value: string } }> => (
      existsSync(`${dump}.config.json`) ? JSON.parse(readFileSync(`${dump}.config.json`, "utf8")) : []
    );
    // the fake's methods file accumulates for the whole (pooled) process, so
    // "was the LAST run prompted" is a count delta, not an includes()
    const promptCount = () =>
      (existsSync(`${dump}.methods.json`) ? JSON.parse(readFileSync(`${dump}.methods.json`, "utf8")) as string[] : [])
        .filter((method) => method === "session/prompt").length;
    const dumpPid = () => (existsSync(dump) ? JSON.parse(readFileSync(dump, "utf8")).pid as number | undefined : undefined);
    let promptsBefore = 0;
    let pidBefore: number | undefined;
    const prompted = () => dumpPid() === pidBefore ? promptCount() > promptsBefore : promptCount() > 0;
    return { instance, recorder, run, calls, prompted, dump };
  };
  afterEach(async () => {
    for (const entry of fixtures.splice(0)) {
      entry.recorder.stop();
      await entry.instance.dispose();
      await removeTempDir(entry.scratch);
    }
  });

  it("omission observes the agent default without sending an effort setter", async () => {
    const f = await fixture({ [model]: variantConfig(["none", "minimal", "high"]) });
    const { done, events } = await f.run();
    expect(done).toMatchObject({ ok: true });
    expect(f.calls()).toEqual([]);
    expect(f.instance.adapter.capabilities.modelVariants).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: "session.model-variants", model, variants: { options: [
        { id: "none", label: "none" }, { id: "minimal", label: "minimal" }, { id: "high", label: "high" },
      ], currentValue: "none" },
    }));
  });

  it.each(["minimal", "none", "default", "custom/Deep_mode"])("applies advertised opaque variant %s", async (variant) => {
    const f = await fixture({ [model]: variantConfig(["low", variant], "low", "thinking-depth") });
    expect((await f.run({ variant })).done).toMatchObject({ ok: true });
    expect(f.calls()).toEqual([{ method: "session/set_config_option", params: {
      sessionId: "fake-acp-session", configId: "thinking-depth", value: variant,
    } }]);
    expect(JSON.parse(readFileSync(`${f.dump}.selection.json`, "utf8"))).toMatchObject({ variant });
  });

  it.each(["none", "default"])("rejects unadvertised %s before any prompt", async (variant) => {
    const f = await fixture({ [model]: variantConfig(["minimal", "low", "high"]) });
    expect((await f.run({ variant })).done).toMatchObject({ ok: false });
    expect(f.prompted()).toBe(false);
    expect(f.calls()).toEqual([]);
  });

  it("allows a model without configurable reasoning, but rejects an explicit variant", async () => {
    const f = await fixture({});
    const first = await f.run();
    expect(first.done).toMatchObject({ ok: true });
    expect(first.events).toContainEqual(expect.objectContaining({ type: "session.model-variants", variants: { options: [] } }));
    expect((await f.run({ variant: "high" })).done).toMatchObject({ ok: false });
    expect(f.prompted()).toBe(false);
  });

  it("uses model-dependent grouped options returned by the model switch", async () => {
    const f = await fixture({
      [model]: variantConfig(["none", "low"]),
      [secondModel]: { id: "depth", currentValue: "minimal", options: [{ group: "Quality", options: [
        { value: "minimal", name: "Minimal" }, { value: "custom-deep", name: "Deep" },
      ] }] },
    });
    const { done, events } = await f.run({ model: secondModel, variant: "custom-deep" });
    expect(done).toMatchObject({ ok: true });
    expect(f.calls().map((entry) => entry.params)).toEqual([
      { sessionId: "fake-acp-session", configId: "model", value: secondModel },
      { sessionId: "fake-acp-session", configId: "depth", value: "custom-deep" },
    ]);
    expect(events.filter((event) => event.type === "session.model-variants").at(-1)).toMatchObject({
      model: secondModel, variants: { options: [{ id: "minimal", label: "Minimal" }, { id: "custom-deep", label: "Deep" }], currentValue: "custom-deep" },
    });
    expect((await f.run({ model: secondModel, variant: "none" })).done).toMatchObject({ ok: false });
    expect(f.prompted()).toBe(false);
  });

  it("reapplies an explicit choice on resume and targets only its native session", async () => {
    const f = await fixture({ [model]: variantConfig(["low", "high"]) });
    expect((await f.run({ variant: "high" })).done).toMatchObject({ ok: true });
    const { done, events } = await f.run({ threadId: "resumed-thread", resumeCursor: "native-resumed", variant: "high" });
    expect(done).toMatchObject({ ok: true, threadId: "resumed-thread" });
    expect(f.calls().map((entry) => entry.params)).toEqual([{ sessionId: "native-resumed", configId: "effort", value: "high" }]);
    expect(events.filter((event) => event.type === "session.model-variants").every((event) => event.threadId === "resumed-thread")).toBe(true);
  });

  it.each(["FAKE_ACP_VARIANT_STICKS", "FAKE_ACP_EMPTY_VARIANT_ACK"])("requires confirmation when %s", async (flag) => {
    const f = await fixture({ [model]: variantConfig(["low", "high"]) }, { [flag]: "1" });
    expect((await f.run({ variant: "high" })).done).toMatchObject({ ok: false });
    expect(f.prompted()).toBe(false);
  });

  it("keeps simultaneous conversations and their selected variants separate", async () => {
    const f = await fixture({ [model]: variantConfig(["low", "high"]) });
    const results = await Promise.all([
      f.run({ threadId: "conversation-a", resumeCursor: "native-a", variant: "high" }),
      f.run({ threadId: "conversation-b", resumeCursor: "native-b", variant: "low" }),
    ]);
    for (const [index, result] of results.entries()) {
      const threadId = index === 0 ? "conversation-a" : "conversation-b";
      expect(result.done).toMatchObject({ ok: true, threadId });
      expect(result.events.every((event) => event.threadId === threadId)).toBe(true);
      expect(result.events.filter((event) => event.type === "session.model-variants").at(-1)).toMatchObject({
        threadId, variants: { currentValue: index === 0 ? "high" : "low" },
      });
      expect(result.events.find((event) => event.type === "session.started")).toMatchObject({
        sessionId: index === 0 ? "native-a" : "native-b",
      });
    }
  });

  it("consumes preprompt config updates but ignores other sessions and replay", async () => {
    const updates = [
      { after: "session/new", configOptions: sessionOptions(["low", "high"], "high") },
      { after: "session/new", sessionId: "another-session", configOptions: sessionOptions(["foreign"]) },
      { after: "session/new", replay: true, configOptions: sessionOptions(["replayed"]) },
      { after: "session/prompt", configOptions: sessionOptions(["low", "high"], "low") },
    ];
    const f = await fixture({ [model]: variantConfig(["low", "high"]) }, { FAKE_ACP_CONFIG_UPDATES: JSON.stringify(updates) });
    const { done, events } = await f.run();
    expect(done).toMatchObject({ ok: true });
    const variants = events.filter((event) => event.type === "session.model-variants");
    expect(variants.map((event) => event.variants.currentValue)).toEqual(["low", "high", "low"]);
    expect(variants.every((event) => event.threadId === "variant-thread")).toBe(true);
  });

  it("does not overwrite a newer notification with the effort acknowledgement", async () => {
    const f = await fixture({ [model]: variantConfig(["low", "high"]) }, {
      FAKE_ACP_CONFIG_UPDATES: JSON.stringify([{ after: "effort", configOptions: sessionOptions(["low"], "low") }]),
    });
    expect((await f.run({ variant: "high" })).done).toMatchObject({ ok: false });
    expect(f.prompted()).toBe(false);
  });

  it("reports the picker alias while configuring the native OpenCode model", async () => {
    const native = "opencode-go/x-preview-f-free";
    const f = await fixture({ [native]: variantConfig(["low", "high"]) });
    const { done, events } = await f.run({ model: "opencode-go/ox-alpha-free", variant: "high" });
    expect(done).toMatchObject({ ok: true });
    expect(events.filter((event) => event.type === "session.model-variants").at(-1)).toMatchObject({ model: "opencode-go/ox-alpha-free" });
    expect(f.calls()[0].params.value).toBe(native);
  });
});
