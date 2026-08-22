import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RoomTurnStallRegistry,
  roomTurnTimeoutMessage,
  roomTurnTimeoutMs,
  scheduleRoomTurnTimeout,
} from "./room-turn-timeout.ts";

afterEach(() => vi.useRealTimers());

describe("room turn timeout", () => {
  it("converts configured minutes to milliseconds", () => {
    expect(roomTurnTimeoutMs(20)).toBe(20 * 60_000);
  });

  it("fires exactly at the configured absolute deadline", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const timer = scheduleRoomTurnTimeout(20, onTimeout);

    await vi.advanceTimersByTimeAsync(20 * 60_000 - 1);
    expect(onTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledOnce();
    clearTimeout(timer);
  });

  it("can be cancelled when the room turn settles", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const timer = scheduleRoomTurnTimeout(5, onTimeout);
    clearTimeout(timer);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("settles a stalled room turn once, cancels its ceiling, and can be reused", async () => {
    vi.useFakeTimers();
    const stalls = new RoomTurnStallRegistry();
    const onTimeout = vi.fn();
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    let completions = 0;
    let timer!: ReturnType<typeof setTimeout>;
    let unregister = () => {};
    const finish = () => {
      if (completions > 0) return;
      completions += 1;
      clearTimeout(timer);
      unregister();
      resolveFinished();
    };
    timer = scheduleRoomTurnTimeout(20, () => {
      onTimeout();
      finish();
    });
    unregister = stalls.register("room-thread", finish);

    expect(stalls.stall("room-thread")).toBe(true);
    expect(stalls.stall("room-thread")).toBe(false);
    await finished;
    expect(completions).toBe(1);

    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(completions).toBe(1);

    const settledElsewhere = vi.fn();
    const cleanup = stalls.register("room-thread", settledElsewhere);
    cleanup();
    expect(stalls.stall("room-thread")).toBe(false);
    expect(settledElsewhere).not.toHaveBeenCalled();

    const nextTurn = vi.fn();
    stalls.register("room-thread", nextTurn);
    expect(stalls.stall("room-thread")).toBe(true);
    expect(nextTurn).toHaveBeenCalledOnce();
  });

  it("formats singular and plural timeout messages", () => {
    expect(roomTurnTimeoutMessage("Atlas", 1)).toBe(
      "Atlas's room turn exceeded 1 minute and was stopped",
    );
    expect(roomTurnTimeoutMessage("Atlas", 20)).toBe(
      "Atlas's room turn exceeded 20 minutes and was stopped",
    );
  });
});
