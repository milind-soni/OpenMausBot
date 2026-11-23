// Turn health on the shared ACP runtime, with the fake agent: a session setup that is never answered, a host that sleeps.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { ANTIGRAVITY_SESSION_SETUP_TIMEOUT_MS } from "../antigravity.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const SUPPORT: AcpSupport = {
  driverKind: "turnHealthTest", displayName: "Turn Health Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
  defaultCli: FAKE_CLI, nativeSource: "turn-health.acp", loginNote: "never reached",
  spawnArgs: () => [], pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true,
};
const scratch: string[] = [];
let instance: ProviderInstance | null = null;
afterEach(async () => {
  await instance?.dispose();
  instance = null;
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "omb-turn-health-"));
  scratch.push(directory);
  return directory;
}

describe("a session setup the agent never answers", () => {
  it("fails the turn after the engine's own limit instead of the core's five minutes", async () => {
    const directory = folder();
    const failure = join(directory, "failure.json");
    writeFileSync(failure, JSON.stringify({ code: -32603, message: "never sent" }));
    const driver = createAcpDriver({ ...SUPPORT, sessionSetupTimeoutMs: 500 });
    instance = await driver.create({
      instanceId: "turn-health-setup", displayName: "Turn Health", enabled: true, config: driver.defaultConfig(),
      // session/new is held behind a gate no one opens: the live process never answers it.
      environment: { FAKE_ACP_RPC_FAILURE_METHOD: "session/new", FAKE_ACP_RPC_FAILURE_FILE: failure, FAKE_ACP_RPC_FAILURE_GATE: join(directory, "never") },
    });
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "thread-setup", text: "hello", cwd: directory });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 5_000)).toMatchObject({ ok: false });
    expect(recorder.events.find((event) => event.type === "runtime.error")).toMatchObject({ message: expect.stringContaining("session/new timed out") });
    recorder.stop();
  });

  it("is 90 seconds for Antigravity, as T3 Code's ACP startup", () => {
    expect(ANTIGRAVITY_SESSION_SETUP_TIMEOUT_MS).toBe(90_000);
  });
});
