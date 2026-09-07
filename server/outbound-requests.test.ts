// A held outbound call: the relay waits on a card, the respond route
// answers it. The service is the meeting point, and its contract is the
// same one the other card services keep — claim exactly once, say what
// happened, never leave a waiter hanging.
import { describe, expect, it } from "vitest";

import { OutboundRequestService } from "./outbound-requests.ts";

const open = (service: OutboundRequestService, timeoutMs = 60_000) =>
  service.open({ botId: "b1", threadId: "t1", tool: "GMAIL_SEND_EMAIL", timeoutMs });

describe("OutboundRequestService", () => {
  it("settles the waiter with the person's answer, and claims the request exactly once", async () => {
    const service = new OutboundRequestService();
    const held = open(service);
    expect(service.pending("t1")).toEqual([held.requestId]);

    expect(service.resolve({ threadId: "t1", requestId: held.requestId, behavior: "allow" })).toEqual({
      claimed: true,
      state: "allowed",
    });
    await expect(held.answer).resolves.toBe("allow");
    expect(service.pending("t1")).toEqual([]);

    expect(service.resolve({ threadId: "t1", requestId: held.requestId, behavior: "deny" })).toEqual({
      claimed: true,
      state: "already_settled",
      behavior: "allow",
    });
  });

  it("does not claim a request it never opened, or one in another thread", () => {
    const service = new OutboundRequestService();
    const held = open(service);
    expect(service.resolve({ threadId: "t1", requestId: "nope", behavior: "allow" })).toEqual({ claimed: false });
    expect(service.resolve({ threadId: "t2", requestId: held.requestId, behavior: "allow" })).toEqual({ claimed: false });
  });

  it("denies when the person says no", async () => {
    const service = new OutboundRequestService();
    const held = open(service);
    expect(service.resolve({ threadId: "t1", requestId: held.requestId, behavior: "deny" })).toEqual({
      claimed: true,
      state: "denied",
    });
    await expect(held.answer).resolves.toBe("deny");
  });

  it("times out as a denial rather than waiting forever", async () => {
    const service = new OutboundRequestService();
    const held = open(service, 20);
    await expect(held.answer).resolves.toBe("timeout");
    expect(service.pending("t1")).toEqual([]);
    expect(service.resolve({ threadId: "t1", requestId: held.requestId, behavior: "allow" })).toEqual({
      claimed: true,
      state: "already_settled",
      behavior: "timeout",
    });
  });
});
