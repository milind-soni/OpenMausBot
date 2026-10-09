import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RoomTurnDeadline,
  RoomTurnStallRegistry,
  effectiveRoomTurnTimeoutMinutes,
  parseConversationTurnTimeout,
  roomTurnTimeoutMessage,
  roomTurnTimeoutMs,
} from "./room-turn-timeout.ts";

afterEach(() => vi.useRealTimers());

describe("room turn timeout", () => {
  it("converts configured minutes to milliseconds", () => {
    expect(roomTurnTimeoutMs(20)).toBe(20 * 60_000);
  });

  it("fires exactly at the configured absolute deadline", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const deadline = new RoomTurnDeadline(20, onTimeout);
    deadline.start();

    await vi.advanceTimersByTimeAsync(20 * 60_000 - 1);
    expect(onTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledOnce();
    deadline.stop();
  });

  it("can be cancelled when the room turn settles", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const deadline = new RoomTurnDeadline(5, onTimeout);
    deadline.start();
    deadline.stop();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("holds the clock while a human decides and resumes where it left off", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const deadline = new RoomTurnDeadline(20, onTimeout);
    deadline.start();

    // fifteen real minutes of work, then an approval card opens
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    deadline.setWaitingOnHuman(true);

    // however long the person takes, none of it counts
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(onTimeout).not.toHaveBeenCalled();

    // answered: only the remaining five work-minutes are left
    deadline.setWaitingOnHuman(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(onTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledOnce();
    deadline.stop();
  });

  it("only resumes after the last of several approvals resolves", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const deadline = new RoomTurnDeadline(10, onTimeout);
    deadline.start();

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    deadline.setWaitingOnHuman(true); // first card
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    deadline.setWaitingOnHuman(true); // a second card while deciding again
    deadline.setWaitingOnHuman(false); // first answered — still holding
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(onTimeout).not.toHaveBeenCalled();

    deadline.setWaitingOnHuman(false); // last answer → resume with 6m left
    await vi.advanceTimersByTimeAsync(6 * 60_000 - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledOnce();
    deadline.stop();
  });

  it("expires immediately when a card opens after the budget already ran out", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const deadline = new RoomTurnDeadline(5, onTimeout);
    deadline.start();

    // a stalled event loop delivers the card event past the deadline, before
    // the timer callback had its turn — the exhausted budget must still fire
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    deadline.setWaitingOnHuman(true);
    expect(onTimeout).toHaveBeenCalledOnce();

    // and nothing afterwards re-arms or double-fires
    deadline.setWaitingOnHuman(false);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("ignores resolves for cards it never saw open", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const deadline = new RoomTurnDeadline(5, onTimeout);
    deadline.start();

    deadline.setWaitingOnHuman(false);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    deadline.setWaitingOnHuman(false); // stale cleanup after an interrupt

    await vi.advanceTimersByTimeAsync(3 * 60_000 - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledOnce();
    deadline.stop();
  });

  it("does not fire while held even past the budget, and stop() cancels a held clock", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const deadline = new RoomTurnDeadline(5, onTimeout);
    deadline.start();

    await vi.advanceTimersByTimeAsync(1 * 60_000);
    deadline.setWaitingOnHuman(true);
    deadline.stop(); // the turn settled while the card was still open
    deadline.setWaitingOnHuman(false); // late resolve must not re-arm

    await vi.advanceTimersByTimeAsync(60 * 60_000);
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
    let deadline!: RoomTurnDeadline;
    let unregister = () => {};
    const finish = () => {
      if (completions > 0) return;
      completions += 1;
      deadline.stop();
      unregister();
      resolveFinished();
    };
    deadline = new RoomTurnDeadline(20, () => {
      onTimeout();
      finish();
    });
    deadline.start();
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

  it("lets one conversation replace the group ceiling and clears back to it", () => {
    expect(effectiveRoomTurnTimeoutMinutes(10, undefined)).toBe(10);
    expect(effectiveRoomTurnTimeoutMinutes(10, null)).toBe(10);
    expect(effectiveRoomTurnTimeoutMinutes(10, 30)).toBe(30);
    expect(effectiveRoomTurnTimeoutMinutes(10, 0)).toBe(10);
    expect(effectiveRoomTurnTimeoutMinutes(10, 1.5)).toBe(10);
    expect(parseConversationTurnTimeout(30)).toEqual({ ok: true, minutes: 30 });
    expect(parseConversationTurnTimeout(null)).toEqual({ ok: true, minutes: null });
    expect(parseConversationTurnTimeout(1441).ok).toBe(false);
    expect(parseConversationTurnTimeout("30").ok).toBe(false);
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
