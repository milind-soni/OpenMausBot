import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import {
  canRunOpenCode,
  catalogFromOpenCodeSession,
  classifyOpenCodeError,
  configuredOpenCodeFolderAction,
  createOpenCodeDriver,
  describeOpenCodeAccountError,
  discoverOpenCodeModels,
  openCodeOwnedDirectories,
  openCodeProviderKeysAllowed,
  openMausOwnsWorkingFolder,
  OPENCODE_PROVIDER_ENV,
  parseOpenCodeModelsOutput,
  preferredOpenCodeModel,
  resetOpenCodeModelCache,
  setOpenCodeProviderKeyPolicy,
} from "./opencode-go.ts";
import { ATTACHMENTS_DIR } from "../../attachments.ts";
import { cloudHomeConfigured } from "../../cloud-home.ts";
import { hostedWorkspaceConfigured } from "../../enterprise.ts";
import { TASK_WORKSPACES_DIR, workspaceDir } from "../../workspace.ts";
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
      "opencode/big-pickle",
      JSON.stringify({ name: "Big Pickle", status: "active", limit: { context: 1_000_000 }, cost: { input: 0, output: 0 } }, null, 2),
      "opencode-go/minimax-m3",
      JSON.stringify({ name: "MiniMax M3", status: "active" }, null, 2),
      "ollama/qwen3",
      JSON.stringify({ name: "Qwen 3", api: { url: "http://127.0.0.1:11434/v1" } }, null, 2),
      "lmstudio/qwen3-ipv6",
      JSON.stringify({ name: "Qwen 3 IPv6", api: { url: "http://[::1]:1234/v1" } }, null, 2),
      "opencode/retired",
      JSON.stringify({ name: "Retired", status: "deprecated" }, null, 2),
    ].join("\n"));

    // Zen's own price marks Big Pickle free; nothing is invented.
    expect(models?.default).toBe("opencode/big-pickle");
    expect(models?.options).toEqual([
      expect.objectContaining({ id: "openrouter/vendor/model-v2", label: "OpenRouter · Vendor Model" }),
      expect.objectContaining({
        id: "opencode/big-pickle",
        label: "Zen · Big Pickle",
        contextWindow: 1_000_000,
      }),
      expect.objectContaining({ id: "opencode-go/minimax-m3", label: "Go · MiniMax M3" }),
      expect.objectContaining({ id: "ollama/qwen3", custom: true, loaded: true }),
      expect.objectContaining({ id: "lmstudio/qwen3-ipv6", custom: true, loaded: true }),
    ]);
  });

  it("caches the setup check's catalog probe across snapshots", async () => {
    resetOpenCodeModelCache();
    const discover = vi.fn(async () => catalog("opencode/big-pickle"));

    await expect(canRunOpenCode({}, "counting-opencode", discover)).resolves.toBe(true);
    await expect(canRunOpenCode({}, "counting-opencode", discover)).resolves.toBe(true);

    expect(discover).toHaveBeenCalledOnce();
  });

  it("accepts header-only output from older CLIs and rejects malformed lines", () => {
    const models = parseOpenCodeModelsOutput([
      "Available models",
      "opencode/big-pickle",
      "bad model/with space",
      "openrouter/anthropic/claude-sonnet-5",
    ].join("\n"));

    expect(models?.options.map((option) => option.id)).toEqual([
      "opencode/big-pickle",
      "openrouter/anthropic/claude-sonnet-5",
    ]);
  });

  it("refreshes the same instance catalog on each explicit refresh", async () => {
    let calls = 0;
    const driver = createOpenCodeDriver(async () => {
      calls += 1;
      const id = calls === 1
        ? "opencode/big-pickle"
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

    expect(instance.models.default).toBe("opencode/big-pickle");
    expect(instance.models.options.some((option) => option.custom)).toBe(false);
    await instance.refreshModels?.();
    expect(instance.models.options.some((option) => option.id === "opencode-go/extra-two" && !option.custom)).toBe(true);
    await instance.refreshModels?.();
    expect(instance.models.options.some((option) => option.id === "openrouter/vendor/extra-three" && !option.custom)).toBe(true);
    await instance.dispose();
  });

  it("keeps the driver optional and declares the OpenCode CLI setup", () => {
    const driver = createOpenCodeDriver(async () => catalog("opencode/big-pickle"));
    expect(driver.driverKind).toBe("opencodeGo");
    expect(driver.metadata.displayName).toBe("OpenCode");
    expect(driver.decodeConfig(undefined)).toEqual({ cli: "opencode", fullAuto: false, workspace: undefined });
    expect(driver.install?.docsUrl).toContain("opencode.ai");
    expect(driver.install?.signInCommand).toBe("opencode auth login");
  });

  it("offers no invented model before OpenCode answers", () => {
    const driver = createOpenCodeDriver(async () => catalog("opencode/big-pickle"));
    expect(driver.models).toEqual({ default: "", options: [] });
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
    const driver = createOpenCodeDriver(async () => catalog("opencode/big-pickle"));
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
    const driver = createOpenCodeDriver(async () => catalog("opencode/big-pickle"));
    const instance = await driver.create({
      instanceId: "opencode-free",
      displayName: "OpenCode",
      environment: {
        HOME: scratch,
        USERPROFILE: scratch,
        XDG_DATA_HOME: join(scratch, "data"),
        FAKE_ACP_MODELS: "opencode/big-pickle",
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
    const driver = createOpenCodeDriver(async () => catalog("opencode/big-pickle"));
    const instance = await driver.create({
      instanceId: "opencode-zen-only",
      displayName: "OpenCode",
      environment: {
        XDG_DATA_HOME: scratch,
        OPENCODE_API_KEY: "",
        FAKE_ACP_MODELS: "opencode/big-pickle",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "t-opencode-zen-only",
        text: "hello",
        model: "opencode/big-pickle",
      });
      const done = await recorder.until((event) => event.type === "turn.completed");
      expect(done).toMatchObject({ ok: true });
      expect(recorder.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "session.started", model: "opencode/big-pickle" }),
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

  // The shapes the real CLI sends. Invalid key: recorded from opencode 1.18.27
  // (ACP, temp home, OPENCODE_API_KEY set to a bogus value, free big-pickle)
  // and 2.0.20 (paid default, same key). The funds text is the diagnosis run's
  // "Insufficient account funds" on a paid Zen model; the subscription text
  // is Zen Go's HTTP refusal. OpenCode wraps provider text the same way.
  const apiError = (message: string) => Object.assign(new Error(`${message} (session/prompt, service: session, APIError)`), {
    code: -32603, data: { service: "session", errorName: "APIError" },
  });
  it.each([
    ["Internal error: Invalid API key.", "invalid_credentials"],
    // OpenRouter's refusal of an unknown key, through opencode 1.18.27
    ["Internal error: User not found.", "invalid_credentials"],
    ["Internal error: Insufficient account funds.", "insufficient_funds"],
    ["Internal error: An active OpenCode Go subscription is required", "inactive_subscription"],
    ["Internal error: Monthly usage limit reached for this key", "quota_or_region_restriction"],
  ] as const)("classifies the real APIError %s", (message, expected) => {
    expect(classifyOpenCodeError(apiError(message))).toBe(expected);
  });

  // A plain rate limit is a transient 429: OpenCode retries it itself, and
  // automatic recovery may still route around it. Only a spent quota is the
  // account's to fix.
  it.each([
    "Internal error: Rate limit exceeded",
    "Internal error: Rate limit reached for model openai/gpt-4o-mini in organization org-x",
    "Internal error: 429 Too Many Requests: rate limit has been exceeded, retry in 20s",
  ])("leaves a transient rate limit unclassified: %s", (message) => {
    expect(classifyOpenCodeError(apiError(message))).toBeUndefined();
  });

  it("classifies OpenCode 2's authentication refusal and leaves real internal errors alone", () => {
    expect(classifyOpenCodeError({ code: -32000, message: "Authentication required: provider authentication required", data: {} }))
      .toBe("invalid_credentials");
    expect(classifyOpenCodeError(Object.assign(new Error("Internal error: OpenCode service failure"), {
      code: -32603, data: { details: "OpenCode service failure" },
    }))).toBeUndefined();
    expect(classifyOpenCodeError(apiError("Internal error: socket hang up"))).toBeUndefined();
  });

  // index.ts keeps only the first 160 characters of a chat error, so a fix
  // longer than that was cut mid-command. With provider keys and `opencode
  // auth login` the refusing account may not be Zen's.
  it.each(["invalid_credentials", "insufficient_funds", "inactive_subscription", "quota_or_region_restriction"] as const)(
    "words %s briefly and names the provider that refused",
    (code) => {
      for (const model of [undefined, "opencode/big-pickle", "opencode-go/minimax-m3", "openrouter/openai/gpt-4o-mini",
        "anthropic/claude-sonnet-5", `${"very-long-provider-name".repeat(4)}/model`]) {
        const text = describeOpenCodeAccountError(code, model);
        expect(text.length, `${code} ${model}`).toBeLessThanOrEqual(160);
        if (model?.startsWith("openrouter/")) {
          expect(text).toContain("OpenRouter");
          expect(text).not.toMatch(/Zen|OpenCode Go|Settings → Connections/u);
        }
        if (model?.startsWith("anthropic/")) expect(text).toContain("Anthropic");
      }
    },
  );

  it("points a rejected Zen key at the key OpenMaus saves", () => {
    expect(describeOpenCodeAccountError("invalid_credentials", "opencode/big-pickle")).toContain("Settings → Connections");
    expect(describeOpenCodeAccountError("insufficient_funds", "opencode/big-pickle")).toContain("Zen");
    expect(describeOpenCodeAccountError("inactive_subscription", "opencode-go/minimax-m3")).toContain("OpenCode Go subscription");
  });

  it("passes the person's provider keys through, as the CLI would see them", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-go-"));
    try {
      const dump = join(scratch, "env.json");
      const driver = createOpenCodeDriver(async () => catalog("opencode-go/minimax-m3"));
      const instance = await driver.create({
        instanceId: "opencode-go",
        displayName: "OpenCode",
        environment: {
          OPENCODE_API_KEY: "secret-value",
          OPENAI_API_KEY: "openai-shell-key",
          ANTHROPIC_API_KEY: "anthropic-shell-key",
          GEMINI_API_KEY: "gemini-shell-key",
          // OpenMaus's own saved keys for other engines never ride along.
          XAI_API_KEY: "saved-for-grok",
          MISTRAL_API_KEY: "saved-for-mistral",
          OMB_ANTHROPIC_API_KEY: "workspace-anthropic",
          FAKE_ACP_DUMP: dump,
        },
        enabled: true,
        config: { cli: FAKE_CLI, fullAuto: false },
      });
      await instance.snapshot();
      const child = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> };
      expect(child.env.OPENCODE_API_KEY).toBe("secret-value");
      expect(child.env.OPENAI_API_KEY).toBe("openai-shell-key");
      expect(child.env.ANTHROPIC_API_KEY).toBe("anthropic-shell-key");
      expect(child.env.GEMINI_API_KEY).toBe("gemini-shell-key");
      expect(child.env.XAI_API_KEY).toBeUndefined();
      expect(child.env.MISTRAL_API_KEY).toBeUndefined();
      expect(child.env.OMB_ANTHROPIC_API_KEY).toBeUndefined();
      await instance.dispose();
    } finally {
      await removeTempDir(scratch);
    }
  });

  it("allows provider keys only where the server's environment is one person's own", () => {
    const own = { cloudHome: false, hostedWorkspace: false, organisationManaged: false, sharedSignIn: false };
    expect(openCodeProviderKeysAllowed(own)).toBe(true);
    for (const key of Object.keys(own) as Array<keyof typeof own>) {
      expect(openCodeProviderKeysAllowed({ ...own, [key]: true }), key).toBe(false);
    }
  });

  // The first catalog probe runs inside registry.load at startup. Wired after
  // it, the policy did not apply to that probe; and a server whose sign-in
  // list lets others in would bill every member's OpenCode bot to the
  // operator's keys.
  it("is wired in index.ts before the first catalog probe, with the sign-in list", () => {
    const source = readFileSync(new URL("../../index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const wired = source.indexOf("setOpenCodeProviderKeyPolicy(openCodeKeysAllowed);");
    const firstLoad = source.indexOf("await registry.load(providerConfigs(), decorateHostedProvider);");
    expect(wired).toBeGreaterThan(0);
    expect(firstLoad).toBeGreaterThan(wired);
    expect(source.match(/setOpenCodeProviderKeyPolicy\(/g)).toHaveLength(1);
    const policy = source.slice(source.indexOf("const openCodeKeysAllowed = "), wired);
    expect(policy).toContain("sharedSignIn: sharedSignIn(signInAllowList())");
    expect(policy).toContain("cloudHome: Boolean(CLOUD_HOME)");
    expect(policy).toContain("hostedWorkspace: HOSTED_WORKSPACE");
    expect(policy).toContain("organisationManaged: openCodeOrganisationManaged()");
    expect(source).toContain("openCodeOrganisationManaged = () => managedPolicy.current() !== null || managedDesktop.enrolled();");
  });

  it("keeps provider keys out on a Cloud home or a managed desktop", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-managed-"));
    setOpenCodeProviderKeyPolicy(() => false);
    try {
      const dump = join(scratch, "env.json");
      const driver = createOpenCodeDriver(async () => catalog("opencode-go/minimax-m3"));
      const instance = await driver.create({
        instanceId: "opencode-managed",
        displayName: "OpenCode",
        environment: {
          OPENCODE_API_KEY: "secret-value",
          ...Object.fromEntries(OPENCODE_PROVIDER_ENV.map((key) => [key, `operator-${key}`])),
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
      expect(child.env.GEMINI_API_KEY).toBeUndefined();
      await instance.dispose();
    } finally {
      setOpenCodeProviderKeyPolicy(() => !cloudHomeConfigured() && !hostedWorkspaceConfigured());
      await removeTempDir(scratch);
    }
  });
});

describe("OpenCode catalog discovery from the ACP session", () => {
  afterEach(() => {
    resetOpenCodeModelCache();
    vi.unstubAllEnvs();
  });

  // Recorded from `opencode acp` session/new in empty temporary homes
  // (no key). V1 1.18.27 names models "OpenCode Zen/…", V2 2.0.20 "opencode/…".
  const V1_SESSION = { sessionId: "ses_v1", configOptions: [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: "opencode/big-pickle", options: [
      { value: "opencode/big-pickle", name: "OpenCode Zen/Big Pickle" },
      { value: "opencode/mimo-v2.5-free", name: "OpenCode Zen/MiMo V2.5 Free" },
      { value: "opencode/nemotron-3.5-lightning-free", name: "OpenCode Zen/Nemotron 3.5 Lightning Free" },
    ] },
    { id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "build" }] },
  ] };
  const V2_SESSION = { sessionId: "ses_v2", configOptions: [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: "opencode/longcat-2.5-preview-free", options: [
      { value: "opencode/big-pickle", name: "opencode/Big Pickle" },
      { value: "opencode/longcat-2.5-preview-free", name: "opencode/LongCat 2.5 Preview Free" },
    ] },
  ] };

  it("reads the session's own catalog on OpenCode 1 and 2", () => {
    expect(catalogFromOpenCodeSession(V1_SESSION)).toEqual({
      current: "opencode/big-pickle",
      options: [
        { id: "opencode/big-pickle", label: "Zen · Big Pickle" },
        { id: "opencode/mimo-v2.5-free", label: "Zen · MiMo V2.5 Free" },
        { id: "opencode/nemotron-3.5-lightning-free", label: "Zen · Nemotron 3.5 Lightning Free" },
      ],
    });
    expect(catalogFromOpenCodeSession(V2_SESSION)?.options[1]).toEqual({
      id: "opencode/longcat-2.5-preview-free", label: "Zen · LongCat 2.5 Preview Free",
    });
    expect(catalogFromOpenCodeSession({ configOptions: [] })).toBeNull();
  });

  it("prefers OpenCode's own pick when it is free, and a free model when it is not", () => {
    const offered = ["opencode/claude-sonnet-5-5", "opencode/big-pickle", "opencode/longcat-2.5-preview-free"];
    expect(preferredOpenCodeModel(offered, "opencode/longcat-2.5-preview-free")).toBe("opencode/longcat-2.5-preview-free");
    expect(preferredOpenCodeModel(offered, "opencode/claude-sonnet-5-5")).toBe("opencode/longcat-2.5-preview-free");
    // Zen's price (models --verbose) outranks the name.
    parseOpenCodeModelsOutput(["opencode/big-pickle", JSON.stringify({ cost: { input: 0, output: 0 } })].join("\n"));
    expect(preferredOpenCodeModel(offered, "opencode/big-pickle")).toBe("opencode/big-pickle");
    // Only the person's own paid providers: their pick stands.
    expect(preferredOpenCodeModel(["anthropic/claude-sonnet-5", "openai/gpt-6"], "openai/gpt-6")).toBe("openai/gpt-6");
    expect(preferredOpenCodeModel([], null)).toBe("");
  });

  it("builds the catalog from ACP and adds OpenCode 1's metadata", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-discover-"));
    try {
      const found = await discoverOpenCodeModels({
        ...process.env, HOME: scratch, FAKE_ACP_MODELS: "opencode/big-pickle,opencode-go/minimax-m3",
      }, FAKE_CLI);
      expect(found.options.map((option) => option.id)).toEqual(["opencode/big-pickle", "opencode-go/minimax-m3"]);
      // context windows come from `models --verbose`
      expect(found.options[0]).toMatchObject({ contextWindow: 200_000 });
    } finally {
      await removeTempDir(scratch);
    }
  });

  it("reads OpenCode 1's metadata again when a first run in a new home loses the database race", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-discover-race-"));
    try {
      const found = await discoverOpenCodeModels({
        ...process.env, HOME: scratch, FAKE_ACP_MODELS: "opencode/big-pickle",
        FAKE_ACP_VERBOSE_FAIL_ONCE: join(scratch, "failed-once"),
      }, FAKE_CLI);
      expect(existsSync(join(scratch, "failed-once"))).toBe(true);
      expect(found.options[0]).toMatchObject({ id: "opencode/big-pickle", contextWindow: 200_000 });
    } finally {
      await removeTempDir(scratch);
    }
  });

  // OpenCode 2 rejects `models --verbose`; before, that left the picker on
  // the invented, dead x-preview-f-free.
  it("still lists every model on OpenCode 2, where models --verbose fails", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-discover-v2-"));
    try {
      const found = await discoverOpenCodeModels({
        ...process.env, HOME: scratch, FAKE_ACP_MODELS_LIST: "v2",
        FAKE_ACP_MODELS: "opencode/claude-sonnet-5-5,opencode/longcat-2.5-preview-free",
      }, FAKE_CLI);
      expect(found.options.map((option) => option.id)).toEqual(["opencode/claude-sonnet-5-5", "opencode/longcat-2.5-preview-free"]);
      expect(found.default).toBe("opencode/longcat-2.5-preview-free");
    } finally {
      await removeTempDir(scratch);
    }
  });

  it("offers nothing rather than an invented id when OpenCode cannot answer", async () => {
    await expect(discoverOpenCodeModels({ ...process.env }, join(tmpdir(), "no-such-opencode-binary"))).resolves.toEqual({
      default: "", options: [],
    });
  });
});

describe("OpenCode turns without a sign-in gate", () => {
  const fixtures: Array<{ scratch: string; instance: ProviderInstance; recorder: EventRecorder }> = [];
  afterEach(async () => {
    for (const entry of fixtures.splice(0)) {
      entry.recorder.stop();
      await entry.instance.dispose();
      await removeTempDir(entry.scratch);
    }
    resetOpenCodeModelCache();
  });
  const open = async (instanceId: string, environmentFor: (scratch: string) => Record<string, string>) => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-gate-"));
    const environment = environmentFor(scratch);
    const driver = createOpenCodeDriver(async () => ({ default: "", options: [] }));
    const instance = await driver.create({
      instanceId, displayName: "OpenCode", enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: scratch },
      environment: {
        HOME: scratch, USERPROFILE: scratch, XDG_CONFIG_HOME: scratch, XDG_DATA_HOME: join(scratch, "data"),
        FAKE_ACP_LAUNCH_COUNT_FILE: join(scratch, "launches"), ...environment,
      },
    });
    const recorder = recordEvents(instance.adapter);
    fixtures.push({ scratch, instance, recorder });
    const launches = () => Number(readFileSync(join(scratch, "launches"), "utf8"));
    const run = async (threadId: string, model?: string) => {
      const { turnId } = await instance.adapter.sendTurn({ threadId, text: "hello", ...(model ? { model } : {}) });
      const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      return { done, events: recorder.events.filter((event) => event.turnId === turnId) };
    };
    return { scratch, run, launches };
  };

  // OpenCode 2's plain `models` answers an empty list right after its
  // background service starts. The old pre-spawn check read that as "no
  // usable models" and refused every anonymous turn for 30 s.
  it("runs an anonymous free-model turn even when `opencode models` answers nothing", async () => {
    const f = await open("opencode-anonymous", () => ({
      FAKE_ACP_MODELS_LIST: "v2", FAKE_ACP_MODELS: "opencode/longcat-2.5-preview-free",
    }));
    const { done, events } = await f.run("t-anonymous", "opencode/longcat-2.5-preview-free");
    expect(done).toMatchObject({ ok: true });
    expect(events.some((event) => event.type === "runtime.error")).toBe(false);
  });

  it("shows a fix-your-key card for a rejected key and keeps the process for the retry", async () => {
    const f = await open("opencode-bad-key", (scratch) => ({
      OPENCODE_API_KEY: "sk-bogus", FAKE_ACP_MODELS: "opencode/big-pickle", FAKE_ACP_RPC_FAILURE_FILE: join(scratch, "failure.json"),
    }));
    // recorded from opencode 1.18.27 with a bogus OPENCODE_API_KEY
    writeFileSync(join(f.scratch, "failure.json"), JSON.stringify({
      code: -32603, message: "Internal error: Invalid API key.", data: { service: "session", errorName: "APIError" },
    }));
    for (const attempt of [1, 2]) {
      const { done, events } = await f.run("t-bad-key", "opencode/big-pickle");
      expect(done, `attempt ${attempt}`).toMatchObject({ ok: false, stopReason: "auth_required" });
      const error = events.find((event) => event.type === "runtime.error");
      expect(error).toMatchObject({ setup: true, message: expect.stringContaining("Settings → Connections") });
      expect(error).not.toMatchObject({ message: expect.stringContaining("Internal error") });
    }
    // the retry reused the warm process instead of cold-starting OpenCode
    expect(f.launches()).toBe(1);
  });
});

// Measured on opencode 1.18.27: after `opencode auth login` and a model
// refresh, a conversation's pooled `opencode acp` still listed its old 7
// models, and the fallback ran big-pickle while saying the new OpenRouter
// model was "no longer offered".
describe("OpenCode after a login added since its process started", () => {
  const added = "openrouter/openai/gpt-4o-mini";
  const fixtures: Array<{ scratch: string; instance: ProviderInstance; recorder: EventRecorder }> = [];
  afterEach(async () => {
    for (const entry of fixtures.splice(0)) {
      entry.recorder.stop();
      await entry.instance.dispose();
      await removeTempDir(entry.scratch);
    }
    resetOpenCodeModelCache();
  });
  const open = async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-login-"));
    const modelsFile = join(scratch, "models");
    writeFileSync(modelsFile, "opencode/big-pickle");
    // the instance catalog already lists the new model (refreshed after login)
    const driver = createOpenCodeDriver(async () => catalog("opencode/big-pickle", added));
    const instance = await driver.create({
      instanceId: "opencode-login", displayName: "OpenCode", enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: scratch },
      environment: {
        HOME: scratch, USERPROFILE: scratch, XDG_CONFIG_HOME: scratch, XDG_DATA_HOME: join(scratch, "data"),
        FAKE_ACP_MODELS_FILE: modelsFile, FAKE_ACP_LAUNCH_COUNT_FILE: join(scratch, "launches"),
        FAKE_ACP_RPC_APPEND_FILE: join(scratch, "rpc.jsonl"),
      },
    });
    const recorder = recordEvents(instance.adapter);
    fixtures.push({ scratch, instance, recorder });
    const run = async (model: string) => {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "t-login", text: "hello", model });
      const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      return { done, events: recorder.events.filter((event) => event.turnId === turnId) };
    };
    const launches = () => Number(readFileSync(join(scratch, "launches"), "utf8"));
    const prompts = () => readFileSync(join(scratch, "rpc.jsonl"), "utf8").trim().split("\n")
      .filter((line) => (JSON.parse(line) as { method: string }).method === "session/prompt").length;
    const login = () => {
      writeFileSync(modelsFile, `opencode/big-pickle,${added}`);
      mkdirSync(join(scratch, "data", "opencode"), { recursive: true });
      writeFileSync(join(scratch, "data", "opencode", "auth.json"), JSON.stringify({ openrouter: { type: "api", key: "sk-or-fixture" } }));
    };
    return { run, launches, prompts, login, modelsFile };
  };

  it("starts a fresh process once OpenCode's logins change, and runs the new model", async () => {
    const f = await open();
    expect((await f.run("opencode/big-pickle")).done).toMatchObject({ ok: true });
    f.login();
    const { done, events } = await f.run(added);
    expect(done).toMatchObject({ ok: true });
    expect(events.some((event) => event.type === "runtime.notice")).toBe(false);
    expect(events.find((event) => event.type === "session.started")).toMatchObject({ model: added });
    expect(f.launches()).toBe(2);
  });

  it("never swaps a model the catalog lists for another one, and retries on a fresh process", async () => {
    const f = await open();
    expect((await f.run("opencode/big-pickle")).done).toMatchObject({ ok: true });
    // the provider arrived some other way (no auth.json change): the pooled
    // process cannot know it
    writeFileSync(f.modelsFile, `opencode/big-pickle,${added}`);
    const stale = await f.run(added);
    expect(stale.done).toMatchObject({ ok: false });
    expect(stale.events.some((event) => event.type === "runtime.notice")).toBe(false);
    expect(stale.events.find((event) => event.type === "runtime.error")).toMatchObject({ message: expect.stringContaining(added) });
    // nothing ran: the only prompt so far is the first turn's
    expect(f.prompts()).toBe(1);
    const retry = await f.run(added);
    expect(retry.done).toMatchObject({ ok: true });
    expect(f.launches()).toBe(2);
  });
});

describe("OpenCode catalog probes", () => {
  afterEach(() => resetOpenCodeModelCache());

  // A probe in a folder outside git lands in OpenCode's global project, so
  // `opencode run --continue` in any other such folder resumed it (checked on
  // 1.18.27: an own-repo folder keeps its sessions out of that list).
  it("runs in a folder that is its own git project", async () => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
    } catch {
      return;
    }
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-probe-folder-"));
    try {
      const rpc = join(scratch, "rpc.jsonl");
      await discoverOpenCodeModels({ ...process.env, HOME: scratch, FAKE_ACP_MODELS: "opencode/big-pickle", FAKE_ACP_RPC_APPEND_FILE: rpc }, FAKE_CLI);
      const folder = (readFileSync(rpc, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; cwd: string })
        .find((entry) => entry.method === "session/new"))!.cwd;
      const root = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: folder, encoding: "utf8" }).trim();
      expect(root).toMatch(/^[0-9a-f]{40,64}$/u);
      // .native on both sides: git prints Windows' long path, while the temp
      // folder can arrive as its 8.3 short name (C:\Users\RUNNER~1\…), which
      // only the native resolver expands
      expect(realpathSync.native(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: folder, encoding: "utf8" }).trim()))
        .toBe(realpathSync.native(folder));
      // once: a second probe keeps the same project
      resetOpenCodeModelCache();
      await discoverOpenCodeModels({ ...process.env, HOME: scratch, FAKE_ACP_MODELS: "opencode/big-pickle" }, FAKE_CLI);
      expect(execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: folder, encoding: "utf8" }).trim()).toBe(root);
    } finally {
      await removeTempDir(scratch);
    }
  });
});

describe("OpenCode access to folders OpenMaus owns", () => {
  it("names the attachments folder and only this bot's shared folder", () => {
    expect(openCodeOwnedDirectories("bot-7")).toEqual([ATTACHMENTS_DIR, workspaceDir("bot-7")]);
    expect(openCodeOwnedDirectories("..")).toEqual([ATTACHMENTS_DIR]);
    expect(openCodeOwnedDirectories("../other")).toEqual([ATTACHMENTS_DIR]);
    expect(openCodeOwnedDirectories()).toEqual([ATTACHMENTS_DIR]);
  });

  // OpenCode loads opencode.json, .opencode/ and AGENTS.md from every folder
  // above its working folder. Measured on 1.18.27: an Ask-mode turn allowed
  // into task-workspaces/<bot> wrote an opencode.json there allowing every
  // folder, and the bot's next conversation then read $HOME with no card.
  it.each([
    ["a conversation's own folder", join(TASK_WORKSPACES_DIR, "bot-7", "thread-1")],
    ["the bot's shared folder (a room's)", workspaceDir("bot-7")],
    ["a folder inside the shared one", join(workspaceDir("bot-7"), "memory")],
    ["the attachments folder", ATTACHMENTS_DIR],
    ["OpenMaus's data folder", dirname(ATTACHMENTS_DIR)],
    ["a project folder", join(tmpdir(), "project")],
  ])("never allows the working folder or a folder above it: %s", (_label, cwd) => {
    const inside = (path: string, folder: string) => {
      const rest = relative(folder, path);
      return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
    };
    const allowed = openCodeOwnedDirectories("bot-7", cwd);
    for (const directory of allowed) expect(inside(cwd, directory), directory).toBe(false);
    // earlier conversations are never on the list: their parent sits above
    // every conversation's working folder
    expect(allowed).not.toContain(join(TASK_WORKSPACES_DIR, "bot-7"));
  });

  it("switches off project config only in OpenMaus's own working folders", () => {
    expect(openMausOwnsWorkingFolder(join(TASK_WORKSPACES_DIR, "bot-7", "thread-1"))).toBe(true);
    expect(openMausOwnsWorkingFolder(workspaceDir("bot-7"))).toBe(true);
    expect(openMausOwnsWorkingFolder(TASK_WORKSPACES_DIR)).toBe(false);
    expect(openMausOwnsWorkingFolder(join(tmpdir(), "project"))).toBe(false);
    expect(openMausOwnsWorkingFolder(`${TASK_WORKSPACES_DIR}-elsewhere`)).toBe(false);
  });

  // OpenCode merges OPENCODE_PERMISSION over the person's config and an
  // object replaces a string (checked with `opencode debug config` on
  // 1.18.27), so OpenMaus's folder map turned their "deny" into "ask".
  it("keeps the person's single folder rule ahead of OpenMaus's folders", () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-folder-rule-"));
    try {
      const configDir = join(scratch, "config", "opencode");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "opencode.jsonc"), [
        "{",
        "  // the person's own rule",
        '  "permission": { "external_directory": "deny", /* no folders */ "bash": "ask", },',
        "}",
      ].join("\n"));
      const env = { HOME: scratch, XDG_CONFIG_HOME: join(scratch, "config") };
      const project = join(scratch, "project", "src");
      mkdirSync(project, { recursive: true });
      expect(configuredOpenCodeFolderAction(env, project, true)).toBe("deny");
      // a project map replaces the string, exactly as in OpenCode
      writeFileSync(join(scratch, "project", "opencode.json"), JSON.stringify({ permission: { external_directory: { "/srv/*": "allow" } } }));
      expect(configuredOpenCodeFolderAction(env, project, true)).toBeUndefined();
      // unless project config is off
      expect(configuredOpenCodeFolderAction(env, project, false)).toBe("deny");
      expect(configuredOpenCodeFolderAction({ ...env, OPENCODE_CONFIG_CONTENT: '{"permission":{"external_directory":"ask"}}' }, project, false)).toBe("ask");
    } finally {
      void removeTempDir(scratch);
    }
  });

  it("carries the person's deny into a turn's folder policy", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-deny-"));
    const dump = join(scratch, "env.json");
    mkdirSync(join(scratch, "opencode"), { recursive: true });
    writeFileSync(join(scratch, "opencode", "opencode.json"), JSON.stringify({ permission: { external_directory: "deny" } }));
    const driver = createOpenCodeDriver(async () => catalog("opencode/big-pickle"));
    const instance = await driver.create({
      instanceId: "opencode-deny", displayName: "OpenCode", enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: scratch },
      environment: { HOME: scratch, XDG_CONFIG_HOME: scratch, XDG_DATA_HOME: scratch, FAKE_ACP_MODELS: "opencode/big-pickle", FAKE_ACP_DUMP: dump },
    });
    const recorder = recordEvents(instance.adapter);
    const cwd = join(TASK_WORKSPACES_DIR, "bot-7", "thread-deny");
    mkdirSync(cwd, { recursive: true });
    try {
      await instance.adapter.sendTurn({ threadId: "t-deny", botId: "bot-7", text: "hi", model: "opencode/big-pickle", approvalMode: "ask", cwd });
      expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
      const env = (JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> }).env;
      expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
      expect(Object.entries(JSON.parse(env.OPENCODE_PERMISSION).external_directory)).toEqual([
        ["*", "deny"],
        ...openCodeOwnedDirectories("bot-7", cwd).flatMap((directory) => [[directory, "allow"], [join(directory, "*"), "allow"]]),
      ]);
    } finally {
      recorder.stop();
      await instance.dispose();
      await removeTempDir(cwd);
      await removeTempDir(scratch);
    }
  });

  it.each([["ask", false], ["full", true]] as const)("sets OpenCode's folder policy for %s turns", async (approvalMode, full) => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-permission-"));
    const dump = join(scratch, "env.json");
    const driver = createOpenCodeDriver(async () => catalog("opencode/big-pickle"));
    const instance = await driver.create({
      instanceId: `opencode-permission-${approvalMode}`, displayName: "OpenCode", enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: scratch },
      environment: {
        HOME: scratch, XDG_CONFIG_HOME: scratch, XDG_DATA_HOME: scratch,
        FAKE_ACP_MODELS: "opencode/big-pickle", FAKE_ACP_DUMP: dump,
        OPENCODE_PERMISSION: JSON.stringify({ bash: "ask", external_directory: { "/srv/shared/*": "deny" } }),
      },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t-permission", botId: "bot-7", text: "read the attachment", model: "opencode/big-pickle", approvalMode });
      expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
      const policy = JSON.parse((JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> }).env.OPENCODE_PERMISSION);
      if (full) {
        expect(policy).toMatchObject({ "*": "allow", external_directory: "allow" });
        return;
      }
      // the person's own rules stay, first; OpenMaus's folders are allowed
      // after them; nothing else is widened. A project folder of the
      // person's keeps its own OpenCode config.
      expect(JSON.parse(readFileSync(dump, "utf8")).env.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined();
      expect(policy.bash).toBe("ask");
      expect(Object.entries(policy.external_directory)).toEqual([
        ["/srv/shared/*", "deny"],
        ...openCodeOwnedDirectories("bot-7").flatMap((directory) => [[directory, "allow"], [join(directory, "*"), "allow"]]),
      ]);
    } finally {
      recorder.stop();
      await instance.dispose();
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
    const driver = createOpenCodeDriver(async () => catalog(model, secondModel, plainModel));
    const instance = await driver.create({
      instanceId: "opencode-variant-test", displayName: "OpenCode", enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: scratch },
      environment: {
        HOME: scratch, XDG_CONFIG_HOME: scratch, XDG_DATA_HOME: scratch,
        OPENCODE_API_KEY: "fixture-key", FAKE_ACP_MODELS: [model, secondModel, plainModel].join(","),
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

  // Zen retired x-preview-f-free (and the Ox Alpha preview before it);
  // OpenCode answers -32602 "model not found", so a bot that saved it failed
  // every turn in about half a second.
  it.each(["opencode/x-preview-f-free", "opencode-go/ox-alpha-free"])(
    "runs a retired saved model %s on the catalog default and says so once",
    async (retired) => {
      const f = await fixture({ [model]: variantConfig(["low", "high"]) });
      const first = await f.run({ model: retired, variant: "high" });
      expect(first.done).toMatchObject({ ok: true });
      const notices = first.events.filter((event) => event.type === "runtime.notice");
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ message: expect.stringContaining(retired) });
      expect(notices[0]).toMatchObject({ message: expect.stringContaining(model) });
      expect(first.events.find((event) => event.type === "session.started")).toMatchObject({ model });
      expect(first.events.filter((event) => event.type === "session.model-variants").at(-1)).toMatchObject({ model });
      // Already on the default and the saved variant belonged to the retired
      // model: neither the model nor the effort is touched.
      expect(f.calls()).toEqual([]);

      const second = await f.run({ model: retired });
      expect(second.done).toMatchObject({ ok: true });
      expect(second.events.some((event) => event.type === "runtime.notice")).toBe(false);
    },
  );

  // The app hid an unprefixed notice with the tool steps (Tool calls is off
  // by default); `notice:` makes it a status row (src/lib/activity-runs.ts).
  it("is stored as a status row the person always sees", () => {
    const source = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    const handler = source.slice(source.indexOf('case "runtime.notice":'), source.indexOf('case "runtime.error":'));
    expect(handler).toContain("name: `notice: ${event.message.slice(0, 240)}`");
  });

  it("still switches to a model the session offers", async () => {
    const f = await fixture({});
    expect((await f.run({ model: secondModel })).done).toMatchObject({ ok: true });
    expect(f.calls().map((entry) => entry.params)).toEqual([{ sessionId: "fake-acp-session", configId: "model", value: secondModel }]);
  });
});

describe("OpenCode model choice without a saved model", () => {
  const fixtures: Array<{ scratch: string; instance: ProviderInstance; recorder: EventRecorder }> = [];
  afterEach(async () => {
    for (const entry of fixtures.splice(0)) {
      entry.recorder.stop();
      await entry.instance.dispose();
      await removeTempDir(entry.scratch);
    }
    resetOpenCodeModelCache();
  });

  // OpenCode 2 with a key starts every session on a paid model (measured:
  // opencode/claude-sonnet-5-5 on 2.0.20). An empty pick must not bill.
  it("runs a free model, not OpenCode's own paid default", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-paid-default-"));
    const dump = join(scratch, "rpc");
    const driver = createOpenCodeDriver(async () => ({ default: "", options: [] }));
    const instance = await driver.create({
      instanceId: "opencode-paid-default", displayName: "OpenCode", enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: scratch },
      environment: {
        HOME: scratch, XDG_CONFIG_HOME: scratch, XDG_DATA_HOME: scratch, OPENCODE_API_KEY: "fixture-key",
        FAKE_ACP_MODELS: "opencode/claude-sonnet-5-5,opencode/longcat-2.5-preview-free", FAKE_ACP_DUMP: dump,
      },
    });
    const recorder = recordEvents(instance.adapter);
    fixtures.push({ scratch, instance, recorder });
    await instance.adapter.sendTurn({ threadId: "t-no-model", text: "hello" });
    expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events.find((event) => event.type === "session.started")).toMatchObject({
      model: "opencode/longcat-2.5-preview-free",
    });
    expect(recorder.events.some((event) => event.type === "runtime.notice")).toBe(false);
    expect(JSON.parse(readFileSync(`${dump}.config.json`, "utf8"))).toEqual([{
      method: "session/set_config_option",
      params: { sessionId: "fake-acp-session", configId: "model", value: "opencode/longcat-2.5-preview-free" },
    }]);
  });
});
