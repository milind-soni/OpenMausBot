import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { waitForLocalVmReady } from "./local-vm-readiness";

const warming = { ready: false, container: "running", problem: null as string | null };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Local VM readiness deadlines", () => {
  it.each([
    ["container", "linux", 60_000],
    ["cua-spaces", "linux", 90_000],
    ["cua-spaces", "macos", 300_000],
  ])("bounds %s %s readiness at %i ms and keeps the last problem", async (backend, os, deadline) => {
    const initial = { ...warming, backend, os };
    const last = { ...initial, problem: "Guest desktop is still starting" };
    const read = vi.fn(async () => last);
    const controller = new AbortController();
    let settled = false;
    const ready = waitForLocalVmReady(initial, read, controller.signal).then((status) => {
      settled = true;
      return status;
    });

    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ready).toBe(last);
    expect(settled).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds an in-flight status read and aborts only its polling signal", async () => {
    let pollingSignal: AbortSignal | undefined;
    const read = vi.fn((signal: AbortSignal) => {
      pollingSignal = signal;
      return new Promise<typeof warming>(() => {});
    });
    const controller = new AbortController();
    const ready = waitForLocalVmReady(warming, read, controller.signal, 5_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledOnce();
    expect(pollingSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await ready).toBe(warming);
    expect(pollingSignal?.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns readiness immediately after the confirming status read", async () => {
    const last = { ...warming, ready: true };
    const read = vi.fn(async () => last);
    const ready = waitForLocalVmReady(warming, read, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await ready).toBe(last);
    expect(read).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["stopped", "missing"])("keeps %s status without polling", async (container) => {
    const initial = { ...warming, container, problem: "Start the desktop first" };
    const read = vi.fn(async () => initial);
    expect(await waitForLocalVmReady(initial, read, new AbortController().signal)).toBe(initial);
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not poll an already-ready desktop", async () => {
    const initial = { ...warming, ready: true };
    const read = vi.fn(async () => initial);
    expect(await waitForLocalVmReady(initial, read, new AbortController().signal)).toBe(initial);
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a stalled read when the selected computer changes", async () => {
    const controller = new AbortController();
    const read = vi.fn(() => new Promise<typeof warming>(() => {}));
    const ready = waitForLocalVmReady(warming, read, controller.signal);
    const reason = new Error("Selected computer changed");
    const rejected = expect(ready).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(2_000);
    controller.abort(reason);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
