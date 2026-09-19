import { describe, expect, it, vi } from "vitest";

import { createDriverSessionRuntime } from "./driver-runtime.ts";

const makeRuntime = () => {
  const stopTurn = vi.fn();
  const runtime = createDriverSessionRuntime<{ turnId: string }>({ driverKind: "test", stopTurn });
  return { runtime, stopTurn };
};

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("driver session runtime teardown", () => {
  it("registers a turn whose claim was never torn down", () => {
    const { runtime, stopTurn } = makeRuntime();
    runtime.claimTurn("t1", "turn-1");
    const active = { turnId: "turn-1" };
    runtime.setTurn("t1", active);
    expect(runtime.turn("t1")).toBe(active);
    expect(stopTurn).not.toHaveBeenCalled();
  });

  it("stops and rejects a claimed start that settles after stopAll", async () => {
    const { runtime, stopTurn } = makeRuntime();
    runtime.claimTurn("t1", "turn-1");
    await runtime.stopAll();
    const late = { turnId: "turn-1" };
    runtime.setTurn("t1", late);
    expect(runtime.turn("t1")).toBeUndefined();
    expect(runtime.hasSession("t1")).toBe(false);
    await nextTick();
    expect(stopTurn).toHaveBeenCalledWith(late);
  });

  it("clears claims on teardown so the thread accepts a fresh start", async () => {
    const { runtime } = makeRuntime();
    runtime.claimTurn("t1", "turn-1");
    await runtime.stopAll();
    expect(() => runtime.claimTurn("t1", "turn-2")).not.toThrow();
  });

  it("rejects new claims after dispose and stops late registrations", async () => {
    const { runtime, stopTurn } = makeRuntime();
    await runtime.dispose();
    expect(() => runtime.claimTurn("t1", "turn-1")).toThrow(/disposed/);
    const late = { turnId: "turn-2" };
    runtime.setTurn("t1", late);
    expect(runtime.turn("t1")).toBeUndefined();
    await nextTick();
    expect(stopTurn).toHaveBeenCalledWith(late);
  });
});
