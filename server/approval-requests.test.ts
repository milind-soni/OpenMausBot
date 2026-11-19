import { describe, it, expect, vi, afterEach } from "vitest";
import { ApprovalRequests } from "./approval-requests.ts";
afterEach(() => vi.useRealTimers());
const input = { botId: "bot", threadId: "thread", tool: "Approval: copy · /Desktop/TEST", summary: "Copy test files" };
describe("explicit approval requests", () => {
  it("waits for the matching owner and resolves once", async () => {
    const opened = vi.fn(), resolved = vi.fn(); const broker = new ApprovalRequests(opened, resolved);
    const pending = broker.open(input);
    expect(opened).toHaveBeenCalledWith({ ...input, id: pending.id });
    expect(broker.respond(pending.id, "other", "thread", { approved: true, always: false })).toBe(false);
    expect(broker.respond(pending.id, "bot", "other", { approved: true, always: false })).toBe(false);
    expect(broker.respond(pending.id, "bot", "thread", { approved: true, always: true })).toBe(true);
    expect(await pending.result).toEqual({ approved: true, always: true });
    expect(broker.respond(pending.id, "bot", "thread", { approved: true, always: false })).toBe(false);
    expect(resolved).toHaveBeenCalledTimes(1);
  });
  it("denies on cancellation without touching another thread", async () => {
    const broker = new ApprovalRequests(() => {}, () => {});
    const one = broker.open(input), two = broker.open({ ...input, threadId: "other" });
    broker.cancelThread("thread");
    expect(await one.result).toMatchObject({ approved: false });
    expect(broker.get(two.id, "bot", "other")).toBeDefined();
    broker.cancelAll(); expect(await two.result).toMatchObject({ approved: false });
  });
  it("expires without granting permission", async () => {
    vi.useFakeTimers();const broker = new ApprovalRequests(() => {}, () => {});
    const pending = broker.open(input, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending.result).toMatchObject({ approved: false, reason: "Approval expired." });
  });
});
