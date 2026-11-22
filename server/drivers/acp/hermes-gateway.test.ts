// The Hermes gateway one conversation's `hermes acp` starts is shared by every conversation: closing one idle
// conversation's engine must leave that gateway, and a turn another conversation is running, alive.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { HermesAgentDriver } from "./hermes.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");

let scratch: string;
let gatewayFile: string;
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

beforeEach(() => {
  ensureDirs();
  scratch = mkdtempSync(join(tmpdir(), "omb-hermes-gateway-"));
  gatewayFile = join(scratch, "gateway.pid");
});

afterEach(async () => {
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  recorder = undefined;
  // The fixture writes the gateway's pid as it starts it, so a test that failed before reading it still stops it.
  const gateway = existsSync(gatewayFile) ? Number(readFileSync(gatewayFile, "utf8")) : 0;
  if (gateway) try { process.kill(-gateway, "SIGKILL"); } catch {}
  vi.unstubAllEnvs();
  await removeTempDir(scratch);
});

it.runIf(process.platform === "linux")("closing one idle conversation leaves the shared Hermes gateway and another conversation's turn running", async () => {
  // Ten seconds is the shortest idle close there is.
  vi.stubEnv("OMB_ACP_SESSION_IDLE_MIN_MS", "10000");
  vi.stubEnv("OMB_ACP_SESSION_IDLE_MS", "10000");
  const hold = join(scratch, "prompt.hold");
  instance = await HermesAgentDriver.create({
    instanceId: "hermes-gateway",
    displayName: "Gateway fixture",
    enabled: true,
    environment: {
      HOME: scratch,
      USERPROFILE: scratch,
      HERMES_HOME: join(scratch, ".hermes"),
      OPENMAUSBOT_PROBE_LOCAL_INJECT: "0",
      FAKE_ACP_HOLD_FILE: hold,
      FAKE_ACP_GATEWAY_PID_FILE: gatewayFile,
    },
    config: { cli: FAKE_CLI, fullAuto: true },
  } as never) as ProviderInstance;
  const events = recordEvents(instance.adapter);
  recorder = events;
  const adapter = instance.adapter;
  /** Starts a turn held by the hold file and returns it with the pid of the `hermes acp` running it. */
  const heldTurn = async (threadId: string) => {
    writeFileSync(hold, "hold");
    const { turnId } = await adapter.sendTurn({ threadId, text: "hello", cwd: scratch });
    let pid: number | undefined;
    await vi.waitFor(() => expect(pid = adapter.enginePid?.(threadId)).toBeGreaterThan(0), { timeout: 10_000 });
    return { turnId, pid: pid! };
  };
  const completed = (turnId: string) => events.until((event) => event.turnId === turnId && event.type === "turn.completed");

  const first = await heldTurn("conversation-a");
  let gatewayPid = 0;
  await vi.waitFor(() => expect(gatewayPid = Number(readFileSync(gatewayFile, "utf8"))).toBeGreaterThan(0), { timeout: 10_000 });
  rmSync(hold);
  expect(await completed(first.turnId)).toMatchObject({ ok: true });

  const second = await heldTurn("conversation-b");
  expect(second.pid).not.toBe(first.pid);
  await vi.waitFor(() => expect(alive(first.pid)).toBe(false), { timeout: 20_000, interval: 200 });
  expect(alive(gatewayPid), "the shared gateway").toBe(true);
  expect(alive(second.pid), "conversation B's engine").toBe(true);

  rmSync(hold);
  expect(await completed(second.turnId)).toMatchObject({ ok: true });
}, 45_000);
