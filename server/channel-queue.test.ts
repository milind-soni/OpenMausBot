import { describe, expect, it, vi } from "vitest";

import {
  _queuedChannelCount,
  cancelChannelMessage,
  drainChannelMessages,
  holdChannelQueue,
  queuedChannelMessage,
  queueChannelMessage,
  restoreHeldChannelQueue,
  settleHeldChannelQueueHead,
} from "./channel-queue.ts";

describe("channel queue", () => {
  it("keeps messages off the running channel and drains one follow-up at a time", () => {
    let working = true;
    const run = vi.fn(() => {
      working = true;
    });
    const first = queueChannelMessage("group-a", "thread-a", "first follow-up", {
      sendId: "send_first_123456",
    });
    queueChannelMessage("group-a", "thread-a", "second follow-up", {
      sendId: "send_second_123456",
      mode: "goal",
    });

    drainChannelMessages(() => working, run);
    expect(run).not.toHaveBeenCalled();
    expect(_queuedChannelCount("thread-a")).toBe(2);
    expect(queuedChannelMessage("group-a", "thread-a", "send_first_123456")?.id).toBe(first.id);

    working = false;
    drainChannelMessages(() => working, run);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({
      groupId: "group-a",
      threadId: "thread-a",
      text: "first follow-up",
      mode: "chat",
    }));
    expect(_queuedChannelCount("thread-a")).toBe(1);

    working = false;
    drainChannelMessages(() => working, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({
      text: "second follow-up",
      mode: "goal",
    }));
    expect(_queuedChannelCount("thread-a")).toBe(0);
  });

  it("cancels only the requested channel message", () => {
    const keep = queueChannelMessage("group-b", "thread-b", "keep");
    const drop = queueChannelMessage("group-b", "thread-b", "drop");

    expect(cancelChannelMessage("group-b", drop.id)).toBe(true);
    expect(cancelChannelMessage("group-b", drop.id)).toBe(false);
    expect(_queuedChannelCount("thread-b")).toBe(1);

    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: keep.id, text: "keep" }));
  });

  it("lifts the whole queue atomically for a live steer, so a settle cannot drain it too", () => {
    const head = queueChannelMessage("group-c", "thread-c", "steer me");
    queueChannelMessage("group-c", "thread-c", "behind the head");

    // A hold for words that are not this queue's, or another room's queue,
    // changes nothing.
    expect(holdChannelQueue("group-c", "thread-c", "unknown")).toBeNull();
    expect(holdChannelQueue("group-other", "thread-c", head.id)).toBeNull();
    expect(_queuedChannelCount("thread-c")).toBe(2);

    const held = holdChannelQueue("group-c", "thread-c", head.id);
    expect(held?.items.map((item) => item.id)).toEqual([head.id, expect.any(String)]);
    // The entry left the map: a drain firing while the adapter is still
    // thinking can never double-dispatch the held words.
    expect(_queuedChannelCount("thread-c")).toBe(0);
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).not.toHaveBeenCalled();

    restoreHeldChannelQueue(held!);
    expect(_queuedChannelCount("thread-c")).toBe(2);
    // Leave the shared map clean for the tests that follow.
    for (const item of held!.items) cancelChannelMessage("group-c", item.id);
    expect(_queuedChannelCount("thread-c")).toBe(0);
  });

  it("restores a refused steer behind words that queued while the hold was open", () => {
    const first = queueChannelMessage("group-d", "thread-d", "refused head");
    const held = holdChannelQueue("group-d", "thread-d", first.id)!;
    // The room kept accepting sends while the steer was in flight.
    const late = queueChannelMessage("group-d", "thread-d", "arrived during the hold", {
      sendId: "send_late_123456",
    });

    restoreHeldChannelQueue(held);
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: first.id }));
    expect(_queuedChannelCount("thread-d")).toBe(1);
    expect(queuedChannelMessage("group-d", "thread-d", "send_late_123456")?.id).toBe(late.id);
    cancelChannelMessage("group-d", late.id);
  });

  it("settles only the steered head and re-queues the tail for the room drain", () => {
    const head = queueChannelMessage("group-e", "thread-e", "folded into the running turn");
    const tail = queueChannelMessage("group-e", "thread-e", "still waits its own turn");
    const held = holdChannelQueue("group-e", "thread-e", head.id)!;

    settleHeldChannelQueueHead(held);
    // The steered words are gone for good: a restart or drain must not
    // replay them as a fresh follow-up.
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: tail.id, text: "still waits its own turn" }));
    expect(_queuedChannelCount("thread-e")).toBe(0);
  });
});
