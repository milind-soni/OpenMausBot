import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInputDropReport } from "./browser-input-drops";

describe("the report of dropped browser input", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("sends the drops of a moment as one request of reason codes and counts", () => {
    const sent: unknown[] = [];
    const report = createInputDropReport(async (counts) => { sent.push(counts); }, () => true, 2_000);
    report.count("queue_halted");
    report.count("queue_halted");
    report.count("stale_after_wait");
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual([{ queue_halted: 2, stale_after_wait: 1 }]);
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(1);
  });

  it("keeps counts while the view is not connected and sends them once it is", () => {
    const sent: unknown[] = [];
    let ready = false;
    const report = createInputDropReport(async (counts) => { sent.push(counts); }, () => ready, 2_000);
    report.count("not_connected");
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual([]);
    ready = true;
    report.kick();
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual([{ not_connected: 1 }]);
  });

  it("does not retry a failed send, and sends nothing once closed", async () => {
    let calls = 0;
    const report = createInputDropReport(async () => { calls += 1; throw new Error("offline"); }, () => true, 2_000);
    report.count("send_failed");
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1);
    report.count("send_failed");
    report.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1);
  });
});
