// Steering a running Devin turn with a second session/prompt, against the scripted ACP peer.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { AnyProviderDriver, ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { DevinAgentDriver } from "./devin.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");

let scratch: string;
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;

beforeEach(() => {
  ensureDirs();
  scratch = mkdtempSync(join(tmpdir(), "omb-devin-steer-"));
});

afterEach(async () => {
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  recorder = undefined;
  await removeTempDir(scratch);
});

const gate = () => join(scratch, "finish.gate");

const start = async (driver: AnyProviderDriver, mode: string, extra: Record<string, string> = {}) => {
  instance = await driver.create({
    instanceId: `steer-${driver.driverKind}`,
    displayName: "Steer fixture",
    enabled: true,
    environment: {
      HOME: scratch,
      USERPROFILE: scratch,
      XDG_DATA_HOME: join(scratch, "data"),
      WINDSURF_API_KEY: "fixture-key",
      OPENMAUSBOT_PROBE_LOCAL_INJECT: "0",
      FAKE_ACP_MODELS: "swe-1-6-fast,claude-sonnet-5-5",
      FAKE_ACP_MODES: "accept-edits,smart,ask,plan,bypass",
      FAKE_ACP_MODE: mode,
      FAKE_ACP_GATE_FILE: gate(),
      FAKE_ACP_RPC_APPEND_FILE: join(scratch, "rpc.jsonl"),
      ...extra,
    },
    config: { cli: FAKE_CLI, fullAuto: true },
  } as never) as ProviderInstance;
  recorder = recordEvents(instance.adapter);
  return instance;
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

const usageOf = (turnId: string) => recorder!.events
  .flatMap((event) => event.turnId === turnId && event.type === "thread.token-usage.updated" ? [[event.input, event.output]] : []);

const until = async (done: () => boolean) => {
  for (let tries = 0; !done(); tries += 1) {
    if (tries > 200) throw new Error("the agent never received the steer");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const methods = () => existsSync(join(scratch, "rpc.jsonl"))
  ? readFileSync(join(scratch, "rpc.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line).method as string)
  : [];

describe("Devin steering", () => {
  it("says it can steer", async () => {
    await start(DevinAgentDriver, "devin-steer");
    expect(instance!.adapter.capabilities.queueing).toBe(true);
    expect(instance!.adapter.steer).toBeTypeOf("function");
  });

  it("steers a message into the running turn as a second prompt, and counts the run's usage once", async () => {
    await start(DevinAgentDriver, "devin-steer");
    const turnId = await runningTurn();

    expect(await instance!.adapter.steer!(threadId, "  Use pytest.  ")).toBe("steered");
    await until(() => methods().includes("session/prompt.steer"));

    expect(await finished(turnId)).toMatchObject({ ok: true });
    expect(replyOf(turnId)).toEqual(["working. done; steered: Use pytest."]);
    expect(usageOf(turnId)).toEqual([[10, 5]]);
  });

  it("takes two steers into one run", async () => {
    await start(DevinAgentDriver, "devin-steer");
    const turnId = await runningTurn();

    expect(await instance!.adapter.steer!(threadId, "one")).toBe("steered");
    expect(await instance!.adapter.steer!(threadId, "two")).toBe("steered");
    await until(() => methods().filter((method) => method === "session/prompt.steer").length === 2);

    expect(await finished(turnId)).toMatchObject({ ok: true });
    expect(replyOf(turnId)).toEqual(["working. done; steered: one | two"]);
    expect(usageOf(turnId)).toEqual([[10, 5]]);
  });

  it("refuses a steer once the turn has ended, without sending it", async () => {
    await start(DevinAgentDriver, "devin-steer");
    const turnId = await runningTurn();
    await finished(turnId);

    expect(await instance!.adapter.steer!(threadId, "too late")).toBe("refused");
    expect(methods()).not.toContain("session/prompt.steer");
  });

  it("refuses without sending when the CLI does not report mid-turn prompts", async () => {
    await start(DevinAgentDriver, "devin-steer", { FAKE_ACP_STEERING: "off" });
    const turnId = await runningTurn();

    expect(await instance!.adapter.steer!(threadId, "use pytest")).toBe("refused");
    expect(methods()).not.toContain("session/prompt.steer");
    await finished(turnId);
    expect(replyOf(turnId)).toEqual(["working. done"]);
  });

  it("refuses a steer with a picture", async () => {
    await start(DevinAgentDriver, "devin-steer");
    const turnId = await runningTurn();
    const picture = { path: join(scratch, "shot.png"), mime: "image/png" as const, bytes: 10 };

    expect(await instance!.adapter.steer!(threadId, "look", [picture])).toBe("refused");
    await finished(turnId);
    expect(methods()).not.toContain("session/prompt.steer");
  });
});
