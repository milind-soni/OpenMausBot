import { describe, expect, it } from "vitest";

import { roomTurnEnd } from "./room-turn-end.ts";

describe("how a room member's turn ends", () => {
  const ok = { ok: true };
  const broke = { ok: false, stopReason: "exit_before_result" };

  it("settles on an ordinary end, and fails a team step with the engine's reason", () => {
    expect(roomTurnEnd(ok, true)).toEqual({ outcome: "settled" });
    expect(roomTurnEnd(broke, false)).toEqual({ outcome: "settled" });
    expect(roomTurnEnd(broke, true)).toEqual({ outcome: "provider_failed", stopReason: "exit_before_result" });
    expect(roomTurnEnd({ ok: false }, true)).toEqual({ outcome: "provider_failed", stopReason: null });
  });

  it("ends on the member's cloud computer that could not start: its cause, never 'interrupted'", () => {
    const claim = { parked: false as const, message: "This month's 50 cloud computer hours are used up. Set Works on to Auto in this bot's settings to continue." };
    // The interrupt that ended it settles as broken or, racing a reply, as ok.
    for (const event of [broke, { ok: false, stopReason: "interrupted" }, ok]) {
      expect(roomTurnEnd(event, true, claim)).toEqual({ outcome: "provider_failed", stopReason: claim.message });
      // A chat round stops there too, as a failure at setup stops it.
      expect(roomTurnEnd(event, false, claim)).toEqual({ outcome: "provider_failed", stopReason: claim.message });
    }
  });

  it("parks when the member waited out the computer's ceiling", () => {
    expect(roomTurnEnd(broke, true, { parked: true })).toEqual({ outcome: "parked" });
    expect(roomTurnEnd(ok, false, { parked: true })).toEqual({ outcome: "parked" });
  });
});
