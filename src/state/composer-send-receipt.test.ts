import { expect, it, vi } from "vitest";
import { applyComposerSendReceipt, applyQueuedSteerReceipt } from "./composer-send-receipt";
import type { Message } from "./store";
it("retains an uncertain delivered message and restores the draft without creating a queue entry", () => {
  const dispatch = vi.fn(), error = vi.fn(), onError = vi.fn();
  applyComposerSendReceipt({ threadId: "t", message: { id: "m" } as Message, uncertain: true }, { text: "draft", sendId: "s", onError }, dispatch, error);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "messageAdded", message: { id: "m" } }));
  expect(onError).toHaveBeenCalledOnce(); expect(error).toHaveBeenCalledOnce();
});
it("replaces an optimistic send with its queued receipt", () => {
  const dispatch = vi.fn(), error = vi.fn();
  applyComposerSendReceipt({ threadId: "t", queued: true, queueId: "q", reason: "capacity" }, { text: "draft", sendId: "s" }, dispatch, error);
  expect(dispatch.mock.calls.map(([a]) => a)).toEqual([{ type: "optimisticMessageRemoved", threadId: "t", sendId: "s" }, { type: "pendingQueued", threadId: "t", queueId: "q", text: "draft", reason: "capacity" }]);
  expect(error).not.toHaveBeenCalled();
});

it.each([false, true])("consumes a queued steer receipt and reports uncertainty when present: %s", (uncertain) => {
  const dispatch = vi.fn(), error = vi.fn(), onError = vi.fn();
  const message = { id: "m", ...(uncertain ? { steerUncertain: true } : {}) } as Message;
  expect(applyQueuedSteerReceipt({ threadId: "t", messages: [message], queueIds: ["q"],
    ...(uncertain ? { uncertain: true } : { steered: true }) }, dispatch, error, onError)).toBe(true);
  expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
    { type: "messageAdded", threadId: "t", message }, { type: "consumePendingQueued", threadId: "t", queueId: "q" },
  ]);
  expect(error).toHaveBeenCalledTimes(uncertain ? 1 : 0);
  expect(onError).toHaveBeenCalledTimes(uncertain ? 1 : 0);
});

it("leaves an unsteered queue intact", () => {
  const dispatch = vi.fn(), error = vi.fn();
  expect(applyQueuedSteerReceipt({ threadId: "t" }, dispatch, error)).toBe(false);
  expect(dispatch).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});
