// Steering a running Hermes turn through hermes-agent's ACP `/steer`, against the scripted ACP peer.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { AnyProviderDriver, ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { publishedMessages } from "../../harness/text-items.testkit.ts";
import { AntigravityDriver } from "../antigravity.ts";
import { ClineAgentDriver } from "./cline.ts";
import { CommandCodeAgentDriver } from "./command-code.ts";
import { CopilotAgentDriver } from "./copilot.ts";
import { CursorAgentDriver } from "./cursor.ts";
import { CustomAcpDriver } from "./custom.ts";
import { DeepSeekAgentDriver } from "./deepseek.ts";
import { DroidAgentDriver } from "./droid.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import { GrokAgentDriver } from "./grok.ts";
import { HermesAgentDriver, hermesSteerAnswer } from "./hermes.ts";
import { KimiAgentDriver } from "./kimi.ts";
import { KiroAgentDriver } from "./kiro.ts";
import { OpenCodeDriver } from "./opencode-go.ts";
import { QwenAgentDriver } from "./qwen.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");

let scratch: string;
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;

beforeEach(() => {
  ensureDirs();
  scratch = mkdtempSync(join(tmpdir(), "omb-hermes-steer-"));
});

afterEach(async () => {
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  recorder = undefined;
  await removeTempDir(scratch);
});

const fixtureEnv = (extra: Record<string, string> = {}) => ({
  HOME: scratch,
  USERPROFILE: scratch,
  HERMES_HOME: join(scratch, ".hermes"),
  KIMI_CODE_HOME: join(scratch, ".kimi"),
  OPENMAUSBOT_PROBE_LOCAL_INJECT: "0",
  FAKE_ACP_MODE: "hermes-steer",
  FAKE_ACP_RPC_APPEND_FILE: join(scratch, "rpc.jsonl"),
  ...extra,
});

const start = async (driver: AnyProviderDriver, extra: Record<string, string> = {}) => {
  instance = await driver.create({
    instanceId: `steer-${driver.driverKind}`,
    displayName: "Steer fixture",
    enabled: true,
    environment: fixtureEnv(extra),
    config: { cli: FAKE_CLI, fullAuto: true },
  } as never) as ProviderInstance;
  recorder = recordEvents(instance.adapter);
  return instance;
};

const gate = () => join(scratch, "finish.gate");
const threadId = "hermes-steer-thread";

/** Starts a turn and resolves once the agent is working on it. */
const runningTurn = async () => {
  const { turnId } = await instance!.adapter.sendTurn({ threadId, text: "Build the report.", cwd: scratch });
  await recorder!.until((event) => event.turnId === turnId && event.type === "content.delta" && event.delta.includes("working"));
  return turnId;
};

const finished = async (turnId: string) => {
  writeFileSync(gate(), "finish");
  return recorder!.until((event) => event.turnId === turnId && event.type === "turn.completed");
};

const replyOf = (turnId: string) => recorder!.events
  .flatMap((event) => event.turnId === turnId && event.type === "item.completed" && event.itemType === "assistant_text" ? [event.text] : []);

const sentPrompts = () => existsSync(join(scratch, "rpc.jsonl"))
  ? readFileSync(join(scratch, "rpc.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line).method as string)
    .filter((method) => method.startsWith("session/prompt"))
  : [];

describe("Hermes steering", () => {
  it("says it can steer", async () => {
    await start(HermesAgentDriver, { FAKE_ACP_GATE_FILE: gate() });
    expect(instance!.adapter.capabilities.queueing).toBe(true);
    expect(instance!.adapter.capabilities.steerImages).toBeUndefined();
    expect(instance!.adapter.steer).toBeTypeOf("function");
  });

  it("steers a message into the running turn with /steer, and keeps Hermes's answer out of the reply", async () => {
    await start(HermesAgentDriver, { FAKE_ACP_GATE_FILE: gate() });
    const turnId = await runningTurn();

    expect(await instance!.adapter.steer!(threadId, "  Use pytest, not unittest.\nAnd keep it short.  ")).toBe("steered");
    expect(sentPrompts()).toEqual(["session/prompt", "session/prompt", "session/prompt.steer"]);

    expect(await finished(turnId)).toMatchObject({ ok: true });
    expect(replyOf(turnId)).toEqual(["working. done; steered: Use pytest, not unittest.\nAnd keep it short."]);
    const shown = recorder!.events.filter((event) => event.turnId === turnId && event.type === "content.delta").map((event) => event.type === "content.delta" ? event.delta : "");
    expect(shown.join("")).not.toContain("Steer queued");
    expect(publishedMessages(recorder!.events.filter((event) => event.turnId === turnId)).map(({ streamed, completed }) => ({ streamed, completed })),
      "a steered turn is still one message under one id, with Hermes's own line left out").toEqual([
      { streamed: "working. done; steered: Use pytest, not unittest.\nAnd keep it short.", completed: "working. done; steered: Use pytest, not unittest.\nAnd keep it short." },
    ]);
  });

  it("refuses a steer once the turn has ended, without sending it", async () => {
    await start(HermesAgentDriver, { FAKE_ACP_GATE_FILE: gate() });
    expect(await instance!.adapter.steer!(threadId, "anything")).toBe("refused");
    const turnId = await runningTurn();
    await finished(turnId);

    expect(await instance!.adapter.steer!(threadId, "too late")).toBe("refused");
    expect(sentPrompts()).toEqual(["session/prompt"]);
  });

  it("refuses what Hermes says it could not steer, and keeps that line out of the reply", async () => {
    await start(HermesAgentDriver, { FAKE_ACP_GATE_FILE: gate(), FAKE_ACP_STEER_FAIL: "1" });
    const turnId = await runningTurn();

    expect(await instance!.adapter.steer!(threadId, "use pytest")).toBe("refused");
    await finished(turnId);
    expect(replyOf(turnId)).toEqual(["working. done"]);
  });

  it("refuses a steer Hermes answers with an error while the turn still runs", async () => {
    await start(HermesAgentDriver, { FAKE_ACP_GATE_FILE: gate(), FAKE_ACP_STEER_FAIL: "rpc" });
    const turnId = await runningTurn();

    expect(await instance!.adapter.steer!(threadId, "use pytest")).toBe("refused");
    expect(await finished(turnId)).toMatchObject({ ok: true });
    expect(replyOf(turnId)).toEqual(["working. done"]);
  });

  it("refuses a steer with a picture, since /steer takes text only", async () => {
    await start(HermesAgentDriver, { FAKE_ACP_GATE_FILE: gate() });
    const turnId = await runningTurn();
    const picture = { path: join(scratch, "shot.png"), mime: "image/png" as const, bytes: 10 };

    expect(await instance!.adapter.steer!(threadId, "look at this", [picture])).toBe("refused");
    await finished(turnId);
    expect(sentPrompts()).not.toContain("session/prompt.steer");
  });

  it("keeps the turn open for a steer Hermes reached only after the turn ended, which it runs as its next prompt", async () => {
    const hold = join(scratch, "steer.hold");
    writeFileSync(hold, "hold");
    await start(HermesAgentDriver, { FAKE_ACP_GATE_FILE: gate(), FAKE_ACP_STEER_HOLD_FILE: hold });
    const turnId = await runningTurn();

    const steered = instance!.adapter.steer!(threadId, "late words");
    writeFileSync(gate(), "finish");
    // The words may run in Hermes after all: never "refused", which would send them a second time.
    expect(await steered).toBe("indeterminate");
    expect(recorder!.events.some((event) => event.turnId === turnId && event.type === "turn.completed")).toBe(false);

    rmSync(hold);
    expect(await recorder!.until((event) => event.turnId === turnId && event.type === "turn.completed")).toMatchObject({ ok: true });
    expect(replyOf(turnId)).toEqual(["working. done", "ran: late words"]);
  });

  it("refuses, without sending it, a steer to a Hermes whose session does not offer /steer", async () => {
    await start(HermesAgentDriver, { FAKE_ACP_GATE_FILE: gate(), FAKE_ACP_HERMES_COMMANDS: "help,queue" });
    const turnId = await runningTurn();

    expect(await instance!.adapter.steer!(threadId, "use pytest")).toBe("refused");
    await finished(turnId);
    expect(sentPrompts()).toEqual(["session/prompt"]);
  });
});

describe("Hermes's answers to /steer", () => {
  it.each([
    ["⏩ Steer queued for the active turn: use pytest\n", "accepted"],
    ["⏩ Steer queued for the active turn: " + "x".repeat(80) + "...", "accepted"],
    ["No active turn — queued for the next turn. (1 queued)", "accepted"],
    ["⚠️ Steer failed: agent busy compressing", "refused"],
    ["working on it", null],
    ["Queued for the next turn. (1 queued)", null],
  ] as const)("%j is %s", (chunk, verdict) => {
    expect(hermesSteerAnswer(chunk)).toBe(verdict);
  });
});

describe("other ACP engines", () => {
  // Each runs against an agent that offers /steer: an engine whose own support is unproven still never steers.
  it.each([
    GeminiAgentDriver, KimiAgentDriver, DroidAgentDriver, CursorAgentDriver, OpenCodeDriver, QwenAgentDriver, ClineAgentDriver,
    CopilotAgentDriver, CommandCodeAgentDriver, KiroAgentDriver, CustomAcpDriver, DeepSeekAgentDriver, GrokAgentDriver, AntigravityDriver,
  ] as AnyProviderDriver[])("$driverKind does not steer", async (driver) => {
    await start(driver);
    expect(instance!.adapter.capabilities.queueing).toBeUndefined();
    expect(instance!.adapter.steer).toBeUndefined();
  });

  it("a turn of another engine never receives /steer while the agent offers it", async () => {
    await start(GeminiAgentDriver, { FAKE_ACP_GATE_FILE: gate() });
    const turnId = await runningTurn();
    expect(instance!.adapter.steer).toBeUndefined();
    await finished(turnId);
    expect(sentPrompts()).toEqual(["session/prompt"]);
    expect(replyOf(turnId)).toEqual(["working. done"]);
  });
});
