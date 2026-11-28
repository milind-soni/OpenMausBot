// Turn health on the shared ACP runtime, with the fake agent: a session setup that is never answered, a host that sleeps.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { antigravityHarnessFailure } from "../antigravity-turn-outcome.ts";
import { ANTIGRAVITY_SESSION_SETUP_TIMEOUT_MS } from "../antigravity.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { ANTIGRAVITY_HARNESS_FAILURE_LOG } from "./harness-failure.ts";

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

// Adapted from pingdotgg/t3code@94baff19c65 (acp-mock-agent.ts's harness failure line, AntigravityAdapterV2.test.ts's cases).
const HARNESS_FAILURE = "I1022 11:04:37.910207 1865358 local_connection.py:551] harness stderr: Agent run failed: failed to handle call hook response: no pending hook for ID hook_request_2";

describe("an agent whose own log says its local harness failed", () => {
  it("knows the packaged Antigravity harness's failure lines, and only those", () => {
    expect(ANTIGRAVITY_HARNESS_FAILURE_LOG.test(HARNESS_FAILURE)).toBe(true);
    expect(ANTIGRAVITY_HARNESS_FAILURE_LOG.test("E1022 11:04:38.000001 1865358 server.py:310] Failed to rebuild agent for session abc")).toBe(true);
    expect(ANTIGRAVITY_HARNESS_FAILURE_LOG.test("W1022 11:04:38.000001 1865358 server.py:310] Agent connection lost for session abc")).toBe(true);
    expect(ANTIGRAVITY_HARNESS_FAILURE_LOG.test("I1022 11:04:37.910207 1865358 local_connection.py:551] harness stderr: tool call finished")).toBe(false);
    expect(ANTIGRAVITY_HARNESS_FAILURE_LOG.test("Agent run failed: in a model's reply")).toBe(false);
  });

  it("fails the waiting turn at once and starts the next one in a new process", async () => {
    const directory = folder();
    const launches = join(directory, "launches");
    const driver = createAcpDriver({ ...SUPPORT, stderrFailure: { line: ANTIGRAVITY_HARNESS_FAILURE_LOG, message: "The local agent connection failed." } });
    instance = await driver.create({
      instanceId: "turn-health-harness", displayName: "Turn Health", enabled: true, config: driver.defaultConfig(),
      environment: { FAKE_ACP_PROMPT_STDERR: HARNESS_FAILURE, FAKE_ACP_PROMPT_STDERR_THEN: "hang", FAKE_ACP_LAUNCH_COUNT_FILE: launches },
    });
    const recorder = recordEvents(instance.adapter);
    for (const threadTurn of [1, 2]) {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "thread-harness", text: `turn ${threadTurn}`, cwd: directory });
      expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 5_000)).toMatchObject({ ok: false });
      expect(recorder.events.filter((event) => event.type === "runtime.error" && event.turnId === turnId).at(-1)).toMatchObject({ message: "The local agent connection failed." });
    }
    expect(Number(readFileSync(launches, "utf8"))).toBe(2);
    recorder.stop();
  });

  it("ends the turn on the usage limit a failure line reports, so a fallback model can carry on", async () => {
    const directory = folder();
    const quotaLine = "E1124 14:52:01.000001 4242 local_connection.py:551] harness stderr: Agent run failed: agent executor error: "
      + "Error 429, Message: Quota exhausted., Status: RESOURCE_EXHAUSTED, Details: [map[metadata:map[quotaResetDelay:38m0s] reason:QUOTA_EXHAUSTED]]";
    const driver = createAcpDriver({
      ...SUPPORT,
      stderrFailure: { line: ANTIGRAVITY_HARNESS_FAILURE_LOG, message: "The local agent connection failed.", failure: (line) => antigravityHarnessFailure("Turn Health Test", line) },
    });
    instance = await driver.create({
      instanceId: "turn-health-quota", displayName: "Turn Health", enabled: true, config: driver.defaultConfig(),
      environment: { FAKE_ACP_PROMPT_STDERR: quotaLine, FAKE_ACP_PROMPT_STDERR_THEN: "hang" },
    });
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "thread-quota", text: "go", cwd: directory });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 5_000)).toMatchObject({ ok: false, stopReason: "quota" });
    expect(recorder.events.find((event) => event.type === "runtime.error" && event.turnId === turnId)).toMatchObject({
      limit: "engine", message: expect.stringContaining("reached its usage limit"),
    });
    recorder.stop();
  });
});
