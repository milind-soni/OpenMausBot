import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONNECTOR_POLL_MS, CONNECTOR_POLL_TRIES, pollConnector } from "./connector-poll";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a Connect whose status request fails", () => {
  it("ends after the attempt budget even when every read rejects", async () => {
    const read = vi.fn(async () => { throw new Error("connection unavailable"); });
    const onEnd = vi.fn();
    pollConnector(undefined, read, onEnd);
    await vi.advanceTimersByTimeAsync(CONNECTOR_POLL_MS * CONNECTOR_POLL_TRIES);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith("timed_out");
    await vi.advanceTimersByTimeAsync(CONNECTOR_POLL_MS * 10);
    expect(read).toHaveBeenCalledTimes(CONNECTOR_POLL_TRIES);
  });

  it("recovers from a rejected read when the next status confirms the connection", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("temporary outage")).mockResolvedValue({ connected: true });
    const onEnd = vi.fn();
    pollConnector(undefined, read, onEnd);
    await vi.advanceTimersByTimeAsync(CONNECTOR_POLL_MS * 2);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith("connected");
  });

  it("handles a synchronous status-reader failure within the same attempt budget", async () => {
    const onEnd = vi.fn();
    pollConnector(undefined, () => { throw new Error("reader unavailable"); }, onEnd);
    await vi.advanceTimersByTimeAsync(CONNECTOR_POLL_MS * CONNECTOR_POLL_TRIES);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith("timed_out");
  });

  it("ignores a late rejection after the panel stops polling", async () => {
    let fail!: (error: Error) => void;
    const onEnd = vi.fn();
    const stop = pollConnector(undefined, () => new Promise((_resolve, reject) => { fail = reject; }), onEnd);
    await vi.advanceTimersByTimeAsync(CONNECTOR_POLL_MS);
    stop();
    fail(new Error("late response failure"));
    await vi.advanceTimersByTimeAsync(CONNECTOR_POLL_MS * CONNECTOR_POLL_TRIES);
    expect(onEnd).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
