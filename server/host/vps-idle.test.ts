import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const viewer = vi.hoisted(() => ({ open: false }));
vi.mock("../vps-computer.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../vps-computer.ts")>(),
  vpsDesktopConnection: vi.fn(() => (viewer.open ? { port: 5901, password: "p", live: () => true, retain: () => () => {} } : undefined)),
  vpsComputerAction: vi.fn(async (_action: string, _cfg: unknown, _botId: string, _runner: unknown, shouldStop?: () => boolean) =>
    ({ container: shouldStop && !shouldStop() ? "running" : "stopped" })),
  stopVpsDesktopTunnel: vi.fn(),
  vpsComputerRunning: vi.fn(async () => false),
  listManagedVpsComputers: vi.fn(async () => ({ instances: [] })),
}));

import type { AppConfig } from "../config.ts";
import type { BotRecord } from "../store.ts";
import * as vps from "../vps-computer.ts";
import { createVpsIdleHost } from "./vps-idle.ts";

const DEFAULT_WINDOW_MS = 480 * 60_000;

/** The Cloud browser sandbox's 3-minute rule lives in cloud-computer-power and never reaches this timer. */
function host() {
  const bot = { id: "bot-1", name: "Bot", cloudBackend: "vps" } as BotRecord;
  const cfg = { vps: { sshAlias: "my-vps" } } as AppConfig;
  const idle = createVpsIdleHost({
    cfg,
    store: { bots: [bot], bot: (id) => (id === bot.id ? bot : null) },
    botHasActiveTurn: () => false,
    hasActiveRoutine: () => false,
    isSharedVmHeld: () => false,
    hasComputerPreview: () => false,
    isVpsConfigTransitioning: () => false,
    isLifecycleBusy: () => false,
    claimBotComputerLifecycle: () => () => {},
    isShuttingDown: () => false,
  });
  return { bot, idle };
}

const stops = () => vi.mocked(vps.vpsComputerAction).mock.calls.filter(([action]) => action === "stop");

describe("idle SSH server desktops", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    viewer.open = false;
    vi.mocked(vps.vpsComputerAction).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("stops a quiet desktop after the fixed 480-minute window, not before", async () => {
    const { bot, idle } = host();
    idle.touchVpsIdle(bot);
    await vi.advanceTimersByTimeAsync(DEFAULT_WINDOW_MS - 1_000);
    expect(stops()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stops()).toHaveLength(1);
    idle.cancelAll();
  });

  it("never stops a desktop while a person is viewing it, and starts a full window once they leave", async () => {
    const { bot, idle } = host();
    viewer.open = true;
    idle.touchVpsIdle(bot);
    await vi.advanceTimersByTimeAsync(3 * DEFAULT_WINDOW_MS);
    expect(stops()).toHaveLength(0);
    expect(vi.mocked(vps.vpsDesktopConnection)).toHaveBeenCalledWith(bot.id);

    viewer.open = false;
    await vi.advanceTimersByTimeAsync(DEFAULT_WINDOW_MS / 2);
    expect(stops()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DEFAULT_WINDOW_MS);
    expect(stops()).toHaveLength(1);
    idle.cancelAll();
  });
});
