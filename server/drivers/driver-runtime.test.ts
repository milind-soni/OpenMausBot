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

  it("clears a canceled claim marker when its setup fails", async () => {
    const { runtime } = makeRuntime();
    runtime.claimTurn("t1", "turn-1");
    await runtime.stopAll();
    expect(runtime.claimCanceled("turn-1")).toBe(true);
    runtime.endTurn("t1", "turn-1");
    expect(runtime.claimCanceled("turn-1")).toBe(false);
  });

  it("rejects a claim on a busy thread and releases an unlaunched claim", async () => {
    const { runtime } = makeRuntime();
    runtime.claimTurn("t1", "turn-1");
    expect(() => runtime.claimTurn("t1", "turn-2")).toThrow(/already running/);
    await runtime.stopAll();
    expect(runtime.claimCanceled("turn-1")).toBe(true);
    runtime.endTurn("t1", "turn-1");
    expect(() => runtime.claimTurn("t1", "turn-3")).not.toThrow();
    runtime.setTurn("t1", { turnId: "turn-3" });
    expect(() => runtime.claimTurn("t1", "turn-4")).toThrow(/already running/);
  });

  it("rejects new claims while a stopAll teardown is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const afterStopTurns = () => gate;
    const runtime = createDriverSessionRuntime<{ turnId: string }>({ driverKind: "test", stopTurn: vi.fn(), afterStopTurns });
    const teardown = runtime.stopAll();
    expect(() => runtime.claimTurn("t1", "turn-1")).toThrow(/stopping/);
    release();
    await teardown;
    expect(() => runtime.claimTurn("t1", "turn-1")).not.toThrow();
  });

  it("serializes overlapping teardowns so each turn stops exactly once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let runtime!: ReturnType<typeof createDriverSessionRuntime<{ turnId: string }>>;
    // a real stopTurn settles the turn, which drains it from the runtime
    const stopTurn = vi.fn(() => gate.then(() => runtime.endTurn("t1", "turn-1")));
    runtime = createDriverSessionRuntime<{ turnId: string }>({ driverKind: "test", stopTurn });
    const active = { turnId: "turn-1" };
    runtime.claimTurn("t1", "turn-1");
    runtime.setTurn("t1", active);
    const stop = runtime.stopAll();
    const dispose = runtime.dispose();
    expect(() => runtime.claimTurn("t1", "turn-2")).toThrow(/stopping/);
    release();
    await Promise.all([stop, dispose]);
    expect(stopTurn).toHaveBeenCalledTimes(1);
    expect(stopTurn).toHaveBeenCalledWith(active);
  });

  it("stops each turn once when a void stopTurn leaves it registered", async () => {
    const stopTurn = vi.fn();
    const runtime = createDriverSessionRuntime<{ turnId: string }>({ driverKind: "test", stopTurn });
    const first = { turnId: "turn-1" };
    const second = { turnId: "turn-2" };
    runtime.claimTurn("t1", "turn-1");
    runtime.setTurn("t1", first);
    runtime.claimTurn("t2", "turn-2");
    runtime.setTurn("t2", second);
    const stop = runtime.stopAll();
    const teardown = runtime.dispose();
    await Promise.all([stop, teardown]);
    expect(stopTurn).toHaveBeenCalledTimes(2);
    expect(stopTurn).toHaveBeenCalledWith(first);
    expect(stopTurn).toHaveBeenCalledWith(second);
  });

  it("reports a live claim as not canceled", () => {
    const { runtime } = makeRuntime();
    runtime.claimTurn("t1", "turn-1");
    expect(runtime.claimCanceled("turn-1")).toBe(false);
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
