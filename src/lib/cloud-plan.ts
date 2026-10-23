import type { CloudAccountState, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudCredit, CloudOffer, CloudOfferPlan, CloudPlanAllowances, CloudSetupStep, CloudTrial, CloudTrialState } from "../../electron/cloud-home.mjs";
import { planTeam, teamPlan } from "../../electron/cloud-team-plan.mjs";
import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

const PLAN_LABEL: Record<string, string> = { starter: "Starter", personal: "Personal", pro: "Pro", max: "Max" };
const CHEAPEST_FIRST: readonly string[] = ["starter", "personal", "pro", "max"];
function switchesDown(tier: string | undefined, target: string): boolean {
  const below = CHEAPEST_FIRST.indexOf(target);
  return tier !== undefined && below >= 0 && CHEAPEST_FIRST.indexOf(tier) > below;
}
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

export function cloudTrialView(trial: CloudTrial, credit?: CloudCredit): CloudTrialView {
  const switchTo = trial.switchTo ?? (trial.personalAmount ? { tier: "personal", amount: trial.personalAmount } : null);
  const plan = trial.tier ? cloudPlanLabel(trial.tier) : t("cloudTrial.yourPlan");
  const ends = shortDate(trial.endsAt), deleted = trial.deleteAt ? shortDate(trial.deleteAt) : null;
  const subscribe = { kind: "subscribe" as const, label: t("cloudTrial.subscribe") };
  switch (trial.state) {
    case "active": return {
      state: "active", title: t("cloudTrial.endsOn", { date: ends }),
      body: trial.amount === null ? t("cloudTrial.activeNoPrice", { plan, date: shortDate(trial.chargeAt ?? trial.endsAt) })
        : t("cloudTrial.active", { plan, price: usd(trial.amount / 100), date: shortDate(trial.chargeAt ?? trial.endsAt) }),
      ...(credit?.state === "active" ? { credit: t("cloudTrial.credit", { granted: usd(credit.grantedUsd), left: usd(credit.remainingUsd) }) } : {}),
      ...(switchTo && switchesDown(trial.tier, switchTo.tier)
        ? { switchPlan: t("cloudTrial.preferPlan", { plan: cloudPlanLabel(switchTo.tier), price: usd(switchTo.amount / 100), date: ends }) } : {}),
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


export type CloudNoticeKind = "sign-in-again" | "removed";
export function cloudNoticeKind(view: CloudPlanView, account: CloudAccountState | null | undefined): CloudNoticeKind | null {
  if (view.kind === "reauth" && account?.lastPlan?.active === true) return "sign-in-again";
  if (view.kind === "removed") return "removed";
  return null;
}


export const CLOUD_SOURCES = ["app_card", "app_howto", "app_menu", "app_settings", "app_routines", "app_pages", "update_popup", "app_onboarding"] as const;
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

export function moneyBackShort(offer: CloudOffer): string | null {
  return offer.refundDays ? t("cloudBuy.moneyBack", { days: offer.refundDays }) : null;
}

/** One line of a plan card; `note` is small print under it. */
export interface CloudPlanCardRow { key: "power" | "desktops" | "hours" | "machine" | "storage" | "voice" | "backups"; text: string; note?: string }
/** A plan card. `action` is its buy button, null on the person's own plan (`current`); `terms` is the money in one line under it. */
export interface CloudPlanCard {
  tier: string; name: string; price: string; popular: boolean; current: boolean; promise: string | null;
  action: string | null; terms: string | null; rows: CloudPlanCardRow[];
}
const PROMISE: Record<string, LocaleKey> = { starter: "cloudBuy.promise.starter", pro: "cloudBuy.promise.pro", max: "cloudBuy.promise.max" };
const amount = (value: number) => new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 1 }).format(value);
const gb = (mb: number) => amount(Math.round(mb / 102.4) / 10);
/** About a thousand characters of speech a minute. */
function voiceLine(characters: number): string {
  const minutes = Math.max(1, Math.round(characters / 1000));
  if (minutes < 60) return t("cloudBuy.plan.voiceMinutes", { minutes: amount(minutes) });
  const hours = Math.round(minutes / 6) / 10;
  return hours === 1 ? t("cloudBuy.plan.voiceHour") : t("cloudBuy.plan.voiceHours", { hours: amount(hours) });
}
/** The same rows in the same order on every card, every number from the Admin's allowances. */
export function planCardRows(a: CloudPlanAllowances): CloudPlanCardRow[] {
  const cpus = a.cpuKind === "shared" ? t("cloudBuy.plan.cpusShared", { count: a.cpus }) : t("cloudBuy.plan.cpus", { count: a.cpus });
  return [
    { key: "power", text: a.sleeps ? t("cloudBuy.sleeps") : t("cloudBuy.row.alwaysOn") },
    { key: "desktops", text: t("cloudBuy.row.desktops"), note: t("cloudBuy.plan.limit", { count: a.computers }) },
    { key: "hours", text: t("cloudAdd.hours", { hours: amount(a.computerHours) }) },
    { key: "machine", text: t("cloudBuy.row.machine", { cpus, memory: gb(a.memoryMb) }), ...(a.swapMb ? { note: t("cloudBuy.row.swap", { swap: gb(a.swapMb) }) } : {}) },
    { key: "storage", text: a.maxDiskGb > a.diskGb ? t("cloudBuy.row.storageGrows", { gb: a.diskGb, max: a.maxDiskGb }) : t("cloudBuy.row.storage", { gb: a.diskGb }) },
    { key: "voice", text: voiceLine(a.voiceCharacters) },
    ...(a.snapshotDays ? [{ key: "backups" as const, text: t("cloudBuy.row.backups", { days: a.snapshotDays }) }] : []),
  ];
}
function planCard(plan: CloudOfferPlan, recommended: string, current: string | null): CloudPlanCard {
  const name = offerPlanLabel(plan), price = usd(plan.amount / 100), mine = plan.tier === current;
  return { tier: plan.tier, name, price, popular: plan.tier === recommended, current: mine,
    promise: Object.hasOwn(PROMISE, plan.tier) ? t(PROMISE[plan.tier]!) : null,
    action: mine ? null : plan.trialDays ? t("cloudIntro.start") : t("cloudBuy.card.get", { plan: name }),
    terms: mine ? null : plan.trialDays ? t("cloudBuy.card.trial", { days: plan.trialDays, price }) : t("cloudBuy.card.paid", { price }),
    rows: plan.allowances ? planCardRows(plan.allowances) : [] };
}
/** The plans on sale as cards, in the Admin's order. `current` is the person's own tier; `own` is that plan when it is not
 * on sale (a Personal subscriber's), listed where its price falls and only for them. */
export function planCards(offer: CloudOffer, { current = null, own = null }: { current?: string | null; own?: CloudOfferPlan | null } = {}): CloudPlanCard[] {
  const plans = [...offer.plans];
  if (current && own?.tier === current && !plans.some(plan => plan.tier === current)) {
    const at = plans.findIndex(plan => plan.amount > own.amount);
    plans.splice(at === -1 ? plans.length : at, 0, own);
  }
  return plans.map(plan => planCard(plan, offer.recommended, current));
}

const DAY_MS = 86_400_000;
/** The free trial's days when every plan on sale has the same ones, so one timeline is true of all of them. */
export function sharedTrialDays(offer: CloudOffer): number | null {
  const days = offer.plans[0]?.trialDays;
  return days && offer.plans.every(plan => plan.trialDays === days) ? days : null;
}
/** Today, the reminder (while the Admin sends one) and the first payment; nothing unless every plan has the same trial. */
export function trialTimeline(offer: CloudOffer, now: number): Array<{ when: string; text: string }> {
  const days = sharedTrialDays(offer);
  if (!days) return [];
  const charge = now + days * DAY_MS;
  const today = { when: t("cloudAdd.today"), text: offer.creditUsd ? t("cloudBuy.timeline.startCredit", { credit: usd(offer.creditUsd) }) : t("cloudBuy.timeline.start") };
  const reminder = offer.reminderDays && offer.reminderDays < days
    ? [{ when: shortDate(charge - offer.reminderDays * DAY_MS), text: t("cloudBuy.timeline.reminder") }] : [];
  return [today, ...reminder, { when: shortDate(charge), text: t("cloudBuy.timeline.firstPayment") }];
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
/** `sleeps`: the Admin says this Cloud's plan sleeps when idle. */
export interface CloudStarted { tier: string | null; trial: CloudTrial | null; credit: CloudCredit | null; sleeps?: true }

/** The Cloud being set up sleeps when idle: its own power, or the plan the offer showed for it says so. */
export function startedSleeps(started: CloudStarted, offer: CloudOffer | null | undefined): boolean {
  const tier = started.tier ?? started.trial?.tier;
  return started.sleeps === true || Boolean(tier && offer?.plans.find(plan => plan.tier === tier)?.allowances?.sleeps);
}

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
  /** A Team or Business plan: its Cloud is the team's (`team` null while the session lists none yet), never a My Cloud. */
  | { kind: "team-starting"; team: string | null; step: CloudSetupStep | null; slow: boolean }
  | { kind: "team-ready"; team: { id: string; name: string } }
  | { kind: "settings" };

function teamCloudView(team: ReturnType<typeof planTeam>): CloudAddView {
  const machine = team?.machine ?? null;
  if (!team || !machine || machine.status === "provisioning") {
    return { kind: "team-starting", team: team?.name ?? null, step: machine?.setup?.step ?? null, slow: machine?.setup?.slow === true };
  }
  return machine.status === "ready" ? { kind: "team-ready", team: { id: team.id, name: team.name } } : { kind: "settings" };
}

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
    trial: account?.trial && trialRunning(account.trial) ? account.trial : null, credit: account?.credit?.state === "active" ? account.credit : null,
    ...(account?.machine?.power?.sleeps ? { sleeps: true as const } : {}) });
  // Asked to sign in (Settings, the card, Already have a plan?): that needs no offer, and is the way back for a saved
  // sign-in that could not be read and was removed.
  if (signIn && !error && (view.kind === "signed-out" || view.kind === "removed")) return { kind: "sign-in", phase: signIn };
  switch (view.kind) {
    case "unknown": return { kind: "checking" };
    case "connecting": return { kind: "signing-in", code: account?.enrollment?.userCode ?? null, checkout: Boolean(account?.checkout) };
    case "purchase": return { kind: "starting", ...started(), step: null, slow: false, received: true };
    case "paid": {
      if (teamPlan(account)) return teamCloudView(planTeam(account));
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
