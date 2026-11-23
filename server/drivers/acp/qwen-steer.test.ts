import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { createAcpDriver } from "./core.ts";
import { acpBackgroundWork } from "./background.ts";
import { QwenAgentDriver, qwenSteers } from "./qwen.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");

describe("qwenSteers", () => {
  it.each([
    ["1.0.0-preview.2", true], ["1.0.0-preview.10", true], ["1.0.0", true], ["1.0.1", true], ["1.2.0", true], ["2.0.0-preview.0", true],
    ["1.0.0-preview.1", false], ["1.0.0-preview.0", false], ["1.0.0-rc.1", false], ["0.28.0", false], ["0.99.9", false],
    ["v1.0.0", false], ["garbage", false], ["", false], [100, false], [null, false],
  ])("%s → %s", (version, steers) => {
    expect(qwenSteers({ agentInfo: { name: "qwen-code", version } })).toBe(steers);
  });

  it("refuses without agentInfo", () => {
    expect(qwenSteers({})).toBe(false);
    expect(qwenSteers(null)).toBe(false);
    expect(qwenSteers(undefined)).toBe(false);
  });
});

let scratch: string;
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;

beforeEach(() => {
  ensureDirs();
  scratch = mkdtempSync(join(tmpdir(), "omb-qwen-steer-"));
});

afterEach(async () => {
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  recorder = undefined;
  await removeTempDir(scratch);
});

const gate = () => join(scratch, "finish.gate");

const start = async (version = "1.0.0-preview.2") => {
  instance = await QwenAgentDriver.create({
    instanceId: "steer-qwen",
    displayName: "Steer fixture",
    enabled: true,
    environment: {
      HOME: scratch,
      USERPROFILE: scratch,
      FAKE_ACP_MODE: "qwen-steer",
      FAKE_ACP_AGENT_NAME: "qwen-code",
      FAKE_ACP_AGENT_VERSION: version,
      FAKE_ACP_GATE_FILE: gate(),
      FAKE_ACP_RPC_APPEND_FILE: join(scratch, "rpc.jsonl"),
    },
    config: { cli: FAKE_CLI, fullAuto: true },
  } as never) as ProviderInstance;
  recorder = recordEvents(instance.adapter);
};

const threadId = "steer-thread";

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

const calls = () => existsSync(join(scratch, "rpc.jsonl"))
  ? readFileSync(join(scratch, "rpc.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; sessionId?: string })
  : [];
const methods = () => calls().map((call) => call.method);

const until = async (done: () => boolean) => {
  for (let tries = 0; !done(); tries += 1) {
    if (tries > 200) throw new Error(`the expected ACP request did not arrive: ${JSON.stringify(calls())}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe("Qwen steering", () => {
  it("steers into the running turn, and the turn ends without waiting for the unanswered steer prompt", async () => {
    await start();
    expect(instance!.adapter.capabilities.queueing).toBe(true);
    const turnId = await runningTurn();

    expect(await instance!.adapter.steer!(threadId, "  Use pytest.  ")).toBe("steered");
    await until(() => methods().includes("session/prompt.steer"));

    expect(await finished(turnId)).toMatchObject({ ok: true });
    expect(replyOf(turnId)).toEqual(["working. done; steered: Use pytest."]);
  });

  it("runs the next turn on the same session after an unanswered steer", async () => {
    await start();
    const first = await runningTurn();
    expect(await instance!.adapter.steer!(threadId, "one")).toBe("steered");
    await until(() => methods().includes("session/prompt.steer"));
    await finished(first);

    const { turnId } = await instance!.adapter.sendTurn({ threadId, text: "Next.", cwd: scratch });
    expect(await recorder!.until((event) => event.turnId === turnId && event.type === "turn.completed")).toMatchObject({ ok: true });
    expect(await instance!.adapter.steer!(threadId, "too late")).toBe("refused");
  });

  it("keeps the next turn's steering and reply after cancelling a gated turn", async () => {
    await start();
    const first = await runningTurn();
    await instance!.adapter.interruptTurn(threadId);
    expect(await recorder!.until((event) => event.type === "turn.completed" && event.turnId === first)).toMatchObject({ stopReason: "cancelled" });
    const next = await runningTurn();
    expect(await instance!.adapter.steer!(threadId, "continue")).toBe("steered");
    await until(() => methods().includes("session/prompt.steer"));
    expect(await finished(next)).toMatchObject({ ok: true });
    expect(replyOf(next)).toEqual(["working. done; steered: continue"]);
  });

  it("refuses without sending on a Qwen build older than the tested one", async () => {
    await start("1.0.0-preview.1");
    const turnId = await runningTurn();

    expect(await instance!.adapter.steer!(threadId, "use pytest")).toBe("refused");
    expect(methods()).not.toContain("session/prompt.steer");
    await finished(turnId);
    expect(replyOf(turnId)).toEqual(["working. done"]);
  });
});

describe("Qwen background work", () => {
  it.each(["background wake", "Stop"])("continues in the fork after %s", async (trigger) => {
    const dump = join(scratch, "dump.json");
    const stopping = trigger === "Stop";
    const backgroundThread = stopping ? "background-stop-thread" : "background-wake-thread";
    instance = await QwenAgentDriver.create({
      instanceId: "background-qwen",
      displayName: "Background fixture",
      enabled: true,
      environment: {
        HOME: scratch,
        USERPROFILE: scratch,
        FAKE_ACP_MODE: "background-wake",
        FAKE_ACP_AGENT_NAME: "qwen-code",
        FAKE_ACP_AGENT_VERSION: "1.0.0-preview.2",
        FAKE_ACP_DUMP: dump,
        FAKE_ACP_RPC_APPEND_FILE: join(scratch, "rpc.jsonl"),
        FAKE_ACP_STEP_MS: "100",
        FAKE_ACP_WAKE_MS: stopping ? "5000" : "300",
      },
      config: { cli: FAKE_CLI, fullAuto: true },
    } as never) as ProviderInstance;
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: backgroundThread, text: stopping ? "build it STOP_ME" : "build it", cwd: scratch });
    const started = await recorder.until((event) => event.turnId === turnId && event.type === "session.started");
    if (started.type !== "session.started") throw new Error("expected session.started");
    const original = started.sessionId;
    const fork = `${original}-fork`;
    if (stopping) {
      await recorder.until((event) => event.turnId === turnId && event.type === "content.delta" && event.delta.includes("build started"));
      await instance.adapter.interruptTurn(backgroundThread);
    }
    expect(await recorder.until((event) => event.turnId === turnId && event.type === "turn.completed")).toMatchObject({
      ok: true,
      ...(stopping ? { stopReason: "cancelled" } : {}),
    });

    await until(() => calls().some((call) => call.method === "session/close" && call.sessionId === fork));
    const next = await instance.adapter.sendTurn({ threadId: backgroundThread, text: "Continue.", cwd: scratch, resumeCursor: original });
    expect(await recorder.until((event) => event.turnId === next.turnId && event.type === "turn.completed")).toMatchObject({ ok: true });
    expect(calls().filter((call) => ["session/fork", "session/delete", "session/close", "session/load", "session/prompt"].includes(call.method))).toEqual([
      expect.objectContaining({ method: "session/prompt", sessionId: original }),
      expect.objectContaining({ method: "session/fork", sessionId: original }),
      expect.objectContaining({ method: "session/delete", sessionId: original }),
      expect.objectContaining({ method: "session/close", sessionId: fork }),
      expect.objectContaining({ method: "session/load", sessionId: fork }),
      expect.objectContaining({ method: "session/prompt", sessionId: fork }),
    ]);
    expect(replyOf(next.turnId)).toEqual(["second answer"]);
    expect(JSON.stringify(recorder.events)).not.toContain("WOKEN");
    expect(JSON.parse(readFileSync(dump, "utf8")).env.QWEN_ENABLE_AGENT_SESSIONS).toBe("0");
  });

  it("does not submit a prompt when background work wakes during turn setup", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let prompts = 0;
    const driver = createAcpDriver({
      driverKind: "qwenAgent", displayName: "Qwen", nativeSource: "qwen.acp", defaultCli: FAKE_CLI,
      loginNote: "Fixture only", models: { default: "", options: [] }, spawnArgs: () => ["--acp"],
      backgroundWork: acpBackgroundWork(["qwen-background-during-setup"]),
      pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true,
      promptOutcome: async () => {
        if (++prompts === 2) await held;
        return async () => undefined;
      },
    });
    instance = await driver.create({
      instanceId: "qwen-background-during-setup", displayName: "Qwen", enabled: true,
      environment: {
        HOME: scratch, USERPROFILE: scratch,
        FAKE_ACP_MODE: "background-wake", FAKE_ACP_AGENT_NAME: "qwen-code", FAKE_ACP_WAKE_MS: "1000",
        FAKE_ACP_RPC_APPEND_FILE: join(scratch, "rpc.jsonl"),
      },
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    const send = (text: string, resumeCursor?: string) => instance!.adapter.sendTurn({ threadId, text, cwd: scratch, resumeCursor });
    const complete = (id: string) => recorder!.until((event) => event.type === "turn.completed" && event.turnId === id);
    const first = await send("Start background work.");
    expect(await complete(first.turnId)).toMatchObject({ ok: true });
    const cursor = calls().find((call) => call.method === "session/prompt")?.sessionId;
    const second = await send("Continue.", cursor);
    try {
      await vi.waitFor(() => expect(prompts).toBe(2));
      await until(() => methods().includes("session/close"));
    } finally {
      release();
    }
    expect(await complete(second.turnId)).toMatchObject({ ok: false });
    expect(methods().filter((method) => method === "session/prompt")).toHaveLength(1);
    const retry = await send("Continue.", cursor);
    expect(await complete(retry.turnId)).toMatchObject({ ok: true });
    expect(calls().filter((call) => call.method === "session/prompt").at(-1)?.sessionId).toBe(`${cursor}-fork`);
  });
});
