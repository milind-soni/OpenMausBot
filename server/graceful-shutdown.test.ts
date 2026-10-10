import { describe, expect, it, vi } from "vitest";

import { createGracefulShutdown } from "./graceful-shutdown.ts";

describe("createGracefulShutdown", () => {
  it("waits for capability and provider cleanup and only starts once", async () => {
    let finishCapabilities!: () => void;
    let finishProviders!: () => void;
    const capabilities = new Promise<void>((resolve) => { finishCapabilities = resolve; });
    const providers = new Promise<void>((resolve) => { finishProviders = resolve; });
    const capabilityCleanup = vi.fn(() => capabilities);
    const providerCleanup = vi.fn(() => providers);
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({
      cleanup: [capabilityCleanup, providerCleanup],
      exit,
      timeoutMs: 5_000,
    });

    shutdown();
    shutdown();
    await Promise.resolve();
    expect(capabilityCleanup).toHaveBeenCalledOnce();
    expect(providerCleanup).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();

    finishCapabilities();
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    finishProviders();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("uses the deadline when cleanup is wedged", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const shutdown = createGracefulShutdown({
        cleanup: [() => new Promise<void>(() => {})],
        exit,
        timeoutMs: 50,
      });
      shutdown();
      await vi.advanceTimersByTimeAsync(49);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
