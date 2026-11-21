import { describe, expect, it } from "vitest";

import { holdLimits } from "./hold.ts";

describe("how long a person's hold on a bot's browser lasts", () => {
  it("is five minutes without input by default, with two minutes' grace once their views went", () => {
    expect(holdLimits({})).toEqual({ graceMs: 120_000, idleMs: 300_000 });
  });

  it("takes an idle limit from one minute to an hour from the environment", () => {
    expect(holdLimits({ OMB_BROWSER_HOLD_IDLE_MS: "1800000" }).idleMs).toBe(1_800_000);
    expect(holdLimits({ OMB_BROWSER_HOLD_IDLE_MS: "60000" }).idleMs).toBe(60_000);
  });

  it.each(["", "abc", "1000", "7200000", "-5"])("keeps five minutes for %j", (value) => {
    expect(holdLimits({ OMB_BROWSER_HOLD_IDLE_MS: value }).idleMs).toBe(300_000);
  });
});
