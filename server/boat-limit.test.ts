import { describe, expect, it } from "vitest";

import { boatRefusal } from "./boat.ts";
import { cloudFailureOf, cloudLimitFields, cloudLimitText } from "./boat-limit.ts";

const envelope = (message: string, fields: Record<string, unknown> = {}) =>
  ({ ok: false, type: "sandbox.error", status: 429, code: "limit_reached", message, ...fields, error: { code: "limit_reached", message, status: 429, ...fields } });
const TRIAL_HOURS = "Your Pro free trial's 20 cloud computer hours are used up. Your full allowance starts with your first payment on 14 Nov.";

describe("a refused cloud computer start, from the Admin's answer to the bot and the app", () => {
  it("reads the Admin's reason through the home's error", () => {
    const refused = boatRefusal(429, "boat create", envelope(TRIAL_HOURS, { reason: "hours_used", trial: true, plan: "Pro", limit: 20, used: 20, resetsAt: "2026-11-14T09:00:00.000Z" }), true);
    expect(cloudFailureOf(refused)).toEqual({ message: TRIAL_HOURS, code: "limit_reached", status: 429,
      limit: { reason: "hours_used", trial: true, plan: "Pro", limit: 20, used: 20, resetsAt: "2026-11-14T09:00:00.000Z" } });
    expect(cloudLimitText(refused)).toBe("This Cloud's free trial cloud computer hours are used up; its full allowance starts with its first payment on 14 Nov.");
    expect(cloudLimitFields(refused)).toEqual({ cloudLimit: { reason: "hours_used", trial: true, plan: "Pro", limit: 20, used: 20, resetsAt: "2026-11-14T09:00:00.000Z" } });
  });

  it("reads an Admin that sends no reason by its words, and tells the bot nothing new for any other failure", () => {
    const older = boatRefusal(429, "boat create", envelope("Your Personal plan includes 1 cloud computer at once. Delete one to start another."), true);
    expect(cloudFailureOf(older)).toEqual({ message: "Your Personal plan includes 1 cloud computer at once. Delete one to start another.", code: "limit_reached", status: 429 });
    expect(cloudLimitText(older)).toBe("This Cloud already has as many cloud computers running as its plan allows.");
    expect(cloudLimitFields(older)).toEqual({});
    expect(cloudLimitText(new Error("the cloud computer could not be created or reached"))).toBeUndefined();
    expect(cloudLimitText("not an error")).toBeUndefined();
    expect(cloudLimitFields(null)).toEqual({});
  });
});
