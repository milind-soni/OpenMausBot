import { afterEach, describe, expect, it, vi } from "vitest";

import { scheduleAdmissionSettlementAfterGrace, type TurnAdmissionOwnership } from "./turn-settlement.ts";

afterEach(() => vi.useRealTimers());

describe("scheduleAdmissionSettlementAfterGrace", () => {
  it("does not settle a newer admission for the same bot and thread", async () => {
    vi.useFakeTimers();
    let current: TurnAdmissionOwnership | undefined = { botId: "bot", token: "stalled-turn" };
    const settle = vi.fn();

    expect(scheduleAdmissionSettlementAfterGrace({
      botId: "bot",
      delayMs: 6_000,
      current: () => current,
      settle,
    })).toBe(true);

    current = { botId: "bot", token: "new-turn" };
    await vi.advanceTimersByTimeAsync(6_000);
    expect(settle).not.toHaveBeenCalled();
  });

  it("settles only when the pinned admission still owns the turn", async () => {
    vi.useFakeTimers();
    let current: TurnAdmissionOwnership | undefined = { botId: "bot", token: "stalled-turn" };
    const settle = vi.fn(() => {
      current = undefined;
    });

    expect(scheduleAdmissionSettlementAfterGrace({
      botId: "bot",
      delayMs: 6_000,
      current: () => current,
      settle,
    })).toBe(true);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(settle).toHaveBeenCalledOnce();

    expect(scheduleAdmissionSettlementAfterGrace({
      botId: "bot",
      delayMs: 6_000,
      current: () => current,
      settle,
    })).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
