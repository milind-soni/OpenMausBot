import { expect, it, vi } from "vitest";
import { existingDirectSendReceipt } from "./direct-send-receipt.ts";
import type { Message } from "./store.ts";
const input = { threadId: "thread", sendId: "send-fixture-0001", text: "draft", delivery: { mode: "steer" as const, runId: "run-1" } };
const message = { id: "m", at: 1792627200000, role: "user", kind: "text", text: input.text, sendId: input.sendId, composerDelivery: input.delivery, steered: true } as Message;
it("returns the original uncertain receipt before consulting queues", () => {
  const queued = vi.fn();
  expect(existingDirectSendReceipt([{ ...message, steerUncertain: true }], queued, input)).toMatchObject({ ok: false, uncertain: true, threadId: input.threadId, message: { id: "m" } });
  expect(queued).not.toHaveBeenCalled();
});
it("refuses reusing a delivered send identity for a different intent", () => {
  expect(() => existingDirectSendReceipt([message], () => null, { ...input, delivery: { mode: "queue" } })).toThrow("sendId already belongs");
  expect(existingDirectSendReceipt([message], () => null, input)).toMatchObject({ ok: true, steered: true });
});
it("restores a queue receipt and refuses a conflicting queue identity", () => {
  const queued = () => ({ id: "q", text: input.text, composerDelivery: { mode: "queue" as const } });
  expect(existingDirectSendReceipt([], queued, { ...input, delivery: { mode: "queue" } })).toMatchObject({ ok: true, queued: true, queueId: "q" });
  expect(() => existingDirectSendReceipt([], queued, input)).toThrow("sendId already belongs");
  expect(existingDirectSendReceipt([], () => null, input)).toBeNull();
});
