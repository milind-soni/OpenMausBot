import { useEffect, useId, useState } from "react";
import { ArrowUpRight, CalendarClock, Cloud, Crown, Monitor, Sparkles, X } from "lucide-react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { api, CLOUD_LINK_SETTINGS, useStore } from "@/state/store";
import { openExternalLink, PRICING_URL, PRO_URL } from "@/lib/app-links";
import { buyOfferAllowed, cloudPlanLine, cloudPlanView, type CloudPlanView } from "@/lib/cloud-plan";
import { emailGateDone } from "@/lib/analytics";
import { currentStep } from "@/lib/guided-tour";
import { hintSeen, hintSeenPatch, welcomeDue } from "@/lib/onboarding";
import { useUpdaterState } from "@/lib/updater";
import { t } from "@/lib/i18n";

// Versioned once, for the launch price: a dismissal of the first card
// ("pro-introduction-dismissed") no longer counts, so everyone sees it once
// more. After that, updates and replaying the welcome tour never reset it.
export const PRO_DISMISSED = "pro-introduction-dismissed-v2";

/** The launch price, and the price after the launch offer. Both are plain
 * text: never a struck-through or "was" former price (FTC 16 CFR 233.1 and
 * the EU 30-day prior-price rule). */
export const PRO_LAUNCH_PRICE = "$49";
export const PRO_LATER_PRICE = "$89";
/** The other OMB Cloud plans, monthly. Every price is plus applicable tax. */
export const CLOUD_PERSONAL_PRICE = "$29";
export const CLOUD_MAX_PRICE = "$99";

/** Only someone signed out, or verified as signed in with no plan, no Cloud
 * and no payment being linked, is ever offered a plan (src/lib/cloud-plan.ts). */
export function proOfferAvailable(account: CloudAccountState | null): boolean {
  return buyOfferAllowed(cloudPlanView(account));
}

/** The plan as the native snapshot says; null without a bridge (a browser, a remote page). */
function useCloudPlan(): CloudPlanView | null {
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState(next => { updated = true; if (active) setAccount(next); });
    // Reads the native snapshot only; never initiates sign-in or a refresh.
    void bridge.state().then(next => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  return bridge ? cloudPlanView(account) : null;
}

/** Signed out: someone who already pays signs in first, before any offer. */
function SignInFirst({ onSignIn }: { onSignIn: () => void }) {
  return <p className="text-[12.5px] text-ink">{t("pro.havePlan")}{" "}
    <button type="button" className="font-medium text-accent underline underline-offset-2 hover:text-ink" onClick={onSignIn}>{t("pro.signIn")}</button></p>;
}

/** Every plan side by side, on the website. */
function PlansLink({ onOpened }: { onOpened?: () => void }) {
  return <button type="button" className="py-2 text-[12px] text-ink-secondary underline underline-offset-2 hover:text-ink"
    onClick={() => void openExternalLink(PRICING_URL).then(onOpened).catch(() => {})}>{t("pro.seePlans")}</button>;
}

export function ProLink({ onOpened }: { onOpened?: () => void }) {
  const [failed, setFailed] = useState(false);
  return <div>
    <button type="button" className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus" onClick={() => {
      setFailed(false);
      void openExternalLink(PRO_URL).then(onOpened).catch(() => setFailed(true));
    }}>
      {t("pro.getPro")}<ArrowUpRight size={14} aria-hidden="true" />
    </button>
    {failed && <p role="alert" className="mt-2 text-[12px] text-danger">{t("pro.openFailed")}</p>}
  </div>;
}

/** Always available in Settings, independent of the introduction's dismissal.
 * Someone with a plan (or one being linked, or one this app cannot check
 * right now) sees that plan here instead, and the way to it. */
export function ProSettingsCard() {
  const { dispatch } = useStore();
  const view = useCloudPlan();
  if (!view) return null;
  if (buyOfferAllowed(view)) {
    return <section aria-label={t("pro.name")} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline/50 p-3">
      <div className="flex items-center gap-3">
        <Crown className="text-ink-secondary" size={18} aria-hidden="true" />
        <div><h3 className="text-[14px] font-semibold text-ink">{t("pro.name")}</h3>
          <p className="mt-1 text-[12px] text-ink-secondary">{t("pro.settingsSummary")}</p>
          <p className="mt-1 text-[12px] text-ink-secondary">{t("pro.fromPrice", { price: CLOUD_PERSONAL_PRICE })}</p></div>
      </div>
      <div className="flex flex-col items-end gap-1">
        {view.kind === "signed-out" && <SignInFirst onSignIn={() => dispatch(CLOUD_LINK_SETTINGS)} />}
        <div className="flex flex-wrap items-center gap-3"><PlansLink /><ProLink /></div>
      </div>
    </section>;
  }
  const line = cloudPlanLine(view);
  if (!line && view.kind !== "reauth") return null;
  return <section aria-label={t("settings.section.cloudAccount")} data-cloud-plan={view.kind} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline/50 p-3">
    <div className="flex items-center gap-3">
      <Cloud className="text-ink-secondary" size={18} aria-hidden="true" />
      <div><h3 className="text-[14px] font-semibold text-ink">{t("settings.section.cloudAccount")}</h3>
        <p className="mt-1 text-[12px] text-ink-secondary">{view.kind === "reauth" ? t("pro.reauthShort") : line}</p></div>
    </div>
    <button type="button" className="ui-button" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "cloudAccount" })}>{t("pro.openCloudSettings")}</button>
  </section>;
}

/** Live calls need a Pro plan (the harness's 402 `needsPro`): the Pro card,
 * in the call button's pop-up where the key form would be. The same rule as
 * the card in Settings: an offer only where buyOfferAllowed says (signed
 * out, signing in first); anyone who pays, may pay, or whose plan is not
 * known yet sees that plan, when there is one to name, and the way to it. A
 * window that cannot read the plan (a browser, a server's page) says only
 * what Live calls need. */
export function LiveProPrompt() {
  const { dispatch } = useStore();
  const view = useCloudPlan();
  const titleId = useId();
  const offer = view && buyOfferAllowed(view) ? view : null;
  const line = !view || offer ? null : view.kind === "reauth" ? t("pro.reauthShort") : cloudPlanLine(view);
  return <section aria-labelledby={titleId} data-cloud-plan={view?.kind} className="flex flex-col gap-2.5 rounded-xl border border-hairline bg-panel p-4 text-left">
    <div className="flex items-center gap-2.5">
      <Crown size={16} className="shrink-0 text-ink-secondary" aria-hidden="true" />
      <h2 id={titleId} className="text-[13.5px] font-medium text-ink">{t("call.live.proTitle")}</h2>
    </div>
    <p className="text-[12.5px] leading-[1.45] text-ink-secondary">{t("call.live.proExplain")}</p>
    {offer ? <>
      {offer.kind === "signed-out" && <SignInFirst onSignIn={() => dispatch(CLOUD_LINK_SETTINGS)} />}
      <p className="text-[12px] text-ink-secondary">{t("pro.fromPrice", { price: CLOUD_PERSONAL_PRICE })}</p>
      <div className="flex flex-wrap items-center gap-3"><ProLink /><PlansLink /></div>
    </> : view && <>
      {line && <p className="text-[12.5px] text-ink">{line}</p>}
      <button type="button" className="ui-button self-start" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "cloudAccount" })}>{t("pro.openCloudSettings")}</button>
    </>}
  </section>;
}

export function ProIntroductionCard({ onDismiss, onSignIn }: { onDismiss: () => void; onSignIn?: () => void }) {
  return <aside aria-labelledby="pro-introduction-title" onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onDismiss(); }
  }} className="fixed bottom-4 left-4 z-40 max-h-[calc(100dvh-32px)] w-[300px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-xl border border-hairline/40 bg-panel p-3.5 text-ink shadow-2xl shadow-black/20">
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <Crown size={16} className="text-ink-secondary" aria-hidden="true" />
        <h2 id="pro-introduction-title" className="text-[13.5px] font-semibold">{t("pro.name")}</h2>
      </div>
      <button type="button" onClick={onDismiss} aria-label={t("pro.dismiss")} className="ui-icon-button"><X size={16} /></button>
    </div>
    <p className="mt-1 text-[12.5px] text-ink-secondary">{t("pro.headline")}</p>
    <ul className="my-3 space-y-2 text-[12.5px]">
      <li className="flex items-center gap-2.5"><Sparkles size={17} className="shrink-0 text-ink-secondary" aria-hidden="true" />{t("pro.priority")}</li>
      <li className="flex items-center gap-2.5"><Cloud size={17} className="shrink-0 text-ink-secondary" aria-hidden="true" />{t("pro.alwaysOn")}</li>
      <li className="flex items-center gap-2.5"><Monitor size={17} className="shrink-0 text-ink-secondary" aria-hidden="true" />{t("pro.computers")}</li>
      <li className="flex items-center gap-2.5"><CalendarClock size={17} className="shrink-0 text-ink-secondary" aria-hidden="true" />{t("pro.schedule")}</li>
    </ul>
    <p className="text-[12.5px]">{t("pro.launchPrice", { price: PRO_LAUNCH_PRICE, laterPrice: PRO_LATER_PRICE })}</p>
    <p className="mt-1 text-[12px] text-ink-secondary">{t("pro.otherPlans", { personal: CLOUD_PERSONAL_PRICE, max: CLOUD_MAX_PRICE })}</p>
    <p className="mb-3 mt-1 text-[11.5px] text-ink-secondary">{t("pro.tax")}</p>
    {onSignIn && <div className="mb-2"><SignInFirst onSignIn={onSignIn} /></div>}
    <div className="flex flex-wrap items-center gap-3">
      <ProLink onOpened={onDismiss} />
      <PlansLink />
      <button type="button" className="py-2 text-[12px] text-ink-secondary hover:text-ink" onClick={onDismiss}>{t("pro.noThanks")}</button>
    </div>
    <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary">{t("pro.disclaimer")}</p>
  </aside>;
}

export function ProIntroduction({ quiet = false }: { quiet?: boolean }) {
  const { state, dispatch } = useStore();
  const view = useCloudPlan();
  const available = view !== null && buyOfferAllowed(view);
  const updater = useUpdaterState();
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(PRO_DISMISSED) === "1"; } catch { return false; }
  });
  // "Sign in" hides the card for now, not for good: signed in with a plan, it never returns anyway.
  const [signingIn, setSigningIn] = useState(false);
  const record = state.config?.onboarding;
  const busy = state.bots.some(bot => bot.busy || bot.tasks?.some(task => task.busy))
    || state.groups.some(group => group.working || group.busyBotId);
  const setup = state.welcomeOpen || state.tourOpen || (Boolean(record?.completedAt) && currentStep(record) !== null)
    || welcomeDue(state.config, { remoteClient: false, legacyDone: emailGateDone() });
  if (!available || dismissed || signingIn || hintSeen(record, PRO_DISMISSED) || !state.connected || !state.config || setup || busy || quiet
    || state.appSettingsOpen || state.settingsOpen || state.newBotOpen || state.pluginsOpen || state.triggersOpen || state.shortcutsOpen
    || (updater && !["idle", "checking"].includes(updater.status))) return null;

  const dismiss = () => {
    setDismissed(true);
    // Immediate device fallback plus the existing durable workspace hint record.
    // No expiry, version comparison, or marketing reminder timer.
    try { localStorage.setItem(PRO_DISMISSED, "1"); } catch { /* Workspace persistence remains available. */ }
    const patch = hintSeenPatch(record, PRO_DISMISSED);
    if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) })
      .then(config => dispatch({ type: "configStatus", config })).catch(() => {});
  };
  return <ProIntroductionCard onDismiss={dismiss} onSignIn={view.kind === "signed-out" ? () => { setSigningIn(true); dispatch(CLOUD_LINK_SETTINGS); } : undefined} />;
}
