import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { CustomAcpDriver } from "./custom.ts";
import { removeTempDir } from "../../testing/cleanup.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

describe("CustomAcpDriver config", () => {
  it("teaches instead of ENOENT when the command is missing or blank", async () => {
    expect(() => CustomAcpDriver.decodeConfig({})).toThrow(/Set CLI|config\.json/);
    expect(() => CustomAcpDriver.decodeConfig({ cli: "   " })).toThrow(/<your-agent> acp/);
    await expect(
      CustomAcpDriver.create({
        instanceId: "custom-blank",
        displayName: undefined,
        environment: {},
        enabled: true,
        config: CustomAcpDriver.defaultConfig(),
      }),
    ).rejects.toThrow(/<your-agent> acp/);
  });

  it("keeps a real command verbatim, wrapper strings included", () => {
    expect(CustomAcpDriver.decodeConfig({ cli: "fx acp", fullAuto: true })).toMatchObject({
      cli: "fx acp",
      fullAuto: true,
    });
  });

  it("advertises the custom rail, multi-instance, and the passthrough model", () => {
    expect(CustomAcpDriver.metadata).toMatchObject({
      access: "custom",
      supportsMultipleInstances: true,
    });
    expect(CustomAcpDriver.models).toEqual({
      default: "agent-default",
      options: [{ id: "agent-default", label: "Agent default", custom: true }],
    });
    expect(CustomAcpDriver.install).toBeUndefined();
  });
});

describe("CustomAcpDriver turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (environment: Record<string, string> = {}) => {
    instance = await CustomAcpDriver.create({
      instanceId: "custom-test",
      displayName: "Custom Test",
      environment,
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-custom-acp-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.XAI_API_KEY;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("runs a full turn through an arbitrary ACP CLI with canonical events", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-custom", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed",
      "item.started",
      "item.completed",
      "thread.token-usage.updated",
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "customAcp")).toBe(true);
    const text = recorder.events.find((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_text")!;
    expect((text as { text?: string }).text).toBe("hello from fake acp");
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
  });

  it("names the person's own agent in what it tells them, never \"Custom (ACP)\"", async () => {
    process.env.FAKE_ACP_MODE = "empty-reply";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-custom-name", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({ message: "Custom Test finished without replying." });
  });

  it("passes instance env to the child but strips foreign provider keys", async () => {
    process.env.XAI_API_KEY = "xai-should-not-leak";
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create({ MY_AGENT_TOKEN: "tok-123" });
    await instance.adapter.sendTurn({ threadId: "t-custom-env", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string | undefined> };
    expect(seen.env.MY_AGENT_TOKEN).toBe("tok-123");
    expect(seen.env.XAI_API_KEY).toBeUndefined();
  });

  it("reports available with a working CLI and no sign-in requirement", async () => {
    await create();
    const snapshot = await instance.snapshot();
    expect(snapshot).toMatchObject({ state: "available" });
  });
});
