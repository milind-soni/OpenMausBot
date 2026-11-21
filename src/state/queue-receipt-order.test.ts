import { expect, it } from "vitest";

import { reconcileSnapshotQueues } from "./queue-receipts";
import { initialState, reducer, type Message } from "./store";

it("keeps live consumed receipts ahead of overlapping loaded history", () => {
  const recent = reducer(reducer(initialState, { type: "consumePendingQueued", threadId: "live", queueId: "overlap" }),
    { type: "consumePendingQueued", threadId: "live", queueId: "new-live" });
  const messages: Message[] = Array.from({ length: 64 }, (_, at) => ({
    id: `m-${at}`, at, role: "user", kind: "text", text: "Already ran", queueId: at === 0 ? "overlap" : `old-${at}`,
  }));
  const hydrated = reconcileSnapshotQueues(recent, [{ messages }]);
  const late = reducer(hydrated, { type: "pendingQueued", threadId: "old-thread", queueId: "overlap", text: "Already ran" });
  expect(late.pendingQueued).toEqual({});
  expect(hydrated.consumedQueueIds["new-live"]).toBe(true);
  expect(Object.keys(hydrated.consumedQueueIds)).toHaveLength(64);
  expect(recent.consumedQueueIds).toEqual({ overlap: true, "new-live": true });
});

it("refreshes a repeated live receipt before evicting the oldest queue ID", () => {
  let state = initialState;
  for (let i = 0; i < 64; i++) state = reducer(state, { type: "consumePendingQueued", threadId: "t", queueId: `q-${i}` });
  state = reducer(state, { type: "consumePendingQueued", threadId: "t", queueId: "q-0" });
  state = reducer(state, { type: "consumePendingQueued", threadId: "t", queueId: "q-64" });
  expect(reducer(state, { type: "pendingQueued", threadId: "t", queueId: "q-0", text: "Already ran" }).pendingQueued).toEqual({});
  expect(state.consumedQueueIds["q-1"]).toBeUndefined();
  expect(Object.keys(state.consumedQueueIds)).toHaveLength(64);
});
