// What the app says about the person's OpenMausBot Cloud plan, in one place:
// Settings → OpenMausBot Cloud, the Cloud card in Settings → General, the
// cards at the bottom left (the card after the update, the free trial's
// notices and This computer's My Cloud card) and the Add a Cloud dialog all
// read it, so no two of them can disagree. The rule the owner set: after
// buying, nothing unexpected or contradictory, never an offer to buy to
// someone who pays (or may pay: an unknown state is not "free"), and every
// state has one message and one next step. Prices, plans, the trial, the
// credit and money-back come from the Admin; nothing here is a price.
import type { CloudAccountState, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudCredit, CloudOffer, CloudOfferPlan, CloudSetupStep, CloudTrial, CloudTrialState } from "../../electron/cloud-home.mjs";
import { activeLocale, t } from "@/lib/i18n";

const PLAN_LABEL: Record<string, string> = { personal: "Personal", pro: "Pro", max: "Max" };
/** A paid plan's product name. No tier is an Admin that sells only Pro; a
 * tier newer than this app reads "Cloud". */
export function cloudPlanLabel(tier?: string): string {
  return tier === undefined ? "Pro" : Object.hasOwn(PLAN_LABEL, tier) ? PLAN_LABEL[tier] : "Cloud";
}

export type CloudPlanView =
  /** Not known yet: no snapshot, or a saved sign-in still being read. */
  | { kind: "unknown" }
  | { kind: "signed-out" }
  /** This computer's saved sign-in could not be read, so it was removed. The
   * person may well pay: signing in again is the step, never an offer. */
  | { kind: "removed" }
  | { kind: "connecting" }
  /** Verified: signed in, no plan, no Cloud, no payment being linked. */
  | { kind: "free" }
  /** Verified and active. `checking`: the last checks failed; this is the last
   * verified answer. `trial`: on a free trial that has not ended. */
  | { kind: "paid"; label: string; checking: boolean; trial?: true }
  /** A plan that is not active (a payment problem, or it ended) or a Cloud still there without one. */
  | { kind: "attention"; label: string | null }
  /** A payment OMB Cloud received and is linking to this account. */
  | { kind: "purchase"; label: string | null; paidAt?: number }
  /** OMB Cloud cannot be asked right now. `label`: the plan last verified. */
  | { kind: "unverified"; label: string | null }
  /** This computer's sign-in ended. The plan is unaffected. */
  | { kind: "reauth"; label: string | null; reason: "expired" | "access-ended" };

export function cloudPlanView(account: CloudAccountState | null | undefined): CloudPlanView {
  if (!account || (account.status === "signed-out" && account.message === "restoring")) return { kind: "unknown" };
  const last = account.lastPlan ? cloudPlanLabel(account.lastPlan.tier) : null;
  if (account.status === "signed-out") return account.message === "restore-removed" ? { kind: "removed" } : { kind: "signed-out" };
  if (account.status === "connecting") return { kind: "connecting" };
  if (account.status === "reauth-required") return { kind: "reauth", label: last, reason: account.message === "expired" ? "expired" : "access-ended" };
  if (account.status !== "connected") return { kind: "unverified", label: last };
  const entitlement = account.entitlement;
  if (entitlement?.plan === "pro" && entitlement.status === "active") {
    return { kind: "paid", label: cloudPlanLabel(entitlement.tier), checking: account.checking === true, ...(trialRunning(account.trial) ? { trial: true as const } : {}) };
  }
  if (account.purchase) {
    return { kind: "purchase", label: account.purchase.tier ? cloudPlanLabel(account.purchase.tier) : null, ...(account.purchase.paidAt ? { paidAt: account.purchase.paidAt } : {}) };
  }
  // A lapsed plan, or a Cloud still there (a payment problem, stopped): never "free", never a new purchase.
  if (entitlement?.plan === "pro") return { kind: "attention", label: cloudPlanLabel(entitlement.tier) };
  if (account.machine) return { kind: "attention", label: null };
  return { kind: "free" };
}

/** Only these two may see an offer to buy: nobody who pays, may pay, or
 * whose state is unknown. Signed out, the offer leads with signing in. */
export function buyOfferAllowed(view: CloudPlanView): boolean {
  return view.kind === "signed-out" || view.kind === "free";
}

/** The plan in one line, or null where there is no plan to name. */
export function cloudPlanLine(view: CloudPlanView): string | null {
  switch (view.kind) {
    case "paid": return t(view.trial ? "cloudAccount.trialPlan" : "cloudAccount.pro", { plan: view.label });
    case "attention": return t("cloudAccount.inactive", { plan: view.label ?? "MausBot Cloud" });
    case "purchase": return t("cloudAccount.purchaseReceived", { plan: view.label ?? "MausBot Cloud" });
    case "unverified": return view.label ? t("cloudAccount.lastPlan", { plan: view.label }) : null;
    case "reauth": return view.label ? t("cloudAccount.planName", { plan: view.label }) : null;
    case "free": return t("cloudAccount.free");
    default: return null;
  }
}

/** A free trial that has not ended: the Cloud is the person's as a paying customer's is. */
export function trialRunning(trial: CloudTrial | undefined): boolean {
  return trial?.state === "active" || trial?.state === "ending" || trial?.state === "processing";
}

const shortDate = (value: number) => new Intl.DateTimeFormat(activeLocale(), { day: "numeric", month: "short" }).format(new Date(value));

/** US dollars, written as the app writes its prices: "$49", "$3.20". */
export function usd(dollars: number): string {
  const cents = Math.round(dollars * 100);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
}

export type CloudTrialAction = "manage" | "subscribe" | "status";
export interface CloudTrialView {
  state: CloudTrialState;
  title: string;
  /** What happens to the Cloud, and when. */
  body: string;
  /** The trial's Claude credit, while the trial runs and the credit lasts. */
  credit?: string;
  /** Its last days, on a plan above Personal: the way down to Personal (the notice says it). */
  switchPlan?: string;
  /** The one next step, on the Cloud page in the browser; null when there is nothing to do. */
  action: { kind: CloudTrialAction; label: string } | null;
}

/** What the app says about a free trial, in one place: the trial's popup and
 * Settings (on this computer and on the Cloud) read it, with the same facts
 * as the Cloud page. One message and at most one next step per state. Before
 * its end, `keep` tells renewal turned off (`portal`: it can be turned back
 * on) from a subscription cancelled outright (anything else), which offers
 * nothing to buy until it has ended: a new checkout then would stop the
 * running Cloud. Personal's price for the way down comes with the trial
 * (`personalAmount`), else from an offer this page read (`personal`). */
export function cloudTrialView(trial: CloudTrial, credit?: CloudCredit, { personal = null }: { personal?: number | null } = {}): CloudTrialView {
  personal = trial.personalAmount ?? personal;
  const plan = trial.tier ? cloudPlanLabel(trial.tier) : t("cloudTrial.yourPlan");
  const ends = shortDate(trial.endsAt), deleted = trial.deleteAt ? shortDate(trial.deleteAt) : null;
  const subscribe = { kind: "subscribe" as const, label: t("cloudTrial.subscribe") };
  switch (trial.state) {
    case "active": return {
      state: "active", title: t("cloudTrial.endsOn", { date: ends }),
      body: trial.amount === null ? t("cloudTrial.activeNoPrice", { plan, date: shortDate(trial.chargeAt ?? trial.endsAt) })
        : t("cloudTrial.active", { plan, price: usd(trial.amount / 100), date: shortDate(trial.chargeAt ?? trial.endsAt) }),
      ...(credit?.state === "active" ? { credit: t("cloudTrial.credit", { granted: usd(credit.grantedUsd), left: usd(credit.remainingUsd) }) } : {}),
      // Pro is preselected at checkout; the last days say how to step down (an operator switches it, with nothing billed).
      ...(trial.tier && trial.tier !== "personal" && Object.hasOwn(PLAN_LABEL, trial.tier) ? { switchPlan: personal
        ? t("cloudTrial.preferPersonal", { price: usd(personal / 100), date: ends })
        : t("cloudTrial.preferPersonalNoPrice", { date: ends }) } : {}),
      action: { kind: "manage", label: t("cloudTrial.manage") },
    };
    case "ending": return trial.keep === "portal"
      ? { state: "ending", title: t("cloudTrial.endsOn", { date: ends }),
        body: deleted ? t("cloudTrial.ending", { date: deleted }) : t("cloudTrial.endingNoDate"), action: subscribe }
      : { state: "ending", title: t("cloudTrial.endsOn", { date: ends }),
        body: deleted ? t("cloudTrial.cancelled", { date: deleted }) : t("cloudTrial.cancelledNoDate"), action: null };
    case "processing": return { state: "processing", title: t("cloudTrial.processingTitle"), body: t("cloudTrial.processing"), action: null };
    case "late": return { state: "late", title: t("cloudTrial.lateTitle"),
      body: deleted ? t("cloudTrial.late", { date: deleted }) : t("cloudTrial.lateNoDate"), action: { kind: "status", label: t("cloudTrial.checkPayment") } };
    case "ended": return { state: "ended", title: t("cloudTrial.endedTitle"),
      body: deleted ? t("cloudTrial.ended", { date: deleted }) : t("cloudTrial.endedNoDate"), action: subscribe };
  }
}

/** The trial's popup due now, or null: main says which notice is due and
 * shows each at most once a day (electron/cloud-trial-notice.mjs). */
export function cloudTrialNotice(plan: CloudPlanSnapshot | null | undefined): CloudTrialView | null {
  if (!plan?.notice || !plan.trial || plan.trial.state !== plan.notice) return null;
  return cloudTrialView(plan.trial, plan.credit);
}

/** The trial's AI credit in one line: what is left, or that it is used up and the next step. */
export function cloudCreditLine(credit: CloudCredit): string {
  return credit.state === "used_up"
    ? t("cloudCredit.usedUp", { granted: usd(credit.grantedUsd) })
    : t("cloudCredit.left", { left: usd(credit.remainingUsd), granted: usd(credit.grantedUsd) });
}

/** The trial's popup on This computer's page needs Personal's price for its
 * way down; any offer the app has read carries it. */
export function personalAmount(offer: CloudOffer | null | undefined): number | null {
  return offer?.plans.find(plan => plan.tier === "personal")?.amount ?? null;
}

// ── This computer's My Cloud card (someone with a plan) ────────────────

/** The one card This computer's window shows about My Cloud, bottom left, or
 * null:
 * - "my-cloud": a paid plan whose My Cloud is ready; the always-on bots are there.
 * - "sign-in-again": this computer's sign-in ended, and it last saw an active
 *   plan, so the card can say the plan and My Cloud are unaffected.
 * - "removed": a saved sign-in this computer could not read and removed. It
 *   cannot tell whether there is a plan, so the card claims none.
 * An offer to buy is the card after the update's, shown only where
 * buyOfferAllowed; My Cloud still being set up is shown in Settings. */
export type CloudNoticeKind = "my-cloud" | "sign-in-again" | "removed";
export function cloudNoticeKind(view: CloudPlanView, account: CloudAccountState | null | undefined): CloudNoticeKind | null {
  if (view.kind === "paid" && account?.machine?.status === "ready") return "my-cloud";
  if (view.kind === "reauth" && account?.lastPlan?.active === true) return "sign-in-again";
  if (view.kind === "removed") return "removed";
  return null;
}

// ── What is for sale, and how it reads ─────────────────────────────────

/** The ways into a checkout from this app, as the Admin counts them
 * (electron/cloud-account.mjs CHECKOUT_SOURCES): the card after the update,
 * Show me how, the server menu, Settings, and the routine screen. */
export const CLOUD_SOURCES = ["app_card", "app_howto", "app_menu", "app_settings", "app_routines"] as const;
export type CloudSource = (typeof CLOUD_SOURCES)[number];

/** A plan's name: the Admin's for a plan newer than this app. */
export function offerPlanLabel(plan: CloudOfferPlan): string {
  return Object.hasOwn(PLAN_LABEL, plan.tier) ? PLAN_LABEL[plan.tier]! : plan.label ?? cloudPlanLabel(plan.tier);
}
const monthly = (amount: number) => t("cloudAdd.perMonth", { price: usd(amount / 100) });

/** The plan an offer preselects, or the one chosen if the offer sells it. */
export function offerPlan(offer: CloudOffer, chosen?: string | null): CloudOfferPlan {
  return offer.plans.find(plan => plan.tier === chosen) ?? offer.plans.find(plan => plan.tier === offer.recommended) ?? offer.plans[0]!;
}

/** The free trial an offer leads with: the preselected plan's, else any
 * plan's. Null without one. */
export function offerTrialDays(offer: CloudOffer | null | undefined): number | null {
  if (!offer) return null;
  return offerPlan(offer).trialDays ?? offer.plans.find(plan => plan.trialDays)?.trialDays ?? null;
}

/** "14-day money-back on every plan.", only when the Admin offers it to this person. */
export function moneyBackLine(offer: CloudOffer | null | undefined): string | null {
  return offer?.refundDays ? t("cloudAdd.moneyBack", { days: offer.refundDays }) : null;
}

/** What a plan gives, leading with what differs between plans: cloud
 * computers at once and storage, then the machine and its monthly hours. */
export function planDetails(plan: CloudOfferPlan): { main: string; machine: string } | null {
  const a = plan.allowances;
  if (!a) return null;
  const computers = a.computers === 1 ? t("cloudAdd.oneComputer") : t("cloudAdd.computers", { count: a.computers });
  const storage = a.maxDiskGb > a.diskGb ? t("cloudAdd.storageGrows", { gb: a.diskGb, max: a.maxDiskGb }) : t("cloudAdd.storage", { gb: a.diskGb });
  const memory = Math.max(1, Math.round(a.memoryMb / 1024));
  return { main: `${computers} · ${storage}`, machine: t("cloudAdd.machine", { cpus: a.cpus, memory, hours: a.computerHours }) };
}

/** A plan's row in the dialog: its name, its price (the largest text), and what it gives. */
export function planRow(plan: CloudOfferPlan): { tier: string; name: string; price: string; popular: boolean; details: { main: string; machine: string } | null } {
  return { tier: plan.tier, name: offerPlanLabel(plan), price: monthly(plan.amount), popular: plan.tier === "pro", details: planDetails(plan) };
}

const DAY_MS = 86_400_000;
/** The free trial's three steps for a plan, from today: nothing charged
 * today (and the credit), the reminder email (only while the Admin sends
 * one), and the first charge with how to avoid it. Empty without a trial. */
export function trialTimeline(offer: CloudOffer, plan: CloudOfferPlan, now: number): Array<{ when: string; text: string }> {
  if (!plan.trialDays) return [];
  const charge = now + plan.trialDays * DAY_MS;
  const today = { when: t("cloudAdd.today"), text: offer.creditUsd
    ? `${t("cloudAdd.timeline.start")} ${t("cloudAdd.timeline.credit", { credit: usd(offer.creditUsd) })}` : t("cloudAdd.timeline.start") };
  const reminder = offer.reminderDays && offer.reminderDays < plan.trialDays
    ? [{ when: shortDate(charge - offer.reminderDays * DAY_MS), text: t("cloudAdd.timeline.reminder") }] : [];
  return [today, ...reminder, { when: shortDate(charge), text: t("cloudAdd.timeline.charge", { plan: offerPlanLabel(plan), price: monthly(plan.amount) }) }];
}

// ── The card after the update ──────────────────────────────────────────

/** The card that introduces the free trial (CloudTrialIntro), or null when
 * there is no trial to offer: it waits for one rather than spend its days.
 * Its numbers are the Admin's: the trial's days, the price of the cheapest
 * plan that starts with it, the credit and the money-back. */
export function cloudIntroView(offer: CloudOffer | null | undefined): { badge: string; points: string[]; price: string; moneyBack: string | null } | null {
  const days = offerTrialDays(offer);
  if (!offer || !days) return null;
  const cheapest = Math.min(...offer.plans.filter(plan => plan.trialDays).map(plan => plan.amount));
  return {
    badge: t("cloudIntro.badge", { days }),
    points: [t("cloudIntro.routines"), t("cloudIntro.phone"), offer.creditUsd ? t("cloudIntro.credit", { credit: usd(offer.creditUsd) }) : t("cloudIntro.included")],
    price: t("cloudIntro.price", { price: usd(cheapest / 100) }),
    moneyBack: moneyBackLine(offer),
  };
}

// ── The Add a Cloud dialog ─────────────────────────────────────────────

/** A checkout this app opened is waited on this long; after that the offer
 * says no payment was seen yet. */
export const CHECKOUT_WAIT_MS = 30 * 60_000;

/** The Add a Cloud dialog's one state→view function: the buying journey
 * only. Payment problems, an ended sign-in or a Cloud that can't be reached
 * go to Settings → OpenMausBot Cloud ("settings"), which has one message and
 * one action for each.
 * - checking: the account or the offer is not known yet;
 * - offer: someone signed out or with no plan, with what is for sale
 *   (`waited`: a checkout this app opened 30 minutes ago has no trial or
 *   payment yet; `notice`: why the last step ended: the sign-in code
 *   expired, the sign-in ended, or a checkout was already being prepared);
 * - unreachable: the offer could not be read;
 * - error: the last checkout did not open (`failed`, or `rate-limited`);
 * - signing-in: the browser signs in first (the code to check; `checkout`:
 *   on the way to a checkout, else a plain sign-in);
 * - waiting: the next step is in the browser: a checkout open there (this
 *   app's, or the Admin's word), or, signed in on the way to one, the page
 *   after approval that leads to it (`browser: "signin"`);
 * - received: a payment is being linked to this account;
 * - starting: a trial or plan is active and My Cloud is being set up;
 * - ready: My Cloud is ready, after a checkout this app opened;
 * - has-cloud: My Cloud exists, not from this journey. */
export type CloudAddView =
  | { kind: "checking" }
  | { kind: "unreachable" }
  | { kind: "error"; reason: "failed" | "rate-limited" }
  | { kind: "offer"; offer: CloudOffer; signedOut: boolean; waited: false | "trial" | "paid"; notice: "code-expired" | "signin-ended" | "preparing" | null }
  | { kind: "signing-in"; code: string | null; checkout: boolean }
  | { kind: "waiting"; plan: string; browser: "checkout" | "signin" }
  | { kind: "received"; line: string }
  | { kind: "starting"; trial: CloudTrial | null; step: CloudSetupStep | null; slow: boolean }
  | { kind: "ready" }
  | { kind: "has-cloud" }
  | { kind: "settings" };

export function cloudAddView(account: CloudAccountState | null | undefined, offer: CloudOffer | null | undefined,
  { now, error = null, choosing = false, conflict = false }: { now: number; error?: "failed" | "rate-limited" | null; choosing?: boolean; conflict?: boolean }): CloudAddView {
  const view = cloudPlanView(account);
  switch (view.kind) {
    case "unknown": return { kind: "checking" };
    case "connecting": return { kind: "signing-in", code: account?.enrollment?.userCode ?? null, checkout: Boolean(account?.checkout) };
    case "purchase": return { kind: "received", line: cloudPlanLine(view) ?? "" };
    case "paid": {
      const machine = account?.machine;
      if (!machine || machine.status === "provisioning") {
        return { kind: "starting", trial: account?.trial && trialRunning(account.trial) ? account.trial : null, step: machine?.setup?.step ?? null, slow: machine?.setup?.slow === true };
      }
      if (machine.status !== "ready") return { kind: "settings" };
      return account?.checkout ? { kind: "ready" } : { kind: "has-cloud" };
    }
    case "signed-out": case "free": {
      if (error) return { kind: "error", reason: error };
      if (offer === undefined) return { kind: "checking" };
      if (offer === null) return { kind: "unreachable" };
      const opened = account?.checkout ?? null, fresh = opened !== null && now - opened.startedAt < CHECKOUT_WAIT_MS;
      const open = offer.checkout && offer.checkout.openUntil > now ? offer.checkout : null;
      // Signed in on the way to a checkout, the browser's page after approval leads to it; once one is open, it is the checkout.
      if (view.kind === "free" && !choosing && (fresh || (open && !opened))) {
        return { kind: "waiting", plan: (fresh ? opened!.plan : open!.plan), browser: fresh && opened!.signIn && !open ? "signin" : "checkout" };
      }
      // Whether what was opened started a trial or a paid plan, as the offer sells it.
      const waited = view.kind === "free" && opened !== null && !fresh ? offer.plans.find(plan => plan.tier === opened.plan)?.trialDays ? "trial" : "paid" : false;
      // Why the last step ended, said once with the offer it returns to.
      const notice = account?.status === "signed-out" && account.message === "enrollment-expired" ? "code-expired"
        : account?.status === "signed-out" && (account.message === "enrollment-ended" || account.message === "signin-failed") ? "signin-ended" : conflict ? "preparing" : null;
      return { kind: "offer", offer, signedOut: view.kind === "signed-out", waited, notice };
    }
    default: return { kind: "settings" };
  }
}
