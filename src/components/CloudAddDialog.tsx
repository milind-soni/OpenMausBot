// The Add a Cloud dialog (docs/cloud-pro.md, "Add a Cloud"): the one way to
// buy OpenMausBot Cloud in the app, opened from the card after the update,
// Show me how, the server menu, Settings and the routine screen. It covers the
// buying journey only, one view per state from lib/cloud-plan cloudAddView:
// the offer (the Admin's plans, trial, credit and money-back, nothing
// hardcoded), signing in, the checkout open in the browser, the payment
// received, My Cloud starting, and My Cloud ready. A payment problem, an ended
// sign-in or a Cloud that can't be reached go to Settings → OpenMausBot Cloud.
// Checkout never runs in the app: main opens Dodo's own checkout page in the
// default browser, and the app follows its own session, never the return.
import { useEffect, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import type { CloudAccountState, CloudCheckoutOutcome } from "../../electron/cloud-account.mjs";
import type { CloudOffer, CloudSetupStep } from "../../electron/cloud-home.mjs";
import { track } from "@/lib/analytics";
import { activeLocale, t } from "@/lib/i18n";
import { cloudAddView, cloudPlanLabel, moneyBackLine, offerPlan, offerPlanLabel, planRow, trialTimeline, usd, type CloudAddView } from "@/lib/cloud-plan";
import type { LocaleKey } from "@/locales";
import { useStore } from "@/state/store";

const SETUP_STEPS = [
  ["reserving", "cloudHome.step.reserving"], ["storage", "cloudHome.step.storage"],
  ["starting", "cloudHome.step.starting"], ["checking", "cloudHome.step.checking"],
] as const satisfies ReadonlyArray<readonly [CloudSetupStep, LocaleKey]>;
const shortDate = (value: number) => new Intl.DateTimeFormat(activeLocale(), { day: "numeric", month: "short" }).format(new Date(value));

const PRIMARY = "inline-flex min-h-10 w-full items-center justify-center rounded-lg bg-accent px-4 py-2 text-[14px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const QUIET = "py-2 text-[12.5px] text-ink-secondary hover:text-ink";

/** The plan an arrow key moves the plan picker to (a radio group: Down and
 * Right go on, Up and Left back, wrapping; Home and End to either end), or
 * null for any other key. */
export function planFromKey(tiers: readonly string[], current: string, key: string): string | null {
  const at = tiers.indexOf(current);
  if (at === -1 || !tiers.length) return null;
  const next = key === "ArrowDown" || key === "ArrowRight" ? (at + 1) % tiers.length : key === "ArrowUp" || key === "ArrowLeft" ? (at - 1 + tiers.length) % tiers.length
    : key === "Home" ? 0 : key === "End" ? tiers.length - 1 : null;
  return next === null ? null : tiers[next]!;
}

/** What a view's buttons do. */
export interface CloudAddActions {
  choose(tier: string): void;
  checkout(): void;
  signIn(): void;
  reopenBrowser(): void;
  cancelSignIn(): void;
  changePlan(): void;
  retry(): void;
  openCloud(): void;
  close(): void;
}

/** The dialog's content for one view: no state of its own. `chosen`: the
 * plan picked (else the offer's preselected one); `offerShown`: the last
 * offer this dialog read, for the terms once the trial has started. */
export function CloudAddPanel({ view, chosen, offerShown, now, busy = false, openFailed = false, actions }: {
  view: CloudAddView; chosen: string | null; offerShown: CloudOffer | null; now: number; busy?: boolean; openFailed?: boolean; actions: CloudAddActions;
}) {
  // The heading takes focus when the view changes (CloudAddDialog), so a screen reader says the new step.
  const heading = (title: string, subtitle?: string) => <>
    <h2 id="cloud-add-title" tabIndex={-1} className="pe-8 text-[17px] font-semibold text-ink outline-none">{title}</h2>
    {subtitle && <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{subtitle}</p>}
  </>;
  const closeRow = (label = t("cloudAdd.close")) => <div className="mt-4 flex justify-end"><button type="button" className="ui-button" onClick={actions.close}>{label}</button></div>;
  switch (view.kind) {
    case "checking": return <div data-cloud-add="checking">
      {heading(t("cloudAdd.title"))}
      <p role="status" className="mt-4 flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" aria-hidden="true" />{t("cloudAdd.checking")}</p>
      {closeRow()}
    </div>;
    case "unreachable": case "error": {
      const line = view.kind === "unreachable" ? t("cloudAdd.unreachable") : view.reason === "rate-limited" ? t("cloudAdd.rateLimited") : t("cloudAdd.failed");
      return <div data-cloud-add={view.kind === "error" ? `error-${view.reason}` : "unreachable"}>
        {heading(t("cloudAdd.title"))}
        <p role="alert" className="mt-4 text-[13px] leading-relaxed text-ink">{line}</p>
        <div className="mt-4 flex items-center justify-end gap-3">
          <button type="button" className={QUIET} onClick={actions.close}>{t("cloudAdd.close")}</button>
          <button type="button" className="ui-button" onClick={actions.retry}>{t("cloudAdd.tryAgain")}</button>
        </div>
      </div>;
    }
    case "offer": {
      const { offer } = view;
      const plan = offerPlan(offer, chosen);
      const trial = Boolean(plan.trialDays);
      const timeline = trialTimeline(offer, plan, now);
      const moneyBack = moneyBackLine(offer);
      return <div data-cloud-add={trial ? "offer-trial" : "offer"}>
        {heading(trial ? t("cloudAdd.titleTrial", { days: plan.trialDays! }) : t("cloudAdd.title"), t("cloudAdd.subtitle"))}
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-secondary">
          {(["cloudIntro.routines", "cloudIntro.phone", "cloudIntro.included"] as const).map(key => <li key={key} className="flex items-center gap-1.5"><Check size={12} aria-hidden="true" />{t(key)}</li>)}
        </ul>
        <div role="radiogroup" aria-label={t("cloudAdd.plans")} className="mt-4 flex flex-col gap-2">
          {offer.plans.map(entry => {
            const row = planRow(entry), selected = entry.tier === plan.tier;
            // One tab stop for the group, on the plan picked; the arrow keys move between plans.
            const onKeyDown = (event: { key: string; preventDefault(): void; currentTarget: { parentElement: HTMLElement | null } }) => {
              const next = planFromKey(offer.plans.map(item => item.tier), plan.tier, event.key);
              if (!next) return;
              event.preventDefault();
              actions.choose(next);
              event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-plan="${next}"]`)?.focus();
            };
            return <button key={entry.tier} type="button" role="radio" aria-checked={selected} tabIndex={selected ? 0 : -1} data-plan={entry.tier} onClick={() => actions.choose(entry.tier)} onKeyDown={onKeyDown}
              className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left ${selected ? "border-accent/70 bg-accent/10" : "border-hairline/50 hover:bg-raised"}`}>
              <span aria-hidden="true" className={`mt-1 size-3.5 shrink-0 rounded-full border-2 ${selected ? "border-accent bg-accent" : "border-hairline"}`} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-[14px] font-medium text-ink">{row.name}{row.popular && <span className="ms-2 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent-text">{t("cloudAdd.popular")}</span>}</span>
                  <span className="text-[15px] font-semibold text-ink">{row.price}</span>
                </span>
                {row.details && <span className="mt-0.5 block text-[12px] text-ink">{row.details.main}</span>}
                {row.details && <span className="block text-[11.5px] text-ink-secondary">{row.details.machine}</span>}
              </span>
            </button>;
          })}
        </div>
        {timeline.length > 0 && <ol data-cloud-add-timeline className="mt-4 flex flex-col gap-1.5 text-[12.5px]">
          {timeline.map(step => <li key={step.when} className="grid grid-cols-[64px_1fr] gap-2"><span className="font-medium text-ink">{step.when}</span><span className="text-ink-secondary">{step.text}</span></li>)}
        </ol>}
        {view.waited && <p role="status" className="mt-3 text-[12.5px] text-ink">{t(view.waited === "trial" ? "cloudAdd.waitedTrial" : "cloudAdd.waited")}</p>}
        {view.notice && <p role="status" className="mt-3 text-[12.5px] text-ink">{t(view.notice === "code-expired" ? "cloudAdd.codeExpired" : view.notice === "signin-ended" ? "cloudAdd.signInEnded" : "cloudAdd.preparing")}</p>}
        <div className="mt-4">
          <button type="button" className={PRIMARY} disabled={busy} onClick={actions.checkout}>
            {trial ? t("cloudIntro.start") : t("cloudAdd.buy", { plan: offerPlanLabel(plan), price: usd(plan.amount / 100) })}
          </button>
          <p className="mt-1.5 text-center text-[12px] text-ink-secondary">{[trial ? null : t("cloudAdd.buyNote"), moneyBack, trial ? t("cloudAdd.trialNote") : null].filter(Boolean).join(" ")}</p>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          {view.signedOut ? <button type="button" className="py-2 text-left text-[12.5px] font-medium text-accent-text underline underline-offset-2 hover:text-ink" onClick={actions.signIn}>{t("cloudAccount.signIn")}</button> : <span />}
          <button type="button" className={QUIET} onClick={actions.close}>{t("notice.notNow")}</button>
        </div>
      </div>;
    }
    case "signing-in": {
      const trial = offerShown ? Boolean(offerPlan(offerShown, chosen).trialDays) : false;
      return <div data-cloud-add="signing-in">
        {heading(t("cloudAdd.browserTitle"))}
        {view.code ? <ol className="mt-3 list-decimal ps-5 text-[13px] leading-relaxed text-ink">
          <li>{t("cloudAdd.signInStep1")}</li>
          <li>{t("cloudAccount.codeCheck")}<code dir="ltr" className="block select-all text-[16px] font-semibold tracking-widest">{view.code}</code></li>
          <li>{t(!view.checkout ? "cloudAdd.signInStep3Connect" : trial ? "cloudAdd.signInStep3Trial" : "cloudAdd.signInStep3")}</li>
        </ol> : <p role="status" className="mt-3 text-[13px] text-ink-secondary">{t("cloudAdd.opening")}</p>}
        <div className="mt-4 flex items-center justify-end gap-3">
          <button type="button" className={QUIET} disabled={busy} onClick={actions.cancelSignIn}>{t("cloudAdd.cancel")}</button>
          <button type="button" className="ui-button" disabled={busy || !view.code} onClick={actions.reopenBrowser}>{t("cloudAdd.reopenBrowser")}</button>
        </div>
      </div>;
    }
    case "waiting": {
      // Signed in on the way to a checkout: the browser's page after approval has the next step. If that tab is gone, this
      // opens the same checkout (the Admin hands back an open one for the same offer).
      const plan = view.browser === "signin" && offerShown ? offerPlan(offerShown, view.plan) : null;
      return <div data-cloud-add={view.browser === "signin" ? "waiting-signin" : "waiting"}>
        {heading(t("cloudAdd.browserTitle"), t(view.browser === "signin" ? "cloudAdd.waitingSignIn" : "cloudAdd.waiting"))}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
          <button type="button" className={QUIET} onClick={actions.close}>{t("cloudAdd.cancel")}</button>
          <button type="button" className={QUIET} onClick={actions.changePlan}>{t("cloudAdd.changePlan")}</button>
          <button type="button" className="ui-button" disabled={busy} onClick={actions.checkout}>{plan
            ? plan.trialDays ? t("cloudIntro.start") : t("cloudAdd.buy", { plan: offerPlanLabel(plan), price: usd(plan.amount / 100) })
            : t("cloudAdd.reopenCheckout")}</button>
        </div>
      </div>;
    }
    case "received": return <div data-cloud-add="received">
      {heading(t("cloudAdd.receivedTitle"), view.line)}
      <p className="mt-2 text-[13px] text-ink-secondary">{t("cloudAccount.purchaseNoteNoDate")}</p>
      {closeRow()}
    </div>;
    case "starting": {
      const at = SETUP_STEPS.findIndex(([step]) => step === view.step);
      const trial = view.trial;
      const terms = trial ? [
        trial.amount !== null
          ? t("cloudAdd.trialTerms", { date: shortDate(trial.endsAt), plan: trial.tier ? cloudPlanLabel(trial.tier) : "MausBot Cloud", price: t("cloudAdd.perMonth", { price: usd(trial.amount / 100) }) })
          : t("cloudAdd.trialTermsNoPrice", { date: shortDate(trial.endsAt), plan: trial.tier ? cloudPlanLabel(trial.tier) : "MausBot Cloud" }),
        offerShown?.reminderDays ? t("cloudAdd.reminderTerms", { days: offerShown.reminderDays }) : null,
        t("cloudAdd.cancelAnyTime"),
      ].filter(Boolean).join(" ") : null;
      return <div data-cloud-add="starting">
        {heading(t(trial ? "cloudAdd.trialStarted" : "cloudAdd.receivedTitle"), t("cloudAdd.starting"))}
        <ol data-cloud-setup={view.step ?? "reserving"} className="mt-3 flex flex-col gap-1 text-[13px]">
          {SETUP_STEPS.map(([step, key], index) => <li key={step} aria-current={index === Math.max(at, 0) ? "step" : undefined}
            className={index === Math.max(at, 0) ? "font-medium text-ink" : index < at ? "text-ink-secondary line-through decoration-ink-secondary/40" : "text-ink-secondary"}>{t(key)}</li>)}
        </ol>
        {view.slow && <p role="status" className="mt-2 text-[12.5px] text-ink-secondary">{t("cloudHome.slow")}</p>}
        {terms && <p className="mt-3 text-[12.5px] leading-relaxed text-ink-secondary">{terms}</p>}
        <p className="mt-2 text-[12.5px] font-medium text-ink">{t("cloudAdd.nextJob")}</p>
        {closeRow()}
      </div>;
    }
    case "ready": case "has-cloud": return <div data-cloud-add={view.kind}>
      {view.kind === "ready" ? heading(t("cloudAdd.readyTitle"), t("cloudAdd.ready")) : heading(t("cloudAdd.hasCloudTitle"), t("cloudAdd.hasCloud"))}
      <div className="mt-4 flex items-center justify-end gap-3">
        <button type="button" className={QUIET} onClick={actions.close}>{t(view.kind === "ready" ? "cloudAdd.later" : "cloudAdd.close")}</button>
        <button type="button" className="ui-button" disabled={busy} onClick={actions.openCloud}>{t("cloudHome.connect")}</button>
      </div>
      {openFailed && <p role="alert" className="mt-2 text-[12.5px] text-danger">{t("cloudNotice.openFailed")}</p>}
      <p className="mt-3 text-[12px] text-ink-secondary">{t("cloudAdd.switchHint")}</p>
    </div>;
    case "settings": return null;
  }
}

/** The dialog, open while the store says (state.cloudAdd), on This computer's page only. */
export function CloudAddDialog({ now = Date.now }: { now?: () => number }) {
  const { state, dispatch } = useStore();
  const request = state.cloudAdd;
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  // What this person may buy (undefined while it is being read), the plan picked, and the last offer shown.
  const [offer, setOffer] = useState<CloudOffer | null | undefined>(undefined);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<"failed" | "rate-limited" | null>(null);
  // A checkout refused as a conflict that changed nothing here (one already being prepared): said with the offer.
  const [conflict, setConflict] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [asked, setAsked] = useState(0);
  const [reported, setReported] = useState<string[]>([]);
  const open = Boolean(request && bridge);
  useEffect(() => {
    if (!open || !bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState(next => { updated = true; if (active) setAccount(next); });
    void bridge.state().then(next => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [open, bridge]);
  const view = open ? cloudAddView(account, offer, { now: now(), error, choosing, conflict }) : null;
  // The offer is read when the dialog opens, on Try again, and when what this account may buy changes.
  const buying = view?.kind === "offer" || view?.kind === "checking" || view?.kind === "unreachable" || view?.kind === "waiting";
  const offerKey = open && buying && account ? `${account.status}:${JSON.stringify(account.offer ?? null)}:${asked}` : null;
  useEffect(() => {
    if (!offerKey || !bridge?.offer) return;
    let active = true;
    void bridge.offer().then(next => { if (active) setOffer(next); }, () => { if (active) setOffer(null); });
    return () => { active = false; };
  }, [offerKey, bridge]);
  const close = () => {
    dispatch({ type: "closeCloudAdd" });
    setError(null); setConflict(false); setChoosing(false); setOpenFailed(false); setReported([]); setChosen(null);
  };
  // Escape closes it and Tab stays inside it, before anything underneath
  // (Settings, when opened from there) hears the key: the capture phase, and
  // the key marked handled.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab") return;
      // The plan picker is one tab stop (its other plans take tabindex -1).
      const controls = [...(document.querySelector("[data-cloud-add-dialog]")?.querySelectorAll<HTMLElement>("button:not([disabled]):not([tabindex='-1'])") ?? [])];
      if (!controls.length) return;
      event.preventDefault();
      const at = controls.indexOf(document.activeElement as HTMLElement);
      controls[at === -1 ? 0 : (at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]!.focus();
    };
    window.addEventListener("keydown", onKey, true);
    (document.querySelector("[data-cloud-add-dialog] button") as HTMLElement | null)?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  // Payment problems, an ended sign-in and an unreachable Cloud have their one message and action in Settings.
  const kind = view?.kind ?? null;
  // A new step takes focus at its heading, so it is read out and Tab stays in the dialog (the button pressed may be gone).
  useEffect(() => {
    if (!kind || kind === "checking" || kind === "settings") return;
    if ((document.activeElement as HTMLElement | null)?.closest?.("[data-cloud-add-dialog]")) return;
    (document.querySelector("#cloud-add-title") as HTMLElement | null)?.focus();
  }, [kind]);
  useEffect(() => {
    if (!kind || !request) return;
    if (kind === "settings") { close(); dispatch({ type: "toggleAppSettings", open: true, section: "cloudAccount" }); return; }
    if (kind === "checking") return;
    const first = reported.length === 0;
    if (first) track("cloud_dialog_shown", { source: request.source, view: kind });
    if (["received", "starting", "ready"].includes(kind) && !reported.includes(kind)) track("cloud_dialog_view", { view: kind });
    if (first || !reported.includes(kind)) setReported([...reported, kind]);
  }, [kind]);
  if (!open || !view || !request || !bridge || view.kind === "settings") return null;

  const offerShown = offer ?? null;
  const run = (step: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setOpenFailed(false);
    void step().catch(() => setError("failed")).finally(() => setBusy(false));
  };
  const checkout = () => run(async () => {
    const plan = view.kind === "waiting" && !chosen ? view.plan : offerShown ? offerPlan(offerShown, chosen).tier : null;
    if (!plan || !bridge.checkout) { setError("failed"); return; }
    const trial = Boolean(offerShown && offerShown.plans.find(entry => entry.tier === plan)?.trialDays);
    const result = await bridge.checkout(plan, request.source);
    const outcome: CloudCheckoutOutcome = result.outcome;
    setAccount(result.state);
    if (outcome === "opened" || outcome === "signing-in") { setChoosing(false); setError(null); setConflict(false); track("cloud_checkout_opened", { plan, trial, source: request.source }); }
    else if (outcome === "rate-limited") setError("rate-limited");
    else if (outcome === "failed") setError("failed");
    // A conflict: the account changed (a plan, a payment being linked), and the state just read says what now; when it
    // still offers the same, a checkout was already being prepared, and the offer says so.
    else setConflict(true);
  });
  const actions: CloudAddActions = {
    choose: tier => { setChosen(tier); setChoosing(true); setConflict(false); },
    checkout,
    // Signed out, someone who already pays signs in; the dialog follows that sign-in.
    signIn: () => run(async () => setAccount(await bridge.begin())),
    reopenBrowser: () => run(async () => setAccount(await bridge.reopen())),
    cancelSignIn: () => run(async () => setAccount(await bridge.cancel())),
    changePlan: () => setChoosing(true),
    retry: () => { setError(null); setConflict(false); setOffer(undefined); setAsked(asked + 1); },
    openCloud: () => {
      if (busy) return;
      setBusy(true); setOpenFailed(false);
      void bridge.connectHome().then(() => close(), () => setOpenFailed(true)).finally(() => setBusy(false));
    },
    close,
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onMouseDown={event => event.target === event.currentTarget && close()}>
    <div role="dialog" aria-modal="true" aria-labelledby="cloud-add-title" data-cloud-add-dialog
      className="relative max-h-full w-full max-w-[560px] overflow-y-auto rounded-2xl border border-hairline/50 bg-panel p-6 shadow-2xl">
      <button type="button" onClick={close} aria-label={t("cloudAdd.close")} className="ui-icon-button absolute end-4 top-4"><X size={16} /></button>
      <CloudAddPanel view={view} chosen={chosen} offerShown={offerShown} now={now()} busy={busy} openFailed={openFailed} actions={actions} />
    </div>
  </div>;
}

