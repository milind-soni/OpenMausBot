// pi driver contract tests, run against the scripted fake `pi` CLI in
// server/testing/fake-pi-cli.ts: parse the live catalog, normalize a full
// RPC turn into canonical events, ride the toolUse→end_turn auto-continue,
// broker a permission ask, and report availability from `pi --version`.
//
// The fake CLI is a shebang script Windows cannot exec directly; spawnCli
// resolves it to `node <script>`, so these run everywhere.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  updatePiModelCatalog,
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
  it("mounts a selected custom mail server without unrelated built-ins", () => {
    const servers = buildMcpServers({ threadId: "selected", text: "Read mail", toolScope: { allow: ["mcp:mail:*"] }, integrations: {
      agents: { command: "node", args: ["agents"], env: {} },
      localComputer: { command: "node", args: ["computer"], env: {} },
      custom: { mail: { command: "node", args: ["mail"], env: { SYNTHETIC: "1" } } },
    } });
    expect(Object.keys(servers ?? {})).toEqual(["mail"]);
    expect(servers?.mail).toMatchObject({ scope: "custom" });
  });

  it("rejects malformed policy and mounts nothing for native-only selection", () => {
    expect(() => buildMcpServers({ threadId: "bad", text: "Stop", toolScope: { allow: null } as never })).toThrow(/tool selection/i);
    expect(buildMcpServers({ threadId: "native", text: "Draft", toolScope: { allow: ["native:read", "native:write"] }, integrations: { agents: { command: "node", args: [], env: {} } } })).toBeNull();
  });
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

  it("updates pi's catalog only on explicit refresh, then probes it again", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-pi-update-"));
    const dump = join(home, "launches.jsonl");
    const instance = await PiDriver.create({
      instanceId: "pi-refresh",
      displayName: undefined,
      environment: { HOME: home, FAKE_PI_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      const startup = readFileSync(dump, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(startup.some((entry) => entry.argv?.[0] === "update")).toBe(false);

      writeFileSync(dump, "");
      await instance.refreshModels?.();
      const refresh = readFileSync(dump, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(refresh.map((entry) => entry.argv)).toEqual([
        ["update", "--models", "--no-approve"],
        ["--mode", "rpc", "--no-session"],
      ]);
    } finally {
      await instance.dispose();
    }
  });

  it("reports update failure without preventing a cached catalog probe", async () => {
    expect(await updatePiModelCatalog(FAKE_CLI, {
      PATH: process.env.PATH ?? "",
      FAKE_PI_MODE: "update-error",
    })).toBe(false);
    const catalog = await fetchPiModels(FAKE_CLI, {
      PATH: process.env.PATH ?? "",
      HOME: join(tmpdir(), "omb-pi-update-error"),
      FAKE_PI_MODE: "update-error",
    });
    expect(catalog.options).toHaveLength(2);
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

  it("refuses a restricted turn when the loaded extension has not confirmed enforcement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-missing-scope-"));
    const dump = join(dir, "rpc.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    await expect(instance.adapter.sendTurn({ threadId: "missing-enforcement", text: "Must not reach a provider", toolScope: { allow: [] } })).rejects.toThrow(/tool selection.*enforcement/i);
    const rows = readFileSync(dump, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.some((row) => row.argv?.includes("-e"))).toBe(true);
    expect(rows.find((row) => row.argv?.includes("-e"))?.mcpConfig?.toolScope).toEqual({ allow: [] });
    expect(rows.some((row) => row.prompt !== undefined)).toBe(false);
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

  it("delivers the full prompt once per session and rides volatile changes as notes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-split-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    // The receipt store is keyed by thread and session file, so a unique
    // thread keeps the run hermetic against earlier suite executions.
    const threadId = "t-pi-prompt-split-" + randomUUID();
    const prompts = () =>
      readFileSync(dump, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { prompt?: { message?: string } })
        .filter((row) => row.prompt).map((row) => row.prompt!.message!);
    const send = async (text: string, volatile: string, cursor?: string) => {
      const { turnId } = await instance.adapter.sendTurn({
        threadId,
        text,
        system: "Standing rules.\n\n" + volatile,
        systemStable: "Standing rules.",
        systemVolatile: volatile,
        ...(cursor ? { resumeCursor: cursor } : {}),
      });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      const session = recorder.events.find((e) => e.type === "session.started" && e.turnId === turnId) as { sessionId: string };
      return { message: prompts().at(-1)!, cursor: session.sessionId };
    };

    // The establishing turn carries the full prompt, exactly as before.
    const first = await send("first", "Memory: likes quiet hours.");
    expect(first.message).toBe("Standing rules.\n\nMemory: likes quiet hours.\n\nfirst");
    // The resumed session already carries it: later turns go through bare.
    const second = await send("second", "Memory: likes quiet hours.", first.cursor);
    expect(second.message).toBe("second");
    // A changed volatile half rides the next prompt as a labelled note.
    const third = await send("third", "Memory: moved to Toronto.", first.cursor);
    expect(third.message)
      .toBe("Context from OpenMausBot updated since this conversation started; it replaces any earlier copy:\n\nMemory: moved to Toronto.\n\nthird");
  });

  it("re-establishes the full prompt after pi compaction summarizes the session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-compaction-"));
    const dump = join(dir, "dump.jsonl");
    await create("compaction", { FAKE_PI_DUMP: dump });
    // The receipt store is keyed by thread and session file, so a unique
    // thread keeps the run hermetic against earlier suite executions.
    const threadId = "t-pi-compaction-" + randomUUID();
    const prompts = () =>
      readFileSync(dump, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { prompt?: { message?: string } })
        .filter((row) => row.prompt).map((row) => row.prompt!.message!);
    const send = async (text: string, cursor?: string) => {
      const { turnId } = await instance.adapter.sendTurn({
        threadId,
        text,
        system: "Standing rules.\n\nMemory: likes quiet hours.",
        systemStable: "Standing rules.",
        systemVolatile: "Memory: likes quiet hours.",
        ...(cursor ? { resumeCursor: cursor } : {}),
      });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      const session = recorder.events.find((e) => e.type === "session.started" && e.turnId === turnId) as { sessionId: string };
      return { message: prompts().at(-1)!, cursor: session.sessionId };
    };

    // The establishing turn carries the full prompt; the fake then compacts
    // mid-turn, and the compaction events must drop the just-written receipt.
    const first = await send("first");
    expect(first.message).toBe("Standing rules.\n\nMemory: likes quiet hours.\n\nfirst");
    // Compaction summarized the delivery away: the next turn re-establishes
    // the standing prompt instead of running bare against a stale receipt.
    const second = await send("second", first.cursor);
    expect(second.message).toBe("Standing rules.\n\nMemory: likes quiet hours.\n\nsecond");
  });

  it("keeps pi alive through post-run compaction recovery and re-establishes the full prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-compaction-recovery-"));
    const dump = join(dir, "dump.jsonl");
    await create("compaction-recovery", { FAKE_PI_DUMP: dump });
    const threadId = "t-pi-compaction-recovery-" + randomUUID();
    const prompts = () =>
      readFileSync(dump, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { prompt?: { message?: string } })
        .filter((row) => row.prompt).map((row) => row.prompt!.message!);
    const send = async (text: string, cursor?: string) => {
      const { turnId } = await instance.adapter.sendTurn({
        threadId,
        text,
        system: "Standing rules.\n\nMemory: likes quiet hours.",
        systemStable: "Standing rules.",
        systemVolatile: "Memory: likes quiet hours.",
        ...(cursor ? { resumeCursor: cursor } : {}),
      });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      const session = recorder.events.find((e) => e.type === "session.started" && e.turnId === turnId) as { sessionId: string };
      return { message: prompts().at(-1)!, cursor: session.sessionId };
    };

    // The establishing turn ends, pi schedules overflow-recovery compaction
    // after a non-terminal agent_end, and only then resumes for the final
    // turn and the terminal agent_end. Settling at turn_end would kill the
    // child before the late compaction events could drop the receipt.
    const first = await send("first");
    expect(first.message).toBe("Standing rules.\n\nMemory: likes quiet hours.\n\nfirst");
    // The recovery compaction summarized the delivery away: the next turn
    // re-establishes the standing prompt instead of running bare against a
    // receipt the missed events should have invalidated.
    const second = await send("second", first.cursor);
    expect(second.message).toBe("Standing rules.\n\nMemory: likes quiet hours.\n\nsecond");
  });

  it("honors upstream willRetry agent_end frames through post-run compaction recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-compaction-recovery-upstream-"));
    const dump = join(dir, "dump.jsonl");
    await create("compaction-recovery-upstream", { FAKE_PI_DUMP: dump });
    const threadId = "t-pi-compaction-recovery-upstream-" + randomUUID();
    const prompts = () =>
      readFileSync(dump, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { prompt?: { message?: string } })
        .filter((row) => row.prompt).map((row) => row.prompt!.message!);
    const send = async (text: string, cursor?: string) => {
      const { turnId } = await instance.adapter.sendTurn({
        threadId,
        text,
        system: "Standing rules.\n\nMemory: likes quiet hours.",
        systemStable: "Standing rules.",
        systemVolatile: "Memory: likes quiet hours.",
        ...(cursor ? { resumeCursor: cursor } : {}),
      });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      const session = recorder.events.find((e) => e.type === "session.started" && e.turnId === turnId) as { sessionId: string };
      return { message: prompts().at(-1)!, cursor: session.sessionId };
    };

    // Upstream pi marks the pre-recovery agent_end with willRetry: true and
    // closes the run with agent_settled; settling on the unmarked frame the
    // way older drivers treated turn_end would kill the child before the
    // overflow-recovery compaction could invalidate the receipt.
    const first = await send("first");
    expect(first.message).toBe("Standing rules.\n\nMemory: likes quiet hours.\n\nfirst");
    const second = await send("second", first.cursor);
    expect(second.message).toBe("Standing rules.\n\nMemory: likes quiet hours.\n\nsecond");
  });

  it("re-anchors the full prompt after eight bare turns on one session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-reanchor-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    const threadId = "t-pi-reanchor-" + randomUUID();
    const messages: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const { turnId } = await instance.adapter.sendTurn({
        threadId,
        text: "turn " + i,
        system: "Standing rules.\n\nMemory: likes quiet hours.",
        systemStable: "Standing rules.",
        systemVolatile: "Memory: likes quiet hours.",
        ...(cursor ? { resumeCursor: cursor } : {}),
      });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      const session = recorder.events.find((e) => e.type === "session.started" && e.turnId === turnId) as { sessionId: string };
      cursor ??= session.sessionId;
      const row = readFileSync(dump, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { prompt?: { message?: string } })
        .filter((r) => r.prompt).at(-1);
      messages.push(row!.prompt!.message!);
    }
    const full = "Standing rules.\n\nMemory: likes quiet hours.";
    expect(messages[0]).toBe(full + "\n\nturn 0");
    for (let i = 1; i <= 8; i++) expect(messages[i]).toBe("turn " + i);
    expect(messages[9]).toBe(full + "\n\nturn 9");
  });

  it("fails the turn and writes no receipt when pi rejects the prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-prompt-reject-"));
    const dump = join(dir, "dump.jsonl");
    await create("prompt-reject", { FAKE_PI_DUMP: dump });
    const threadId = "t-pi-prompt-reject-" + randomUUID();
    const { turnId } = await instance.adapter.sendTurn({
      threadId,
      text: "first",
      system: "Standing rules.\n\nMemory: likes quiet hours.",
      systemStable: "Standing rules.",
      systemVolatile: "Memory: likes quiet hours.",
    });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: false, stopReason: "failed" });
    expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({
      message: "pi prompt failed",
    });
    // A healthy pi resuming the same session: the rejected prompt left no
    // receipt, so the full prompt rides again instead of a bare turn.
    recorder.stop();
    await instance.dispose();
    await create(undefined, { FAKE_PI_DUMP: dump });
    const second = await instance.adapter.sendTurn({
      threadId,
      text: "second",
      system: "Standing rules.\n\nMemory: likes quiet hours.",
      systemStable: "Standing rules.",
      systemVolatile: "Memory: likes quiet hours.",
      resumeCursor: "/fake/pi-session-1.json",
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    const row = readFileSync(dump, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { prompt?: { message?: string } })
      .filter((r) => r.prompt).at(-1);
    expect(row?.prompt?.message).toBe("Standing rules.\n\nMemory: likes quiet hours.\n\nsecond");
  });

  it("keeps the full prompt when no session could be established", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-split-error-"));
    const dump = join(dir, "dump.jsonl");
    await create("session-error", { FAKE_PI_DUMP: dump });
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-pi-prompt-split-error-" + randomUUID(),
      text: "bare",
      system: "Standing rules.\n\nMemory: likes quiet hours.",
      systemStable: "Standing rules.",
      systemVolatile: "Memory: likes quiet hours.",
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const message = readFileSync(dump, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { prompt?: { message?: string } })
      .find((row) => row.prompt)?.prompt?.message;
    // Without a session the prompt is the model's only context: the turn
    // keeps the full block and writes no receipt.
    expect(message).toBe("Standing rules.\n\nMemory: likes quiet hours.\n\nbare");
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
    const savedBoat = process.env.BOX_TOKEN;
    const savedXai = process.env.XAI_API_KEY;
    process.env.BOX_TOKEN = "boat-secret-value";
    process.env.XAI_API_KEY = "xai-secret-value";
    try {
      await create(undefined, {
        FAKE_PI_DUMP: dump,
        ANTHROPIC_API_KEY: "anthropic-secret-value",
        OPENAI_API_KEY: "openai-secret-value",
      });
      await instance.dispose();
    } finally {
      if (savedBoat === undefined) delete process.env.BOX_TOKEN;
      else process.env.BOX_TOKEN = savedBoat;
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
        computer: { kind: "box", boxId: "b1" },
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
  });

  it("rides the toolUse auto-continue and only settles on the final end_turn", async () => {
    await create("tooluse");
    await instance.adapter.sendTurn({ threadId: "t-tool", text: "run it" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    // a tool ran and completed, then pi auto-continued to synthesize the reply
    expect(recorder.events.filter((e) => e.type === "item.started").length).toBe(1);
    expect(recorder.events.filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "tool").length).toBe(1);
    expect(recorder.events.find((event) => event.type === "item.started")).toMatchObject({ summary: "echo hi", input: expect.stringContaining("echo hi") });
    expect(recorder.events.find((event) => event.type === "item.completed" && event.itemType === "tool")).toMatchObject({ output: expect.stringContaining('"text": "hi"') });
    expect(JSON.stringify(recorder.events)).not.toContain("pi-input-secret");
    expect(JSON.stringify(recorder.events)).not.toContain("pi-output-secret");
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

  it("renders a select ask as a question with choices and returns the picked value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-question-"));
    const dump = join(dir, "dump.jsonl");
    await create("question-select", { FAKE_PI_DUMP: dump });
    await instance.adapter.sendTurn({ threadId: "t-pi-select", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "question",
      summary: "Which color?",
      choices: ["Blue", "Green"],
      questions: [{ question: "Which color?", options: [{ label: "Blue" }, { label: "Green" }] }],
    });
    // Exactly what the tabbed QuestionCard submits: one Q:/A: block, not a
    // bare option label.
    const outcome = await instance.adapter.respondToRequest("t-pi-select", (opened as { requestId: string }).requestId, {
      behavior: "answer",
      message: "The user answered your questions.\n\nQ: Which color?\nA: Green",
    });
    expect(outcome).toBe("answered");
    await recorder.until((e) => e.type === "turn.completed");
    const rows = readFileSync(dump, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { uiResponse?: { id?: string; value?: string; cancelled?: boolean } });
    expect(rows.find((row) => row.uiResponse)?.uiResponse).toMatchObject({ id: "ask-select", value: "Green" });
  });

  it("returns typed text verbatim for a free-text input ask", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-input-"));
    const dump = join(dir, "dump.jsonl");
    await create("question-input", { FAKE_PI_DUMP: dump });
    await instance.adapter.sendTurn({ threadId: "t-pi-input", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "question", summary: "Which city?" });
    expect(opened).not.toHaveProperty("choices");
    await instance.adapter.respondToRequest("t-pi-input", (opened as { requestId: string }).requestId, {
      behavior: "answer",
      message: "  Toronto  ",
    });
    await recorder.until((e) => e.type === "turn.completed");
    const rows = readFileSync(dump, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { uiResponse?: { id?: string; value?: string } });
    expect(rows.find((row) => row.uiResponse)?.uiResponse).toMatchObject({ id: "ask-input", value: "  Toronto  " });
  });

  it.each([false, true])("returns original capped options, refusing ambiguous display labels (%s)", async collision => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-capped-question-"));
    const dump = join(dir, "dump.jsonl");
    const label = "  Green ".repeat(30);
    await create("question-select", { FAKE_PI_DUMP: dump,
      FAKE_PI_QUESTION_OPTIONS: JSON.stringify([label, collision ? label + "other" : "Blue"]) });
    await instance.adapter.sendTurn({ threadId: "t-pi-capped", text: "go" });
    const opened = await recorder.until(e => e.type === "request.opened");
    await instance.adapter.respondToRequest("t-pi-capped", (opened as { requestId: string }).requestId, {
      behavior: "answer", message: `The user answered your questions.\n\nQ: Which color?\nA: ${label.trim().slice(0, 120)}`,
    });
    await recorder.until(e => e.type === "turn.completed");
    const rows = readFileSync(dump, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(rows.find(row => row.uiResponse)?.uiResponse).toMatchObject(collision
      ? { id: "ask-select", cancelled: true } : { id: "ask-select", value: label });
  });

  it("denies an ask by cancelling the protocol request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-deny-"));
    const dump = join(dir, "dump.jsonl");
    await create("question-select", { FAKE_PI_DUMP: dump });
    await instance.adapter.sendTurn({ threadId: "t-pi-deny", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    const outcome = await instance.adapter.respondToRequest("t-pi-deny", (opened as { requestId: string }).requestId, {
      behavior: "deny",
    });
    expect(outcome).toBe("rejected");
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "deny", source: "user" });
    await recorder.until((e) => e.type === "turn.completed");
    const rows = readFileSync(dump, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { uiResponse?: { id?: string; cancelled?: boolean } });
    expect(rows.find((row) => row.uiResponse)?.uiResponse).toMatchObject({ id: "ask-select", cancelled: true });
  });

  it("cancels an unanswered ask after 15 minutes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-timeout-"));
    const dump = join(dir, "dump.jsonl");
    await create("question-select", { FAKE_PI_DUMP: dump });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await instance.adapter.sendTurn({ threadId: "t-pi-timeout", text: "go" });
      const opened = await recorder.until((e) => e.type === "request.opened");
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      const resolved = await recorder.until((e) => e.type === "request.resolved" && e.requestId === opened.requestId);
      expect(resolved).toMatchObject({ behavior: "deny", source: "timeout" });
      await recorder.until((e) => e.type === "turn.completed");
      const rows = readFileSync(dump, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { uiResponse?: { id?: string; cancelled?: boolean } });
      expect(rows.find((row) => row.uiResponse)?.uiResponse).toMatchObject({ id: "ask-select", cancelled: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an ask's fail-safe timer when the turn is interrupted", async () => {
    await create("question-select");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    const cancelled = vi.spyOn(globalThis, "clearTimeout");
    try {
      await instance.adapter.sendTurn({ threadId: "t-ask-interrupt", text: "go" });
      await recorder.until((e) => e.type === "request.opened");
      const askIndex = scheduled.mock.calls.findIndex(([, delay]) => delay === 15 * 60_000);
      expect(askIndex).toBeGreaterThanOrEqual(0);
      const askTimer = scheduled.mock.results[askIndex].value;
      expect(cancelled).not.toHaveBeenCalledWith(askTimer);
      await instance.adapter.interruptTurn("t-ask-interrupt");
      await recorder.until((e) => e.type === "turn.completed");
      // Assert this ask's timer was cancelled, not that the whole process
      // has no timers: killCliTree may still be polling for the real child
      // to exit, which advancing a fake clock cannot guarantee.
      expect(cancelled).toHaveBeenCalledWith(askTimer);
    } finally {
      scheduled.mockRestore();
      cancelled.mockRestore();
      vi.useRealTimers();
    }
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

describe("PiDriver mid-turn steer (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async (environment: Record<string, string> = {}) => {
    instance = await PiDriver.create({
      instanceId: "pi-steer-test",
      displayName: "pi Steer Test",
      environment,
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
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

  it("declares queueing so the harness offers the mid-turn seam", async () => {
    await create();
    expect(instance.adapter.capabilities.queueing).toBe(true);
  });

  it("refuses steer on a thread with no running turn", async () => {
    await create();
    await expect(instance.adapter.steer!("t-idle", "peer context")).resolves.toBe("refused");
  });

  it("steers a running turn through the native steer frame and refuses once settled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-steer-"));
    const dump = join(dir, "dump.jsonl");
    await create({ FAKE_PI_DUMP: dump, FAKE_PI_MODE: "permission" });
    await instance.adapter.sendTurn({ threadId: "t-steer", text: "go" });
    await recorder.until((e) => e.type === "request.opened");
    const envelope = "[aside from @Peer — peer context, not steering]\nheads up\n[end aside]";
    await expect(instance.adapter.steer!("t-steer", envelope)).resolves.toBe("steered");
    const rows = readFileSync(dump, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { steer?: { id?: string; message?: string } });
    const frame = rows.find((row) => row.steer)?.steer;
    expect(frame?.message).toBe(envelope);
    expect(typeof frame?.id).toBe("string");
    // Finish the held turn: the seam belongs to the RUNNING turn only.
    await instance.adapter.respondToRequest("t-steer", "ask-1", { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
    await expect(instance.adapter.steer!("t-steer", "late")).resolves.toBe("refused");
  });

  it("maps an explicit runtime refusal to refused so the words stay queued", async () => {
    await create({ FAKE_PI_MODE: "permission", FAKE_PI_STEER_REFUSE: "1" });
    await instance.adapter.sendTurn({ threadId: "t-refuse", text: "go" });
    await recorder.until((e) => e.type === "request.opened");
    await expect(instance.adapter.steer!("t-refuse", "peer context")).resolves.toBe("refused");
    await instance.adapter.respondToRequest("t-refuse", "ask-1", { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("correlates concurrent steers by frame id so a refusal lands only on its own caller", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-pi-steer-"));
    const dump = join(dir, "dump.jsonl");
    await create({ FAKE_PI_DUMP: dump, FAKE_PI_MODE: "permission", FAKE_PI_STEER_OUT_OF_ORDER: "1" });
    await instance.adapter.sendTurn({ threadId: "t-race", text: "go" });
    await recorder.until((e) => e.type === "request.opened");
    // The fake holds the first steer's refusal until the second frame exists,
    // then answers refusal-for-first / success-for-second: keyed by command
    // name alone, the refusal would reject the second caller (requeueing
    // words pi accepted) and the first caller would hang to its timeout.
    const first = instance.adapter.steer!("t-race", "first aside");
    const second = instance.adapter.steer!("t-race", "second aside");
    await expect(first).resolves.toBe("refused");
    await expect(second).resolves.toBe("steered");
    const frames = readFileSync(dump, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { steer?: { id?: string } })
      .flatMap((row) => (row.steer ? [row.steer] : []));
    expect(frames).toHaveLength(2);
    expect(new Set(frames.map((frame) => frame.id)).size).toBe(2);
    await instance.adapter.respondToRequest("t-race", "ask-1", { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
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
