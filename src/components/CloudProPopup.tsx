import { useEffect, useState } from "react";
import { Check, Crown, X } from "lucide-react";
import type { CloudAccountBridge, CloudAccountState, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
import type { DesktopHandoffIntent, DesktopNoticesBridge, DesktopNoticesState } from "../../electron/desktop-prefs.mjs";
import { analyticsChoiceKnown, identifyEmail, track } from "@/lib/analytics";
import { buyOfferAllowed, cloudIntroView, cloudPlanLabel, cloudPlanLine, cloudPlanView, moneyBackLine, trialRunning, usd, type CloudPlanView, type CloudSource } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { cloudPlanFromAccount, cloudPlanFromSnapshot, type CloudPlanFacts } from "@/lib/usage-snapshot";
import type { Action } from "@/state/store";
import { NotNowButton } from "./NoticeCard";

export const CLOUD_PRO_POPUP_SOURCE = "update_popup" satisfies CloudSource;

/** `continue`: a server's page's main button, which switches the window to This computer. */
export type CloudProPopupAction = "shown" | "upgrade" | "manage" | "see_plans" | "continue" | "not_now" | "close";
/** Where an event is counted: This computer's page, My Cloud's own page or another saved server's. */
export type CloudProPopupPage = "local" | "my_cloud" | "server";

export interface CloudProPopupView {
  /** Never a checkout, never the browser: the Add a Cloud dialog or Settings → MausBot Cloud on this computer's page; on a
   * server's page, This computer, whose page finishes the click without showing the popup: My Cloud's Manage plan in
   * Settings → MausBot Cloud, and Continue on this computer as its own popup's main button would for the plan it knows. */
  primary: { label: string; via: "add-cloud" | "settings" | "settings-on-this-computer" | "this-computer" };
  /** Compare plans, for someone who can buy: the dialog lists every plan. A payer has nothing to compare there yet. */
  seePlans: boolean;
  plan: CloudPlanFacts["plan"] | "trial";
  signedIn: boolean;
  email: string | null;
  badge: string | null;
  points: string[];
  price: string | null;
  moneyBack: string | null;
  current: string | null;
}

type Who = Pick<CloudProPopupView, "plan" | "signedIn" | "email">;

export function cloudProPopupWho(account: CloudAccountState | null): Who {
  const facts = cloudPlanFromAccount(account);
  const signedIn = account?.status === "connected";
  return { plan: facts.trial ? "trial" : facts.plan, signedIn, email: signedIn ? account?.account?.email ?? null : null };
}

const included = () => [t("cloudIntro.routines"), t("cloudIntro.phone"), t("cloudIntro.included")];
const manageView = (who: Who, via: "settings" | "settings-on-this-computer", current: string | null): CloudProPopupView =>
  ({ ...who, primary: { via, label: t("cloudProPopup.manage") }, seePlans: false, badge: null, points: included(), price: null, moneyBack: null, current });

/** This computer's page. */
export function cloudProPopupView(account: CloudAccountState | null, offer: CloudOffer | null | undefined): CloudProPopupView | "loading" | "offline" {
  const view = cloudPlanView(account);
  if (view.kind === "unknown" || view.kind === "connecting") return "loading";
  if (view.kind === "unverified") return "offline";
  const who = cloudProPopupWho(account);
  if (buyOfferAllowed(view)) {
    if (offer === undefined) return "loading";
    if (offer === null) return "offline";
    const intro = cloudIntroView(offer);
    return {
      ...who,
      primary: { via: "add-cloud", label: t(intro ? "cloudIntro.start" : "cloudProPopup.upgrade") },
      seePlans: true,
      badge: intro?.badge ?? null,
      points: intro?.points ?? included(),
      price: intro?.price ?? t("pro.fromPrice", { price: usd(Math.min(...offer.plans.map(plan => plan.amount)) / 100) }),
      moneyBack: moneyBackLine(offer),
      current: null,
    };
  }
  return manageView(who, "settings", view.kind === "reauth" ? t("pro.reauthShort") : cloudPlanLine(view));
}

/** A saved server's page is told nothing about the plan, so it offers no plan, price or Compare plans. */
export function cloudProElsewhereView(): CloudProPopupView {
  return { plan: "unknown", signedIn: false, email: null, primary: { via: "this-computer", label: t("cloudProPopup.thisComputer") }, seePlans: false,
    badge: null, points: included(), price: null, moneyBack: null, current: null };
}

function snapshotPlanView(snapshot: CloudPlanSnapshot): CloudPlanView | null {
  const label = snapshot.tier === undefined ? null : cloudPlanLabel(snapshot.tier);
  if (snapshot.status === "paid") return { kind: "paid", label: cloudPlanLabel(snapshot.tier), checking: false, ...(trialRunning(snapshot.trial) ? { trial: true as const } : {}) };
  if (snapshot.status === "attention") return { kind: "attention", label };
  if (snapshot.status === "signin") return { kind: "reauth", label, reason: "expired" };
  return null;
}

/** My Cloud's own page, from the plan main tells that page: a plan manages in Settings on This computer, one being
 * checked waits, and with none read it is as on a saved server. */
export function cloudProCloudPageView(snapshot: CloudPlanSnapshot | null): CloudProPopupView | "loading" | "offline" {
  if (!snapshot) return "loading";
  if (snapshot.status === "checking") return "offline";
  const view = snapshotPlanView(snapshot);
  if (!view) return cloudProElsewhereView();
  const facts = cloudPlanFromSnapshot(snapshot);
  return manageView({ plan: facts.trial ? "trial" : facts.plan, signedIn: view.kind !== "reauth", email: null }, "settings-on-this-computer",
    view.kind === "reauth" ? t("pro.reauthShort") : cloudPlanLine(view));
}

/** null until main answers; a page main refuses has nothing due. */
export function useDesktopNotices(desktop: DesktopNoticesBridge | undefined): DesktopNoticesState | null {
  const [answer, setAnswer] = useState<DesktopNoticesState | null>(null);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void desktop.state().then(next => { if (active) setAnswer(next); }, () => { if (active) setAnswer({ seen: [], cloud: false }); });
    return () => { active = false; };
  }, [desktop]);
  return desktop ? answer : null;
}

const CLICKS: ReadonlySet<CloudProPopupAction> = new Set(["upgrade", "manage", "see_plans"]);

/** `via`: the page whose click This computer's page finishes. */
export function reportCloudProPopup(action: CloudProPopupAction, who: Who, page: CloudProPopupPage, via?: CloudProHandoff["via"]) {
  if (who.email && CLICKS.has(action) && analyticsChoiceKnown()) identifyEmail(who.email, { submitted: false });
  track("cloud_pro_popup", { action, plan: who.plan, signed_in: who.signedIn, page, ...(via ? { via } : {}) });
}

/** The popup's click another page of the window made, which main switched the window to This computer for. */
export interface CloudProHandoff {
  intent: DesktopHandoffIntent;
  via: "my_cloud" | "server";
}

const HANDOFF_SETTINGS = new Map<string | null, DesktopHandoffIntent>([["cloud-add", "cloud-pro"], ["cloud-settings", "manage"]]);

/** Read off the address main loaded This computer's page at, and removed from it. */
export function takeCloudProHandoff(url: URL): CloudProHandoff | null {
  const intent = HANDOFF_SETTINGS.get(url.searchParams.get("desktop-settings"));
  if (!intent) return null;
  const source = url.searchParams.get("source"), via = url.searchParams.get("via");
  url.searchParams.delete("source"); url.searchParams.delete("via");
  return source === CLOUD_PRO_POPUP_SOURCE && (via === "my_cloud" || via === "server") ? { intent, via } : null;
}

export const CLOUD_PRO_HANDOFF_WAIT_MS = 10_000;
const CLOUD_SETTINGS = { type: "toggleAppSettings", open: true, section: "cloudAccount" } as const;
const UNSETTLED: ReadonlySet<CloudPlanView["kind"]> = new Set(["unknown", "connecting", "unverified"]);

/**
 * Finished on This computer's page at once, whatever else is on it: Manage plan opens Settings → MausBot Cloud; Continue
 * on this computer opens the Add a Cloud dialog for someone who can buy and Settings → MausBot Cloud for anyone else. A
 * sign-in still restoring or connecting, or a plan that cannot be checked right now, is waited on for `wait` at most,
 * then it is Settings, which says where it stands.
 */
export function finishCloudProHandoff({ intent, via }: CloudProHandoff, bridge: Pick<CloudAccountBridge, "state" | "onState">,
  dispatch: (action: Action) => void, wait = CLOUD_PRO_HANDOFF_WAIT_MS) {
  if (intent === "manage") dispatch(CLOUD_SETTINGS);
  let account: CloudAccountState | null = null, done = false, unsubscribe = () => {};
  const finish = () => {
    if (done) return;
    done = true; clearTimeout(timer); unsubscribe();
    const buying = intent === "cloud-pro" && buyOfferAllowed(cloudPlanView(account));
    reportCloudProPopup(buying ? "upgrade" : "manage", cloudProPopupWho(account), "local", via);
    if (intent === "cloud-pro") dispatch(buying ? { type: "openCloudAdd", source: CLOUD_PRO_POPUP_SOURCE } : CLOUD_SETTINGS);
  };
  const read = (next: CloudAccountState) => {
    account = next;
    if (!UNSETTLED.has(cloudPlanView(next).kind)) finish();
  };
  const timer = setTimeout(finish, wait);
  unsubscribe = bridge.onState(read);
  if (done) unsubscribe();
  void bridge.state().then(next => { if (!account) read(next); }, finish);
}

const TITLE = "cloud-pro-popup-title";
const POPUP = "[data-cloud-pro-popup]";
const OTHER_DIALOGS = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-tour-card], [data-cloud-setup-ready]';

/** Any dialog on screen counts, modal or not, and the card that says a new Cloud is set up. */
export function otherDialogOpen(): boolean {
  return [...document.querySelectorAll<HTMLElement>(OTHER_DIALOGS)].some(element => !element.closest(POPUP) && element.checkVisibility());
}

export function useOtherDialogOpen(watch: boolean): boolean {
  const [, setOpen] = useState(false);
  useEffect(() => {
    if (!watch) return;
    const timer = setInterval(() => setOpen(otherDialogOpen()), 1_000);
    return () => clearInterval(timer);
  }, [watch]);
  return watch && otherDialogOpen();
}

const focusLost = (focus: Element | null) => !focus || focus === document.body || !focus.isConnected;

const PRIMARY = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[14px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** `switching`: main is switching the window for the main button; `refused`: it could not. */
export function CloudProPopup({ view, switching = false, refused = false, onPrimary, onSeePlans, onNotNow, onClose }: {
  view: CloudProPopupView; switching?: boolean; refused?: boolean; onPrimary: () => void; onSeePlans: () => void; onNotNow: () => void; onClose: () => void;
}) {
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null, popup = document.querySelector(POPUP);
    document.getElementById(TITLE)?.focus();
    return () => {
      const focus = document.activeElement;
      if ((focusLost(focus) || popup?.contains(focus)) && opener?.isConnected && opener !== document.body) opener.focus();
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const popup = document.querySelector(POPUP), focus = document.activeElement, inside = Boolean(focus && popup?.contains(focus));
      if (event.key === "Escape") {
        if (!inside) return;
        event.preventDefault(); event.stopPropagation(); onClose();
        return;
      }
      if (event.key !== "Tab" || !(inside || focusLost(focus))) return;
      const controls = [...(popup?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
      if (!controls.length) return;
      event.preventDefault();
      const at = controls.indexOf(focus as HTMLElement), step = event.shiftKey ? -1 : 1;
      controls[at === -1 ? (step > 0 ? 0 : controls.length - 1) : (at + step + controls.length) % controls.length]!.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-labelledby={TITLE} aria-describedby="cloud-pro-popup-body" data-cloud-pro-popup={view.plan} tabIndex={-1}
      className="relative max-h-full w-full max-w-[440px] overflow-y-auto rounded-2xl border border-hairline/50 bg-panel p-6 text-ink shadow-2xl outline-none">
      <div className="flex items-center gap-2.5 pe-8">
        <Crown size={18} className="shrink-0 text-accent-text" aria-hidden="true" />
        <h2 id={TITLE} tabIndex={-1} className="text-[17px] font-semibold outline-none">{t("cloudProPopup.title")}</h2>
      </div>
      {view.badge && <p className="mt-3 inline-flex rounded-full bg-accent/15 px-2 py-0.5 text-[12px] font-medium text-accent-text">{view.badge}</p>}
      <div id="cloud-pro-popup-body">
        <p className="mt-3 text-[13.5px] leading-relaxed text-ink-secondary">{t("cloudIntro.body")}</p>
        <ul className="mt-3 flex flex-col gap-2 text-[13px]">
          {view.points.map(point => <li key={point} className="flex items-start gap-2"><Check size={15} className="mt-0.5 shrink-0 text-ink-secondary" aria-hidden="true" />{point}</li>)}
        </ul>
        {view.current && <p className="mt-3 text-[13px] font-medium">{view.current}</p>}
        {view.price && <p className="mt-3 text-[12.5px] text-ink-secondary">{view.price}</p>}
        {view.moneyBack && <p className="text-[12.5px] text-ink-secondary">{view.moneyBack}</p>}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" className={PRIMARY} onClick={onPrimary} disabled={switching} aria-busy={switching || undefined}>{view.primary.label}</button>
        {view.seePlans && <button type="button" className="inline-flex items-center gap-1 py-2 text-[13px] text-ink-secondary underline underline-offset-2 hover:text-ink" onClick={onSeePlans}>
          {t("pro.seePlans")}
        </button>}
      </div>
      {refused && <p role="alert" className="mt-3 text-[12.5px] text-ink-secondary">{t("cloudProPopup.refused")}</p>}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[11.5px] text-ink-secondary">{t("pro.disclaimer")}</p>
        <NotNowButton onClick={onNotNow} />
      </div>
      <button type="button" onClick={onClose} aria-label={t("cloudAdd.close")} className="ui-icon-button absolute end-4 top-4"><X size={16} /></button>
    </div>
  </div>;
}
