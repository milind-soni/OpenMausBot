import { describe, expect, it, vi } from "vitest";
import { TurnSupervision } from "./turn-supervision.ts";

describe("TurnSupervision", () => {
  it("accepts the matching terminal event and rejects a late provider id", () => {
    const unknown = vi.fn();
    const guard = new TurnSupervision({ graceMs: 20, onUnknown: unknown });
    expect(guard.begin("bot", "thread")).toBe(true);
    expect(guard.bind("bot", "thread", "turn-1")).toBe(true);
    expect(guard.observeTerminal("bot", "thread", "turn-1")).toMatchObject({ accepted: true, turnId: "turn-1" });
    expect(guard.isLate("bot", "thread", "turn-1")).toBe(true);
    expect(guard.begin("bot", "thread")).toBe(true);
    expect(guard.isCurrent("bot", "thread", "turn-1")).toBe(false);
    expect(unknown).not.toHaveBeenCalled();
  });

  it("emits exactly one unknown receipt after bounded cancellation grace", async () => {
    const unknown = vi.fn();
    const guard = new TurnSupervision({ graceMs: 5, onUnknown: unknown });
    guard.begin("bot", "thread");
    await guard.requestStop("bot", "thread", "cancel", () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(unknown).toHaveBeenCalledTimes(1);
    expect(unknown.mock.calls[0]?.[0]).toMatchObject({ intent: "cancel", threadId: "thread" });
    expect(guard.has("bot", "thread")).toBe(false);
  });
});
