import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CloudUsage, CloudUsageMeter } from "../../electron/cloud-home.mjs";
import { setLocale } from "@/lib/i18n";
import {
  CARD_METERS, meterAmounts, meterBand, meterPercent, NEAR_LIMIT_PERCENT, nextPlan, resetLine, tightMeters, upgradeConfirmBody, upgradeLabel, upgradePath,
  usageCardView,
} from "./usage-meter";

const RESETS = Date.UTC(2026, 10, 1);
const meter = (kind: CloudUsageMeter["kind"], used: number, max: number, usedUp?: true): CloudUsageMeter => ({ kind, used, max, ...(usedUp ? { usedUp } : {}) });
const usage = (meters: CloudUsageMeter[], extra: Partial<CloudUsage> = {}): CloudUsage =>
  ({ tier: "pro", resetsAt: RESETS, meters, upgrades: [{ tier: "max", amount: 9900 }], ...extra });

beforeEach(() => setLocale("en"));
afterEach(() => setLocale("en"));

describe("how full an allowance is", () => {
  it("rounds down so nearly full never reads as full; used up, or over, is full", () => {
    expect(meterPercent(meter("voice", 0, 30_000))).toBe(0);
    expect(meterPercent(meter("voice", 23_999, 30_000))).toBe(79);
    expect(meterPercent(meter("voice", 24_000, 30_000))).toBe(80);
    expect(meterPercent(meter("computerHours", 299.9, 300))).toBe(99);
    expect(meterPercent(meter("computerHours", 300, 300))).toBe(100);
    expect(meterPercent(meter("x", 1, 5_000, true))).toBe(100);
    expect(meterPercent(meter("storage", 120, 100))).toBe(100);
  });
  it("is near its limit from 80% and at it from 100%", () => {
    expect(NEAR_LIMIT_PERCENT).toBe(80);
    expect([0, 79, 80, 99, 100].map(meterBand)).toEqual(["ok", "ok", "near", "near", "full"]);
  });
});

describe("the sidebar card", () => {
  const near = meter("computerHours", 250, 300), full = meter("voice", 30_000, 30_000), nearer = meter("x", 4_700, 5_000), calm = meter("decisions", 100, 20_000);
  it("shows the tightest two allowances at 80% or more, fullest first", () => {
    expect(CARD_METERS).toBe(2);
    expect(tightMeters(usage([near, calm, full, nearer]))).toEqual([full, nearer]);
    expect(tightMeters(usage([calm, near]))).toEqual([near]);
  });
  it("is hidden without a plan's usage, with nothing near a limit, and on a Team Cloud unless its plan is the team's", () => {
    expect(usageCardView({ usage: null, teamHome: false, dismissed: null })).toBeNull();
    expect(usageCardView({ usage: usage([calm, meter("storage", 79, 100)]), teamHome: false, dismissed: null })).toBeNull();
    expect(usageCardView({ usage: usage([calm, meter("storage", 80, 100)]), teamHome: false, dismissed: null })).toMatchObject({ meters: [meter("storage", 80, 100)], band: "near" });
    expect(usageCardView({ usage: usage([near]), teamHome: false, dismissed: null })).toEqual({ meters: [near], band: "near", dismissKey: `${RESETS}:near` });
    // A member's own personal plan never shows on their team's Cloud; the team's payer sees the team's.
    expect(usageCardView({ usage: usage([near]), teamHome: true, dismissed: null })).toBeNull();
    expect(usageCardView({ usage: usage([near], { tier: "team", upgrades: [] }), teamHome: true, dismissed: null })).toMatchObject({ band: "near" });
  });
  it("stays hidden once dismissed for this month and level: it comes back at 100%, and next month", () => {
    const dismissed = `${RESETS}:near`;
    expect(usageCardView({ usage: usage([near]), teamHome: false, dismissed })).toBeNull();
    expect(usageCardView({ usage: usage([near, full]), teamHome: false, dismissed })).toMatchObject({ band: "full", dismissKey: `${RESETS}:full` });
    expect(usageCardView({ usage: usage([near], { resetsAt: Date.UTC(2026, 11, 1) }), teamHome: false, dismissed })).toMatchObject({ band: "near" });
  });
});

describe("Upgrade", () => {
  it("moves up to the cheapest bigger plan in the app, opens the Cloud page when the app can't, and has nothing above Max or a team's plan", () => {
    const two = usage([], { tier: "starter", upgrades: [{ tier: "max", amount: 9900 }, { tier: "pro", amount: 4900 }] });
    expect(nextPlan(two)).toEqual({ tier: "pro", amount: 4900 });
    expect(upgradePath(two)).toBe("app");
    expect(upgradePath(usage([], { upgrades: [] }))).toBe("browser");
    expect(upgradePath(usage([], { tier: "max", upgrades: [] }))).toBe("top");
    expect(upgradePath(usage([], { tier: "team", upgrades: [] }))).toBe("top");
    expect(upgradeLabel({ tier: "max", amount: 9900 })).toBe("Upgrade to Max · $99/month");
  });
  it("says in the confirm what the new plan costs, what today's charge is and when the next payment comes", () => {
    const next = Date.UTC(2026, 10, 18);
    expect(upgradeConfirmBody({ plan: "max", trial: false, price: 9900, chargeNow: 2340, tax: 0, nextBillingAt: next }))
      .toBe("Max is $99 a month and starts right away. Today you pay $23.40, the difference for the rest of this billing month. From Nov 18 it's $99 a month, plus any tax.");
    expect(upgradeConfirmBody({ plan: "pro", trial: false, price: 4900, chargeNow: 2574, tax: 234 }))
      .toBe("Pro is $49 a month and starts right away. Today you pay $25.74 with tax, the difference for the rest of this billing month.");
    expect(upgradeConfirmBody({ plan: "max", trial: true, price: 9900, chargeNow: 0, tax: 0, nextBillingAt: next }))
      .toBe("Your free trial moves to Max now, and nothing is charged today. Your first payment on Nov 18 will be $99, plus any tax.");
  });
});

describe("the words", () => {
  it("say used of included in each allowance's own unit, and when the month starts over", () => {
    expect(meterAmounts(meter("computerHours", 241.46, 300))).toBe("241.5 of 300 hours");
    expect(meterAmounts(meter("voice", 12_000, 60_000))).toBe("12,000 of 60,000 characters");
    expect(meterAmounts(meter("decisions", 20_000, 20_000, true))).toBe("20,000 of 20,000");
    expect(meterAmounts(meter("x", 4_700, 5_000))).toBe("4,700 of 5,000 calls");
    expect(meterAmounts(meter("research", 4.2, 15))).toBe("$4.20 of $15");
    expect(meterAmounts(meter("storage", 120, 100))).toBe("100 of 100 GB");
    expect(resetLine(usage([]))).toBe("Resets on Nov 1.");
    expect(resetLine(usage([], { trialEndsAt: Date.UTC(2026, 9, 27) }))).toBe("Your full allowance starts on Oct 27.");
  });
});
