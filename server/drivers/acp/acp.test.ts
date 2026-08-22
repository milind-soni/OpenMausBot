// ACP driver contract tests, run against the scripted fake ACP CLI in
// server/testing/fake-acp-cli.ts. Covers the shared acp/core.ts runtime via
// its two harness shims (grok = fail-closed auth, gemini = lenient auth):
// normalize the ACP handshake into canonical events, keep argv/env hygiene,
// broker permission asks, and settle interrupts/crashes cleanly.
//
// The fake CLI is a shebang script Windows cannot exec directly —
// resolveCliSpawn turns it into `node <script>`, so these run everywhere.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { GrokAgentDriver } from "./grok.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import { KimiAgentDriver } from "./kimi.ts";
import { DroidAgentDriver } from "./droid.ts";
import { __catalogTestHooks, discoverCatalog, OpenCodeAgentDriver, parseModels, permissionEnv } from "./opencode.ts";
import { CursorAgentDriver } from "./cursor.ts";
import { removeTempDir } from "../../testing/cleanup.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

/** A harness that exists only in tests: it exercises the opt-in session-config
 *  model hook so PR 1 can prove the core capability without shipping a visible
 *  engine. Real harnesses live in their own file. */
const SELECT_MODEL_SUPPORT: AcpSupport = {
  driverKind: "selectModelTest",
  displayName: "Select Model Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }, { id: "m-two", label: "Two" }] },
  defaultCli: "fake-select-model",
  nativeSource: "test.acp",
  loginNote: "never reached",
  selectModel: { configId: "model" },
  spawnArgs: () => [],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
};
const SelectModelDriver = createAcpDriver(SELECT_MODEL_SUPPORT);

/** Proves transformEnv can vary with the instance config, which is how the
 *  opencode driver picks its permission policy from `fullAuto`. */
const EnvPolicyDriver = createAcpDriver({
  ...SELECT_MODEL_SUPPORT,
  driverKind: "envPolicyTest",
  selectModel: undefined,
  transformEnv: (env, config) => {
    env.TEST_POLICY = config.fullAuto ? "auto" : "ask";
  },
});

/** Proves snapshot() awaits an async isAuthenticated, which is how the
 *  opencode driver answers from a discovered catalog. */
const AsyncAuthDriver = createAcpDriver({
  ...SELECT_MODEL_SUPPORT,
  driverKind: "asyncAuthTest",
  selectModel: undefined,
  isAuthenticated: async () => true,
});

const ClassifiedErrorDriver = createAcpDriver({
  ...SELECT_MODEL_SUPPORT,
  driverKind: "classifiedErrorTest",
  selectModel: undefined,
  classifyError: (error) =>
    error && typeof error === "object" && (error as { code?: unknown }).code === -32000
      ? "invalid_credentials"
      : undefined,
});

describe("ACP decodeConfig", () => {
  it("resolves a dynamic model catalog when a support provides one", async () => {
    const support: AcpSupport = {
      driverKind: "dynamic-test",
      displayName: "Dynamic Test",
      models: { default: "fallback", options: [{ id: "fallback", label: "Fallback" }] },
      defaultCli: FAKE_CLI,
      nativeSource: "dynamic-test.acp",
      loginNote: "not authenticated",
      spawnArgs: () => [],
      pickAuthMethod: () => null,
      authFailure: "continue",
      isAuthenticated: () => true,
      resolveModels: async () => ({
        default: "dynamic-model",
        options: [{ id: "dynamic-model", label: "Dynamic model" }],
      }),
    };
    const driver = createAcpDriver(support);
    const instance = await driver.create({
      instanceId: "dynamic-test",
      displayName: "Dynamic Test",
      environment: {},
      enabled: true,
      config: driver.defaultConfig(),
    });
    expect(instance.models).toEqual({
      default: "dynamic-model",
      options: [{ id: "dynamic-model", label: "Dynamic model" }],
    });
    await instance.dispose();
  });
  it("grok defaults to the grok binary", () => {
    expect(GrokAgentDriver.decodeConfig({})).toEqual({ cli: "grok", fullAuto: false, workspace: undefined });
  });
  it("gemini defaults to the gemini binary", () => {
    expect(GeminiAgentDriver.decodeConfig(undefined)).toEqual({ cli: "gemini", fullAuto: false, workspace: undefined });
  });
  it("kimi defaults to the kimi binary and declares cross-platform setup", () => {
    expect(KimiAgentDriver.decodeConfig(undefined)).toEqual({ cli: "kimi", fullAuto: false, workspace: undefined });
    expect(KimiAgentDriver.install?.command).toMatchObject({
      darwin: expect.stringContaining("install.sh"),
      linux: expect.stringContaining("install.sh"),
      win32: expect.stringContaining("install.ps1"),
    });
    expect(KimiAgentDriver.install?.signInCommand).toBe("kimi login");
  });
  it("droid defaults to the droid binary and declares cross-platform setup", () => {
    expect(DroidAgentDriver.decodeConfig(undefined)).toEqual({ cli: "droid", fullAuto: false, workspace: undefined });
    expect(DroidAgentDriver.install?.command).toMatchObject({
      darwin: expect.stringContaining("factory.ai/cli"),
      linux: expect.stringContaining("factory.ai/cli"),
      win32: expect.stringContaining("factory.ai/cli"),
    });
    expect(DroidAgentDriver.install?.signInCommand).toBe("droid");
  });
  it("opencode defaults to the opencode binary and declares cross-platform setup", () => {
    expect(OpenCodeAgentDriver.decodeConfig(undefined)).toEqual({
      cli: "opencode",
      fullAuto: false,
      workspace: undefined,
    });
    expect(OpenCodeAgentDriver.install?.command).toMatchObject({
      darwin: expect.stringContaining("opencode.ai/install"),
      linux: expect.stringContaining("opencode.ai/install"),
      win32: expect.stringContaining("opencode-ai"),
    });
    expect(OpenCodeAgentDriver.install?.signInCommand).toBe("opencode auth login");
  });
  it("cursor defaults to its unambiguous binary and declares cross-platform setup", () => {
    expect(CursorAgentDriver.decodeConfig(undefined)).toEqual({
      cli: "cursor-agent",
      fullAuto: false,
      workspace: undefined,
    });
    expect(CursorAgentDriver.install?.command).toMatchObject({
      darwin: expect.stringContaining("cursor.com/install"),
      linux: expect.stringContaining("cursor.com/install"),
      win32: expect.stringContaining("cursor.com/install"),
    });
    expect(CursorAgentDriver.install?.signInCommand).toBe("cursor-agent login");
  });
  it("fullAuto only when explicitly true", () => {
    expect(GrokAgentDriver.decodeConfig({ fullAuto: "yes" }).fullAuto).toBe(false);
    expect(GrokAgentDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
  });

  it("does not advertise or accept local CUA in full-auto mode", async () => {
    const fullAuto = await GrokAgentDriver.create({
      instanceId: "grok-full-auto",
      displayName: "Grok Full Auto",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    expect(fullAuto.adapter.capabilities.localComputerMcp).toBe(false);
    await expect(
      fullAuto.adapter.sendTurn({
        threadId: "t-full-auto-local",
        text: "click",
        integrations: {
          localComputer: {
            command: "/cua-driver",
            args: ["mcp"],
            env: {},
            platform: "linux",
            scope: "local-computer",
          },
        },
      }),
    ).rejects.toThrow(/interactive provider approvals/);
    await fullAuto.dispose();
  });
});

describe("ACP turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (driver = GrokAgentDriver, mode?: string) => {
    if (mode) process.env.FAKE_ACP_MODE = mode;
    instance = await driver.create({
      instanceId: "acp-test",
      displayName: "ACP Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-acp-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.XAI_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_AUTH_TOKEN;
    delete process.env.BOX_TOKEN;
    delete process.env.OMB_TTS_KEY;
    delete process.env.FAKE_ACP_MODELS;
    delete process.env.FAKE_ACP_MODEL_STICKS;
    delete process.env.FAKE_ACP_USAGE_ROOT;
    delete process.env.OPENCODE_PERMISSION;
    delete process.env.OPENCODE_CONFIG;
    delete process.env.OPENCODE_CONFIG_DIR;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("normalizes a full turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi", model: "grok-4.5" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.started", // tool tc-1
      "item.completed", // tool tc-1 done
      "thread.token-usage.updated",
      "item.completed", // assistant_text (summed) on settle
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "grokAgent")).toBe(true);
    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated")!;
    expect(usage).toMatchObject({ input: 10, output: 5 });
    const text = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text")!;
    expect((text as any).text).toBe("hello from fake acp");
    const done = recorder.events.at(-1)!;
    expect(done).toMatchObject({ type: "turn.completed", ok: true });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("reads token usage from the root of the prompt result", async () => {
    process.env.FAKE_ACP_USAGE_ROOT = "1";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-usage-root", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated");
    expect(usage).toMatchObject({ input: 10, output: 5 });
  });

  it("passes ACP stdio flags and strips foreign provider keys from the child env", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.XAI_API_KEY = "xai-should-not-leak";
    process.env.OPENCODE_API_KEY = "opencode-should-not-leak";
    process.env.CURSOR_API_KEY = "cursor-should-not-leak";
    process.env.CURSOR_AUTH_TOKEN = "cursor-token-should-not-leak";
    // workspace credentials with no CLI consumer at all — held by the
    // harness (env-injected at boot by the desktop shell), used in-process
    process.env.BOX_TOKEN = "box-should-not-leak";
    process.env.OMB_TTS_KEY = "tts-should-not-leak";

    await instance.adapter.sendTurn({ threadId: "t-hygiene", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("agent");
    expect(seen.argv).toContain("stdio");
    expect(seen.argv).toContain("--permission-mode");
    expect(seen.env.XAI_API_KEY).toBeUndefined();
    expect(seen.env.OPENCODE_API_KEY).toBeUndefined();
    expect(seen.env.CURSOR_API_KEY).toBeUndefined();
    expect(seen.env.CURSOR_AUTH_TOKEN).toBeUndefined();
    expect(seen.env.BOX_TOKEN).toBeUndefined();
    expect(seen.env.OMB_TTS_KEY).toBeUndefined();
  });

  // ACP session/new accepts stdio MCP entries, so connected apps use the
  // same harness-owned bridge as Claude and Codex.
  it("mounts connected apps as a stdio MCP server", async () => {
    await create();
    const dump = join(scratch, "composio.json");
    process.env.FAKE_ACP_DUMP = dump;
    expect(instance.adapter.capabilities.composioMcp).toBe(true);
    await instance.adapter.sendTurn({
      threadId: "t-composio",
      text: "go",
      integrations: {
        composio: {
          command: process.execPath,
          args: ["/tmp/connector-proxy.js"],
          env: { OMB_CONNECTOR_UPSTREAM_URL: "http://127.0.0.1:8799/api/internal/connectors/mcp" },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    expect(JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8"))).toContainEqual({
      name: "composio",
      command: process.execPath,
      args: ["/tmp/connector-proxy.js"],
      env: [{ name: "OMB_CONNECTOR_UPSTREAM_URL", value: "http://127.0.0.1:8799/api/internal/connectors/mcp" }],
    });
  });

  it("droid takes model and autonomy over the wire, never through argv", async () => {
    // `droid exec -m <id> -o acp` ignores the flag (verified against 0.196.0),
    // so a model that only reached argv would silently run the CLI's own pick.
    instance = await DroidAgentDriver.create({
      instanceId: "droid-test",
      displayName: "Droid Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    const dump = join(scratch, "droid-dump.json");
    process.env.FAKE_ACP_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-droid", text: "go", model: "claude-sonnet-5" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toEqual(["exec", "-o", "acp"]);
    expect(seen.argv).not.toContain("-m");

    const applied = JSON.parse(readFileSync(`${dump}.config.json`, "utf8"));
    expect(applied).toEqual([
      { method: "session/set_mode", params: { sessionId: "fake-acp-session", modeId: "auto-high" } },
      { method: "session/set_model", params: { sessionId: "fake-acp-session", modelId: "claude-sonnet-5" } },
    ]);
  });

  it("droid pins read-only mode when fullAuto is off", async () => {
    instance = await DroidAgentDriver.create({
      instanceId: "droid-safe",
      displayName: "Droid Safe",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const dump = join(scratch, "droid-safe.json");
    process.env.FAKE_ACP_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-droid-safe", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    // Both settings are explicit even with nothing on the turn: whatever
    // ~/.factory/settings.json pinned (including a `custom:` provider with its
    // own endpoint) must never be what the session silently runs on.
    expect(JSON.parse(readFileSync(`${dump}.config.json`, "utf8"))).toEqual([
      { method: "session/set_mode", params: { sessionId: "fake-acp-session", modeId: "normal" } },
      { method: "session/set_model", params: { sessionId: "fake-acp-session", modelId: "claude-opus-5" } },
    ]);
  });

  it("droid names the rejected setting when the agent predates session config", async () => {
    // The realistic failure is version skew: an older droid answers -32601 to
    // session/set_mode, and core surfaces the RPC message verbatim. A bare
    // "method not found" tells the user nothing, so the driver wraps it.
    process.env.FAKE_ACP_MODE = "no-session-config";
    instance = await DroidAgentDriver.create({
      instanceId: "droid-old-cli",
      displayName: "Droid Old CLI",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-droid-skew", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "rpc_error" });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toContain("session/set_mode");
    expect(err.message).toContain('autonomy mode "normal"');
    expect(err.message).toMatch(/`droid` is current/);
    // The session id still reached the client, so the thread can resume rather
    // than orphaning the session droid just created.
    expect(recorder.events.some((e) => e.type === "session.started")).toBe(true);
  });

  it("mounts local CUA only on an approval-capable ACP instance", async () => {
    await create();
    const dump = join(scratch, "local-dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-local",
      text: "inspect",
      integrations: {
        localComputer: {
          command: "/opt/cua driver/cua-driver",
          args: ["mcp", "--embedded", "--socket", "/run/user/1000/driver.sock"],
          env: { CUA_DRIVER_EMBEDDED: "1" },
          platform: "linux",
          generation: "generation-1",
          scope: "local-computer",
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpServers).toContainEqual({
      name: "computer",
      command: "/opt/cua driver/cua-driver",
      args: ["mcp", "--embedded", "--socket", "/run/user/1000/driver.sock"],
      env: [{ name: "CUA_DRIVER_EMBEDDED", value: "1" }],
    });
    expect(instance.adapter.capabilities.localComputerMcp).toBe(true);
  });

  it("surfaces a permission ask as request.opened and completes once allowed", async () => {
    await create(GrokAgentDriver, "permission");
    await instance.adapter.sendTurn({
      threadId: "t-perm",
      text: "go",
      integrations: {
        localComputer: {
          command: "/cua-driver",
          args: ["mcp"],
          env: {},
          platform: "linux",
          scope: "local-computer",
        },
      },
    });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "permission",
      tool: "shell",
      approvalScope: "local-computer",
    });

    await instance.adapter.respondToRequest("t-perm", (opened as any).requestId, { behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({
      behavior: "allow",
      source: "user",
      approvalScope: "local-computer",
    });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("grok fails closed when the CLI advertises no cached_token (needs login)", async () => {
    await create(GrokAgentDriver, "no-auth");
    await instance.adapter.sendTurn({ threadId: "t-auth", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/not signed in/);
  });

  it("gemini proceeds through a missing auth method (lenient login)", async () => {
    await create(GeminiAgentDriver, "no-auth");
    await instance.adapter.sendTurn({ threadId: "t-lenient", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events.some((e) => e.provider === "geminiAgent")).toBe(true);
  });

  it("rejects a second turn while one is in flight", async () => {
    await create(GrokAgentDriver, "hang");
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
    await recorder.until((e) => e.type === "session.started");
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
    await instance.adapter.interruptTurn("t-busy");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("interrupt settles a hung turn as cancelled", async () => {
    await create(GrokAgentDriver, "hang");
    await instance.adapter.sendTurn({ threadId: "t-int", text: "go" });
    await recorder.until((e) => e.type === "session.started");
    await instance.adapter.interruptTurn("t-int");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ type: "turn.completed" });
  });

  it("an exit before result becomes runtime.error + failed turn", async () => {
    await create(GrokAgentDriver, "exit-early");
    await instance.adapter.sendTurn({ threadId: "t-crash", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(true);
  });

  it("preserves ACP error codes for provider setup classification", async () => {
    await create(ClassifiedErrorDriver, "auth-required");
    await instance.adapter.sendTurn({ threadId: "t-auth-required", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({ setup: true });
  });

  it("selectModel confirms the requested model before prompting", async () => {
    process.env.FAKE_ACP_MODELS = "m-one,m-two";
    await create(SelectModelDriver);
    await instance.adapter.sendTurn({ threadId: "t-model", text: "go", model: "m-two" });

    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ model: "m-two" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("a model the session does not advertise fails the turn instead of running another", async () => {
    process.env.FAKE_ACP_MODELS = "m-one,m-two";
    await create(SelectModelDriver);
    await instance.adapter.sendTurn({ threadId: "t-bad-model", text: "go", model: "m-nope" });

    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/model not found/);
    // nothing was generated: the prompt is never sent
    expect(recorder.events.some((e) => e.type === "content.delta")).toBe(false);
  });

  // The unadvertised-model test above rides the fake's -32602, so it settles in
  // `request()` and never reaches the guard. This one is the silent case the
  // guard was written for: the agent acknowledges the switch and keeps its old
  // model, which no error surfaces.
  it("a model switch acknowledged but not applied fails the turn", async () => {
    process.env.FAKE_ACP_MODELS = "m-one,m-two";
    process.env.FAKE_ACP_MODEL_STICKS = "1";
    await create(SelectModelDriver);
    await instance.adapter.sendTurn({ threadId: "t-stuck-model", text: "go", model: "m-two" });

    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/did not switch to m-two \(still m-one\)/);
    // the whole point: no paid turn is spent on the wrong model
    expect(recorder.events.some((e) => e.type === "content.delta")).toBe(false);
  });

  it("selects the model on a resumed session too, not just a new one", async () => {
    process.env.FAKE_ACP_MODELS = "m-one,m-two";
    await create(SelectModelDriver);
    await instance.adapter.sendTurn({
      threadId: "t-resume-model",
      text: "go",
      model: "m-two",
      // deliberately NOT "fake-acp-session", the id session/new returns: with
      // that cursor a session/load that threw and fell back to session/new
      // would emit the same sessionId and this test could not fail
      resumeCursor: "resumed-thread-1",
    });

    // session/load feeds the same sessionResult as session/new, so the model
    // hook must fire on a resumed thread as well
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "resumed-thread-1", model: "m-two" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("applyTurnEnv sees the picker model after resolveTurnModel", async () => {
    const dump = join(scratch, "turn-env.json");
    process.env.FAKE_ACP_DUMP = dump;
    const TurnEnvDriver = createAcpDriver({
      ...SELECT_MODEL_SUPPORT,
      driverKind: "turnEnvTest",
      selectModel: undefined,
      resolveTurnModel: (model) => (model ? `resolved/${model}` : model),
      applyTurnEnv: (env, { model, requestedModel }) => {
        env.TEST_TURN_MODEL = `${model ?? ""}|${requestedModel ?? ""}`;
      },
    });
    instance = await TurnEnvDriver.create({
      instanceId: "turn-env-test",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "t-turn-env",
      text: "go",
      model: "ollama::ornith:35b-bf16",
    });
    await recorder.until((e) => e.type === "turn.completed");

    expect(JSON.parse(readFileSync(dump, "utf8")).env.TEST_TURN_MODEL).toBe(
      "resolved/ollama::ornith:35b-bf16|ollama::ornith:35b-bf16",
    );
  });

  it("transformEnv sees the instance config", async () => {
    const dump = join(scratch, "policy.json");
    process.env.FAKE_ACP_DUMP = dump;
    instance = await EnvPolicyDriver.create({
      instanceId: "policy-test",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-policy", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(JSON.parse(readFileSync(dump, "utf8")).env.TEST_POLICY).toBe("auto");
  });

  it("declares effort levels for Grok only", async () => {
    await create(GrokAgentDriver);
    expect(instance.adapter.capabilities.effortLevels).toEqual(["low", "medium", "high"]);

    await create(GeminiAgentDriver);
    expect(instance.adapter.capabilities.effortLevels).toBeUndefined();

    await create(KimiAgentDriver);
    expect(instance.adapter.capabilities.effortLevels).toBeUndefined();
  });

  it("passes effort to Grok, and omits the flag when unset", async () => {
    const withEffort = join(scratch, "grok-effort.json");
    await create(GrokAgentDriver);
    process.env.FAKE_ACP_DUMP = withEffort;
    await instance.adapter.sendTurn({ threadId: "t-effort", text: "hi", effort: "high" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(withEffort, "utf8"));
    expect(seen.argv).toContain("--reasoning-effort");
    expect(seen.argv[seen.argv.indexOf("--reasoning-effort") + 1]).toBe("high");

    const without = join(scratch, "grok-no-effort.json");
    await create(GrokAgentDriver);
    process.env.FAKE_ACP_DUMP = without;
    await instance.adapter.sendTurn({ threadId: "t-no-effort", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(JSON.parse(readFileSync(without, "utf8")).argv).not.toContain("--reasoning-effort");
  });

  // The name used to end "and only the permission key". It names four key paths
  // now, so that was a lie about the driver's scope; what the test actually pins
  // is that the caller's unrelated settings survive.
  it("opencode forces an ask policy into the child and leaves the caller's other settings alone", async () => {
    process.env.FAKE_ACP_MODELS = "opencode/hy3-free";
    const dump = join(scratch, "opencode-env.json");
    process.env.FAKE_ACP_DUMP = dump;
    instance = await OpenCodeAgentDriver.create({
      instanceId: "opencode-ask",
      displayName: undefined,
      environment: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { keepme: {} }, permission: "allow" }) },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-oc-ask", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const injected = JSON.parse(JSON.parse(readFileSync(dump, "utf8")).env.OPENCODE_CONFIG_CONTENT);
    expect(injected.permission.bash).toBe("ask");
    expect(injected.permission["*"]).toBe("ask");
    expect(injected.permission.edit).toBe("allow");
    // opencode's own `.env` guard survives our blanket read allowance
    expect(injected.permission.read).toMatchObject({ "*": "allow", "*.env": "ask" });
    // the user's other settings survive: we replace one key, not the file
    expect(injected.mcp).toEqual({ keepme: {} });
  });

  it("opencode shuts the routes that outrank the injected policy", async () => {
    process.env.FAKE_ACP_MODELS = "opencode/hy3-free";
    const dump = join(scratch, "opencode-routes.json");
    process.env.FAKE_ACP_DUMP = dump;
    instance = await OpenCodeAgentDriver.create({
      instanceId: "opencode-routes",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    // All three are inherited from our own process env and all three sidestep
    // the config merge: OPENCODE_PERMISSION is applied after it, and
    // OPENCODE_CONFIG/_DIR point opencode at a file or directory we do not
    // control. Set them AFTER create() so only the per-turn sanitiser can
    // remove them.
    process.env.OPENCODE_PERMISSION = JSON.stringify({ bash: "allow" });
    process.env.OPENCODE_CONFIG = join(scratch, "hostile-opencode.json");
    process.env.OPENCODE_CONFIG_DIR = scratch;

    await instance.adapter.sendTurn({ threadId: "t-oc-routes", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const { env } = JSON.parse(readFileSync(dump, "utf8"));
    expect(env.OPENCODE_PERMISSION).toBeUndefined();
    expect(env.OPENCODE_CONFIG).toBeUndefined();
    expect(env.OPENCODE_CONFIG_DIR).toBeUndefined();
    // a per-agent permission block in the working directory outranks ours too;
    // disabling project config is what removes that route
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
  });

  it("opencode hands everything to the agent in fullAuto", async () => {
    process.env.FAKE_ACP_MODELS = "opencode/hy3-free";
    const dump = join(scratch, "opencode-auto.json");
    process.env.FAKE_ACP_DUMP = dump;
    instance = await OpenCodeAgentDriver.create({
      instanceId: "opencode-auto",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-oc-auto", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const { env } = JSON.parse(readFileSync(dump, "utf8"));
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).permission).toBe("allow");
    // fullAuto means the user asked for no gate at all, so the project's own
    // config is left alone rather than suppressed
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined();
  });

  it("opencode spawns the acp subcommand and passes no -m", async () => {
    process.env.FAKE_ACP_MODELS = "opencode/hy3-free";
    const dump = join(scratch, "opencode-argv.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(OpenCodeAgentDriver);

    await instance.adapter.sendTurn({ threadId: "t-oc-argv", text: "go", model: "opencode/hy3-free" });
    await recorder.until((e) => e.type === "turn.completed");

    const { argv } = JSON.parse(readFileSync(dump, "utf8"));
    expect(argv).toEqual(["acp"]);
  });

  it("opencode inherits its own provider key and no one else's", async () => {
    process.env.FAKE_ACP_MODELS = "opencode/hy3-free";
    const dump = join(scratch, "opencode-keys.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(OpenCodeAgentDriver);
    // OPENCODE_API_KEY unlocks the OpenCode Zen provider: on a virgin HOME the
    // catalog goes from 8 free models to 81 once it is set (measured, 1.18.18).
    // It is in core.ts's PROVIDER_CREDENTIAL_ENV, so only declaring it in
    // credentialEnv keeps it. The user's own logins live in opencode's
    // auth.json and need nothing from us — these two must not travel.
    process.env.OPENCODE_API_KEY = "zen-key";
    process.env.OPENAI_API_KEY = "openai-should-not-leak";
    process.env.ANTHROPIC_API_KEY = "anthropic-should-not-leak";

    await instance.adapter.sendTurn({ threadId: "t-oc-keys", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const { env } = JSON.parse(readFileSync(dump, "utf8"));
    expect(env.OPENCODE_API_KEY).toBe("zen-key");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("puts Grok -m after agent so ACP stdio binds the local slug", async () => {
    const dump = join(scratch, "grok-argv-order.json");
    await create(GrokAgentDriver);
    process.env.FAKE_ACP_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-argv", text: "hi", model: "grok-4.5", effort: "high" });
    await recorder.until((e) => e.type === "turn.completed");

    const argv = JSON.parse(readFileSync(dump, "utf8")).argv as string[];
    const agent = argv.indexOf("agent");
    const modelFlag = argv.indexOf("-m");
    const stdio = argv.indexOf("stdio");
    expect(agent).toBeGreaterThan(-1);
    expect(modelFlag).toBeGreaterThan(agent);
    expect(stdio).toBeGreaterThan(modelFlag);
    expect(argv[modelFlag + 1]).toBe("grok-4.5");
    expect(argv.indexOf("--reasoning-effort")).toBeGreaterThan(agent);
    expect(argv.indexOf("--permission-mode")).toBeLessThan(agent);
  });
});

describe("ACP snapshot", () => {
  it("a missing binary is unavailable", async () => {
    const instance = await GrokAgentDriver.create({
      instanceId: "grok-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: "definitely-not-a-real-grok-binary", fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    await instance.dispose();
  });

  it("kimi checks KIMI_CODE_HOME before the child HOME", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-kimi-auth-"));
    const kimiHome = join(scratch, "custom-kimi-home");
    const childHome = join(scratch, "child-home");
    mkdirSync(join(childHome, ".kimi-code", "credentials"), { recursive: true });
    writeFileSync(join(childHome, ".kimi-code", "credentials", "kimi-code.json"), "{}");

    const instance = await KimiAgentDriver.create({
      instanceId: "kimi-custom-home",
      displayName: undefined,
      environment: { KIMI_CODE_HOME: kimiHome, HOME: childHome },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(false);
      mkdirSync(join(kimiHome, "credentials"), { recursive: true });
      writeFileSync(join(kimiHome, "credentials", "kimi-code.json"), "{}");
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("droid resolves the signed-in CLI before falling back to FACTORY_API_KEY", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-droid-auth-"));
    // FACTORY_HOME_OVERRIDE replaces the CLI's HOME, not its data root: droid
    // writes <home>/.factory/auth.v2.file either way (verified against 0.196.0).
    const overrideHome = join(scratch, "custom-home");
    const childHome = join(scratch, "child-home");
    mkdirSync(join(childHome, ".factory"), { recursive: true });
    writeFileSync(join(childHome, ".factory", "auth.v2.file"), "{}");

    // The child env inherits process.env (core.ts childEnv), so a developer
    // machine with a real FACTORY_API_KEY exported would otherwise satisfy
    // every case here and prove nothing about the on-disk lookup.
    const make = (environment: Record<string, string>) =>
      DroidAgentDriver.create({
        instanceId: "droid-auth",
        displayName: undefined,
        environment: { FACTORY_API_KEY: "", ...environment },
        enabled: true,
        config: { cli: FAKE_CLI, fullAuto: false },
      });

    const instances: ProviderInstance[] = [];
    try {
      // FACTORY_HOME_OVERRIDE wins: the child HOME's credential must not count.
      const overridden = await make({ FACTORY_HOME_OVERRIDE: overrideHome, HOME: childHome });
      instances.push(overridden);
      expect((await overridden.snapshot()).authenticated).toBe(false);
      mkdirSync(join(overrideHome, ".factory"), { recursive: true });
      writeFileSync(join(overrideHome, ".factory", "auth.v2.file"), "{}");
      expect((await overridden.snapshot()).authenticated).toBe(true);

      // A logged-out override is not rescued by a key on the way past it, but
      // the key alone still authenticates when nothing is signed in on disk.
      const loggedOutWithKey = await make({
        FACTORY_HOME_OVERRIDE: join(scratch, "empty-home"),
        HOME: childHome,
        FACTORY_API_KEY: "fk-test",
      });
      instances.push(loggedOutWithKey);
      expect((await loggedOutWithKey.snapshot()).authenticated).toBe(true);

      const fromHome = await make({ HOME: childHome });
      instances.push(fromHome);
      expect((await fromHome.snapshot()).authenticated).toBe(true);

      // secure_auth_storage writes the keychain/keyring variant instead of
      // auth.v2.file, so a fresh macOS login has only this one.
      const keychainHome = join(scratch, "keychain-home");
      mkdirSync(join(keychainHome, ".factory"), { recursive: true });
      writeFileSync(join(keychainHome, ".factory", "auth.v2.loginkeychain"), "{}");
      const fromKeychain = await make({ HOME: keychainHome });
      instances.push(fromKeychain);
      expect((await fromKeychain.snapshot()).authenticated).toBe(true);

      const neither = await make({ HOME: join(scratch, "empty") });
      instances.push(neither);
      expect((await neither.snapshot()).authenticated).toBe(false);
    } finally {
      for (const i of instances) await i.dispose();
      await removeTempDir(scratch);
    }
  });

  it("droid reads custom models, favourites order, and the configured default", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-droid-models-"));
    mkdirSync(join(scratch, ".factory"), { recursive: true });
    writeFileSync(
      join(scratch, ".factory", "settings.json"),
      JSON.stringify({
        customModels: [
          { id: "custom:LMStudio-Qwen-0", displayName: "Qwen (local)" },
          { id: "custom:Azure-Opus-0", displayName: "Azure Opus" },
        ],
        modelFavorites: ["custom:Azure-Opus-0", "custom:LMStudio-Qwen-0"],
        sessionDefaultSettings: { model: "custom:LMStudio-Qwen-0" },
      }),
    );

    const instance = await DroidAgentDriver.create({
      instanceId: "droid-models",
      displayName: undefined,
      environment: { HOME: scratch },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      // favourites first in the user's own order, then the built-in slice
      expect(instance.models.options.slice(0, 2)).toEqual([
        { id: "custom:Azure-Opus-0", label: "Azure Opus", custom: true },
        { id: "custom:LMStudio-Qwen-0", label: "Qwen (local)", custom: true },
      ]);
      expect(instance.models.options.some((o) => o.id === "claude-opus-5")).toBe(true);
      expect(instance.models.default).toBe("custom:LMStudio-Qwen-0");
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("droid falls back to the built-in catalog when settings.json is unreadable", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-droid-nosettings-"));
    mkdirSync(join(scratch, ".factory"), { recursive: true });
    writeFileSync(join(scratch, ".factory", "settings.json"), "{ not json");

    const instance = await DroidAgentDriver.create({
      instanceId: "droid-models-fallback",
      displayName: undefined,
      environment: { HOME: scratch },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect(instance.models.default).toBe("claude-opus-5");
      expect(instance.models.options.every((o) => !o.id.startsWith("custom:"))).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("kimi resolves default credentials from the child HOME", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-kimi-home-"));
    const credentialDir = join(scratch, ".kimi-code", "credentials");
    mkdirSync(credentialDir, { recursive: true });
    writeFileSync(join(credentialDir, "kimi-code.json"), "{}");

    const instance = await KimiAgentDriver.create({
      instanceId: "kimi-child-home",
      displayName: undefined,
      environment: { HOME: scratch },
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

  it("awaits an async isAuthenticated", async () => {
    const instance = await AsyncAuthDriver.create({
      instanceId: "async-auth",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      // without the await this is a Promise: truthy, but not `true`
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
    }
  });

  it("opencode is unauthenticated when its catalog is empty, authenticated when it is not", async () => {
    __catalogTestHooks.reset();
    process.env.FAKE_ACP_MODELS = "";
    const empty = await OpenCodeAgentDriver.create({
      instanceId: "opencode-empty",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await empty.snapshot()).authenticated).toBe(false);
    } finally {
      await empty.dispose();
    }

    __catalogTestHooks.reset();
    process.env.FAKE_ACP_MODELS = "opencode/hy3-free";
    const ready = await OpenCodeAgentDriver.create({
      instanceId: "opencode-ready",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      const snap = await ready.snapshot();
      expect(snap.state).toBe("available");
      expect(snap.authenticated).toBe(true);
      expect((await ready.catalog!()).options).toEqual([{ id: "opencode/hy3-free", label: "hy3-free" }]);
    } finally {
      __catalogTestHooks.reset();
      delete process.env.FAKE_ACP_MODELS;
      await ready.dispose();
    }
  });
});

describe("opencode permission policy", () => {
  const perm = (existing?: string) => JSON.parse(permissionEnv(existing, false)).permission;

  it("wins over a permission key the caller already set", () => {
    expect(perm(JSON.stringify({ permission: "allow" })).bash).toBe("ask");
  });

  it("keeps the caller's other settings", () => {
    const merged = JSON.parse(permissionEnv(JSON.stringify({ mcp: { keepme: {} } }), false));
    expect(merged.mcp).toEqual({ keepme: {} });
  });

  it("falls back to a bare policy on any shape that is not a plain object", () => {
    for (const junk of ["{not json", "[1,2]", '"a string"', "42", "null"]) {
      expect(perm(junk).bash).toBe("ask");
    }
  });

  it("hands everything over in fullAuto", () => {
    const merged = JSON.parse(permissionEnv(undefined, true));
    expect(merged.permission).toBe("allow");
    // fullAuto is the user asking for no gate at all, so nothing is pinned
    expect(merged.agent).toBeUndefined();
    expect(merged.mode).toBeUndefined();
    expect(merged.default_agent).toBeUndefined();
  });

  it("pins the same policy on every agent it names", () => {
    // A per-agent block is a different key path from the top-level policy: it
    // is appended after it and evaluation is last-match-wins, so a global
    // config could otherwise restore `bash: allow`. Naming the key path is what
    // makes ours collide with theirs instead of losing to it.
    const merged = JSON.parse(permissionEnv(undefined, false));
    for (const name of ["build", "plan", "general"]) {
      expect(merged.agent[name].permission).toEqual(merged.permission);
      expect(merged.agent[name].permission.bash).toBe("ask");
    }
    // and a config cannot point the session at an agent we did not pin
    expect(merged.default_agent).toBe("build");
  });

  it("replaces a pinned agent's permission but keeps its other fields and other agents", () => {
    const merged = JSON.parse(
      permissionEnv(
        JSON.stringify({
          agent: {
            build: { model: "anthropic/claude-opus-5", permission: { bash: "allow" } },
            reviewer: { prompt: "review it" },
          },
        }),
        false,
      ),
    );
    expect(merged.agent.build.permission.bash).toBe("ask");
    expect(merged.agent.build.model).toBe("anthropic/claude-opus-5");
    expect(merged.agent.reviewer).toEqual({ prompt: "review it" });
  });

  it("pins the legacy mode key path, for build and for no other agent", () => {
    // opencode folds `mode.<name>` into `agent.<name>` AFTER every config file
    // has merged, with the mode entry winning, so a global
    // `mode.build.permission` outranks the agent pin above. Naming the key path
    // is what takes it back. `build` only: the fold hardcodes `mode: "primary"`
    // on whatever it copies, so naming `mode.general` would promote the `task`
    // tool's subagent to a selectable primary agent the user does not have.
    const merged = JSON.parse(permissionEnv(undefined, false));
    expect(merged.mode.build.permission).toEqual(merged.permission);
    expect(merged.mode.build.permission.bash).toBe("ask");
    expect(Object.keys(merged.mode)).toEqual(["build"]);
  });

  it("overrides a mode block the caller already set, keeping its other fields and modes", () => {
    const merged = JSON.parse(
      permissionEnv(
        JSON.stringify({
          mode: {
            build: { model: "anthropic/claude-opus-5", permission: { bash: "allow" } },
            scribe: { prompt: "write it up" },
          },
        }),
        false,
      ),
    );
    // without this the caller's mode block would ride through the spread
    // untouched and hand back exactly what the agent pin took
    expect(merged.mode.build.permission.bash).toBe("ask");
    expect(merged.mode.build.model).toBe("anthropic/claude-opus-5");
    expect(merged.mode.scribe).toEqual({ prompt: "write it up" });
  });

  it("still pins when the caller's agent or mode key is not a plain object", () => {
    for (const junk of ['{"agent":"nope"}', '{"agent":[1,2]}', '{"agent":{"build":"nope"}}']) {
      expect(JSON.parse(permissionEnv(junk, false)).agent.build.permission.bash).toBe("ask");
    }
    for (const junk of ['{"mode":"nope"}', '{"mode":[1,2]}', '{"mode":{"build":"nope"}}']) {
      expect(JSON.parse(permissionEnv(junk, false)).mode.build.permission.bash).toBe("ask");
    }
  });
});

describe("opencode catalog parsing", () => {
  it("keeps one qualified id per line and labels it with the model part", () => {
    expect(parseModels("anthropic/claude-opus-5\nollama/qwen3-coder:latest\n")).toEqual([
      { id: "anthropic/claude-opus-5", label: "claude-opus-5" },
      { id: "ollama/qwen3-coder:latest", label: "qwen3-coder:latest" },
    ]);
  });

  it("drops anything that is not a qualified id rather than guessing", () => {
    expect(parseModels("Available models:\n\nanthropic/claude-opus-5\nnot-qualified\n  indented/thing\n")).toEqual([
      { id: "anthropic/claude-opus-5", label: "claude-opus-5" },
    ]);
  });

  it("returns nothing for empty output", () => {
    expect(parseModels("")).toEqual([]);
    expect(parseModels("\n\n")).toEqual([]);
  });

  it("keeps only the first slash as the provider boundary", () => {
    expect(parseModels("ollama/hf.co/unsloth/Qwen3-32B-GGUF:Q4_K_M\n")).toEqual([
      { id: "ollama/hf.co/unsloth/Qwen3-32B-GGUF:Q4_K_M", label: "hf.co/unsloth/Qwen3-32B-GGUF:Q4_K_M" },
    ]);
  });

  it("parses a CRLF stream exactly like an LF one", () => {
    // Measured on Linux the CLI emits LF, but nothing guarantees that on
    // Windows, and a surviving \r drops every entry without an error.
    expect(parseModels("anthropic/claude-opus-5\r\nollama/qwen3-coder:latest\r\n")).toEqual([
      { id: "anthropic/claude-opus-5", label: "claude-opus-5" },
      { id: "ollama/qwen3-coder:latest", label: "qwen3-coder:latest" },
    ]);
  });
});

describe("opencode catalog discovery", () => {
  beforeEach(() => {
    __catalogTestHooks.reset();
    process.env.FAKE_ACP_MODELS = "opencode/hy3-free,anthropic/claude-opus-5";
  });
  afterEach(() => {
    __catalogTestHooks.reset();
    delete process.env.FAKE_ACP_MODELS;
    delete process.env.FAKE_ACP_DEFAULT_MODEL;
    delete process.env.FAKE_ACP_CONFIG_FAILS;
    delete process.env.FAKE_ACP_MODELS_FAILS;
  });

  it("uses the CLI's own resolved default when it is in the catalog", async () => {
    process.env.FAKE_ACP_DEFAULT_MODEL = "anthropic/claude-opus-5";
    const catalog = await discoverCatalog(FAKE_CLI, process.env);
    expect(catalog.default).toBe("anthropic/claude-opus-5");
    expect(catalog.options).toHaveLength(2);
  });

  // A provider prefix is the CLI's to spell, never ours to build. Getting this
  // wrong is silent at every layer we control and only fails at the last one:
  // `session/set_config_option` answers "model not found: <id>" and core.ts
  // turns that into a failed turn, so a whole picker can look healthy while
  // none of its entries can run.
  it("serves model ids exactly as the CLI spells them, adding no prefix", async () => {
    process.env.FAKE_ACP_MODELS = "openai/gpt-5.6-sol,opencode/claude-opus-4-5";
    const catalog = await discoverCatalog(FAKE_CLI, process.env);
    expect(catalog.options.map((o) => o.id)).toEqual([
      "openai/gpt-5.6-sol",
      "opencode/claude-opus-4-5",
    ]);
  });

  it("falls back to the first entry when debug config fails", async () => {
    process.env.FAKE_ACP_CONFIG_FAILS = "1";
    const catalog = await discoverCatalog(FAKE_CLI, process.env);
    expect(catalog.default).toBe("opencode/hy3-free");
  });

  it("falls back to the first entry when the reported default is not in the catalog", async () => {
    process.env.FAKE_ACP_DEFAULT_MODEL = "gone/removed-model";
    const catalog = await discoverCatalog(FAKE_CLI, process.env);
    expect(catalog.default).toBe("opencode/hy3-free");
  });

  it("reports an empty catalog rather than inventing one", async () => {
    process.env.FAKE_ACP_MODELS = "";
    const catalog = await discoverCatalog(FAKE_CLI, process.env);
    expect(catalog).toEqual({ default: "", options: [] });
  });

  it("does not cache a CLI that could not run, so the next call retries", async () => {
    let clock = 1_000;
    __catalogTestHooks.setClock(() => clock);
    process.env.FAKE_ACP_MODELS_FAILS = "1";
    expect((await discoverCatalog(FAKE_CLI, process.env)).options).toEqual([]);

    delete process.env.FAKE_ACP_MODELS_FAILS;
    // Same instant, so the clock cannot be what lets this through: only an
    // uncached failure allows the second call to reach the CLI at all.
    expect((await discoverCatalog(FAKE_CLI, process.env)).options).toHaveLength(2);
  });

  it("serves the last good catalog when a later probe cannot run", async () => {
    let clock = 1_000;
    __catalogTestHooks.setClock(() => clock);
    expect((await discoverCatalog(FAKE_CLI, process.env)).options).toHaveLength(2);

    // Change what a SUCCESSFUL probe would return as well, so a fresh probe
    // that wrongly ignored the failure would visibly diverge from the stale
    // value instead of coincidentally matching it.
    process.env.FAKE_ACP_MODELS = "only/one";
    process.env.FAKE_ACP_MODELS_FAILS = "1";
    clock += 61_000; // past the TTL, so the cache is a fallback and not a hit
    expect((await discoverCatalog(FAKE_CLI, process.env)).options).toEqual([
      { id: "opencode/hy3-free", label: "hy3-free" },
      { id: "anthropic/claude-opus-5", label: "claude-opus-5" },
    ]);
  });

  it("does not collide two homes whose paths contain the key separator", async () => {
    let clock = 1_000;
    __catalogTestHooks.setClock(() => clock);
    // "a b" + "c" and "a" + "b c" join to the same string under a naive
    // space-joined key, and Windows paths routinely contain spaces
    const first = await discoverCatalog(FAKE_CLI, { ...process.env, HOME: "a b", XDG_CONFIG_HOME: "c" });
    expect(first.options).toHaveLength(2);

    process.env.FAKE_ACP_MODELS = "only/one";
    const second = await discoverCatalog(FAKE_CLI, { ...process.env, HOME: "a", XDG_CONFIG_HOME: "b c" });
    expect(second.options).toEqual([{ id: "only/one", label: "one" }]);
  });

  it("serves the cache until the TTL expires, on an injected clock", async () => {
    let now = 1_000;
    __catalogTestHooks.setClock(() => now);
    const first = await discoverCatalog(FAKE_CLI, process.env);
    expect(first.options).toHaveLength(2);

    process.env.FAKE_ACP_MODELS = "only/one";
    now += 59_000;
    expect((await discoverCatalog(FAKE_CLI, process.env)).options).toHaveLength(2);

    now += 2_000;
    expect((await discoverCatalog(FAKE_CLI, process.env)).options).toEqual([{ id: "only/one", label: "one" }]);
  });

  it("does not serve one instance's catalog to another home", async () => {
    let clock = 1_000;
    __catalogTestHooks.setClock(() => clock);
    const a = await discoverCatalog(FAKE_CLI, { ...process.env, HOME: "/tmp/home-a" });
    expect(a.options).toHaveLength(2);

    process.env.FAKE_ACP_MODELS = "only/one";
    // same binary, same instant, different home: must not hit A's entry
    const b = await discoverCatalog(FAKE_CLI, { ...process.env, HOME: "/tmp/home-b" });
    expect(b.options).toEqual([{ id: "only/one", label: "one" }]);
  });

  it("probes in the working directory it is given, not the server's", async () => {
    let clock = 1_000;
    __catalogTestHooks.setClock(() => clock);
    // control: an existing directory probes normally
    expect((await discoverCatalog(FAKE_CLI, process.env, tmpdir())).options).toHaveLength(2);

    // A directory that does not exist makes the spawn itself fail, which is
    // observable only if the cwd reached execCli at all — and the distinct key
    // means this is a fresh probe rather than the control's cache entry.
    const gone = join(tmpdir(), "omb-opencode-no-such-dir");
    expect((await discoverCatalog(FAKE_CLI, process.env, gone)).options).toEqual([]);
  });

  it("does not serve one instance's catalog to another config content", async () => {
    let clock = 1_000;
    __catalogTestHooks.setClock(() => clock);
    // OPENCODE_CONFIG_CONTENT can declare a whole provider, so two instances
    // differing only by a per-instance `environment` entry legitimately see
    // different catalogs. Measured on 1.18.18: 473 -> 474 lines.
    const a = await discoverCatalog(FAKE_CLI, { ...process.env, OPENCODE_CONFIG_CONTENT: '{"x":1}' });
    expect(a.options).toHaveLength(2);

    process.env.FAKE_ACP_MODELS = "only/one";
    const b = await discoverCatalog(FAKE_CLI, { ...process.env, OPENCODE_CONFIG_CONTENT: '{"x":2}' });
    expect(b.options).toEqual([{ id: "only/one", label: "one" }]);
  });

  // The cache collapses SEQUENTIAL callers: describe() awaits snapshot() —
  // which asks isAuthenticated, which discovers — before it awaits catalog(),
  // so the second one hits a warm entry. Concurrent callers are the gap: two
  // in-flight /api/instances requests both miss and both spawn the CLI.
  it("spawns one probe when two callers arrive at once", async () => {
    let clock = 1_000;
    __catalogTestHooks.setClock(() => clock);
    const dir = mkdtempSync(join(tmpdir(), "omb-probe-count-"));
    try {
      const log = join(dir, "probes.log");
      const env = { ...process.env, FAKE_ACP_MODELS_LOG: log };

      const [a, b] = await Promise.all([
        discoverCatalog(FAKE_CLI, env),
        discoverCatalog(FAKE_CLI, env),
      ]);

      expect(a.options).toHaveLength(2);
      expect(b).toEqual(a);
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The tests above call discoverCatalog directly, so they prove the cwd
  // reaches execCli — not that the support computes it from the instance
  // config. Drop `probeCwd(config)` from opencode.ts's `catalog` and every one
  // of them still passes while the probe silently moves to the server's own
  // directory. This one goes through instance.catalog() to close that gap.
  it("probes a configured workspace, not wherever the server was launched", async () => {
    let clock = 1_000;
    __catalogTestHooks.setClock(() => clock);
    const gone = join(tmpdir(), "omb-opencode-workspace-gone");

    const instance = await OpenCodeAgentDriver.create({
      instanceId: "opencode-workspace",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: gone },
    });
    try {
      // A workspace that does not exist makes the spawn itself fail, which is
      // observable only if config.workspace reached execCli.
      expect((await instance.catalog!()).options).toEqual([]);
    } finally {
      await instance.dispose();
    }

    // control: the same driver with a workspace that exists probes normally,
    // so the empty result above is the cwd and not a broken fake CLI
    const ok = await OpenCodeAgentDriver.create({
      instanceId: "opencode-workspace-ok",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: tmpdir() },
    });
    try {
      expect((await ok.catalog!()).options).toHaveLength(2);
    } finally {
      await ok.dispose();
    }
  });

  it("does not serve one instance's catalog to another Windows home", async () => {
    let clock = 1_000;
    __catalogTestHooks.setClock(() => clock);
    // On Windows HOME and the XDG_* vars are all undefined, so keying only on
    // them collapses every opencode instance onto one entry — a silent failure
    // on a platform we cannot exercise from here.
    const a = await discoverCatalog(FAKE_CLI, { ...process.env, USERPROFILE: "C:\\Users\\a" });
    expect(a.options).toHaveLength(2);

    process.env.FAKE_ACP_MODELS = "only/one";
    const b = await discoverCatalog(FAKE_CLI, { ...process.env, USERPROFILE: "C:\\Users\\b" });
    expect(b.options).toEqual([{ id: "only/one", label: "one" }]);
  });
});
