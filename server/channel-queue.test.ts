import { describe, expect, it, vi } from "vitest";

import {
  _queuedChannelCount,
  cancelChannelMessage,
  drainChannelMessages,
  queuedChannelMessage,
  queueChannelMessage,
} from "./channel-queue.ts";

describe("channel queue", () => {
  it("keeps messages off the running channel and drains one follow-up at a time", () => {
    let working = true;
    const run = vi.fn(() => {
      working = true;
    });
    const first = queueChannelMessage("group-a", "thread-a", "first follow-up", {
      sendId: "send_first_123456",
      usageTrigger: { kind: "user", label: "Alice device" },
    });
    queueChannelMessage("group-a", "thread-a", "second follow-up", {
      sendId: "send_second_123456",
      mode: "goal",
      usageTrigger: { kind: "user", label: "Bob device" },
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
      usageTrigger: { kind: "user", label: "Alice device" },
    }));
    expect(_queuedChannelCount("thread-a")).toBe(1);

    working = false;
    drainChannelMessages(() => working, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({
      text: "second follow-up",
      mode: "goal",
      usageTrigger: { kind: "user", label: "Bob device" },
    }));
    expect(_queuedChannelCount("thread-a")).toBe(0);
  });

  it("cancels only the requested channel message", () => {
    const keep = queueChannelMessage("group-b", "thread-b", "keep", { usageTrigger: { kind: "owner" } });
    const drop = queueChannelMessage("group-b", "thread-b", "drop", { usageTrigger: { kind: "owner" } });

    expect(cancelChannelMessage("group-b", drop.id)).toBe(true);
    expect(cancelChannelMessage("group-b", drop.id)).toBe(false);
    expect(_queuedChannelCount("thread-b")).toBe(1);

    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: keep.id, text: "keep" }));
  });
});
