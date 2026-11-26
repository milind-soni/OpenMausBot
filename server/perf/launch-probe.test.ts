import { afterEach, describe, expect, it, vi } from "vitest";

const saved = process.env.OMB_DESKTOP_PARENT;
afterEach(() => {
  if (saved === undefined) delete process.env.OMB_DESKTOP_PARENT; else process.env.OMB_DESKTOP_PARENT = saved;
  vi.useRealTimers();
  vi.resetModules();
});

async function probe(desktop: boolean) {
  vi.resetModules();
  if (desktop) process.env.OMB_DESKTOP_PARENT = "1"; else delete process.env.OMB_DESKTOP_PARENT;
  return import("./launch-probe.ts");
}

describe("start-up work the desktop window does not need", () => {
  it("runs at once on any server the desktop app did not start (a Cloud home, a self-hosted one)", async () => {
    const { afterLaunchSettles } = await probe(false);
    const ran: string[] = [];
    afterLaunchSettles(() => ran.push("sampler"));
    expect(ran).toEqual(["sampler"]);
  });

  it("waits under the desktop app until a launch part says the window is in use, then runs in order, and later work at once", async () => {
    const { afterLaunchSettles, launchSettled } = await probe(true);
    const ran: string[] = [];
    afterLaunchSettles(() => ran.push("runtime check"));
    afterLaunchSettles(() => { throw new Error("one failing step"); });
    afterLaunchSettles(() => ran.push("update check"));
    expect(ran).toEqual([]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    launchSettled();
    expect(ran).toEqual(["runtime check", "update check"]);
    launchSettled();
    afterLaunchSettles(() => ran.push("later"));
    expect(ran).toEqual(["runtime check", "update check", "later"]);
  });

  it("runs anyway a while after listening when no window ever reports in", async () => {
    vi.useFakeTimers();
    const { afterLaunchSettles, launchListening, SETTLE_AT_MOST_MS } = await probe(true);
    const ran: string[] = [];
    afterLaunchSettles(() => ran.push("runtime check"));
    launchListening();
    vi.advanceTimersByTime(SETTLE_AT_MOST_MS - 1);
    expect(ran).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ran).toEqual(["runtime check"]);
  });
});
