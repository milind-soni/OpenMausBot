import { afterEach, describe, expect, it, vi } from "vitest";
import { createHelperRestarts, followLinuxConnection, HELPER_KEEPS_CRASHING, HELPER_RESTARTING, RESTART_WAITS_MS } from "./cua-restart.mjs";

afterEach(() => vi.useRealTimers());

function restarts({ back = () => true } = {}) {
  vi.useFakeTimers();
  const reports = [];
  const calls = [];
  const keeper = createHelperRestarts({
    restart: async () => { calls.push(Date.now()); return back(calls.length); },
    report: (reason) => reports.push(reason),
  });
  return { keeper, reports, calls };
}

describe("restarting a helper that dies", () => {
  it("says it is restarting at once and restarts after the first wait", async () => {
    const { keeper, reports, calls } = restarts();
    keeper.started();
    keeper.exited("code 1");
    expect(reports).toEqual([HELPER_RESTARTING]);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(RESTART_WAITS_MS[0] - 1);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
  });

  it("waits longer each time, then stops and says so when it keeps dying", async () => {
    const { keeper, reports, calls } = restarts();
    keeper.started();
    for (const wait of RESTART_WAITS_MS) {
      keeper.exited("crash");
      await vi.advanceTimersByTimeAsync(wait);
    }
    expect(calls).toHaveLength(RESTART_WAITS_MS.length);
    keeper.exited("crash");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls).toHaveLength(RESTART_WAITS_MS.length);
    expect(reports.at(-1)).toBe(HELPER_KEEPS_CRASHING);
  });

  it("keeps trying while a restart fails, within the same bound", async () => {
    const { keeper, reports, calls } = restarts({ back: () => false });
    keeper.exited("crash");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls).toHaveLength(RESTART_WAITS_MS.length);
    expect(reports.at(-1)).toBe(HELPER_KEEPS_CRASHING);
  });

  it("starts a new count after the helper has run for a while", async () => {
    const { keeper, reports, calls } = restarts();
    keeper.started();
    keeper.exited("crash");
    await vi.advanceTimersByTimeAsync(RESTART_WAITS_MS[0]);
    keeper.exited("crash");
    await vi.advanceTimersByTimeAsync(RESTART_WAITS_MS[1]);
    await vi.advanceTimersByTimeAsync(120_000);
    keeper.exited("crash");
    await vi.advanceTimersByTimeAsync(RESTART_WAITS_MS[0]);
    expect(calls).toHaveLength(3);
    expect(reports.every((reason) => reason === HELPER_RESTARTING)).toBe(true);
  });

  it("stops and leaves the published reason when only the person can fix it", async () => {
    const { keeper, reports, calls } = restarts({ back: () => "needs-person" });
    keeper.exited("crash");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls).toHaveLength(1);
    expect(reports).toEqual([HELPER_RESTARTING]);
  });

  it("a person's restart cancels the waiting restart and forgets the count", async () => {
    const { keeper, calls } = restarts();
    keeper.exited("crash");
    keeper.reset();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls).toHaveLength(0);
  });
});

describe("following the Linux runtime", () => {
  const spies = () => ({ started: vi.fn(), exited: vi.fn() });

  it("counts a died daemon as an exit and a ready one as started", () => {
    const restarts = spies();
    followLinuxConnection(restarts, { status: "error", reasonCode: "daemon-exited", exitCode: 139 });
    expect(restarts.exited).toHaveBeenCalledWith("exit 139");
    followLinuxConnection(restarts, { status: "ready" });
    expect(restarts.started).toHaveBeenCalledOnce();
  });

  it("ignores every other change, such as the person turning it off", () => {
    const restarts = spies();
    followLinuxConnection(restarts, { status: "disabled", reasonCode: "opt-in-required" });
    followLinuxConnection(restarts, { status: "error", reasonCode: "wayland-health-lost" });
    followLinuxConnection(restarts, null);
    expect(restarts.started).not.toHaveBeenCalled();
    expect(restarts.exited).not.toHaveBeenCalled();
  });
});
