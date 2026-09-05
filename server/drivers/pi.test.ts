// pi driver contract tests, run against the scripted fake `pi` CLI in
// server/testing/fake-pi-cli.ts: parse the live catalog, normalize a full
// RPC turn into canonical events, ride the toolUse→end_turn auto-continue,
// broker a permission ask, and report availability from `pi --version`.
//
// The fake CLI is a shebang script Windows cannot exec directly; spawnCli
// resolves it to `node <script>`, so these run everywhere.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { encodeInjectId, localHost } from "./local-inject.ts";
import {
  applyPiLocalCatalog,
  buildMcpServers,
  ensurePiInjectModel,
  fetchPiModels,
  parsePiCatalog,
  PiDriver,
  preferPiInjectRows,
  splitPiModel,
} from "./pi.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-pi-cli.ts");
const MODELS_LINE =
  '{"type":"response","command":"get_available_models","success":true,"data":{"models":[{"provider":"ollama-cloud","id":"glm-5.2","name":"glm-5.2"},{"provider":"openai","id":"gpt-4o","name":"GPT-4o"}]}}';

describe("parsePiCatalog", () => {
  it("turns a get_available_models response into custom composite-id options", () => {
    const catalog = parsePiCatalog(MODELS_LINE + "\n");
    expect(catalog.default).toBe("ollama-cloud/glm-5.2");
    expect(catalog.options).toEqual([
      { id: "ollama-cloud/glm-5.2", label: "glm-5.2", custom: true, provider: "ollama-cloud" },
      { id: "openai/gpt-4o", label: "GPT-4o", custom: true, provider: "openai" },
    ]);
  });

  it("uses the fallback default when the response omits one and a settings file is absent", () => {
    const catalog = parsePiCatalog(MODELS_LINE + "\n", "openai/gpt-4o");
    expect(catalog.default).toBe("openai/gpt-4o");
  });

  it("reports the provider so BYOK duplicates of one model stay distinguishable", () => {
    const line =
      '{"type":"response","command":"get_available_models","success":true,"data":{"models":[' +
      '{"provider":"zai","id":"glm-5.3","name":"GLM-5.3"},' +
      '{"provider":"nous","id":"glm-5.3","name":"GLM-5.3"}]}}\n';
    const catalog = parsePiCatalog(line);
    expect(catalog.options.map((o) => [o.id, o.provider])).toEqual([
      ["zai/glm-5.3", "zai"],
      ["nous/glm-5.3", "nous"],
    ]);
  });

  it("keeps an empty catalog when the probe fails or reports no models", () => {
    expect(parsePiCatalog("not json\n")).toEqual({ default: "", options: [] });
    expect(parsePiCatalog('{"type":"response","command":"get_available_models","success":false}\n')).toEqual({
      default: "",
      options: [],
    });
    expect(
      parsePiCatalog('{"type":"response","command":"get_available_models","success":true,"data":{"models":[]}}\n'),
    ).toEqual({ default: "", options: [] });
  });

  it("ignores non-response lines (pi emits TUI bookkeeping on stdout too)", () => {
    const stdout =
      '{"type":"extension_ui_request","id":"x","method":"setStatus","statusKey":"loops"}\n' + MODELS_LINE + "\n";
    const catalog = parsePiCatalog(stdout);
    expect(catalog.options).toHaveLength(2);
  });
});

describe("buildMcpServers", () => {
  it("returns null when there are no integrations", () => {
    expect(buildMcpServers({ threadId: "t", text: "hi" })).toBeNull();
  });

  it("passes composio/agents/phone through as stdio servers", () => {
    const servers = buildMcpServers({
      threadId: "t",
      text: "hi",
      integrations: {
        composio: { command: "node", args: ["c"], env: { A: "1" } },
        agents: { command: "node", args: ["a"], env: { B: "2" } },
        phone: { command: "node", args: ["p"], env: {} },
      },
    });
    expect(servers).toEqual({
      composio: { command: "node", args: ["c"], env: { A: "1" } },
      agents: { command: "node", args: ["a"], env: { B: "2" } },
      phone: { command: "node", args: ["p"], env: {} },
    });
  });

  it("wraps the cloud computer in the computer-proxy spawn contract", () => {
    const servers = buildMcpServers({
      threadId: "t",
      text: "hi",
      integrations: {
        computer: { kind: "box", boxId: "b1", token: "tok", control: { url: "http://c", token: "ct" } },
      },
    });
    expect(servers?.computer).toMatchObject({
      command: process.execPath,
      args: [expect.stringContaining("computer-proxy")],
      env: expect.objectContaining({ OGB_BOX_ID: "b1", OGB_BOX_TOKEN: "tok" }),
    });
  });

  it("passes a local computer (Cua/VPS) through as a direct stdio server", () => {
    const servers = buildMcpServers({
      threadId: "t",
      text: "hi",
      integrations: {
        localComputer: { command: "node", args: ["mcp"], env: { X: "y" } },
      },
    });
    expect(servers?.computer).toEqual({ command: "node", args: ["mcp"], env: { X: "y" } });
  });

  it("marks a host computer with scope so the extension gates its tools", () => {
    const servers = buildMcpServers({
      threadId: "t",
      text: "hi",
      integrations: {
        localComputer: { command: "node", args: ["mcp"], env: {}, scope: "local-computer" },
      },
    });
    expect(servers?.computer).toMatchObject({ scope: "local-computer" });
  });
});

describe("PiDriver config + install", () => {
  it("defaults to the `pi` binary", () => {
    expect(PiDriver.decodeConfig({})).toEqual({ cli: "pi", fullAuto: false });
    expect(PiDriver.decodeConfig(undefined)).toEqual({ cli: "pi", fullAuto: false });
    expect(PiDriver.decodeConfig(null)).toEqual({ cli: "pi", fullAuto: false });
    expect(PiDriver.decodeConfig({ cli: "  " })).toEqual({ cli: "pi", fullAuto: false });
  });

  it("rejects invalid config (throws → shadow snapshot)", () => {
    expect(() => PiDriver.decodeConfig(5)).toThrow(/object/);
    expect(() => PiDriver.decodeConfig({ cli: 5 })).toThrow(/string/);
    expect(() => PiDriver.decodeConfig({ fullAuto: "yes" })).toThrow(/boolean/);
  });

  it("publishes the npm installer on every platform and points docs at pi.dev", () => {
    expect(PiDriver.install).toMatchObject({
      command: {
        darwin: "npm install -g @earendil-works/pi-coding-agent",
        linux: "npm install -g @earendil-works/pi-coding-agent",
        win32: "npm install -g @earendil-works/pi-coding-agent",
      },
      docsUrl: "https://pi.dev",
      needsNode: true,
    });
    expect(PiDriver.metadata).toMatchObject({ displayName: "pi", access: "custom" });
  });
});

describe("PiDriver catalog (fake CLI)", () => {
  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });

  it("probes the live catalog and flags every option custom", async () => {
    const catalog = await fetchPiModels(FAKE_CLI, { PATH: process.env.PATH ?? "", HOME: join(tmpdir(), "omb-pi-no-settings") });
    expect(catalog.options).toEqual([
      { id: "ollama-cloud/glm-5.2", label: "glm-5.2", custom: true, provider: "ollama-cloud" },
      { id: "openai/gpt-4o", label: "gpt-4o", custom: true, provider: "openai" },
    ]);
    // no ~/.pi/agent/settings.json in the throwaway home → first option wins
    expect(catalog.default).toBe("ollama-cloud/glm-5.2");
  });

  it("keeps an empty catalog when the probe reports no models", async () => {
    const catalog = await fetchPiModels(FAKE_CLI, {
      PATH: process.env.PATH ?? "",
      HOME: join(tmpdir(), "omb-pi-empty"),
      FAKE_PI_MODE: "no-models",
    });
    expect(catalog.options).toEqual([]);
  });
});

describe("PiDriver turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async (
    mode?: string,
    environment: Record<string, string> = {},
    fullAuto = false,
  ) => {
    instance = await PiDriver.create({
      instanceId: "pi-test",
      displayName: "pi Test",
      environment: { ...environment, ...(mode ? { FAKE_PI_MODE: mode } : {}) },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
  });

  it("normalizes a full turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-happy",
      text: "hi",
      model: "ollama-cloud/glm-5.2",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "content.delta",
      "content.delta",
      "item.completed", // assistant_text
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "piAgent")).toBe(true);

    const session = recorder.events.find((e) => e.type === "session.started")!;
    expect((session as { sessionId: string }).sessionId).toMatch(/\/fake\/pi-session-\d+\.json/);

    const text = recorder.events.find(
      (e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text",
    )!;
    expect((text as { text: string }).text).toBe("Hello from pi");

    const done = recorder.events.at(-1)!;
    expect(done).toMatchObject({ type: "turn.completed", ok: true, stopReason: "end_turn", usage: { input: 12, output: 3 } });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("sends images as native base64 prompt content without copying bytes into diagnostics", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-image-"));
    const dump = join(dir, "dump.jsonl");
    const imagePath = join(dir, "tiny.png");
    const bytes = Buffer.from("private-image-bytes");
    const base64 = bytes.toString("base64");
    writeFileSync(imagePath, bytes);
    await create(undefined, { FAKE_PI_DUMP: dump });

    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-pi-native-image",
      text: "What is this?",
      images: [{ path: imagePath, mime: "image/png", bytes: bytes.length }],
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);

    const rows = readFileSync(dump, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { prompt?: { message?: string; images?: unknown[] } });
    expect(rows.find((row) => row.prompt)?.prompt).toEqual({
      message: "What is this?",
      images: [{ type: "image", data: base64, mimeType: "image/png" }],
    });

    const nativeLog = readFileSync(join(NATIVE_DIR, "t-pi-native-image.ndjson"), "utf8");
    expect(nativeLog).not.toContain(base64);
    expect(nativeLog).toContain(`[image data: ${base64.length} base64 chars]`);
  });

  it("resumes a prior pi session using the sessionFile resume cursor", async () => {
    await create();
    const first = await instance.adapter.sendTurn({ threadId: "t-resume", text: "first" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const firstSession = recorder.events.find((e) => e.type === "session.started" && e.turnId === first.turnId) as
      | { sessionId: string }
      | undefined;
    expect(firstSession?.sessionId).toMatch(/\/fake\/pi-session-\d+\.json/);

    const second = await instance.adapter.sendTurn({
      threadId: "t-resume",
      text: "second",
      resumeCursor: firstSession!.sessionId,
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    const secondSession = recorder.events.find((e) => e.type === "session.started" && e.turnId === second.turnId) as
      | { sessionId: string }
      | undefined;
    expect(secondSession?.sessionId).toBe(firstSession?.sessionId);
  });

  it("fails promptly when the pi process exits before replying", async () => {
    await create("exit-early");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-exit", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: false, stopReason: "failed" });
    expect(instance.adapter.hasSession("t-exit")).toBe(false);
  });

  it("surfaces a pi turn error instead of reporting an empty success", async () => {
    await create("turn-error");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-turn-error", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: false, stopReason: "failed", usage: { input: 0, output: 0 } });
    expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({
      message: "Invalid schema for function 'computer_browser_prepare'",
    });
    expect(instance.adapter.hasSession("t-turn-error")).toBe(false);
  });

  it("advertises images and every harness effort level", async () => {
    await create();
    expect(instance.adapter.capabilities.images).toBe(true);
    expect(instance.adapter.capabilities.effortLevels).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });

  it("pins reasoning effort via set_thinking_level after the model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-effort-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-effort",
      text: "hi",
      model: "ollama-cloud/glm-5.2",
      effort: "high",
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const levels = readFileSync(dump, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { thinkingLevel?: string })
      .filter((record) => record.thinkingLevel !== undefined)
      .map((record) => record.thinkingLevel!);
    expect(levels).toEqual(["high"]);
  });

  it("maps the none effort to pi's off and sends nothing without effort", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-effort-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    const none = await instance.adapter.sendTurn({ threadId: "t-none", text: "hi", effort: "none" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === none.turnId);
    const plain = await instance.adapter.sendTurn({ threadId: "t-plain", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === plain.turnId);
    const levels = readFileSync(dump, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { thinkingLevel?: string })
      .filter((record) => record.thinkingLevel !== undefined)
      .map((record) => record.thinkingLevel!);
    // exactly one pin across both turns: the "none" turn's off — a plain turn
    // must not touch the thinking level at all
    expect(levels).toEqual(["off"]);
  });

  it("scrubs provider and workspace credentials from every pi child env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-dump-"));
    const dump = join(dir, "dump.jsonl");
    // Plant a workspace credential on the harness process itself — the leak
    // path is `...process.env`, not just input.environment.
    const savedBox = process.env.BOX_TOKEN;
    const savedXai = process.env.XAI_API_KEY;
    process.env.BOX_TOKEN = "box-secret-value";
    process.env.XAI_API_KEY = "xai-secret-value";
    try {
      await create(undefined, {
        FAKE_PI_DUMP: dump,
        ANTHROPIC_API_KEY: "anthropic-secret-value",
        OPENAI_API_KEY: "openai-secret-value",
      });
      await instance.dispose();
    } finally {
      if (savedBox === undefined) delete process.env.BOX_TOKEN;
      else process.env.BOX_TOKEN = savedBox;
      if (savedXai === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = savedXai;
    }

    const rows = readFileSync(dump, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; envConfigured: string[] });
    expect(rows.some((row) => row.argv.join(" ") === "--mode rpc --no-session")).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.envConfigured).toContain("PATH");
      expect(row.envConfigured).not.toContain("ANTHROPIC_API_KEY");
      expect(row.envConfigured).not.toContain("OPENAI_API_KEY");
      expect(row.envConfigured).not.toContain("XAI_API_KEY");
      expect(row.envConfigured).not.toContain("BOX_TOKEN");
    }
    expect(JSON.stringify(rows)).not.toContain("anthropic-secret-value");
    expect(JSON.stringify(rows)).not.toContain("openai-secret-value");
  });

  it("mounts integrations as stdio MCP servers and loads the pi-mcp-extension", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-mcp-dump-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-mcp",
      text: "hi",
      integrations: {
        composio: { command: "node", args: ["connector-proxy.js"], env: { COMPOSIO_KEY: "ck" } },
        computer: { kind: "box", boxId: "b1", token: "bt", control: { url: "http://c", token: "ct" } },
      },
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    const rows = readFileSync(dump, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; mcpConfig?: { mcpServers?: Record<string, any> } | null });
    const mcpRow = rows.find((r) => r.mcpConfig != null);
    expect(mcpRow).toBeTruthy();

    // the extension rides `-e` so the external pi process mounts the servers
    const extIndex = mcpRow!.argv.indexOf("-e");
    expect(extIndex).toBeGreaterThanOrEqual(0);
    expect(mcpRow!.argv[extIndex + 1]).toContain("pi-mcp-extension");

    const servers = mcpRow!.mcpConfig!.mcpServers!;
    // composio passes through verbatim as a stdio server
    expect(servers.composio).toMatchObject({ command: "node", args: ["connector-proxy.js"], env: { COMPOSIO_KEY: "ck" } });
    // the cloud computer wraps in the computer-proxy spawn contract
    expect(servers.computer.args[0]).toContain("computer-proxy");
    expect(servers.computer.env).toMatchObject({ OGB_BOX_ID: "b1", OGB_BOX_TOKEN: "bt" });
    // the box token lives in the 0600 config file, never in argv
    expect(JSON.stringify(mcpRow!.argv)).not.toContain("bt");
  });

  it("rides the toolUse auto-continue and only settles on the final end_turn", async () => {
    await create("tooluse");
    await instance.adapter.sendTurn({ threadId: "t-tool", text: "run it" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    // a tool ran and completed, then pi auto-continued to synthesize the reply
    expect(recorder.events.filter((e) => e.type === "item.started").length).toBe(1);
    expect(recorder.events.filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "tool").length).toBe(1);
    expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
    expect((done as { usage: { input: number; output: number } }).usage).toEqual({ input: 12, output: 2 });
    const text = recorder.events.find(
      (e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text",
    ) as { text: string } | undefined;
    expect(text?.text).toBe("done");
    expect(instance.adapter.hasSession("t-tool")).toBe(false);
  });

  it("emits each assistant text block before the tool that follows it", async () => {
    await create("interleave");
    await instance.adapter.sendTurn({ threadId: "t-interleave", text: "go", model: "ollama-cloud/glm-5.2" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed", // before one
      "item.started",
      "item.completed", // tool
      "content.delta",
      "item.completed", // before two
      "item.started",
      "item.completed", // tool
      "content.delta",
      "item.completed", // after
      "turn.completed",
    ]);
    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["before one", "before two", "after"]);
  });

  it("brokers a permission ask through request.opened → respondToRequest", async () => {
    await create("permission");
    await instance.adapter.sendTurn({ threadId: "t-perm", text: "go" });
    await recorder.until((e) => e.type === "request.opened");
    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(true);

    const outcome = await instance.adapter.respondToRequest("t-perm", "ask-1", { behavior: "allow" });
    expect(outcome).toBe("allowed-once");

    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
    expect(recorder.events.some((e) => e.type === "request.resolved")).toBe(true);
  });

  it("per-bot Ask restores host approval on a legacy full-auto instance", async () => {
    await create("permission", {}, true);
    expect(instance.adapter.capabilities.localComputerMcp).toBe(true);
    const localComputer = {
      command: "/cua-driver",
      args: ["mcp"],
      env: {},
      platform: "linux" as const,
      scope: "local-computer" as const,
    };

    await expect(instance.adapter.sendTurn({
      threadId: "t-pi-legacy-full-auto",
      text: "go",
      integrations: { localComputer },
    })).rejects.toThrow(/interactive approval broker/);

    await instance.adapter.sendTurn({
      threadId: "t-pi-ask-override",
      text: "go",
      approvalMode: "ask",
      integrations: { localComputer },
    });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.respondToRequest(
      "t-pi-ask-override",
      (opened as { requestId: string }).requestId,
      { behavior: "allow" },
    );
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("registers an ask before emitting it so synchronous auto-approval works", async () => {
    await create("permission");
    let unsubscribe = () => {};
    const outcome = new Promise<string>((resolve) => {
      unsubscribe = instance.adapter.onEvent((event) => {
        if (event.type !== "request.opened" || !event.requestId) return;
        // This mirrors the harness's auto-approve listener: emit() invokes it
        // synchronously, so the ask must already be in pending here.
        void instance.adapter
          .respondToRequest(event.threadId, event.requestId, { behavior: "allow" })
          .then(resolve);
      });
    });
    await instance.adapter.sendTurn({ threadId: "t-sync-auto", text: "go" });
    expect(await outcome).toBe("allowed-once");
    unsubscribe();
    const done = await recorder.until((event) => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
  });

  it("respondToRequest is unavailable for an ask that is not pending", async () => {
    await create();
    await expect(instance.adapter.respondToRequest("t-none", "nope", { behavior: "allow" })).resolves.toBe("unavailable");
  });

  it("interruptTurn cancels a running turn", async () => {
    await create("permission");
    await instance.adapter.sendTurn({ threadId: "t-interrupt", text: "go" });
    await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.interruptTurn("t-interrupt");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
  });

  it("writes models.json and set_model for a host::model inject pick", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-pi-turn-inject-"));
    const dump = join(home, "dump.jsonl");
    await create(undefined, { HOME: home, FAKE_PI_DUMP: dump });
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-inject",
      text: "hi",
      model: encodeInjectId("omlx", "MiniMax-M3-4bit"),
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const dumps = readFileSync(dump, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { setModel?: { provider: string; modelId: string } });
    expect(dumps.some((row) => row.setModel?.provider === "omlx" && row.setModel?.modelId === "MiniMax-M3-4bit")).toBe(
      true,
    );
    const written = JSON.parse(readFileSync(join(home, ".pi", "agent", "models.json"), "utf8")) as {
      providers: { omlx: { baseUrl: string; models: Array<{ id: string }> } };
    };
    expect(written.providers.omlx.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(written.providers.omlx.models.some((m) => m.id === "MiniMax-M3-4bit")).toBe(true);
  });
});

describe("splitPiModel", () => {
  it("splits native provider/model composites, including slashes in the model id", () => {
    expect(splitPiModel("ollama-cloud/glm-5.2")).toEqual({ provider: "ollama-cloud", modelId: "glm-5.2" });
    expect(splitPiModel("openai/gpt-4o")).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(splitPiModel("openrouter/qwen/qwen3-coder-next")).toEqual({
      provider: "openrouter",
      modelId: "qwen/qwen3-coder-next",
    });
  });

  it("splits live-host inject ids on ::, not /", () => {
    expect(splitPiModel("omlx::MiniMax-M3-4bit")).toEqual({ provider: "omlx", modelId: "MiniMax-M3-4bit" });
    expect(splitPiModel("ollama::llama3.1:70b")).toEqual({ provider: "ollama", modelId: "llama3.1:70b" });
    expect(splitPiModel("unsloth::unsloth/gemma-4-26B-A4B-it-GGUF")).toEqual({
      provider: "unsloth",
      modelId: "unsloth/gemma-4-26B-A4B-it-GGUF",
    });
  });

  it("returns null for empty or unstructured ids", () => {
    expect(splitPiModel("")).toBeNull();
    expect(splitPiModel("glm-5.2")).toBeNull();
  });
});

describe("preferPiInjectRows", () => {
  it("drops host/model rows when the same live host::model is present", () => {
    const catalog = preferPiInjectRows({
      default: "omlx/MiniMax-M3-4bit",
      options: [
        { id: "omlx/MiniMax-M3-4bit", label: "MiniMax-M3-4bit", custom: true },
        { id: "openai/gpt-4o", label: "GPT-4o", custom: true },
        { id: "omlx::MiniMax-M3-4bit", label: "MiniMax-M3-4bit (oMLX)", custom: true, loaded: true },
      ],
    });
    expect(catalog.options.map((o) => o.id)).toEqual(["openai/gpt-4o", "omlx::MiniMax-M3-4bit"]);
    expect(catalog.default).toBe("omlx::MiniMax-M3-4bit");
  });

  it("leaves the catalog alone when there are no inject rows", () => {
    const catalog = {
      default: "omlx/keep",
      options: [{ id: "omlx/keep", label: "keep", custom: true as const }],
    };
    expect(preferPiInjectRows(catalog)).toEqual(catalog);
  });
});

describe("ensurePiInjectModel", () => {
  it("upserts a provider into ~/.pi/agent/models.json without dropping existing models", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-pi-inject-"));
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "models.json"),
      JSON.stringify({
        providers: {
          omlx: {
            baseUrl: "http://127.0.0.1:8080/v1",
            api: "openai-completions",
            apiKey: "omlx",
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
            models: [{ id: "keep-me", name: "Keep me", contextWindow: 8192, maxTokens: 1024 }],
          },
        },
      }),
    );
    const split = ensurePiInjectModel("omlx::MiniMax-M3-4bit", { HOME: home });
    expect(split).toEqual({ provider: "omlx", modelId: "MiniMax-M3-4bit" });
    const written = JSON.parse(readFileSync(join(home, ".pi", "agent", "models.json"), "utf8")) as {
      providers: {
        omlx: {
          baseUrl: string;
          api: string;
          apiKey: string;
          models: Array<{ id: string; contextWindow?: number }>;
        };
      };
    };
    expect(written.providers.omlx.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(written.providers.omlx.api).toBe("openai-completions");
    expect(written.providers.omlx.apiKey).toBe("omlx");
    expect(written.providers.omlx.models.map((m) => m.id)).toEqual(["keep-me", "MiniMax-M3-4bit"]);
    expect(written.providers.omlx.models[0]).toMatchObject({ id: "keep-me", contextWindow: 8192 });
  });

  it("writes Unsloth's studio token, not the placeholder", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-pi-unsloth-"));
    const split = ensurePiInjectModel("unsloth::Qwen3.8-27B", {
      HOME: home,
      UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret",
    });
    expect(split).toEqual({ provider: "unsloth", modelId: "Qwen3.8-27B" });
    const written = JSON.parse(readFileSync(join(home, ".pi", "agent", "models.json"), "utf8")) as {
      providers: { unsloth: { apiKey: string; baseUrl: string } };
    };
    expect(written.providers.unsloth.apiKey).toBe("unsloth-secret");
    expect(written.providers.unsloth.baseUrl).toBe(localHost("unsloth")!.baseUrl);
  });

  it("leaves official slugs and the models.json file untouched", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-pi-cloud-"));
    expect(ensurePiInjectModel("openai/gpt-4o", { HOME: home })).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(() => readFileSync(join(home, ".pi", "agent", "models.json"))).toThrow();
  });

  it("does not destroy a malformed models.json", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-pi-badjson-"));
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    const path = join(home, ".pi", "agent", "models.json");
    writeFileSync(path, "not json");
    expect(ensurePiInjectModel("omlx::MiniMax-M3-4bit", { HOME: home })).toEqual({
      provider: "omlx",
      modelId: "MiniMax-M3-4bit",
    });
    expect(readFileSync(path, "utf8")).toBe("not json");
  });
});

describe("applyPiLocalCatalog", () => {
  it("merges live inject rows onto the probed catalog", async () => {
    const catalog = await applyPiLocalCatalog(
      {
        default: "openai/gpt-4o",
        options: [
          { id: "openai/gpt-4o", label: "GPT-4o", custom: true },
          { id: "omlx/MiniMax-M3-4bit", label: "MiniMax-M3-4bit", custom: true },
        ],
      },
      { VITEST: "true", OPENMAUSBOT_PROBE_LOCAL_INJECT: "1" },
      async (url) => {
        if (String(url).includes(":8080")) {
          return new Response(JSON.stringify({ data: [{ id: "MiniMax-M3-4bit" }] }), { status: 200 });
        }
        return new Response("nope", { status: 500 });
      },
    );
    expect(catalog.options.some((o) => o.id === "omlx::MiniMax-M3-4bit")).toBe(true);
    expect(catalog.options.some((o) => o.id === "omlx/MiniMax-M3-4bit")).toBe(false);
    expect(catalog.options.some((o) => o.id === "openai/gpt-4o")).toBe(true);
  });
});

describe("PiDriver snapshot", () => {
  beforeEach(() => chmodSync(FAKE_CLI, 0o755));

  it("reports available with the CLI version against the fake", async () => {
    const instance = await PiDriver.create({
      instanceId: "pi-snap",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("available");
    expect(snap.version).toBe("pi 0.84.2 (fake)");
    expect(snap.authenticated).toBe(true);
    await instance.dispose();
  });

  it("reports unavailable with a reason when the CLI is missing", async () => {
    const instance = await PiDriver.create({
      instanceId: "pi-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: "pi-definitely-not-on-path-xyz", fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toMatch(/not found/);
    await instance.dispose();
  });
});
