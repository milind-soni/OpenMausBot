import type { CloudAccountState, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudCredit, CloudOffer, CloudOfferPlan, CloudSetupStep, CloudTrial, CloudTrialState } from "../../electron/cloud-home.mjs";
import { activeLocale, t } from "@/lib/i18n";

const PLAN_LABEL: Record<string, string> = { personal: "Personal", pro: "Pro", max: "Max" };
export function cloudPlanLabel(tier?: string): string {
  return tier === undefined ? "Pro" : Object.hasOwn(PLAN_LABEL, tier) ? PLAN_LABEL[tier] : "Cloud";
}

export type CloudPlanView =
  | { kind: "unknown" }
  | { kind: "signed-out" }
  | { kind: "removed" }
  | { kind: "connecting" }
  | { kind: "free" }
  | { kind: "paid"; label: string; checking: boolean; trial?: true }
  | { kind: "attention"; label: string | null }
  | { kind: "purchase"; label: string | null; paidAt?: number }
  | { kind: "unverified"; label: string | null }
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
  if (entitlement?.plan === "pro") return { kind: "attention", label: cloudPlanLabel(entitlement.tier) };
  if (account.machine) return { kind: "attention", label: null };
  return { kind: "free" };
}

export function buyOfferAllowed(view: CloudPlanView): boolean {
  return view.kind === "signed-out" || view.kind === "free";
}

/** What the X research card offers someone whose server has no plan credential yet: a paying desktop is still connecting
 * it; signed out (or a sign-in that ended), sign in; verified free, get a plan. Nothing where the state is unknown or
 * someone may already pay, and without a desktop bridge. */
export function xResearchAction(view: CloudPlanView | null): "connecting" | "sign-in" | "get-pro" | null {
  if (!view) return null;
  if (view.kind === "paid") return "connecting";
  if (view.kind === "signed-out" || view.kind === "reauth") return "sign-in";
  return view.kind === "free" ? "get-pro" : null;
}

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

export function trialRunning(trial: CloudTrial | undefined): boolean {
  return trial?.state === "active" || trial?.state === "ending" || trial?.state === "processing";
}

const shortDate = (value: number) => new Intl.DateTimeFormat(activeLocale(), { day: "numeric", month: "short" }).format(new Date(value));

export function usd(dollars: number): string {
  const cents = Math.round(dollars * 100);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
}

export type CloudTrialAction = "manage" | "subscribe" | "status";
export interface CloudTrialView {
  state: CloudTrialState;
  title: string;
  body: string;
  credit?: string;
  switchPlan?: string;
  action: { kind: CloudTrialAction; label: string } | null;
}

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

export function cloudTrialNotice(plan: CloudPlanSnapshot | null | undefined): CloudTrialView | null {
  if (!plan?.notice || !plan.trial || plan.trial.state !== plan.notice) return null;
  return cloudTrialView(plan.trial, plan.credit);
}

export function cloudCreditLine(credit: CloudCredit): string {
  return credit.state === "used_up"
    ? t("cloudCredit.usedUp", { granted: usd(credit.grantedUsd) })
    : t("cloudCredit.left", { left: usd(credit.remainingUsd), granted: usd(credit.grantedUsd) });
}

export function personalAmount(offer: CloudOffer | null | undefined): number | null {
  return offer?.plans.find(plan => plan.tier === "personal")?.amount ?? null;
}


export type CloudNoticeKind = "my-cloud" | "sign-in-again" | "removed";
export function cloudNoticeKind(view: CloudPlanView, account: CloudAccountState | null | undefined): CloudNoticeKind | null {
  if (view.kind === "paid" && account?.machine?.status === "ready") return "my-cloud";
  if (view.kind === "reauth" && account?.lastPlan?.active === true) return "sign-in-again";
  if (view.kind === "removed") return "removed";
  return null;
}


export const CLOUD_SOURCES = ["app_card", "app_howto", "app_menu", "app_settings", "app_routines", "update_popup", "app_onboarding"] as const;
export type CloudSource = (typeof CLOUD_SOURCES)[number];

export function offerPlanLabel(plan: CloudOfferPlan): string {
  return Object.hasOwn(PLAN_LABEL, plan.tier) ? PLAN_LABEL[plan.tier]! : plan.label ?? cloudPlanLabel(plan.tier);
}

export function offerPlan(offer: CloudOffer, chosen?: string | null): CloudOfferPlan {
  return offer.plans.find(plan => plan.tier === chosen) ?? offer.plans.find(plan => plan.tier === offer.recommended) ?? offer.plans[0]!;
}

export function offerTrialDays(offer: CloudOffer | null | undefined): number | null {
  if (!offer) return null;
  return offerPlan(offer).trialDays ?? offer.plans.find(plan => plan.trialDays)?.trialDays ?? null;
}

export function moneyBackLine(offer: CloudOffer | null | undefined): string | null {
  return offer?.refundDays ? t("cloudAdd.moneyBack", { days: offer.refundDays }) : null;
}

export function planDetails(plan: CloudOfferPlan): { main: string; machine: string } | null {
  const a = plan.allowances;
  if (!a) return null;
  const computers = a.computers === 1 ? t("cloudAdd.oneComputer") : t("cloudAdd.computers", { count: a.computers });
  const storage = a.maxDiskGb > a.diskGb ? t("cloudAdd.storageGrows", { gb: a.diskGb, max: a.maxDiskGb }) : t("cloudAdd.storage", { gb: a.diskGb });
  const memory = Math.max(1, Math.round(a.memoryMb / 1024));
  return { main: `${computers} · ${storage}`, machine: t("cloudAdd.machine", { cpus: a.cpus, memory, hours: a.computerHours }) };
}

/** One plan card: its name, the Admin's price, what differs (cloud computers at once) and three allowance chips. */
export interface CloudPlanRow { tier: string; name: string; price: string; popular: boolean; line: string | null; chips: string[] }
export function planRow(plan: CloudOfferPlan, recommended?: string): CloudPlanRow {
  const a = plan.allowances;
  const chips = a ? [
    t("cloudBuy.chip.machine", { cpus: a.cpus, memory: Math.max(1, Math.round(a.memoryMb / 1024)) }),
    a.maxDiskGb > a.diskGb ? t("cloudBuy.chip.storageGrows", { gb: a.diskGb, max: a.maxDiskGb }) : t("cloudAdd.storage", { gb: a.diskGb }),
    t("cloudBuy.chip.hours", { hours: a.computerHours }),
  ] : [];
  return { tier: plan.tier, name: offerPlanLabel(plan), price: usd(plan.amount / 100), popular: plan.tier === recommended,
    line: a ? (a.computers === 1 ? t("cloudAdd.oneComputer") : t("cloudAdd.computers", { count: a.computers })) : null, chips };
}

const DAY_MS = 86_400_000;
/** Today, the reminder (while the Admin sends one) and the first charge; nothing without a trial. */
export function trialTimeline(offer: CloudOffer, plan: CloudOfferPlan, now: number): Array<{ when: string; text: string }> {
  if (!plan.trialDays) return [];
  const charge = now + plan.trialDays * DAY_MS;
  const today = { when: t("cloudAdd.today"), text: offer.creditUsd ? t("cloudBuy.timeline.startCredit", { credit: usd(offer.creditUsd) }) : t("cloudBuy.timeline.start") };
  const reminder = offer.reminderDays && offer.reminderDays < plan.trialDays
    ? [{ when: shortDate(charge - offer.reminderDays * DAY_MS), text: t("cloudBuy.timeline.reminder") }] : [];
  return [today, ...reminder, { when: shortDate(charge), text: t("cloudBuy.timeline.charge", { price: usd(plan.amount / 100) }) }];
}

/** What the chosen plan costs, in one place: due today, the money line (the card is needed for a trial), the button. */
export function planTerms(offer: CloudOffer, plan: CloudOfferPlan): { trial: boolean; due: string; money: string; action: string; moneyBack: string | null } {
  const price = usd(plan.amount / 100);
  const moneyBack = offer.refundDays ? t("cloudBuy.moneyBack", { days: offer.refundDays }) : null;
  return plan.trialDays
    ? { trial: true, due: dueToday(0), money: t("cloudBuy.moneyTrial", { days: plan.trialDays, price }), action: t("cloudIntro.start"), moneyBack }
    : { trial: false, due: t("cloudBuy.duePaid", { price }), money: t("cloudBuy.moneyPaid", { price }), action: t("cloudBuy.continue", { price }), moneyBack };
}
/** The welcome's Cloud beat: the Admin's offer in one line (trial days and the lowest price, the credit, money-back) and
 * its one action, Start free trial, or See plans without a trial. No number is the app's own. */
export function cloudBeatTerms(offer: CloudOffer): { trial: boolean; line: string; action: string } {
  const days = offerTrialDays(offer);
  const priced = days ? offer.plans.filter(plan => plan.trialDays) : offer.plans;
  const price = usd(Math.min(...priced.map(plan => plan.amount)) / 100);
  const line = [days ? t("onboarding.cloud.trial", { days, price }) : t("onboarding.cloud.price", { price }),
    days && offer.creditUsd ? t("onboarding.cloud.credit", { credit: usd(offer.creditUsd) }) : null,
    offer.refundDays ? t("onboarding.cloud.moneyBack", { days: offer.refundDays }) : null].filter(Boolean).join(" ");
  return { trial: Boolean(days), line, action: days ? t("cloudIntro.start") : t("onboarding.cloud.seePlans") };
}

/** The plan picked before signing in costs and starts the same for this account (its session's own offer); otherwise
 * Choose shows the account's terms before any checkout, so "$0.00 today" is never said of a paid one. */
export function sameTerms(shown: CloudOffer | null | undefined, mine: CloudOffer | null | undefined, tier: string): boolean {
  const before = shown?.plans.find(plan => plan.tier === tier), now = mine?.plans.find(plan => plan.tier === tier);
  return Boolean(before && now && before.amount === now.amount && (before.trialDays ?? 0) === (now.trialDays ?? 0));
}

export function dueToday(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(cents / 100);
}


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


export const CHECKOUT_WAIT_MS = 30 * 60_000;

/** The in-app sign-in's step, kept by the sheet: where it is and what the Admin last said, never a code or token. */
export type CloudSignInProblem = "invalid-email" | "rate-limited" | "failed" | "wrong-code" | "expired" | "signup-closed" | "device-limit" | "sso" | "two-factor" | "browser";
export type CloudSignInPhase =
  | { step: "email"; intent: boolean; problem: CloudSignInProblem | null }
  | { step: "code"; intent: boolean; email: string; resendAt: number; problem: CloudSignInProblem | null; triesLeft: number | null; signupOpen?: boolean }
  | { step: "done"; intent: boolean };

/** What the setup screen says about the plan that started: its tier, the running trial and the trial's credit. */
export interface CloudStarted { tier: string | null; trial: CloudTrial | null; credit: CloudCredit | null }

export type CloudAddView =
  | { kind: "checking" }
  | { kind: "unreachable" }
  | { kind: "error"; reason: "failed" | "rate-limited" }
  | { kind: "offer"; offer: CloudOffer; signedOut: boolean; notice: "code-expired" | "signin-ended" | "preparing" | "terms" | null }
  | { kind: "sign-in"; phase: CloudSignInPhase }
  | { kind: "signing-in"; code: string | null; checkout: boolean }
  | { kind: "waiting"; plan: string; browser: "checkout" | "signin"; late: boolean; link: boolean; email: string | null }
  | ({ kind: "starting"; step: CloudSetupStep | null; slow: boolean; received: boolean } & CloudStarted)
  | ({ kind: "ready" } & CloudStarted)
  | { kind: "has-cloud" }
  | { kind: "settings" };

/** The one state → view function of the buying sheet: every Cloud state is one message and one next step. */
export function cloudAddView(account: CloudAccountState | null | undefined, offer: CloudOffer | null | undefined,
  { now, error = null, choosing = false, conflict = false, signIn = null, arrived = false, terms = false }: {
    now: number; error?: "failed" | "rate-limited" | null; choosing?: boolean; conflict?: boolean; signIn?: CloudSignInPhase | null;
    /** Signed in here to an account whose own terms differ from those shown: Choose says so. */
    terms?: boolean;
    /** Signed in from this sheet just now: a ready Cloud is theirs to open, not a second one to ask for. */
    arrived?: boolean;
  }): CloudAddView {
  const view = cloudPlanView(account);
  const started = (): CloudStarted => ({ tier: account?.entitlement?.tier ?? account?.purchase?.tier ?? null,
    trial: account?.trial && trialRunning(account.trial) ? account.trial : null, credit: account?.credit?.state === "active" ? account.credit : null });
  // Asked to sign in (Settings, the card, Already have a plan?): that needs no offer, and is the way back for a saved
  // sign-in that could not be read and was removed.
  if (signIn && !error && (view.kind === "signed-out" || view.kind === "removed")) return { kind: "sign-in", phase: signIn };
  switch (view.kind) {
    case "unknown": return { kind: "checking" };
    case "connecting": return { kind: "signing-in", code: account?.enrollment?.userCode ?? null, checkout: Boolean(account?.checkout) };
    case "purchase": return { kind: "starting", ...started(), step: null, slow: false, received: true };
    case "paid": {
      const machine = account?.machine;
      if (!machine || machine.status === "provisioning") return { kind: "starting", ...started(), step: machine?.setup?.step ?? null, slow: machine?.setup?.slow === true, received: false };
      if (machine.status !== "ready") return { kind: "settings" };
      // Ready while this purchase is not over (main marks it done once the Cloud was opened, announced or shown ready), or
      // for this sheet's own journey; afterwards Add a Cloud… is one Cloud for now.
      return (account?.checkout && !account.checkout.done) || arrived ? { kind: "ready", ...started() } : { kind: "has-cloud" };
    }
    case "signed-out": case "free": {
      if (error) return { kind: "error", reason: error };
      if (offer === undefined) return { kind: "checking" };
      if (offer === null) return { kind: "unreachable" };
      const opened = account?.checkout ?? null;
      if (signIn && !opened && (view.kind === "signed-out" || signIn.step === "done")) return { kind: "sign-in", phase: signIn };
      const open = offer.checkout && offer.checkout.openUntil > now ? offer.checkout : null;
      if (view.kind === "free" && !choosing && (opened || open)) {
        const late = opened ? now - opened.startedAt >= CHECKOUT_WAIT_MS : false;
        return { kind: "waiting", plan: opened?.plan ?? open!.plan, browser: opened?.signIn && !opened.link && !open ? "signin" : "checkout", late,
          link: opened?.link === true, email: account?.account?.email ?? null };
      }
      const notice = account?.status === "signed-out" && account.message === "enrollment-expired" ? "code-expired"
        : account?.status === "signed-out" && (account.message === "enrollment-ended" || account.message === "signin-failed") ? "signin-ended"
          : conflict ? "preparing" : terms ? "terms" : null;
      return { kind: "offer", offer, signedOut: view.kind === "signed-out", notice };
    }
    default: return { kind: "settings" };
  }
}
