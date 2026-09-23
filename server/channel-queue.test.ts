import { describe, expect, it, vi } from "vitest";

import {
  _queuedChannelCount,
  cancelChannelMessage,
  drainChannelMessages,
  holdChannelQueue,
  queuedChannelMessage,
  queueChannelMessage,
  restoreChannelMessages,
  restoreHeldChannelQueue,
  resolveHeldReplyTarget,
  settleHeldChannelQueueHead,
} from "./channel-queue.ts";
import { saveChatFollowup } from "./message-db.ts";

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

  it("hands the drain who sent a queued message, through a restart too", () => {
    queueChannelMessage("group-sender", "thread-sender", "from the paired person", { sender: { name: "Priya" } });
    queueChannelMessage("group-sender", "thread-sender", "from the owner");
    restoreChannelMessages(); // a restart reads the name back from the durable row

    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-sender", text: "from the paired person", sender: { name: "Priya" },
    }));
    drainChannelMessages(() => false, run);
    const owner = run.mock.calls.map(([input]) => input).find((input) => input.text === "from the owner");
    expect(owner).toBeDefined();
    expect(owner.sender).toBeUndefined();
  });

  it("keeps who sent the head of a held queue, so a room steer can still name them", () => {
    const head = queueChannelMessage("group-sender-held", "thread-sender-held", "steer me", { sender: { name: "Priya" } });
    const held = holdChannelQueue("group-sender-held", "thread-sender-held", head.id);
    expect(held?.items[0].sender).toEqual({ name: "Priya" });
    settleHeldChannelQueueHead(held!);
  });

  it("still loads and drains a durable row written before senders were kept", () => {
    saveChatFollowup({
      id: "legacy-channel-followup-without-sender", kind: "channel", ownerId: "group-legacy", threadId: "thread-legacy",
      payload: { text: "queued by an older build", mode: "chat" },
    });
    expect(() => restoreChannelMessages()).not.toThrow();
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    const legacy = run.mock.calls.map(([input]) => input).find((input) => input.threadId === "thread-legacy");
    expect(legacy).toMatchObject({ id: "legacy-channel-followup-without-sender", text: "queued by an older build", mode: "chat" });
    expect(legacy.sender).toBeUndefined();
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

  it("refuses to lift the queue when the request names a later item, not the head", () => {
    const head = queueChannelMessage("group-f", "thread-f", "the head must stay");
    const later = queueChannelMessage("group-f", "thread-f", "named by the request");

    // The steer path settles held.items[0]; a hold granted for a later id
    // would steer and delete the head's words instead. Nothing may move.
    expect(holdChannelQueue("group-f", "thread-f", later.id)).toBeNull();
    expect(_queuedChannelCount("thread-f")).toBe(2);
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: head.id, text: "the head must stay" }));
    expect(run).toHaveBeenCalledTimes(1);
    cancelChannelMessage("group-f", head.id);
    cancelChannelMessage("group-f", later.id);
    expect(_queuedChannelCount("thread-f")).toBe(0);
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

  it("restores the held queue when the head's reply target can no longer be resolved", () => {
    const head = queueChannelMessage("group-h", "thread-h", "reply to a vanished message", {
      replyToId: "msg_gone",
    });
    const held = holdChannelQueue("group-h", "thread-h", head.id)!;
    expect(_queuedChannelCount("thread-h")).toBe(0);

    // The steer route resolves the reply target while the queue is lifted;
    // a target that drifted out of the transcript must put the words back.
    expect(() =>
      resolveHeldReplyTarget(held, () => {
        throw new Error("the message being replied to is no longer available");
      }),
    ).toThrow("no longer available");
    expect(_queuedChannelCount("thread-h")).toBe(1);
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: head.id, replyToId: "msg_gone" }));
    cancelChannelMessage("group-h", head.id);
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
