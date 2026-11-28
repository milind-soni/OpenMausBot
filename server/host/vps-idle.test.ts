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
function host(extra: Partial<AppConfig> = {}, opts: { isShuttingDown?: () => boolean } = {}) {
  const bot = { id: "bot-1", name: "Bot", cloudBackend: "vps" } as BotRecord;
  const cfg = { vps: { sshAlias: "my-vps" }, ...extra } as AppConfig;
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
    isShuttingDown: opts.isShuttingDown ?? (() => false),
  });
  return { bot, idle };
}

const stops = () => vi.mocked(vps.vpsComputerAction).mock.calls.filter(([action]) => action === "stop");

describe("idle SSH server desktops", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    viewer.open = false;
    vi.mocked(vps.vpsComputerAction).mockClear();
    vi.mocked(vps.listManagedVpsComputers).mockReset();
    vi.mocked(vps.listManagedVpsComputers).mockResolvedValue({
      configured: true, available: true, vpsAliases: ["my-vps"], problem: null, instances: [],
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

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

  it("logs idle-stop failures with the retry delay and retries until the stop succeeds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const windowMs = 5 * 60_000;
    const { bot, idle } = host({ vpsIdle: { timeoutMinutes: 5 } });
    vi.mocked(vps.vpsComputerAction).mockRejectedValueOnce(new Error("Docker over SSH timed out"));

    idle.touchVpsIdle(bot);
    idle.vpsThreadStarted(bot.id, "t-1");
    await vi.advanceTimersByTimeAsync(1_000);
    idle.vpsThreadEnded(bot.id, "t-1");

    await vi.advanceTimersByTimeAsync(windowMs - 1);
    expect(stops()).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(stops()).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toEqual(expect.stringContaining("Bot"));
    expect(String(warn.mock.calls[0]?.[0])).toEqual(expect.stringContaining("my-vps"));
    expect(String(warn.mock.calls[0]?.[0])).toEqual(expect.stringContaining("300s"));
    expect(String(warn.mock.calls[0]?.[0])).toEqual(expect.stringContaining("Docker over SSH timed out"));
    expect(idle.vpsIdles.has(bot.id)).toBe(true);

    await vi.advanceTimersByTimeAsync(windowMs - 1);
    expect(stops()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stops()).toHaveLength(2);
    expect(idle.vpsIdles.has(bot.id)).toBe(false);
    idle.cancelAll();
  });

  it("logs an unreachable VPS during boot recovery and retries with backoff until running desktops are recovered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const windowMs = 5 * 60_000;
    const { bot, idle } = host({ vpsIdle: { timeoutMinutes: 5 } });
    vi.mocked(vps.listManagedVpsComputers)
      .mockResolvedValueOnce({
        configured: true, available: false, vpsAliases: ["my-vps"],
        problem: "Docker over SSH could not list managed computers on my-vps: No route to host",
        unreachable: true, instances: [],
      })
      .mockResolvedValueOnce({
        configured: true, available: false, vpsAliases: ["my-vps"],
        problem: "Docker over SSH could not list managed computers on my-vps: Connection timed out",
        unreachable: true, instances: [],
      })
      .mockResolvedValueOnce({
        configured: true, available: true, vpsAliases: ["my-vps"], problem: null,
        instances: [{
          name: "openmausbot-vps-bot1-000000000000", state: "running", vpsAlias: "my-vps",
          ownerBotId: bot.id, ownerName: bot.name, orphaned: false, inUse: false,
        }],
      });

    idle.recover();
    await vi.advanceTimersByTimeAsync(0);
    expect(vps.listManagedVpsComputers).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toEqual(expect.stringContaining("No route to host"));
    expect(String(warn.mock.calls[0]?.[0])).toEqual(expect.stringContaining("30s"));
    expect(idle.vpsIdles.has(bot.id)).toBe(false);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(vps.listManagedVpsComputers).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(vps.listManagedVpsComputers).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]?.[0])).toEqual(expect.stringContaining("60s"));

    await vi.advanceTimersByTimeAsync(59_999);
    expect(vps.listManagedVpsComputers).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(vps.listManagedVpsComputers).toHaveBeenCalledTimes(3);
    expect(idle.vpsIdles.has(bot.id)).toBe(true);

    await vi.advanceTimersByTimeAsync(windowMs);
    expect(stops()).toHaveLength(1);
    idle.cancelAll();
  });

  it("logs a non-unreachable recovery problem once without retrying, and cancels pending retries on cancelAll or shutdown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let bootFinished = false;
    let shuttingDown = false;
    const { idle } = host({}, {
      isShuttingDown: () => {
        if (!bootFinished) throw new ReferenceError("Cannot access 'companyShutdown' before initialization");
        return shuttingDown;
      },
    });

    vi.mocked(vps.listManagedVpsComputers).mockResolvedValueOnce({
      configured: false, available: false, vpsAliases: [], problem: null, instances: [],
    });
    idle.recover();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    bootFinished = true;
    expect(warn).not.toHaveBeenCalled();
    expect(vps.listManagedVpsComputers).toHaveBeenCalledTimes(1);

    vi.mocked(vps.listManagedVpsComputers).mockResolvedValueOnce({
      configured: true, available: false, vpsAliases: ["my-vps"],
      problem: "The Docker CLI is not on PATH", instances: [],
    });
    idle.recover();
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toEqual(expect.stringContaining("The Docker CLI is not on PATH"));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(vps.listManagedVpsComputers).toHaveBeenCalledTimes(2);

    vi.mocked(vps.listManagedVpsComputers).mockResolvedValue({
      configured: true, available: false, vpsAliases: ["my-vps"],
      problem: "SSH timed out", unreachable: true, instances: [],
    });
    idle.recover();
    await vi.advanceTimersByTimeAsync(0);
    expect(vps.listManagedVpsComputers).toHaveBeenCalledTimes(3);
    idle.cancelAll();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(vps.listManagedVpsComputers).toHaveBeenCalledTimes(3);

    idle.recover();
    await vi.advanceTimersByTimeAsync(0);
    expect(vps.listManagedVpsComputers).toHaveBeenCalledTimes(4);
    shuttingDown = true;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(vps.listManagedVpsComputers).toHaveBeenCalledTimes(4);
  });
});
