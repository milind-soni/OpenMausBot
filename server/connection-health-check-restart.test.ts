import { describe, expect, it, vi } from "vitest";

import { createBackgroundCheck } from "./connection-health-check.ts";

describe("background connection checks across restarts", () => {
  it("does not let a cancelled in-flight check create a second timer after restart", async () => {
    let finish!: (outcome: string) => void;
    const result = new Promise<string>((resolve) => { finish = resolve; });
    const pending = new Set<() => void>();
    const record = vi.fn();
    const check = createBackgroundCheck({
      due: () => ["server"], check: () => result, record,
      asleep: () => false, wokeAt: () => null,
      setTimer: (run) => { pending.add(run); return { cancel: () => { pending.delete(run); } }; },
    });
    check.start();
    const first = [...pending][0]!;
    pending.delete(first);
    first();
    check.stop();
    check.start();
    finish("ok");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(record).not.toHaveBeenCalled();
    expect(pending.size).toBe(1);
    check.stop();
    expect(pending.size).toBe(0);
  });

  it("ignores a timer callback from a previous start even if cancellation came too late", async () => {
    const callbacks: Array<() => void> = [];
    const probe = vi.fn(async () => "ok");
    const check = createBackgroundCheck({
      due: () => ["server"], check: probe, record: vi.fn(),
      asleep: () => false, wokeAt: () => null,
      setTimer: (run) => { callbacks.push(run); return { cancel: () => undefined }; },
    });
    check.start();
    check.stop();
    check.start();
    callbacks[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(probe).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(2);
    check.stop();
  });
});
