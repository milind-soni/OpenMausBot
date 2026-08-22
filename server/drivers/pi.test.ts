// pi driver contract tests, run against the scripted fake `pi` CLI in
// server/testing/fake-pi-cli.ts: parse the live catalog, normalize a full
// RPC turn into canonical events, ride the toolUse→end_turn auto-continue,
// broker a permission ask, and report availability from `pi --version`.
//
// The fake CLI is a shebang script Windows cannot exec directly; spawnCli
// resolves it to `node <script>`, so these run everywhere.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { fetchPiModels, parsePiCatalog, PiDriver } from "./pi.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-pi-cli.ts");
const MODELS_LINE =
  '{"type":"response","command":"get_available_models","success":true,"data":{"models":[{"provider":"ollama-cloud","id":"glm-5.2","name":"glm-5.2"},{"provider":"openai","id":"gpt-4o","name":"GPT-4o"}]}}';

describe("parsePiCatalog", () => {
  it("turns a get_available_models response into custom composite-id options", () => {
    const catalog = parsePiCatalog(MODELS_LINE + "\n");
    expect(catalog.default).toBe("ollama-cloud/glm-5.2");
    expect(catalog.options).toEqual([
      { id: "ollama-cloud/glm-5.2", label: "glm-5.2", custom: true },
      { id: "openai/gpt-4o", label: "GPT-4o", custom: true },
    ]);
  });

  it("uses the fallback default when the response omits one and a settings file is absent", () => {
    const catalog = parsePiCatalog(MODELS_LINE + "\n", "openai/gpt-4o");
    expect(catalog.default).toBe("openai/gpt-4o");
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

describe("PiDriver config + install", () => {
  it("defaults to the `pi` binary", () => {
    expect(PiDriver.decodeConfig({})).toEqual({ cli: "pi" });
    expect(PiDriver.decodeConfig(undefined)).toEqual({ cli: "pi" });
    expect(PiDriver.decodeConfig(null)).toEqual({ cli: "pi" });
    expect(PiDriver.decodeConfig({ cli: "  " })).toEqual({ cli: "pi" });
  });

  it("rejects invalid config (throws → shadow snapshot)", () => {
    expect(() => PiDriver.decodeConfig(5)).toThrow(/object/);
    expect(() => PiDriver.decodeConfig({ cli: 5 })).toThrow(/string/);
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
      { id: "ollama-cloud/glm-5.2", label: "glm-5.2", custom: true },
      { id: "openai/gpt-4o", label: "gpt-4o", custom: true },
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

  const create = async (mode?: string, environment: Record<string, string> = {}) => {
    instance = await PiDriver.create({
      instanceId: "pi-test",
      displayName: "pi Test",
      environment: { ...environment, ...(mode ? { FAKE_PI_MODE: mode } : {}) },
      enabled: true,
      config: { cli: FAKE_CLI },
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
});

describe("PiDriver snapshot", () => {
  beforeEach(() => chmodSync(FAKE_CLI, 0o755));

  it("reports available with the CLI version against the fake", async () => {
    const instance = await PiDriver.create({
      instanceId: "pi-snap",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI },
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
      config: { cli: "pi-definitely-not-on-path-xyz" },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toMatch(/not found/);
    await instance.dispose();
  });
});