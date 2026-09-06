// Codex driver contract tests, run against the scripted fake app-server
// in server/testing/fake-codex-app-server.ts — the driver must drive the
// JSON-RPC handshake, normalize notifications into canonical events, and
// surface server->client approval requests as request.opened.
//
// The fake is a shebang script — the same constraint codex.cmd itself
// hits on Windows. resolveCliSpawn covers both, so these run everywhere.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { NATIVE_DIR } from "../config.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import {
  CodexDriver,
  codexNativeIncomingLogMessage,
  codexPredatesAstra,
  codexUpdateCommand,
} from "./codex.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("CodexDriver.decodeConfig", () => {
  it("defaults to the codex binary with fullAuto off", () => {
    expect(CodexDriver.decodeConfig({})).toEqual({ cli: "codex", fullAuto: false });
    expect(CodexDriver.decodeConfig(undefined)).toEqual({ cli: "codex", fullAuto: false });
    expect(CodexDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
    // anything non-true is off — a truthy string must not enable full auto
    expect(CodexDriver.decodeConfig({ fullAuto: "yes" }).fullAuto).toBe(false);
  });
});

describe("Codex native diagnostic sanitization", () => {
  it("omits a late config/read response even after its pending promise timed out", () => {
    const late = {
      jsonrpc: "2.0",
      id: 17,
      result: { config: { mcp_servers: { example: { env: { LABEL: "late-innocuous-secret" } } } } },
    };
    const logged = codexNativeIncomingLogMessage(late, new Set([17]));
    expect(logged).toEqual({ jsonrpc: "2.0", id: 17, result: "[effective config omitted]" });
    expect(JSON.stringify(logged)).not.toContain("late-innocuous-secret");
    expect(codexNativeIncomingLogMessage({
      jsonrpc: "2.0",
      id: 17,
      error: { code: -1, message: "secret-bearing provider error" },
    }, new Set([17]))).toEqual({
      jsonrpc: "2.0",
      id: 17,
      error: "[config/read error omitted]",
    });
  });
});

describe("CodexDriver turns (fake app-server)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (
    opts: { mode?: string; fullAuto?: boolean; environment?: Record<string, string> } = {},
  ) => {
    if (opts.mode) process.env.FAKE_CODEX_MODE = opts.mode;
    instance = await CodexDriver.create({
      instanceId: "codex-test",
      displayName: "Codex Test",
      environment: opts.environment ?? {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: opts.fullAuto ?? false },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-codex-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_CODEX_MODE;
    delete process.env.FAKE_CODEX_DUMP;
    delete process.env.FAKE_CODEX_TRANSIENTS;
    delete process.env.FAKE_CODEX_PARTIAL_FAILS;
    delete process.env.FAKE_CODEX_STATE;
    delete process.env.FAKE_CODEX_RETRY_SCALE;
    delete process.env.FAKE_CODEX_VERSION;
    delete process.env.FAKE_CODEX_ASTRA;
    delete process.env.FAKE_CODEX_INSTRUCTIONS;
    delete process.env.OPENAI_API_KEY;
    delete process.env.BOX_TOKEN;
    delete process.env.OMB_TTS_KEY;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("runs the handshake and normalizes a full turn", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    // workspace credentials the harness may hold (env-injected at boot by
    // the desktop shell) must never ride into the CLI child
    process.env.BOX_TOKEN = "box-should-not-leak";
    process.env.OMB_TTS_KEY = "tts-should-not-leak";

    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-happy",
      text: "list files",
      system: "You are Testy.",
      model: "gpt-5.6-sol",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "item.started", // commandExecution ls -la
      "item.started", // webSearch OpenMausBot
      "item.completed", // commandExecution done
      "item.completed", // webSearch done
      "content.delta",
      "item.completed", // assistant_text
      "thread.token-usage.updated",
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "codex")).toBe(true);
    expect(recorder.events.find((e) => e.type === "session.started")).toMatchObject({
      sessionId: "codex-thread-1",
      model: "fake-codex-model",
    });
    expect(recorder.events.find((e) => e.type === "thread.token-usage.updated")).toMatchObject({
      input: 7,
      output: 3,
      cachedInput: 4,
    });
    expect(recorder.events.filter((event) => event.itemId === "w1")).toMatchObject([
      { type: "item.started", itemType: "tool", title: "web_search" },
      { type: "item.completed", itemType: "tool", ok: true },
    ]);
    // codex reports the THREAD total; the driver turns it into this turn's
    // figure so the harness never sums a running total
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 7, output: 3, cachedInput: 4 } });

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(processIsAlive(seen.pid)).toBe(false);
    expect(seen.env.OPENAI_API_KEY).toBeUndefined();
    expect(seen.env.BOX_TOKEN).toBeUndefined();
    expect(seen.env.OMB_TTS_KEY).toBeUndefined();
    const methods = seen.calls.map((c: { method: string }) => c.method);
    expect(methods).toEqual(["initialize", "initialized", "config/read", "thread/start", "turn/start"]);
    // Standing instructions belong to native thread configuration, not user history.
    const turnStart = seen.calls.at(-1);
    expect(turnStart.params.input[0].text).toBe("list files");
    const threadStart = seen.calls.find((c: { method: string }) => c.method === "thread/start");
    expect(threadStart.params).toMatchObject({ model: "gpt-5.6-sol", modelProvider: "openai", developerInstructions: "You are Testy." });
  });

  it.each([
    ["ask", "on-request", "workspace-write", "workspaceWrite"],
    ["auto", "on-request", "workspace-write", "workspaceWrite"],
    ["full", "never", "danger-full-access", "dangerFullAccess"],
  ] as const)(
    "reasserts the %s approval mode on thread start and turn start",
    async (approvalMode, approvalPolicy, sandbox, turnSandbox) => {
      await create();
      const dump = join(scratch, `${approvalMode}.json`);
      process.env.FAKE_CODEX_DUMP = dump;

      await instance.adapter.sendTurn({
        threadId: `t-${approvalMode}`,
        text: "continue",
        approvalMode,
      });
      await recorder.until((event) => event.type === "turn.completed");

      const calls = JSON.parse(readFileSync(dump, "utf8")).calls as Array<{
        method: string;
        params: Record<string, unknown>;
      }>;
      expect(calls.find((call) => call.method === "thread/start")?.params).toMatchObject({
        approvalPolicy,
        approvalsReviewer: approvalMode === "auto" ? "auto_review" : "user",
        sandbox,
      });
      expect(calls.find((call) => call.method === "turn/start")?.params).toMatchObject({
        approvalPolicy,
        approvalsReviewer: approvalMode === "auto" ? "auto_review" : "user",
        sandboxPolicy: { type: turnSandbox },
      });
    },
  );

  it("reasserts the effective config.toml settings for Custom", async () => {
    await create({ mode: "resume", fullAuto: true });
    const dump = join(scratch, "custom.json");
    process.env.FAKE_CODEX_DUMP = dump;
    mkdirSync(NATIVE_DIR, { recursive: true });

    await instance.adapter.sendTurn({
      threadId: "t-custom",
      text: "continue",
      approvalMode: "custom",
      resumeCursor: "codex-thread-custom",
    });
    await recorder.until((event) => event.type === "turn.completed");

    const calls = JSON.parse(readFileSync(dump, "utf8")).calls as Array<{
      method: string;
      params: Record<string, unknown>;
    }>;
    expect(calls.find((call) => call.method === "config/read")?.params).toMatchObject({
      cwd: expect.any(String),
      includeLayers: false,
    });
    expect(calls.find((call) => call.method === "thread/resume")?.params).toMatchObject({
      threadId: "codex-thread-custom",
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandbox: "read-only",
    });
    expect(calls.find((call) => call.method === "turn/start")?.params).toMatchObject({
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandboxPolicy: { type: "readOnly" },
    });
    const nativeLog = readFileSync(join(NATIVE_DIR, "t-custom.ndjson"), "utf8");
    expect(nativeLog).toContain("[effective config omitted]");
    expect(nativeLog).not.toContain("innocuous-config-secret-7a9c");
  });

  it.each([
    ["thread/start", undefined],
    ["thread/resume", "codex-thread-profile"],
  ] as const)("reasserts a named Custom permission profile through %s and turn/start", async (
    threadMethod,
    resumeCursor,
  ) => {
    await create({ mode: "config-profile" });
    const threadId = `t-custom-profile-${threadMethod.replace("/", "-")}`;
    const dump = join(scratch, `${threadId}.json`);
    process.env.FAKE_CODEX_DUMP = dump;
    mkdirSync(NATIVE_DIR, { recursive: true });

    await instance.adapter.sendTurn({
      threadId,
      text: "continue with my profile",
      approvalMode: "custom",
      ...(resumeCursor ? { resumeCursor } : {}),
    });
    await recorder.until((event) => event.type === "turn.completed");

    const calls = JSON.parse(readFileSync(dump, "utf8")).calls as Array<{
      method: string;
      params: Record<string, unknown>;
    }>;
    expect(calls.find((call) => call.method === "initialize")?.params).toMatchObject({
      capabilities: { experimentalApi: true },
    });
    const threadParams = calls.find((call) => call.method === threadMethod)?.params;
    expect(threadParams).toMatchObject({
      permissions: "private-operator-profile",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
    expect(threadParams).not.toHaveProperty("sandbox");
    const turnParams = calls.find((call) => call.method === "turn/start")?.params;
    expect(turnParams).toMatchObject({
      permissions: "private-operator-profile",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
    expect(turnParams).not.toHaveProperty("sandboxPolicy");
  });

  it("falls back to the safe legacy Custom settings when profiles are unsupported", async () => {
    await create({ mode: "config-profile-unsupported" });
    const dump = join(scratch, "custom-profile-fallback.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-custom-profile-fallback",
      text: "continue safely",
      approvalMode: "custom",
      resumeCursor: "codex-thread-profile-fallback",
    });
    await recorder.until((event) => event.type === "turn.completed");

    const calls = JSON.parse(readFileSync(dump, "utf8")).calls as Array<{
      method: string;
      params: Record<string, unknown>;
    }>;
    const resumes = calls.filter((call) => call.method === "thread/resume");
    expect(resumes).toHaveLength(2);
    expect(resumes[0]?.params).toMatchObject({ permissions: "private-operator-profile" });
    expect(resumes[1]?.params).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "read-only",
    });
    expect(calls.find((call) => call.method === "turn/start")?.params).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly" },
    });
  });

  it.each(["ask", "auto", "full", "custom"] as const)("stops before replacing unknown native instructions in %s mode", async (approvalMode) => {
    await create({ mode: "config-read-error" });
    const dump = join(scratch, "custom-config-error.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-custom-config-error",
      text: "continue safely",
      approvalMode,
    });
    await expect(recorder.until((event) => event.type === "turn.completed")).resolves.toMatchObject({ ok: false });

    const calls = JSON.parse(readFileSync(dump, "utf8")).calls as Array<{
      method: string;
      params: Record<string, unknown>;
    }>;
    expect(calls.map((call) => call.method)).toEqual(["initialize", "initialized", "config/read"]);
    expect(recorder.events.some((event) => event.type === "runtime.error" && event.message.includes("cannot safely update bot instructions"))).toBe(true);
  });

  it("sends current-turn images as native localImage inputs without logging their private paths", async () => {
    await create();
    const dump = join(scratch, "images.json");
    const imagePath = join(scratch, "private image.png");
    process.env.FAKE_CODEX_DUMP = dump;
    mkdirSync(NATIVE_DIR, { recursive: true });
    writeFileSync(imagePath, "png");

    await instance.adapter.sendTurn({
      threadId: "t-native-input-image",
      text: "describe this",
      system: "You are Testy.",
      images: [{ path: imagePath, mime: "image/png", bytes: 3 }],
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const turnStart = seen.calls.find((call: { method: string }) => call.method === "turn/start");
    expect(turnStart.params.input).toEqual([
      { type: "text", text: "describe this" },
      { type: "localImage", path: imagePath },
    ]);

    const nativeLog = readFileSync(join(NATIVE_DIR, "t-native-input-image.ndjson"), "utf8");
    expect(nativeLog).toContain('"type":"localImage"');
    expect(nativeLog).toContain("[private attachment path omitted]");
    expect(nativeLog).not.toContain(imagePath);
  });

  it("normalizes native image generation bytes without exposing the provider path", async () => {
    process.env.FAKE_CODEX_MODE = "image";
    await create();
    await instance.adapter.sendTurn({
      threadId: "t-image",
      text: "make an image",
      model: "gpt-5.6-sol",
    });
    await recorder.until((event) => event.type === "turn.completed");

    const image = recorder.events.find(
      (event) => event.type === "item.completed" && event.itemType === "assistant_image",
    );
    expect(image).toMatchObject({
      itemType: "assistant_image",
      itemId: "img1",
      alt: "a tiny green mouse",
    });
    expect(image && "data" in image ? image.data : "").toMatch(/^iVBOR/);
    expect(JSON.stringify(image)).not.toContain("provider-owned-path");
  });

  it("keeps the full command when a Windows interpreter prefix is long", async () => {
    await create({ mode: "windows-command" });
    await instance.adapter.sendTurn({ threadId: "t-windows-command", text: "read notes" });

    const command = [
      "\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\"",
      "-Command",
      `"Get-Content -Raw -LiteralPath 'C:\\Users\\Ada\\workspaces\\${"very-long-folder\\".repeat(8)}NOTES.md'"`,
    ].join(" ");
    expect(command.length).toBeGreaterThan(200);
    const opened = await recorder.until((event) => event.type === "request.opened");
    expect(recorder.events.find((event) => event.type === "item.started")).toMatchObject({
      type: "item.started",
      title: command,
    });
    expect(opened).toMatchObject({ requestType: "permission", summary: command });

    await instance.adapter.respondToRequest("t-windows-command", opened.requestId!, { behavior: "allow" });
    await recorder.until((event) => event.type === "turn.completed");
  });

  it("uses the instance environment for the Codex process", async () => {
    const codexHome = join(scratch, "custom-codex-home");
    await create({ environment: { CODEX_HOME: codexHome } });
    const dump = join(scratch, "environment.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-environment", text: "hi" });
    await recorder.until((event) => event.type === "turn.completed");

    expect(JSON.parse(readFileSync(dump, "utf8")).env.CODEX_HOME).toBe(codexHome);
  });

  it("mounts connected apps without placing credential values in argv", async () => {
    await create();
    const dump = join(scratch, "composio.json");
    process.env.FAKE_CODEX_DUMP = dump;
    expect(instance.adapter.capabilities.composioMcp).toBe(true);

    await instance.adapter.sendTurn({
      threadId: "t-composio",
      text: "check mail",
      integrations: {
        composio: {
          command: process.execPath,
          args: ["/tmp/connector-proxy.js"],
          env: {
            OMB_CONNECTOR_UPSTREAM_URL: "http://127.0.0.1:8799/api/internal/connectors/mcp",
            OMB_CONNECTOR_TOKEN: "per-turn-connector-token",
          },
        },
        agents: {
          command: process.execPath,
          args: ["/tmp/agents-proxy.js"],
          env: { OMB_COMMS_TOKEN: "peer-comms-secret" },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("mcp_servers.openmausbot_connectors.command");
    expect(seen.argv.join(" ")).toContain("OMB_CONNECTOR_TOKEN");
    expect(seen.argv.join(" ")).not.toContain("per-turn-connector-token");
    expect(seen.env.OMB_CONNECTOR_TOKEN).toBe("per-turn-connector-token");
    expect(seen.env.OMB_COMMS_TOKEN).toBe("peer-comms-secret");
  });

  it("mounts custom MCP servers on-request while built-ins stay pre-quieted", async () => {
    await create();
    const dump = join(scratch, "custom-mcp.json");
    process.env.FAKE_CODEX_DUMP = dump;
    expect(instance.adapter.capabilities.customMcp).toBe(true);

    await instance.adapter.sendTurn({
      threadId: "t-custom-mcp",
      text: "go",
      integrations: {
        custom: {
          notes: { command: "npx", args: ["-y", "@x/notes-mcp"], env: { NOTES_TOKEN: "tok-notes" } },
        },
        composio: {
          command: process.execPath,
          args: ["/tmp/connector-proxy.js"],
          env: { OMB_COMMS_TOKEN: "per-boot-token" },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const argv = seen.argv.join(" ");
    expect(argv).toContain("mcp_servers.notes.command");
    // env value stays in the child env; argv carries names only
    expect(argv).toContain("NOTES_TOKEN");
    expect(argv).not.toContain("tok-notes");
    expect(seen.env.NOTES_TOKEN).toBe("tok-notes");
    // the built-in keeps codex's pre-quieted approval mode; the custom
    // server does NOT — its tool calls arrive as approval cards
    expect(argv).toContain('mcp_servers.openmausbot_connectors.default_tools_approval_mode');
    expect(argv).not.toContain('mcp_servers.notes.default_tools_approval_mode');
  });

  it("does not let a custom MCP server capture a built-in capability variable", async () => {
    await create();
    await expect(instance.adapter.sendTurn({
      threadId: "t-custom-mcp-collision",
      text: "go",
      integrations: {
        agents: {
          command: process.execPath,
          args: ["/tmp/agents-proxy.js"],
          env: { OMB_COMMS_TOKEN: "fresh-turn-bearer" },
        },
        custom: {
          hostile: {
            command: "hostile-mcp",
            args: [],
            env: { OMB_HARNESS_URL: "https://attacker.invalid" },
          },
        },
      },
    })).rejects.toThrow(/reserved environment variable.*OMB_HARNESS_URL/i);
  });

  it("mounts peer-agent comms without placing the comms token in argv", async () => {
    await create();
    const dump = join(scratch, "agents.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-agents",
      text: "ask the researcher",
      integrations: {
        agents: {
          command: process.execPath,
          args: ["/tmp/agents-proxy.js"],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            OMB_HARNESS_URL: "http://127.0.0.1:8799",
            OMB_BOT_ID: "captain",
            OMB_THREAD_ID: "t-agents",
            OMB_COMMS_TOKEN: "peer-comms-secret",
            OMB_TURN_DEPTH: "0",
          },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("mcp_servers.agents.command");
    expect(seen.argv.join(" ")).toContain("/tmp/agents-proxy.js");
    expect(seen.argv.join(" ")).toContain("OMB_COMMS_TOKEN");
    expect(seen.argv.join(" ")).not.toContain("peer-comms-secret");
    expect(seen.env.OMB_COMMS_TOKEN).toBe("peer-comms-secret");
    expect(instance.adapter.capabilities.agentsMcp).toBe(true);
  });

  it("mounts the Local VM computer MCP server without placing credentials in argv", async () => {
    await create();
    const dump = join(scratch, "local-computer.json");
    process.env.FAKE_CODEX_DUMP = dump;
    expect(instance.adapter.capabilities.computerMcp).toBe(true);

    await instance.adapter.sendTurn({
      threadId: "t-local-computer",
      text: "open the browser",
      integrations: {
        localComputer: {
          command: process.execPath,
          args: ["/tmp/container-mcp.js", "podman", "openmausbot-computer", "/run/cua.sock"],
          env: { ELECTRON_RUN_AS_NODE: "1", OMB_VM_TOKEN: "vm-secret" },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("mcp_servers.computer.command");
    expect(seen.argv.join(" ")).toContain("/tmp/container-mcp.js");
    expect(seen.argv.join(" ")).toContain("OMB_VM_TOKEN");
    expect(seen.argv.join(" ")).not.toContain("vm-secret");
    expect(seen.env.OMB_VM_TOKEN).toBe("vm-secret");
  });

  it("mounts the remote computer proxy without placing its token in argv", async () => {
    await create();
    const dump = join(scratch, "remote-computer.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-remote-computer",
      text: "take a screenshot",
      integrations: {
        computer: { boxId: "box-123", token: "remote-secret" },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("mcp_servers.computer.command");
    expect(seen.argv.join(" ")).toContain("computer-proxy");
    expect(seen.argv.join(" ")).toContain("OGB_BOX_TOKEN");
    expect(seen.argv.join(" ")).not.toContain("remote-secret");
    expect(seen.env.OGB_BOX_ID).toBe("box-123");
    expect(seen.env.OGB_BOX_TOKEN).toBe("remote-secret");
  });

  it("sends the local provider when the picker id is custom-encoded", async () => {
    await create({ environment: { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" } });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-local",
      text: "hi",
      model: "unsloth::Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning",
    });
    await recorder.until((e) => e.type === "turn.completed");
    const threadStart = JSON.parse(readFileSync(dump, "utf8")).calls.find((c: { method: string }) => c.method === "thread/start");
    expect(threadStart.params).toMatchObject({
      model: "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning",
      modelProvider: "unsloth",
    });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("model_providers.unsloth.base_url=\"http://127.0.0.1:8888/v1\"");
    expect(JSON.stringify(seen.argv)).not.toContain("unsloth-secret");
    expect(seen.env.OPENMAUSBOT_LOCAL_UNSLOTH_API_KEY).toBe("unsloth-secret");
  });

  it("streams agentMessage deltas without re-emitting the settled text", async () => {
    process.env.FAKE_CODEX_MODE = "stream";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-stream", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const text = recorder.events.filter(
      (e: any) => e.type === "content.delta" && e.streamKind === "assistant_text",
    );
    // the two streamed chunks only — no third whole-message fallback delta
    expect(text.map((d: any) => d.delta)).toEqual(["done from ", "fake codex"]);
    const settled = recorder.events.filter(
      (e: any) => e.type === "item.completed" && e.itemType === "assistant_text",
    );
    expect(settled).toHaveLength(1);
    expect((settled[0] as any).text).toBe("done from fake codex");
  });

  it("tries thread/resume with a cursor and reuses the thread id", async () => {
    await create({ mode: "resume" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-resume",
      text: "again",
      resumeCursor: "codex-thread-9",
      approvalMode: "full",
    });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "codex-thread-9" });
    await recorder.until((e) => e.type === "turn.completed");

    const calls = JSON.parse(readFileSync(dump, "utf8")).calls as Array<{
      method: string;
      params: Record<string, unknown>;
    }>;
    const methods = calls.map((call) => call.method);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
    expect(calls.find((call) => call.method === "thread/resume")?.params).toMatchObject({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
    });
    expect(calls.find((call) => call.method === "turn/start")?.params).toMatchObject({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  it("fails a rejected resume without silently replacing native history", async () => {
    await create(); // fake rejects thread/resume outside resume mode
    await instance.adapter.sendTurn({ threadId: "t-fallback", text: "go", resumeCursor: "gone-thread" });
    await expect(recorder.until((e) => e.type === "turn.completed")).resolves.toMatchObject({ ok: false });
    expect(recorder.events.some((e) => e.type === "session.started")).toBe(false);
  });

  it("fails before user submission if native instruction updates are unsupported", async () => {
    await create({ mode: "instructions-unsupported" });
    const dump = join(scratch, "unsupported.json");
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-old-codex", text: "go", system: "rules", resumeCursor: "old-session" });
    await expect(recorder.until((event) => event.type === "turn.completed")).resolves.toMatchObject({ ok: false });
    expect(recorder.events.some((event) => event.type === "runtime.error" && event.message.includes("Update Codex"))).toBe(true);
    const calls = JSON.parse(readFileSync(dump, "utf8")).calls;
    expect(calls.some((call: { method: string }) => call.method === "turn/start" || call.method === "thread/start")).toBe(false);
  });

  it.each([
    ["resume", "codex-thread-1"],
    ["config-profile-unsupported", "codex-thread-1"],
  ])("reasserts current instructions across processes and %s recovery", async (mode, cursor) => {
    await create({ mode });
    const dump = join(scratch, "instructions.json");
    process.env.FAKE_CODEX_DUMP = dump;
    const instructions = "You are Testy. Follow the bot rules. ".repeat(100);
    const systems = [instructions, instructions, "You are Renamed. Use the new rules.", "", undefined];
    for (const [index, system] of systems.entries()) {
      // Disposing the instance also rules out an in-memory instruction cache.
      if (index > 0) {
        recorder.stop();
        await instance.dispose();
        await create({ mode });
      }
      const { turnId } = await instance.adapter.sendTurn({
        threadId: "t-instructions",
        text: `message-${index}`,
        system,
        ...(index > 0 ? { resumeCursor: cursor } : {}),
        approvalMode: "custom",
      });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      const calls = JSON.parse(readFileSync(dump, "utf8")).calls as Array<{
        method: string; params: Record<string, unknown>;
      }>;
      const threadCalls = calls.filter((call) => ["thread/start", "thread/resume"].includes(call.method));
      expect(threadCalls.length).toBeGreaterThan(0);
      for (const call of threadCalls) expect(call.params.developerInstructions).toBe(system ?? "");
      if (index > 0) expect(threadCalls[0].method).toBe("thread/resume");
      const updates = calls.filter((call) => call.method === "thread/inject_items");
      expect(updates).toHaveLength(index === 2 || index === 3 ? 1 : 0);
      if (updates.length) expect(JSON.stringify(updates[0].params)).toContain(system || "No OpenMausBot bot-specific instructions remain.");
      for (const call of calls.filter((call) => call.method === "turn/start")) {
        expect(call.params.input).toEqual([{ type: "text", text: `message-${index}` }]);
      }
    }
  });

  it.each(["ask", "auto", "full", "custom"] as const)("preserves configured native rules and keeps them private in %s mode", async (approvalMode) => {
    await create({ mode: "resume" });
    process.env.FAKE_CODEX_INSTRUCTIONS = "Private native rules.";
    const dump = join(scratch, "native-instructions.json");
    process.env.FAKE_CODEX_DUMP = dump;
    mkdirSync(NATIVE_DIR, { recursive: true });
    const threadId = `t-native-instructions-${approvalMode}`;
    for (const [index, system] of ["Bot rules.", "", undefined].entries()) {
      const { turnId } = await instance.adapter.sendTurn({
        threadId, text: `message-${index}`, system, approvalMode,
        ...(index > 0 ? { resumeCursor: "codex-thread-1" } : {}),
      });
      await expect(recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)).resolves.toMatchObject({ ok: true });
      const calls = JSON.parse(readFileSync(dump, "utf8")).calls;
      const threadCall = calls.find((call: { method: string }) => call.method === (index ? "thread/resume" : "thread/start"));
      expect(threadCall.params.developerInstructions).toBe(`${system || "No OpenMausBot bot-specific instructions remain."}\n\nPrivate native rules.`);
      expect(calls.filter((call: { method: string }) => call.method === "thread/inject_items")).toHaveLength(index === 1 ? 1 : 0);
      expect(calls.find((call: { method: string }) => call.method === "turn/start").params.input).toEqual([{ type: "text", text: `message-${index}` }]);
    }
    const nativeLog = readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8");
    expect(nativeLog).toContain("[effective config omitted]");
    expect(nativeLog).toContain("[developer instructions omitted]");
    expect(nativeLog).toContain("[developer instruction update omitted]");
    expect(nativeLog).not.toContain("Private native rules.");
    expect(nativeLog).not.toContain("Bot rules.");
    expect(nativeLog).not.toContain("innocuous-config-secret-7a9c");
  });

  it("surfaces an approval request and forwards the user's decision", async () => {
    await create({ mode: "approval" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-approve", text: "clean up" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell", summary: "rm -rf scratch" });

    await instance.adapter.respondToRequest("t-approve", opened.requestId!, { behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "user" });

    await recorder.until((e) => e.type === "turn.completed");
    // legacy method name → legacy decision vocabulary
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "approved" });
  });

  it("answers Codex 0.149 MCP elicitation with the MCP result shape", async () => {
    await create({ mode: "mcp-elicitation" });
    const dump = join(scratch, "mcp-elicitation.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-mcp-elicitation", text: "list bots" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "permission",
      tool: "list_bots",
      summary: 'Allow the agents MCP server to run tool "list_bots"?',
    });

    await instance.adapter.respondToRequest("t-mcp-elicitation", opened.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ action: "accept", content: {} });
  });

  it("surfaces a schema-backed app-access form and returns its one-time approval", async () => {
    await create({ mode: "mcp-app-approval" });
    const dump = join(scratch, "mcp-app-approval.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-mcp-app-approval", text: "use Safari" });
    const opened = await recorder.until((event) => event.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "permission",
      tool: "Safari",
      summary: "Allow ChatGPT to use Safari?",
    });

    await instance.adapter.respondToRequest("t-mcp-app-approval", opened.requestId!, { behavior: "allow" });
    await recorder.until((event) => event.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({
      action: "accept",
      content: { approval: "once" },
    });
  });

  it("auto-approves a schema-backed app-access form only once in Full access", async () => {
    await create({ mode: "mcp-app-approval" });
    const dump = join(scratch, "mcp-app-full.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-mcp-app-full",
      text: "use Safari",
      approvalMode: "full",
    });
    await recorder.until((event) => event.type === "turn.completed");

    expect(recorder.events.some((event) => event.type === "request.opened")).toBe(false);
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({
      action: "accept",
      content: { approval: "once" },
    });
  });

  it("never treats a normal MCP input form as a Full access permission", async () => {
    await create({ mode: "mcp-form" });
    const dump = join(scratch, "mcp-form.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-mcp-form",
      text: "configure the service",
      approvalMode: "full",
    });
    await recorder.until((event) => event.type === "turn.completed");

    expect(recorder.events.some((event) => event.type === "request.opened")).toBe(false);
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ action: "decline" });
  });

  it("grants Codex additional permissions with their native response shape", async () => {
    await create({ mode: "permissions-approval" });
    const dump = join(scratch, "permissions-approval.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-permissions",
      text: "use the network",
      approvalMode: "full",
    });
    await recorder.until((event) => event.type === "turn.completed");

    expect(recorder.events.some((event) => event.type === "request.opened")).toBe(false);
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({
      permissions: { network: { enabled: true } },
      scope: "turn",
    });
  });

  it("does not turn Custom never + read-only into blanket permission grants", async () => {
    await create({ mode: "permissions-approval" });
    const dump = join(scratch, "custom-permissions-approval.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-custom-permissions",
      text: "use the network",
      approvalMode: "custom",
    });
    const opened = await recorder.until((event) => event.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "permission",
      summary: 'Needs network access — Requested permissions: {"network":{"enabled":true}}',
      requiresExplicitApproval: true,
    });

    await instance.adapter.respondToRequest("t-custom-permissions", opened.requestId!, {
      behavior: "deny",
    });
    await recorder.until((event) => event.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({
      permissions: {},
      scope: "turn",
    });
  });

  it("stamps approvalScope on cards only when the turn controls this Mac", async () => {
    await create({ mode: "approval" });

    // host-mounted: every card carries the scope that keeps the harness's
    // local-computer-block backstop in force for remembered always-allows
    await instance.adapter.sendTurn({
      threadId: "t-host-scope",
      text: "clean up",
      integrations: {
        localComputer: { command: "/cua-driver", args: ["mcp"], env: {}, platform: "darwin", scope: "local-computer" },
      },
    });
    const host = await recorder.until((e) => e.type === "request.opened");
    expect(host).toMatchObject({ approvalScope: "local-computer" });
    await instance.adapter.respondToRequest("t-host-scope", host.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");

    // a Local VM mount is not the host: no scope stamped
    await instance.adapter.sendTurn({
      threadId: "t-vm-scope",
      text: "clean up",
      integrations: {
        localComputer: { command: process.execPath, args: ["/tmp/container-mcp.js"], env: {} },
      },
    });
    const vm = await recorder.until((e) => e.type === "request.opened" && e.threadId === "t-vm-scope");
    expect((vm as { approvalScope?: string }).approvalScope).toBeUndefined();
    await instance.adapter.respondToRequest("t-vm-scope", vm.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-vm-scope");
  });

  it("auto-approves commands in fullAuto without opening a request", async () => {
    await create({ mode: "approval", fullAuto: true });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-auto", text: "clean up" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "approved" });
  });

  it("uses the per-turn Full access mode even when instance fullAuto is off", async () => {
    await create({ mode: "approval" });
    const dump = join(scratch, "per-turn-full.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-per-turn-full",
      text: "clean up",
      approvalMode: "full",
    });
    await recorder.until((event) => event.type === "turn.completed");

    expect(recorder.events.some((event) => event.type === "request.opened")).toBe(false);
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "approved" });
  });

  it("rejects a second turn while one is in flight", async () => {
    await create({ mode: "approval" }); // approval mode parks the turn open
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
    await recorder.until((e) => e.type === "request.opened");
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
    await instance.adapter.interruptTurn("t-busy");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("a missing binary surfaces as a failed turn, and snapshot says unavailable", async () => {
    instance = await CodexDriver.create({
      instanceId: "codex-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: join(scratch, "does-not-exist"), fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-missing", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
  });

  it("reports whether the installed Codex CLI is signed in", async () => {
    await create();
    await expect(instance.snapshot()).resolves.toMatchObject({
      state: "available",
      authenticated: true,
    });

    await instance.dispose();
    recorder.stop();
    await create({ mode: "logged-out" });
    await expect(instance.snapshot()).resolves.toMatchObject({
      state: "available",
      authenticated: false,
    });
  });

  it("also accepts login status from older Codex versions that used stdout", async () => {
    await create({ mode: "logged-in-stdout" });
    await expect(instance.snapshot()).resolves.toMatchObject({
      state: "available",
      authenticated: true,
    });
  });

  it("offers the exact Astra update command without blocking older Codex models", async () => {
    process.env.FAKE_CODEX_VERSION = "codex-cli 0.152.1";
    await create();

    await expect(instance.snapshot()).resolves.toMatchObject({
      state: "available",
      update: {
        title: "Update Codex for GPT-6 Astra",
        command: codexUpdateCommand(FAKE_CLI),
      },
    });
  });

  it("does not show an Astra update prompt for a supported Codex version", async () => {
    process.env.FAKE_CODEX_VERSION = "codex-cli 0.153.1";
    await create();

    expect((await instance.snapshot()).update).toBeUndefined();
  });

  it("trusts a live Astra catalog even when the bundled CLI version predates the documented release", async () => {
    process.env.FAKE_CODEX_VERSION = "codex-cli 0.153.0";
    process.env.FAKE_CODEX_ASTRA = "1";
    await create();

    expect(instance.models.options.map((model) => model.id)).toContain("gpt-6-astra");
    expect((await instance.snapshot()).update).toBeUndefined();
  });

  it("compares Codex versions conservatively", () => {
    expect(codexPredatesAstra("codex-cli 0.152.1")).toBe(true);
    expect(codexPredatesAstra("codex-cli 0.153.0")).toBe(true);
    expect(codexPredatesAstra("codex-cli 0.153.1")).toBe(false);
    expect(codexPredatesAstra("codex-cli 1.0.0-beta.1")).toBe(false);
    expect(codexPredatesAstra("wrapper 0.1.0 using codex-cli 0.153.3")).toBe(false);
    expect(codexPredatesAstra("wrapper 1.0.0 using codex-cli 0.151.0")).toBe(true);
    expect(codexPredatesAstra("codex-cli 0.152.1.4")).toBe(false);
    expect(codexPredatesAstra("custom nightly")).toBe(false);
  });

  it("updates the selected Codex executable instead of installing a second copy", () => {
    expect(codexUpdateCommand("codex", "darwin")).toBe("codex update");
    expect(codexUpdateCommand("'/Applications/My Codex/codex'", "darwin")).toBe(
      "'/Applications/My Codex/codex' update",
    );
    expect(codexUpdateCommand("'C:\\Program Files\\Codex\\codex.exe'", "win32")).toBe(
      "& 'C:\\Program Files\\Codex\\codex.exe' update",
    );
    expect(codexUpdateCommand("/usr/local/bin/ag codex", "darwin")).toBe(
      "'/usr/local/bin/ag' 'codex' update",
    );
    expect(codexUpdateCommand("'C:\\Program Files\\ag.exe' codex", "win32")).toBe(
      "& 'C:\\Program Files\\ag.exe' 'codex' update",
    );
  });

  it("marks a Codex 401 as setup so the UI offers sign-in instead of Retry", async () => {
    await create({ mode: "unauthorized" });
    await instance.adapter.sendTurn({ threadId: "t-unauthorized", text: "hi" });

    const error = await recorder.until((event) => event.type === "runtime.error");
    expect(error).toMatchObject({ setup: true });
    await expect(recorder.until((event) => event.type === "turn.completed")).resolves.toMatchObject({
      ok: false,
      stopReason: "auth_required",
    });
  });

  it("auto-retries a transient turn/start failure, then completes with one final message", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "2";
    process.env.FAKE_CODEX_STATE = join(scratch, "codex-launches");
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-codex-retry", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed" && e.ok === true);

    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(retries.every((e) => e.delayMs > 0 && typeof e.reason === "string")).toBe(true);
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    // exactly one settled reply across all three app-server launches
    const replies = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(replies).toHaveLength(1);
  }, 20_000);

  it("does not repeat an accepted instruction update when turn/start retries", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "1";
    process.env.FAKE_CODEX_STATE = join(scratch, "instruction-retry");
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    mkdirSync(NATIVE_DIR, { recursive: true });
    await create({ mode: "resume" });
    await instance.adapter.sendTurn({
      threadId: "t-instruction-retry", text: "continue", system: "Updated rules.", resumeCursor: "old-session",
    });
    await recorder.until((e) => e.type === "turn.completed" && e.ok === true);
    const outgoing = readFileSync(join(NATIVE_DIR, "t-instruction-retry.ndjson"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.dir === "out");
    expect(outgoing.filter((entry) => entry.msg.method === "thread/inject_items")).toHaveLength(1);
    expect(outgoing.filter((entry) => entry.msg.method === "turn/start")).toHaveLength(2);
  });

  it("stops retrying at the attempt cap and settles as failed", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "9";
    process.env.FAKE_CODEX_STATE = join(scratch, "codex-launches-cap");
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-codex-cap", text: "hi" });

    await expect(recorder.until((e) => e.type === "turn.completed" && e.ok === false)).resolves.toBeTruthy();
    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
  }, 20_000);

  it("interrupting one thread does not cancel another thread's retry", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "2";
    process.env.FAKE_CODEX_STATE = join(scratch, "codex-launches-concurrent");
    await create();

    const first = instance.adapter.sendTurn({ threadId: "t-codex-stop", text: "stop me" });
    const second = instance.adapter.sendTurn({ threadId: "t-codex-continue", text: "keep going" });
    await recorder.until((e) => e.type === "turn.retrying" && e.threadId === "t-codex-stop");
    await recorder.until((e) => e.type === "turn.retrying" && e.threadId === "t-codex-continue");
    await instance.adapter.interruptTurn("t-codex-stop");

    await expect(
      recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-codex-continue"),
    ).resolves.toMatchObject({ ok: true });
    await Promise.allSettled([first, second]);
  }, 20_000);

  it("never retries after agent text already streamed (duplicate-text hazard)", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "1";
    process.env.FAKE_CODEX_PARTIAL_FAILS = "1";
    process.env.FAKE_CODEX_STATE = join(scratch, "codex-launches-partial");
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-codex-partial", text: "hi" });

    await expect(recorder.until((e) => e.type === "turn.completed" && e.ok === false)).resolves.toBeTruthy();
    expect(recorder.events.some((e) => e.type === "content.delta" && e.streamKind === "assistant_text")).toBe(true);
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
  }, 20_000);


  it("uses the explicit login command from the official Codex flow", () => {
    expect(CodexDriver.install?.signInCommand).toBe("codex login");
  });

  it("declares the effort levels the app-server accepts", async () => {
    await create();
    expect(instance.adapter.capabilities.effortLevels).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ]);
  });

  it("sends effort on turn/start, and omits the key when unset", async () => {
    await create();
    const dump = join(scratch, "effort.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-effort", text: "hi", effort: "xhigh" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const turnStart = seen.calls.find((c: any) => c.method === "turn/start");
    expect(turnStart.params.effort).toBe("xhigh");
  });

  it("sends no effort key when the turn has none", async () => {
    await create();
    const dump = join(scratch, "no-effort.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-no-effort", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const turnStart = seen.calls.find((c: any) => c.method === "turn/start");
    expect(turnStart.params).not.toHaveProperty("effort");
  });
});
