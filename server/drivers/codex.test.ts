// Codex driver contract tests, run against the scripted fake app-server
// in server/testing/fake-codex-app-server.ts — the driver must drive the
// JSON-RPC handshake, normalize notifications into canonical events, and
// surface server->client approval requests as request.opened.
//
// The fake is a shebang script — the same constraint codex.cmd itself
// hits on Windows. resolveCliSpawn covers both, so these run everywhere.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { CodexDriver, ensureOpenMausCodexHome } from "./codex.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");

describe("CodexDriver.decodeConfig", () => {
  it("defaults to the codex binary with fullAuto off", () => {
    expect(CodexDriver.decodeConfig({})).toEqual({ cli: "codex", fullAuto: false });
    expect(CodexDriver.decodeConfig(undefined)).toEqual({ cli: "codex", fullAuto: false });
    expect(CodexDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
    // anything non-true is off — a truthy string must not enable full auto
    expect(CodexDriver.decodeConfig({ fullAuto: "yes" }).fullAuto).toBe(false);
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
    delete process.env.OPENAI_API_KEY;
    delete process.env.BOX_TOKEN;
    delete process.env.OMB_TTS_KEY;
    delete process.env.AOS_STARTUP_DIRECTIVE;
    delete process.env.FAKE_CODEX_APPROVAL_COMMAND;
    delete process.env.FAKE_CODEX_APPROVAL_KIND;
    delete process.env.FAKE_CODEX_APPROVAL_SERVER_NAME;
    delete process.env.FAKE_CODEX_APPROVAL_FALLBACK_SERVER;
    delete process.env.OPENSSL_CONF;
    delete process.env.JDK_JAVA_OPTIONS;
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
    });
    expect(recorder.events.filter((event) => event.itemId === "w1")).toMatchObject([
      { type: "item.started", itemType: "tool", title: "web_search" },
      { type: "item.completed", itemType: "tool", ok: true },
    ]);
    // codex reports the THREAD total; the driver turns it into this turn's
    // figure so the harness never sums a running total
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 7, output: 3 } });

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.OPENAI_API_KEY).toBeUndefined();
    expect(seen.env.BOX_TOKEN).toBeUndefined();
    expect(seen.env.OMB_TTS_KEY).toBeUndefined();
    const methods = seen.calls.map((c: { method: string }) => c.method);
    expect(methods).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    // persona rides in front of the prompt text — codex has no system slot
    const turnStart = seen.calls.at(-1);
    expect(turnStart.params.input[0].text).toBe("You are Testy.\n\nlist files");
    const threadStart = seen.calls.find((c: { method: string }) => c.method === "thread/start");
    expect(threadStart.params).toMatchObject({ model: "gpt-5.6-sol", modelProvider: "openai" });
  });

  it("keeps local computer capability profile-aware while exposing the scoped profile", async () => {
    await create({ fullAuto: true });
    expect(instance.adapter.capabilities.localComputerMcp).toBe(false);
    expect(instance.adapter.capabilities.fullTaskScoped).toBe(true);
  });

  it("keeps the full command when a Windows interpreter prefix is long", async () => {
    await create({ mode: "windows-command" });
    await instance.adapter.sendTurn({ threadId: "t-windows-command", text: "read notes" });

    const command = [
      "\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\"",
      "-Command",
      `\"Get-Content -Raw -LiteralPath 'C:\\Users\\Ada\\workspaces\\${"very-long-folder\\".repeat(8)}NOTES.md'\"`,
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

  it("uses a dedicated keyring-only CODEX_HOME and explicit gateway for the full profile", async () => {
    await create();
    const dump = join(scratch, "full-profile.json");
    process.env.FAKE_CODEX_DUMP = dump;
    process.env.AOS_STARTUP_DIRECTIVE = "must-not-survive";

    await instance.adapter.sendTurn({
      threadId: "t-full-profile",
      turnToken: "turn-token-123456789012345678901234",
      text: "work",
      system: "OpenMaus explicit prompt",
      accessProfile: "full-task-scoped",
      autoApprove: true,
      integrations: {
        capabilityGateway: {
          command: process.execPath,
          args: ["/tmp/capability-proxy.js"],
          env: { OMB_TURN_TOKEN: "turn-token-123456789012345678901234" },
        },
        localComputer: {
          command: process.execPath,
          args: ["/tmp/computer.js"],
          env: {},
          scope: "local-computer",
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.AOS_STARTUP_DIRECTIVE).toBeUndefined();
    expect(seen.env.CODEX_HOME).toBe(ensureOpenMausCodexHome());
    const config = readFileSync(join(seen.env.CODEX_HOME, "config.toml"), "utf8");
    expect(config).toContain('cli_auth_credentials_store = "keyring"');
    expect(config).toContain("project_doc_max_bytes = 0");
    expect(config).toContain('default_permissions = "openmaus-gateway-only"');
    expect(config).toContain("shell_tool = false");
    expect(config).toContain("unified_exec = false");
    expect(config).toContain("hooks = false");
    expect(config).not.toContain(`[permissions.openmaus-gateway-only.filesystem]`);
    expect(config).not.toContain('":minimal"');
    expect(config).toContain("enabled = false");
    const argv = seen.argv.join(" ");
    expect(argv).toContain("mcp_servers.openmaus_capabilities.command");
    expect(argv).toContain('mcp_servers.openmaus_capabilities.default_tools_approval_mode="auto"');
    expect(argv).not.toContain("mcp_servers.computer");
    const start = seen.calls.find((call: { method: string }) => call.method === "thread/start");
    expect(start.params).toMatchObject({ permissions: "openmaus-gateway-only", approvalPolicy: "on-request" });
    expect(start.params.sandbox).toBeUndefined();
  });

  it("strips process-control environment from full-task children and MCP mounts", async () => {
    await create({
      environment: {
        NoDe_OpTiOnS: "--require=/tmp/provider-preload.js",
        DYLD_INSERT_LIBRARIES: "/tmp/provider-preload.dylib",
        Path: "/tmp/provider-bin",
        OMB_GRAPH_SAFE_SETTING: "retained",
        Node_Path: "/tmp/foreign-node-modules",
      },
    });
    const dump = join(scratch, "full-profile-environment.json");
    process.env.FAKE_CODEX_DUMP = dump;
    process.env.OPENSSL_CONF = "/tmp/inherited-openssl.cnf";
    process.env.JDK_JAVA_OPTIONS = "-javaagent:/tmp/foreign-agent.jar";

    await instance.adapter.sendTurn({
      threadId: "t-full-profile-environment",
      turnToken: "turn-token-environment-123456789012345",
      text: "work",
      accessProfile: "full-task-scoped",
      integrations: {
        capabilityGateway: {
          command: process.execPath,
          args: ["/tmp/capability-proxy.js"],
          env: {
            OMB_TURN_TOKEN: "turn-token-environment-123456789012345",
            lD_pReLoAd: "/tmp/proxy-preload.dylib",
            PYTHONSTARTUP: "/tmp/proxy-startup.py",
          },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    for (const name of [
      "NoDe_OpTiOnS", "DYLD_INSERT_LIBRARIES", "Path", "HOME", "TMPDIR",
      "OPENSSL_CONF", "JDK_JAVA_OPTIONS", "Node_Path", "OMB_GRAPH_SAFE_SETTING",
    ]) {
      expect(seen.env[name]).toBeUndefined();
    }
    expect(seen.env.PATH).not.toBe("/tmp/provider-bin");
    expect(seen.env.OMB_TURN_TOKEN).toBe("turn-token-environment-123456789012345");
    expect(JSON.stringify(seen.argv)).not.toMatch(/lD_pReLoAd|PYTHONSTARTUP/);
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
            OMB_COMMS_TOKEN: "per-boot-token",
          },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("mcp_servers.openmausbot_connectors.command");
    expect(seen.argv.join(" ")).toContain("OMB_COMMS_TOKEN");
    expect(seen.argv.join(" ")).not.toContain("per-boot-token");
    expect(seen.env.OMB_COMMS_TOKEN).toBe("per-boot-token");
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

    await instance.adapter.sendTurn({ threadId: "t-resume", text: "again", resumeCursor: "codex-thread-9" });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "codex-thread-9" });
    await recorder.until((e) => e.type === "turn.completed");

    const methods = JSON.parse(readFileSync(dump, "utf8")).calls.map((c: { method: string }) => c.method);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
  });

  it("falls back to a fresh thread when resume fails", async () => {
    await create(); // fake rejects thread/resume outside resume mode
    await instance.adapter.sendTurn({ threadId: "t-fallback", text: "go", resumeCursor: "gone-thread" });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "codex-thread-1" });
    await recorder.until((e) => e.type === "turn.completed");
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

  it("forces the approval broker for graph turns even when fullAuto and turn auto-approval are enabled", async () => {
    await create({ mode: "approval", fullAuto: true });
    const dump = join(scratch, "forced-broker.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-forced-broker",
      text: "inspect the workspace",
      autoApprove: true,
      forceApprovalBroker: true,
    });
    const opened = await recorder.until((event) => event.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission" });
    await instance.adapter.respondToRequest("t-forced-broker", opened.requestId!, { behavior: "deny" });
    await recorder.until((event) => event.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "denied" });
  });

  it("auto-approves an ordinary scoped delete in full-task-scoped mode", async () => {
    await create({ mode: "approval" });
    const dump = join(scratch, "full-delete.json");
    process.env.FAKE_CODEX_DUMP = dump;
    process.env.FAKE_CODEX_APPROVAL_KIND = "gateway";

    await instance.adapter.sendTurn({
      threadId: "t-full-delete",
      turnToken: "turn-token-123456789012345678901234",
      text: "clean up",
      accessProfile: "full-task-scoped",
      autoApprove: true,
    });
    await recorder.until((event) => event.type === "turn.completed");
    expect(recorder.events.some((event) => event.type === "request.opened")).toBe(false);
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ action: "accept" });
  });

  it("keeps auto-approval independent from the full-task-scoped capability profile", async () => {
    await create({ mode: "approval", fullAuto: true });
    const dump = join(scratch, "full-manual.json");
    process.env.FAKE_CODEX_DUMP = dump;
    process.env.FAKE_CODEX_APPROVAL_KIND = "gateway";

    await instance.adapter.sendTurn({
      threadId: "t-full-manual",
      turnToken: "turn-token-123456789012345678901234",
      text: "clean up",
      accessProfile: "full-task-scoped",
      autoApprove: false,
    });
    const opened = await recorder.until((event) => event.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "call_capability" });
    await instance.adapter.respondToRequest("t-full-manual", opened.requestId!, { behavior: "deny" });
    await recorder.until((event) => event.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ action: "decline" });
  });

  it("fails closed when MCP elicitation omits the exact gateway serverName", async () => {
    await create({ mode: "approval" });
    const dump = join(scratch, "full-invalid-server.json");
    process.env.FAKE_CODEX_DUMP = dump;
    process.env.FAKE_CODEX_APPROVAL_KIND = "gateway";
    process.env.FAKE_CODEX_APPROVAL_SERVER_NAME = "not-openmaus";
    process.env.FAKE_CODEX_APPROVAL_FALLBACK_SERVER = "openmaus_capabilities";

    await instance.adapter.sendTurn({
      threadId: "t-full-invalid-server",
      turnToken: "turn-token-123456789012345678901234",
      text: "clean up",
      accessProfile: "full-task-scoped",
      autoApprove: true,
    });
    await recorder.until((event) => event.type === "turn.completed");
    expect(recorder.events.some((event) => event.type === "request.opened")).toBe(false);
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ action: "decline" });
  });

  it("rejects provider-native effects and directs the model through the gateway", async () => {
    await create({ mode: "approval" });
    const dump = join(scratch, "full-native-reject.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-full-native-reject",
      turnToken: "turn-token-123456789012345678901234",
      text: "clean up",
      accessProfile: "full-task-scoped",
      autoApprove: true,
    });
    await recorder.until((event) => event.type === "turn.completed");
    expect(recorder.events.some((event) => event.type === "request.opened")).toBe(false);
    expect(recorder.events.some((event) => event.type === "runtime.error" && /openmaus_capabilities/.test(event.message))).toBe(true);
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "denied" });
  });

  it("centrally declines catastrophic destruction in full-task-scoped mode", async () => {
    await create({ mode: "approval" });
    const dump = join(scratch, "full-deny.json");
    process.env.FAKE_CODEX_DUMP = dump;
    process.env.FAKE_CODEX_APPROVAL_COMMAND = "bash -lc 'rm -rf /'";

    await instance.adapter.sendTurn({
      threadId: "t-full-deny",
      turnToken: "turn-token-123456789012345678901234",
      text: "destroy",
      accessProfile: "full-task-scoped",
    });
    await recorder.until((event) => event.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "denied" });
    expect(recorder.events.some((event) => event.type === "runtime.error" && /catastrophic-destruction/.test(event.message))).toBe(true);
  });

  it("rejects a second turn while one is in flight", async () => {
    await create({ mode: "approval" }); // approval mode parks the turn open
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
    await recorder.until((e) => e.type === "request.opened");
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
    await expect(instance.adapter.interruptTurn("t-busy", "wrong-turn")).rejects.toThrow(/identity does not match/);
    expect(instance.adapter.hasSession("t-busy")).toBe(true);
    await instance.adapter.interruptTurn("t-busy", turnId);
    expect(instance.adapter.hasSession("t-busy")).toBe(false);
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
