import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { KimiAgentDriver } from "./kimi.ts";

const FAKE_CLI = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const SUBSCRIPTION = "kimi-code/kimi-for-coding";
const PLATFORM = "moonshot-cn/kimi-k2.6";

describe("Kimi session model selection", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "omb-kimi-model-"));
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  async function create(environment: Record<string, string> = {}) {
    instance = await KimiAgentDriver.create({
      instanceId: "kimi-model-fixture", displayName: "Kimi", enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
      environment: {
        HOME: scratch, USERPROFILE: scratch, KIMI_CODE_HOME: join(scratch, ".kimi-code"),
        FAKE_ACP_MODELS: `${SUBSCRIPTION},${PLATFORM}`,
        FAKE_ACP_DUMP: join(scratch, "launch.json"),
        FAKE_ACP_RPC_DUMP: join(scratch, "rpc.json"),
        ...environment,
      },
    });
    recorder = recordEvents(instance.adapter);
    return { instance, recorder };
  }

  const methods = (): string[] => JSON.parse(readFileSync(join(scratch, "rpc.json"), "utf8"));
  const prompts = (): Array<{ model: string }> => {
    const path = join(scratch, "launch.json.prompts.jsonl");
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  };

  it.each([undefined, "saved-kimi-session"])("selects the Platform provider before prompting a new or restored session: %s", async (resumeCursor) => {
    const { instance, recorder } = await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "kimi-chat", text: "hello", model: PLATFORM, resumeCursor });
    await expect(recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId))
      .resolves.toMatchObject({ ok: true });
    const rpc = methods();
    expect(rpc).toContain(resumeCursor ? "session/load" : "session/new");
    expect(rpc.indexOf("session/set_config_option")).toBeLessThan(rpc.indexOf("session/prompt"));
    expect(prompts()).toEqual([expect.objectContaining({ model: PLATFORM })]);
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "session.started", model: PLATFORM }));
  });

  it("does not prompt when Kimi acknowledges a switch but retains the subscription model", async () => {
    const { instance, recorder } = await create({ FAKE_ACP_MODEL_STICKS: "1" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "kimi-chat", text: "hello", model: PLATFORM });
    await expect(recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId))
      .resolves.toMatchObject({ ok: false });
    expect(methods()).toContain("session/set_config_option");
    expect(prompts()).toEqual([]);
    expect(recorder.events).toContainEqual(expect.objectContaining({
      type: "runtime.error", message: expect.stringContaining(`did not switch to ${PLATFORM}`),
    }));
  });

  it("does not prompt when the requested model is rejected", async () => {
    const { instance, recorder } = await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "kimi-chat", text: "hello", model: "moonshot-cn/missing" });
    await expect(recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId))
      .resolves.toMatchObject({ ok: false });
    expect(methods()).not.toContain("session/prompt");
    expect(prompts()).toEqual([]);
  });
});
