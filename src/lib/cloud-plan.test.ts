import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CloudAccountState, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import { CHECKOUT_SOURCES } from "../../electron/cloud-account.mjs";
import type { CloudCredit, CloudOffer, CloudOfferPlan, CloudTeam, CloudTrial } from "../../electron/cloud-home.mjs";
import { buyOfferAllowed, CLOUD_SOURCES, cloudAddView, cloudCreditLine, cloudIntroView, cloudNoticeKind, cloudPlanLine, cloudPlanView, cloudTrialNotice, cloudTrialView,
  cloudBeatTerms, dueToday, moneyBackLine, moneyBackShort, offerPlan, offerTrialDays, planCardRows, planCards, sameTerms, sharedTrialDays, trialTimeline, usd,
  type CloudSignInPhase } from "./cloud-plan";
import { setLocale } from "./i18n";

const DAY = 86_400_000;
const ENDS = new Date(2026, 9, 15, 12).getTime();
const trial = (state: CloudTrial["state"], extra: Partial<CloudTrial> = {}): CloudTrial =>
  ({ state, tier: "pro", endsAt: ENDS, amount: 4900, chargeAt: null, holdUntil: null, deleteAt: null, keep: "none", ...extra });
const credit: CloudCredit = { grantedUsd: 5, remainingUsd: 3.2, state: "active" };

beforeEach(() => setLocale("en"));
afterEach(() => setLocale("en"));

describe("a free trial, in one message and at most one next step per state", () => {
  it("active: when it ends, what is charged and when, how to cancel, and nothing to do", () => {
    const view = cloudTrialView(trial("active", { chargeAt: ENDS }), credit);
    expect(view.title).toBe("Your free trial ends on Oct 15");
    expect(view.body).toBe("Then Pro is $49/month plus tax, charged on Oct 15. The Cloud keeps running, so there's nothing to do. To cancel, choose Manage subscription before then.");
    expect(view.credit).toBe("Includes $5 of Claude credit: $3.20 left.");
    expect(view.action).toEqual({ kind: "manage", label: "Manage subscription" });
    expect(view.body).toContain(view.action!.label);
    const unpriced = cloudTrialView(trial("active", { amount: null, tier: "max" }));
    expect(unpriced.body).toBe("Then Max is charged monthly, plus tax, from Oct 15. The Cloud keeps running, so there's nothing to do. To cancel, choose Manage subscription before then.");
    expect(unpriced.credit).toBeUndefined();
    expect(cloudTrialView(trial("active"), { ...credit, remainingUsd: 0, state: "used_up" }).credit).toBeUndefined();
    expect(cloudTrialView(trial("active", { tier: "team-2027" })).body).toContain("Then Cloud is $49/month");
    expect(cloudTrialView(trial("active", { tier: undefined })).body).toContain("Then your plan is $49/month");
    expect(cloudTrialView(trial("active", { amount: 5831 })).body).toContain("$58.31/month");
  });

  it("ending with renewal off: when it stops, when its files go, and Subscribe to keep it", () => {
    const view = cloudTrialView(trial("ending", { deleteAt: ENDS + 3 * DAY, keep: "portal" }), credit);
    expect(view).toEqual({ state: "ending", title: "Your free trial ends on Oct 15",
      body: "Renewal is off, so the Cloud stops then and its files are deleted on Oct 18.", action: { kind: "subscribe", label: "Subscribe to keep it" } });
    expect(cloudTrialView(trial("ending", { keep: "portal" })).body).toBe("Renewal is off, so the Cloud stops then, and its files are deleted a few days later.");
  });

  it("cancelled outright before it ends: nothing to buy until it has stopped (a checkout now would stop the running Cloud)", () => {
    for (const keep of ["none", "checkout"] as const) {
      const view = cloudTrialView(trial("ending", { deleteAt: ENDS + 3 * DAY, keep }));
      expect(view.body, keep).toBe("Your subscription was cancelled, so the Cloud stops then and its files are deleted on Oct 18. To keep it, subscribe again once it has stopped.");
      expect(view.action, keep).toBeNull();
    }
  });

  it("processing, late and ended each say what happens to My Cloud and its files", () => {
    expect(cloudTrialView(trial("processing", { chargeAt: ENDS, holdUntil: ENDS + 3 * DAY }))).toEqual({ state: "processing",
      title: "Your first payment is processing", body: "The Cloud keeps running meanwhile, so there's nothing to do.", action: null });
    expect(cloudTrialView(trial("late", { deleteAt: ENDS + 6 * DAY, keep: "portal" }))).toEqual({ state: "late",
      title: "Your first payment is taking longer",
      body: "The Cloud is paused until it goes through, and comes back by itself. Its files are kept until Oct 21.",
      action: { kind: "status", label: "Check payment status" } });
    for (const keep of ["portal", "checkout"] as const) {
      expect(cloudTrialView(trial("ended", { deleteAt: ENDS + 3 * DAY, keep }))).toEqual({ state: "ended", title: "Your free trial has ended",
        body: "The Cloud is stopped. Its files are kept until Oct 18, then deleted.", action: { kind: "subscribe", label: "Subscribe to keep it" } });
    }
    expect(cloudTrialView(trial("ended")).body).toBe("The Cloud is stopped, and its files are deleted soon.");
    expect(cloudTrialView(trial("late")).body).toBe("The Cloud is paused until it goes through, and comes back by itself.");
  });

  it("the notice shows only the state main says is due, never another or an older one", () => {
    const plan = (extra: Partial<CloudPlanSnapshot>): CloudPlanSnapshot => ({ status: "paid", tier: "pro", ...extra });
    expect(cloudTrialNotice(plan({ trial: trial("ending", { keep: "portal" }), notice: "ending" }))?.state).toBe("ending");
    expect(cloudTrialNotice(plan({ trial: trial("ending", { keep: "portal" }) }))).toBeNull();
    expect(cloudTrialNotice(plan({ trial: trial("processing"), notice: "active" }))).toBeNull();
    expect(cloudTrialNotice(plan({ notice: "ended" }))).toBeNull();
    expect(cloudTrialNotice(null)).toBeNull();
  });
});

describe("the plan line and the credit", () => {
  const connected = (extra: Partial<CloudAccountState>): CloudAccountState => ({ status: "connected", account: { id: "a", email: "person@example.test" },
    entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: ENDS + 3 * DAY, version: 1 }, ...extra });
  it("a running trial is a free trial, not an active paid plan; once paid, or ended, it is not", () => {
    for (const state of ["active", "ending", "processing"] as const) {
      expect(cloudPlanLine(cloudPlanView(connected({ trial: trial(state) })))).toBe("Pro free trial · verified by MausBot Cloud");
    }
    expect(cloudPlanLine(cloudPlanView(connected({})))).toBe("Pro active · verified by MausBot Cloud");
    expect(cloudPlanView(connected({ entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 2 }, machine: { status: "stopped" }, trial: trial("ended") })).kind).toBe("attention");
  });

  it("says what is left, or that it is used up and what to do", () => {
    expect(cloudCreditLine(credit)).toBe("Trial Claude credit: $3.20 of $5 left. Cloud bots use it until you sign in there with your own Claude or ChatGPT account, or add an API key.");
    expect(cloudCreditLine({ grantedUsd: 5, remainingUsd: 0, state: "used_up" }))
      .toBe("Your $5 trial Claude credit is used up. To keep your bots working, sign in with your own Claude or ChatGPT account in the Cloud, or add an API key there.");
    expect([usd(5), usd(3.2), usd(0.004), usd(49), usd(58.31)]).toEqual(["$5", "$3.20", "$0", "$49", "$58.31"]);
  });

  it("in its last two days, a trial says how to step down to the plan the Admin names, with its price", () => {
    const active = trial("active", { chargeAt: ENDS }), starter = { tier: "starter" as const, amount: 1500 };
    expect(cloudTrialView({ ...active, switchTo: starter }).switchPlan).toBe("Prefer Starter at $15? Tell us from your Plan page before Oct 15, and we'll switch your plan.");
    expect(cloudTrialView({ ...active, tier: "max", switchTo: starter, personalAmount: 2900 }).switchPlan, "the Admin's switchTo wins")
      .toBe("Prefer Starter at $15? Tell us from your Plan page before Oct 15, and we'll switch your plan.");
    expect(cloudTrialView({ ...active, tier: "personal", switchTo: starter }).switchPlan).toBe("Prefer Starter at $15? Tell us from your Plan page before Oct 15, and we'll switch your plan.");
    expect(cloudTrialView({ ...active, personalAmount: 2900 }).switchPlan, "an older Admin names only Personal's price: Personal is the way down").toBe("Prefer Personal at $29? Tell us from your Plan page before Oct 15, and we'll switch your plan.");
    expect(cloudTrialView(active).switchPlan, "no plan named, no switch to offer").toBeUndefined();
    for (const quiet of [{ ...active, tier: "personal", personalAmount: 2900 }, { ...active, tier: "starter", switchTo: starter }, { ...active, switchTo: { tier: "max" as const, amount: 9900 } },
      { ...active, tier: undefined, switchTo: starter }, { ...active, tier: "team-2027", switchTo: starter }, trial("ending", { keep: "portal", switchTo: starter })]) {
      expect(cloudTrialView(quiet).switchPlan, JSON.stringify(quiet)).toBeUndefined();
    }
  });

  it("a Personal subscriber's plan is Personal wherever the app names it", () => {
    const personal = { plan: "pro" as const, tier: "personal", expiresAt: ENDS + 3 * DAY, version: 1 };
    expect(cloudPlanLine(cloudPlanView(connected({ entitlement: { ...personal, status: "active" } })))).toBe("Personal active · verified by MausBot Cloud");
    expect(cloudPlanLine(cloudPlanView(connected({ entitlement: { ...personal, status: "inactive" } })))).toBe("Personal · not active right now");
    expect(cloudPlanLine(cloudPlanView({ status: "unavailable", lastPlan: { tier: "personal", active: true } }))).toBe("Personal · checking with MausBot Cloud…");
    expect(cloudPlanLine(cloudPlanView({ status: "reauth-required", message: "expired", lastPlan: { tier: "personal", active: true } }))).toBe("Personal plan");
    expect(cloudTrialView(trial("active", { tier: "personal", amount: 2900 })).body).toContain("Then Personal is $29/month plus tax");
  });

});


const allowances = (computers: number, diskGb: number, maxDiskGb = diskGb) => ({ cpus: computers, memoryMb: computers * 1024, diskGb, maxDiskGb, computers, computerHours: computers * 50, voiceCharacters: 100_000 });
const PLANS: CloudOfferPlan[] = [
  { tier: "starter", label: "Starter", amount: 1500, allowances: allowances(1, 10), trialDays: 7 },
  { tier: "pro", label: "Pro", amount: 4900, allowances: allowances(4, 40, 50), trialDays: 7 },
  { tier: "max", label: "Max", amount: 9900, allowances: allowances(8, 80, 100), trialDays: 7 },
];
const OFFER: CloudOffer = { plans: PLANS, recommended: "pro", creditUsd: 5, reminderDays: 2, refundDays: 14 };
const noTrial = (offer: CloudOffer): CloudOffer => ({ ...offer, creditUsd: undefined, reminderDays: undefined, plans: offer.plans.map(({ trialDays: _days, ...plan }) => plan) });
const NOW = new Date(2026, 9, 8, 12).getTime();
/** A plan the Admin says sleeps when idle, with no swap and a fixed disk. */
const SLEEPS: CloudOfferPlan = { tier: "lite", label: "Lite", amount: 900, allowances: { cpus: 2, cpuKind: "shared", memoryMb: 2048, diskGb: 10, maxDiskGb: 10, computers: 15,
  computerHours: 30, voiceCharacters: 10_000, sleeps: true, snapshotDays: 7 } };

describe("what is for sale, as the Admin says", () => {
  it("the sources the app counts are main's own allow-list", () => {
    expect([...CLOUD_SOURCES]).toEqual([...CHECKOUT_SOURCES]);
    expect(CLOUD_SOURCES, "the welcome's Cloud beat").toContain("app_onboarding");
  });

  it("one card per plan on sale, in the Admin's order: name, price, promise, its own button and the money in one line; Most popular is the Admin's recommended plan", () => {
    expect(planCards(OFFER).map(({ rows: _rows, ...card }) => card)).toEqual([
      { tier: "starter", name: "Starter", price: "$15", popular: false, current: false, promise: "Your bots keep working with your laptop closed, at the lowest price.",
        action: "Start free trial", terms: "Free for 7 days, then $15/month + tax" },
      { tier: "pro", name: "Pro", price: "$49", popular: true, current: false, promise: "Your bots keep working 24/7, even when your laptop is closed.",
        action: "Start free trial", terms: "Free for 7 days, then $49/month + tax" },
      { tier: "max", name: "Max", price: "$99", popular: false, current: false, promise: "The biggest cloud machine, for bots that use computers all day.",
        action: "Start free trial", terms: "Free for 7 days, then $99/month + tax" },
    ]);
    expect(planCards({ ...OFFER, recommended: "max" }).map(card => card.popular), "never Pro by itself").toEqual([false, false, true]);
    expect(planCards(noTrial(OFFER)).map(card => [card.action, card.terms])).toEqual([["Get Starter", "$15 + tax today, then each month"],
      ["Get Pro", "$49 + tax today, then each month"], ["Get Max", "$99 + tax today, then each month"]]);
    expect(planCards({ plans: [{ tier: "team", label: "Team", amount: 19900 }], recommended: "team" })).toEqual([{ tier: "team", name: "Team", price: "$199", popular: true, current: false,
      promise: null, action: "Get Team", terms: "$199 + tax today, then each month", rows: [] }]);
    expect(planCards({ plans: [{ tier: "pro", amount: 5831 }], recommended: "pro" })[0]!.price).toBe("$58.31");
  });

  it("the person's own plan says Your plan instead of a button; a Personal subscriber sees Personal's own card, only for themselves", () => {
    expect(planCards(OFFER, { current: "pro" }).map(card => [card.tier, card.current, card.action, card.terms])).toEqual([
      ["starter", false, "Start free trial", "Free for 7 days, then $15/month + tax"], ["pro", true, null, null], ["max", false, "Start free trial", "Free for 7 days, then $99/month + tax"]]);
    const personal: CloudOfferPlan = { tier: "personal", label: "Personal", amount: 2900, allowances: { cpus: 2, cpuKind: "shared", memoryMb: 2048, swapMb: 3072, diskGb: 10, maxDiskGb: 20,
      computers: 15, computerHours: 100, voiceCharacters: 30_000, snapshotDays: 14 } };
    const mine = planCards(OFFER, { current: "personal", own: personal });
    expect(mine.map(card => [card.name, card.price, card.current, card.action])).toEqual([["Starter", "$15", false, "Start free trial"], ["Personal", "$29", true, null],
      ["Pro", "$49", false, "Start free trial"], ["Max", "$99", false, "Start free trial"]]);
    expect(mine[1]!.rows.map(row => row.text)).toContain("100 cloud desktop hours a month");
    expect(planCards(OFFER, { own: personal }).map(card => card.tier), "nobody else sees Personal").toEqual(["starter", "pro", "max"]);
    expect(planCards(OFFER, { current: "max", own: personal }).map(card => card.tier), "nor a subscriber on another plan").toEqual(["starter", "pro", "max"]);
    expect(planCards(OFFER, { current: "personal" }).map(card => card.tier), "with no plan to show, no card").toEqual(["starter", "pro", "max"]);
  });

  it("every card lists the same rows in the same order, in the website's words, every number from the Admin's catalog", () => {
    const pro = { tier: "pro", label: "Pro", amount: 4900, allowances: { cpus: 4, cpuKind: "shared" as const, memoryMb: 4096, swapMb: 4096, diskGb: 10, maxDiskGb: 100, computers: 15, computerHours: 300,
      voiceCharacters: 60_000, snapshotDays: 14 } };
    const starter = { tier: "starter", label: "Starter", amount: 1500, allowances: { ...pro.allowances, cpus: 2, memoryMb: 2048, swapMb: 3072, maxDiskGb: 20, computerHours: 100,
      voiceCharacters: 30_000 } };
    const max = { tier: "max", label: "Max", amount: 9900, allowances: { ...pro.allowances, cpus: 8, memoryMb: 8192, computerHours: 800, voiceCharacters: 180_000 } };
    const cards = planCards({ plans: [starter, pro, max], recommended: "pro" });
    expect(cards.map(card => card.rows.map(row => row.key))).toEqual(Array(3).fill(["power", "desktops", "hours", "machine", "storage", "voice", "backups"]));
    expect(cards[0]!.rows).toEqual([
      { key: "power", text: "Always on, around the clock" },
      { key: "desktops", text: "Cloud desktops: as many as your bots need", note: "Fair use: up to 15 at once" },
      { key: "hours", text: "100 cloud desktop hours a month" },
      { key: "machine", text: "2 shared CPUs · 2 GB memory", note: "Plus 3 GB of swap" },
      { key: "storage", text: "10 GB storage, grows to 20 GB" },
      { key: "voice", text: "Voice replies: about 30 minutes of speech a month" },
      { key: "backups", text: "Daily backups, kept 14 days" },
    ]);
    expect(cards.map(card => card.rows[2]!.text)).toEqual(["100 cloud desktop hours a month", "300 cloud desktop hours a month", "800 cloud desktop hours a month"]);
    expect(cards.map(card => card.rows[5]!.text)).toEqual(["Voice replies: about 30 minutes of speech a month", "Voice replies: about an hour of speech a month",
      "Voice replies: about 3 hours of speech a month"]);
    // Another catalog's numbers show as such; an older Admin without swap, backup days or the CPU kind leaves them unsaid, and a plan it says sleeps says so.
    expect(planCardRows({ ...pro.allowances, computers: 6, computerHours: 450 }).slice(1, 3)).toEqual([
      { key: "desktops", text: "Cloud desktops: as many as your bots need", note: "Fair use: up to 6 at once" }, { key: "hours", text: "450 cloud desktop hours a month" }]);
    expect(planCardRows({ cpus: 8, memoryMb: 8192, diskGb: 10, maxDiskGb: 10, computers: 4, computerHours: 500, voiceCharacters: 90_000 }).map(row => row.text)).toEqual([
      "Always on, around the clock", "Cloud desktops: as many as your bots need", "500 cloud desktop hours a month", "8 CPUs · 8 GB memory", "10 GB storage",
      "Voice replies: about 1.5 hours of speech a month"]);
    expect(planCardRows(SLEEPS.allowances!)[0]!.text).toBe("Sleeps when idle, wakes in about a second");
    expect(JSON.stringify(cards)).not.toMatch(/a day|credit|Everything in/);
  });

  it("speaks the reader's language, numbers included", () => {
    setLocale("de");
    const [card] = planCards({ plans: [{ tier: "max", amount: 9900, trialDays: 3, allowances: { cpus: 8, cpuKind: "shared", memoryMb: 8192, diskGb: 10, maxDiskGb: 100, computers: 15,
      computerHours: 800, voiceCharacters: 90_000, snapshotDays: 14 } }], recommended: "max" });
    expect(card!.rows.map(row => row.text)).toEqual(["Immer an, rund um die Uhr", "Cloud-Desktops: so viele, wie deine Bots brauchen", "800 Cloud-Desktop-Stunden im Monat",
      "8 geteilte CPUs · 8 GB Arbeitsspeicher", "10 GB Speicher, wächst bis 100 GB", "Sprachantworten: etwa 1,5 Stunden Sprache im Monat", "Tägliche Backups, 14 Tage aufbewahrt"]);
    expect([card!.action, card!.terms]).toEqual(["Kostenlos testen", "3 Tage kostenlos, dann $99/Monat zzgl. Steuern"]);
  });

  it("money-back only while the Admin offers it; due today in cents", () => {
    expect(moneyBackShort(OFFER)).toBe("14-day money-back");
    expect(moneyBackShort({ ...OFFER, refundDays: undefined })).toBeNull();
    expect(dueToday(0)).toBe("$0.00"); expect(dueToday(4900)).toBe("$49.00");
  });

  it("the trial leads with the preselected plan's days; money-back only when the Admin offers it", () => {
    expect(offerTrialDays(OFFER)).toBe(7);
    expect(offerTrialDays({ ...OFFER, plans: [PLANS[0]!, { ...PLANS[1]!, trialDays: undefined }] })).toBe(7);
    expect(offerTrialDays(noTrial(OFFER))).toBeNull();
    expect(offerTrialDays(null)).toBeNull();
    expect(offerPlan(OFFER).tier).toBe("pro"); expect(offerPlan(OFFER, "max").tier).toBe("max"); expect(offerPlan(OFFER, "team").tier).toBe("pro");
    expect(moneyBackLine(OFFER)).toBe("14-day money-back on every plan.");
    expect(moneyBackLine({ ...OFFER, refundDays: undefined })).toBeNull();
  });

  it("the welcome's Cloud beat says the Admin's offer in one line: trial and lowest price, credit and money-back only when offered", () => {
    expect(cloudBeatTerms(OFFER)).toEqual({ trial: true, action: "Start free trial",
      line: "Free for 7 days, then from $15/month + tax. Includes $5 of Claude credit. 14-day money-back." });
    expect(cloudBeatTerms({ ...OFFER, creditUsd: undefined, refundDays: undefined }).line).toBe("Free for 7 days, then from $15/month + tax.");
    expect(cloudBeatTerms(noTrial(OFFER))).toEqual({ trial: false, action: "See plans", line: "From $15/month + tax. 14-day money-back." });
    expect(cloudBeatTerms({ ...OFFER, plans: [{ ...PLANS[0]!, trialDays: undefined }, PLANS[1]!, PLANS[2]!] }).line, "the lowest price among plans with the trial")
      .toContain("then from $49/month");
    expect(cloudBeatTerms({ ...noTrial(OFFER), creditUsd: 5 }).line, "credit comes only with a trial").not.toContain("credit");
  });

  it("the account's own terms are the same as those shown only with the same price and the same trial for that plan", () => {
    expect(sameTerms(OFFER, OFFER, "pro")).toBe(true);
    expect(sameTerms(OFFER, noTrial(OFFER), "pro"), "a trial already used").toBe(false);
    expect(sameTerms(OFFER, { ...OFFER, plans: OFFER.plans.map(plan => ({ ...plan, amount: plan.amount + 100 })) }, "pro"), "another price").toBe(false);
    expect(sameTerms(OFFER, { ...OFFER, plans: OFFER.plans.map(plan => ({ ...plan, trialDays: 3 })) }, "pro"), "other trial days").toBe(false);
    expect(sameTerms(OFFER, undefined, "pro"), "no offer of its own").toBe(false);
    expect(sameTerms(OFFER, { ...OFFER, plans: [PLANS[0]!] }, "pro"), "not sold to it").toBe(false);
    expect(cloudAddView({ status: "connected", account: { id: "a", email: "p@example.test" }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } },
      OFFER, { now: NOW, terms: true })).toMatchObject({ kind: "offer", notice: "terms" });
  });

  it("the timeline, when every plan has the same trial: today (and the credit), the reminder only while the Admin sends one, and the first payment", () => {
    expect(sharedTrialDays(OFFER)).toBe(7);
    expect(trialTimeline(OFFER, NOW)).toEqual([
      { when: "Today", text: "Trial starts, with $5 of Claude credit" },
      { when: "Oct 13", text: "Reminder email" },
      { when: "Oct 15", text: "First payment" },
    ]);
    expect(trialTimeline({ ...OFFER, reminderDays: undefined, creditUsd: undefined }, NOW)).toEqual([
      { when: "Today", text: "Trial starts" },
      { when: "Oct 15", text: "First payment" },
    ]);
    const mixed = { ...OFFER, plans: [PLANS[0]!, PLANS[1]!, { ...PLANS[2]!, trialDays: undefined }] };
    expect([sharedTrialDays(mixed), trialTimeline(mixed, NOW)], "each card says its own terms instead").toEqual([null, []]);
    expect(trialTimeline(noTrial(OFFER), NOW)).toEqual([]);
  });

  it("the card after the update needs a trial, and says only the Admin's numbers: never a launch price or a later one", () => {
    expect(cloudIntroView(OFFER)).toEqual({ badge: "Free for 7 days",
      points: ["Routines run on time, day and night", "Reach your bots from your phone, even with this computer off", "$5 of Claude credit to start"],
      price: "Then from $15/month + tax. Cancel any time.", moneyBack: "14-day money-back on every plan." });
    const bare = cloudIntroView({ ...OFFER, creditUsd: undefined, refundDays: undefined })!;
    expect(bare.points[2]).toBe("Cloud desktops and voice included"); expect(bare.moneyBack).toBeNull();
    expect(cloudIntroView(noTrial(OFFER))).toBeNull(); expect(cloudIntroView(null)).toBeNull(); expect(cloudIntroView(undefined)).toBeNull();
    expect(JSON.stringify(cloudIntroView(OFFER))).not.toMatch(/launch|\$89|first 100/i);
    const partial: CloudOffer = { ...OFFER, plans: OFFER.plans.map(plan => plan.tier === "starter" ? { ...plan, trialDays: undefined } : plan) };
    expect(cloudIntroView(partial)!.price).toBe("Then from $49/month + tax. Cancel any time.");
  });
});

describe("the buying sheet, one view per state", () => {
  const connected = (extra: Partial<CloudAccountState> = {}): CloudAccountState => ({ status: "connected", account: { id: "a", email: "person@example.test" },
    entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 }, ...extra });
  const paid = (extra: Partial<CloudAccountState> = {}) => connected({ entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, ...extra });
  const at = { now: NOW };

  it("checks first, then offers what is for sale to someone signed out or with no plan, or says Cloud can't be reached", () => {
    expect(cloudAddView(null, undefined, at)).toEqual({ kind: "checking" });
    expect(cloudAddView({ status: "signed-out", message: "restoring" }, OFFER, at)).toEqual({ kind: "checking" });
    expect(cloudAddView({ status: "signed-out" }, undefined, at)).toEqual({ kind: "checking" });
    expect(cloudAddView({ status: "signed-out" }, OFFER, at)).toEqual({ kind: "offer", offer: OFFER, signedOut: true, notice: null });
    expect(cloudAddView(connected(), noTrial(OFFER), at)).toEqual({ kind: "offer", offer: noTrial(OFFER), signedOut: false, notice: null });
    expect(cloudAddView({ status: "signed-out" }, null, at)).toEqual({ kind: "unreachable" });
    expect(cloudAddView(connected(), OFFER, { ...at, error: "rate-limited" })).toEqual({ kind: "error", reason: "rate-limited" });
  });

  it("follows the sign-in and the checkout in the browser by its own session, never by the return", () => {
    expect(cloudAddView({ status: "connecting", enrollment: { userCode: "ABCDE-FGHJK", expiresAt: NOW + 600_000 }, checkout: { plan: "pro", startedAt: NOW, signIn: true } }, OFFER, at))
      .toEqual({ kind: "signing-in", code: "ABCDE-FGHJK", checkout: true });
    expect(cloudAddView({ status: "connecting" }, OFFER, at)).toEqual({ kind: "signing-in", code: null, checkout: false });
    const email = "person@example.test";
    const opened = connected({ checkout: { plan: "max", startedAt: NOW - 29 * 60_000, link: true } });
    expect(cloudAddView(opened, OFFER, at)).toEqual({ kind: "waiting", plan: "max", browser: "checkout", late: false, link: true, email });
    expect(cloudAddView(opened, OFFER, { ...at, choosing: true })).toEqual({ kind: "offer", offer: OFFER, signedOut: false, notice: null });
    expect(cloudAddView(opened, OFFER, { now: NOW + 2 * 60_000 }), "after 30 minutes: We haven't seen a payment yet, with Reopen and Change plan")
      .toEqual({ kind: "waiting", plan: "max", browser: "checkout", late: true, link: true, email });
    const signedIn = connected({ checkout: { plan: "pro", startedAt: NOW - 60_000, signIn: true } });
    expect(cloudAddView(signedIn, OFFER, at)).toEqual({ kind: "waiting", plan: "pro", browser: "signin", late: false, link: false, email });
    expect(cloudAddView(signedIn, { ...OFFER, checkout: { plan: "pro", openUntil: NOW + 3600_000 } }, at)).toMatchObject({ kind: "waiting", plan: "pro", browser: "checkout" });
    const open = { ...OFFER, checkout: { plan: "starter", openUntil: NOW + 3600_000 } };
    expect(cloudAddView(connected(), open, at)).toEqual({ kind: "waiting", plan: "starter", browser: "checkout", late: false, link: false, email });
    expect(cloudAddView(connected(), { ...open, checkout: { plan: "starter", openUntil: NOW - 1 } }, at).kind).toBe("offer");
    expect(cloudAddView({ status: "signed-out", checkout: { plan: "pro", startedAt: NOW } }, OFFER, at).kind).toBe("offer");
  });

  it("then: the payment received, the Cloud set up (the plan, trial and credit for its badge), and ready after this app's checkout or sign-in", () => {
    expect(cloudAddView(connected({ purchase: { state: "confirming", tier: "pro", paidAt: NOW } }), OFFER, at))
      .toEqual({ kind: "starting", tier: "pro", trial: null, credit: null, step: null, slow: false, received: true });
    const running = trial("active", { endsAt: NOW + 7 * DAY, chargeAt: NOW + 7 * DAY });
    expect(cloudAddView(paid({ trial: running, credit }), undefined, at)).toEqual({ kind: "starting", tier: "pro", trial: running, credit, step: null, slow: false, received: false });
    expect(cloudAddView(paid({ credit: { ...credit, remainingUsd: 0, state: "used_up" } }), undefined, at)).toMatchObject({ kind: "starting", credit: null });
    expect(cloudAddView(paid({ machine: { status: "provisioning", setup: { step: "storage", slow: true } } }), undefined, at))
      .toEqual({ kind: "starting", tier: "pro", trial: null, credit: null, step: "storage", slow: true, received: false });
    const ready = { status: "ready" as const, origin: "https://omb-u-1.fly.dev" };
    expect(cloudAddView(paid({ machine: ready, checkout: { plan: "pro", startedAt: NOW - 3600_000 } }), undefined, at)).toEqual({ kind: "ready", tier: "pro", trial: null, credit: null });
    expect(cloudAddView(paid({ machine: ready }), undefined, at), "Add a Cloud… with a Cloud: one Cloud for now").toEqual({ kind: "has-cloud" });
    expect(cloudAddView(paid({ machine: ready, checkout: { plan: "pro", startedAt: NOW - 3600_000, done: true } }), undefined, at),
      "a purchase that is over (opened, announced or shown ready): one Cloud for now").toEqual({ kind: "has-cloud" });
    expect(cloudAddView(paid({ machine: ready, checkout: { plan: "pro", startedAt: NOW, done: true } }), undefined, { ...at, arrived: true }).kind,
      "unless this sheet followed it").toBe("ready");
    expect(cloudAddView(paid({ machine: ready }), undefined, { ...at, arrived: true }), "signed in here just now: theirs to open").toMatchObject({ kind: "ready" });
    expect(cloudAddView(paid({ machine: { status: "provisioning" } }), undefined, at).kind, "Add a Cloud… during setup shows the setup").toBe("starting");
  });

  it("a Team or Business plan has no Cloud of its own: the team's Cloud to open, or its setup, never a setup of a Cloud that never comes", () => {
    const team = (machine: CloudTeam["machine"], extra: Partial<CloudTeam> = {}): CloudTeam => ({ id: "team-acme", name: "Acme", role: "owner", machine, ...extra });
    const onTeam = (tier: string, teams?: CloudTeam[], extra: Partial<CloudAccountState> = {}) =>
      paid({ entitlement: { plan: "pro", tier, status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, ...(teams ? { teams } : {}), ...extra });
    const up = { status: "ready" as const, origin: "https://omb-t-2.fly.dev" };
    for (const tier of ["team", "business"]) {
      expect(cloudAddView(onTeam(tier, [team(up)]), undefined, at), tier).toEqual({ kind: "team-ready", team: { id: "team-acme", name: "Acme" } });
      expect(cloudAddView(onTeam(tier, [team(up)]), undefined, { ...at, arrived: true }), `${tier}, signed in here just now`).toEqual({ kind: "team-ready", team: { id: "team-acme", name: "Acme" } });
    }
    expect(cloudAddView(onTeam("team", [team(up, { id: "team-other", name: "Other", role: "member" }), team(up)]), undefined, at), "the team the plan runs: the one this account owns")
      .toEqual({ kind: "team-ready", team: { id: "team-acme", name: "Acme" } });
    expect(cloudAddView(onTeam("team", [team({ status: "provisioning", setup: { step: "storage", slow: true } })]), undefined, at), "the team's Cloud being set up: its own steps")
      .toEqual({ kind: "team-starting", team: "Acme", step: "storage", slow: true });
    expect(cloudAddView(onTeam("business", [team(null)]), undefined, at), "the team has no machine yet").toEqual({ kind: "team-starting", team: "Acme", step: null, slow: false });
    expect(cloudAddView(onTeam("team"), undefined, at), "no team listed yet").toEqual({ kind: "team-starting", team: null, step: null, slow: false });
    expect(cloudAddView(onTeam("team", [team({ status: "failed" })]), undefined, at), "a problem is Settings' to say").toEqual({ kind: "settings" });
    expect(cloudAddView(paid(), undefined, at).kind, "a personal plan with no Cloud yet: its setup").toBe("starting");
    expect(cloudAddView(paid({ teams: [team(up, { role: "member" })] }), undefined, at).kind, "a Pro plan's own Cloud, even for someone in a team").toBe("starting");
    expect(cloudAddView(onTeam("team", [team(up)], { machine: { status: "provisioning" } }), undefined, at).kind, "a My Cloud the Admin lists is set up as one").toBe("starting");
  });

  it("asked to sign in, the sheet signs in: with no offer to be had, and for a saved sign-in that was removed (else Settings' to say)", () => {
    const plain: CloudSignInPhase = { step: "email", intent: false, problem: null };
    const removed: CloudAccountState = { status: "signed-out", message: "restore-removed" };
    for (const offer of [undefined, null, OFFER]) {
      expect(cloudAddView(removed, offer, { ...at, signIn: plain }), `removed, offer ${JSON.stringify(offer)?.slice(0, 20)}`).toEqual({ kind: "sign-in", phase: plain });
      expect(cloudAddView({ status: "signed-out" }, offer, { ...at, signIn: plain }), "signed out, whatever the offer").toEqual({ kind: "sign-in", phase: plain });
    }
    expect(cloudAddView(removed, OFFER, at)).toEqual({ kind: "settings" });
    expect(cloudAddView({ status: "signed-out" }, null, at)).toEqual({ kind: "unreachable" });
    expect(cloudAddView({ status: "signed-out" }, OFFER, { ...at, signIn: plain, error: "failed" })).toEqual({ kind: "error", reason: "failed" });
  });

  it("the in-app sign-in is a view of its own while signed out, then the checkout it leads to", () => {
    const email: CloudSignInPhase = { step: "email", intent: true, problem: null };
    expect(cloudAddView({ status: "signed-out" }, OFFER, { ...at, signIn: email })).toEqual({ kind: "sign-in", phase: email });
    const code: CloudSignInPhase = { step: "code", intent: true, email: "p@example.test", resendAt: NOW + 30_000, problem: "wrong-code", triesLeft: 3 };
    expect(cloudAddView({ status: "signed-out" }, OFFER, { ...at, signIn: code })).toEqual({ kind: "sign-in", phase: code });
    expect(cloudAddView(connected(), OFFER, { ...at, signIn: email }).kind, "signed in meanwhile: the sign-in is over").toBe("offer");
    expect(cloudAddView(connected(), OFFER, { ...at, signIn: { step: "done", intent: true } }), "Signed in. Opening secure checkout…")
      .toEqual({ kind: "sign-in", phase: { step: "done", intent: true } });
    expect(cloudAddView(connected({ checkout: { plan: "pro", startedAt: NOW, link: true } }), OFFER, { ...at, signIn: { step: "done", intent: true } }).kind).toBe("waiting");
    expect(cloudAddView({ status: "signed-out" }, undefined, { ...at, signIn: email }).kind, "sign-in needs no offer").toBe("sign-in");
  });

  it("never offers anything to someone who pays or may pay: a problem, an ended sign-in or an unreachable Cloud is Settings' to say", () => {
    for (const account of [
      connected({ entitlement: { plan: "pro", tier: "pro", status: "inactive", expiresAt: null, version: 3 }, machine: { status: "payment-problem", origin: "https://omb-u-1.fly.dev" } }),
      connected({ machine: { status: "stopped" }, trial: trial("ended", { keep: "checkout" }) }),
      paid({ machine: { status: "failed" } }),
      { status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } },
      { status: "unavailable", lastPlan: { tier: "max", active: true } }, { status: "unavailable" },
      { status: "signed-out", message: "restore-removed" },
    ] as CloudAccountState[]) {
      expect(cloudAddView(account, OFFER, at), JSON.stringify(account)).toEqual({ kind: "settings" });
      expect(buyOfferAllowed(cloudPlanView(account)), JSON.stringify(account)).toBe(false);
    }
  });
});

describe("This computer's Cloud sign-in card", () => {
  const view = (account: CloudAccountState) => cloudNoticeKind(cloudPlanView(account), account);
  it("says sign in again where the sign-in ended, and nothing to someone signed in", () => {
    const base = { status: "connected" as const, account: { id: "a", email: "p@example.test" } };
    const ready = { status: "ready" as const, origin: "https://omb-u-1.fly.dev" };
    expect(view({ ...base, entitlement: { plan: "pro", status: "active", expiresAt: NOW + DAY, version: 1 }, machine: ready })).toBeNull();
    expect(view({ status: "reauth-required", message: "expired", lastPlan: { active: true } })).toBe("sign-in-again");
    expect(view({ status: "reauth-required", message: "expired", lastPlan: { active: false } })).toBeNull();
    expect(view({ status: "signed-out", message: "restore-removed" })).toBe("removed");
    expect(view({ status: "signed-out" })).toBeNull();
    expect(view({ ...base, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } })).toBeNull();
  });
});

describe("why a step of the dialog ended without going on", () => {
  const at = { now: NOW };
  it("says it with the offer the dialog returns to: the code expired, the sign-in ended, or a checkout was already being prepared", () => {
    expect(cloudAddView({ status: "signed-out", message: "enrollment-expired" }, OFFER, at)).toMatchObject({ kind: "offer", notice: "code-expired" });
    for (const message of ["enrollment-ended", "signin-failed"] as const) expect(cloudAddView({ status: "signed-out", message }, OFFER, at)).toMatchObject({ kind: "offer", notice: "signin-ended" });
    expect(cloudAddView({ status: "signed-out" }, OFFER, at)).toMatchObject({ kind: "offer", notice: null });
    const free: CloudAccountState = { status: "connected", account: { id: "a", email: "person@example.test" }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } };
    expect(cloudAddView(free, OFFER, { ...at, conflict: true })).toMatchObject({ kind: "offer", notice: "preparing" });
  });
});
