import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import {
  ROOM_TOOL_QUIET_LIMIT_MS,
  ROOM_TURN_PROGRESS,
  RoomTurnDeadline,
  RoomTurnStallRegistry,
  effectiveRoomTurnTimeoutMinutes,
  parseConversationTurnTimeout,
  roomTurnTimeoutMessage,
  roomTurnTimeoutMs,
} from "./room-turn-timeout.ts";

afterEach(() => vi.useRealTimers());

const base = { eventId: "e1", provider: "claudeAgent", threadId: "t1", createdAt: "2026-01-01T00:00:00.000Z" } as const;
const toolStarted = (itemId: string): RuntimeEvent => ({ ...base, type: "item.started", itemType: "tool", itemId });
const toolEnded = (itemId: string): RuntimeEvent => ({ ...base, type: "item.completed", itemType: "tool", itemId, ok: true });
const cardOpened: RuntimeEvent = { ...base, type: "request.opened", requestId: "r", requestType: "permission", tool: "Bash", summary: "ls" };
const cardResolved: RuntimeEvent = { ...base, type: "request.resolved", requestId: "r", behavior: "allow", source: "user" };

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

  it("keeps a turn that shows progress going past the limit, and stops it once it shows none for the limit", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const deadline = new RoomTurnDeadline(5, onTimeout);
    deadline.start();

    for (let minute = 0; minute < 30; minute += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      deadline.progress();
    }
    expect(onTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledOnce();
    deadline.stop();
  });

  it("counts the engine's work as progress, and not retries, session news or cards", () => {
    for (const type of ["content.delta", "item.started", "item.updated", "item.completed", "item.output", "turn.progress"] as const) {
      expect(ROOM_TURN_PROGRESS.has(type)).toBe(true);
    }
    for (const type of ["turn.retrying", "cap.exhausted", "session.started", "session.model-variants", "runtime.notice", "request.opened", "turn.wait_started"] as const) {
      expect(ROOM_TURN_PROGRESS.has(type)).toBe(false);
    }
  });

  it("progress while waiting gives the turn the full limit once the wait ends", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const deadline = new RoomTurnDeadline(5, onTimeout);
    deadline.start();

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    deadline.setWaiting(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    deadline.progress();
    deadline.setWaiting(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledOnce();
    deadline.stop();
  });

  it("stops a turn whose progress arrives after the limit, before the timer ran", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const deadline = new RoomTurnDeadline(5, onTimeout);
    deadline.start();

    // A stalled event loop delivers the event past the limit, before the timer callback ran.
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    deadline.progress();
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

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    deadline.setWaiting(true);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(onTimeout).not.toHaveBeenCalled();

    deadline.setWaiting(false);
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
    deadline.setWaiting(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    deadline.setWaiting(true);
    deadline.setWaiting(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(onTimeout).not.toHaveBeenCalled();

    deadline.setWaiting(false);
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

    // A stalled event loop delivers the card event past the deadline, before the timer callback ran.
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    deadline.setWaiting(true);
    expect(onTimeout).toHaveBeenCalledOnce();

    deadline.setWaiting(false);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("ignores resolves for cards it never saw open", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const deadline = new RoomTurnDeadline(5, onTimeout);
    deadline.start();

    deadline.setWaiting(false);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    deadline.setWaiting(false);

    await vi.advanceTimersByTimeAsync(3 * 60_000 - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledOnce();
    deadline.stop();
  });

  it("keeps a turn going while a tool runs past the limit, and gives it the full limit once the tool ends", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const deadline = new RoomTurnDeadline(5, onTimeout);
    deadline.start();

    await vi.advanceTimersByTimeAsync(60_000);
    deadline.observe(toolStarted("run"));
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(onTimeout).not.toHaveBeenCalled();

    deadline.observe(toolEnded("run"));
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("stops a turn whose tool shows nothing for the tool limit, as when its end never arrives", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const deadline = new RoomTurnDeadline(5, onTimeout);
    deadline.start();

    deadline.observe(toolStarted("lost"));
    await vi.advanceTimersByTimeAsync(ROOM_TOOL_QUIET_LIMIT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("stops a turn with no tool running at the limit, whatever tools ended before", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const deadline = new RoomTurnDeadline(5, onTimeout);
    deadline.start();

    deadline.observe(toolStarted("a"));
    deadline.observe(toolEnded("a"));
    deadline.observe(toolEnded("never-started"));
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("keeps the tool limit until the last running tool ends, across a card that opened and closed", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const deadline = new RoomTurnDeadline(5, onTimeout);
    deadline.start();

    deadline.observe(toolStarted("a"));
    deadline.observe(toolStarted("b"));
    deadline.observe(cardOpened);
    deadline.observe(toolEnded("a"));
    deadline.observe(cardResolved);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(onTimeout).not.toHaveBeenCalled();

    deadline.observe(toolEnded("b"));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("does not fire while held even past the budget, and stop() cancels a held clock", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const deadline = new RoomTurnDeadline(5, onTimeout);
    deadline.start();

    await vi.advanceTimersByTimeAsync(1 * 60_000);
    deadline.setWaiting(true);
    deadline.stop();
    deadline.setWaiting(false);

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

    expect(stalls.stall("room-thread", "no activity")).toBe(true);
    expect(stalls.stall("room-thread", "no activity")).toBe(false);
    await finished;
    expect(completions).toBe(1);

    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(completions).toBe(1);

    const settledElsewhere = vi.fn();
    const cleanup = stalls.register("room-thread", settledElsewhere);
    cleanup();
    expect(stalls.stall("room-thread", "no activity")).toBe(false);
    expect(settledElsewhere).not.toHaveBeenCalled();

    const nextTurn = vi.fn();
    stalls.register("room-thread", nextTurn);
    expect(stalls.stall("room-thread", "no activity for 120 minutes")).toBe(true);
    expect(nextTurn).toHaveBeenCalledExactlyOnceWith("no activity for 120 minutes");
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
      "Atlas's room turn made no progress for 1 minute and was stopped",
    );
    expect(roomTurnTimeoutMessage("Atlas", 20)).toBe(
      "Atlas's room turn made no progress for 20 minutes and was stopped",
    );
  });
});
