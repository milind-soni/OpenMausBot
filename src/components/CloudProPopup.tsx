import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import type { CloudAccountState, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
import type { DesktopNoticesBridge, DesktopNoticesState } from "../../electron/desktop-prefs.mjs";
import { analyticsChoiceKnown, identifyEmail, track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { buyOfferAllowed, cloudIntroView, cloudPlanLabel, cloudPlanLine, cloudPlanView, moneyBackLine, trialRunning, usd, type CloudPlanView, type CloudSource } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { cloudPlanFromAccount, cloudPlanFromSnapshot, type CloudPlanFacts } from "@/lib/usage-snapshot";
import { NightCard } from "./cloud-buy/NightCard";
import { CLOSE, ON_NIGHT, PRIMARY, QUIET, SHEET, Tag, TAG_ON_NIGHT } from "./cloud-buy/parts";
import { NotNowButton } from "./NoticeCard";
import { UPDATES_CONSENT_POPUP } from "./UpdatesConsent";

export const CLOUD_PRO_POPUP_SOURCE = "update_popup" satisfies CloudSource;

export type CloudProPopupAction = "shown" | "upgrade" | "manage" | "see_plans" | "not_now" | "close";
/** Where an event is counted: This computer's page or My Cloud's own page. */
export type CloudProPopupPage = "local" | "my_cloud";

export interface CloudProPopupView {
  /** Never a checkout, never the browser: the Add a Cloud dialog, or Settings → MausBot Cloud on the page it shows on. */
  primary: { label: string; via: "add-cloud" | "settings" };
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
const manageView = (who: Who, current: string | null): CloudProPopupView =>
  ({ ...who, primary: { via: "settings", label: t("cloudProPopup.manage") }, seePlans: false, badge: null, points: included(), price: null, moneyBack: null, current });

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
  // Every plan manages in the app. Personal → Pro is not self-serve yet, so no "Upgrade" that ends at "email us".
  return manageView(who, view.kind === "reauth" ? t("pro.reauthShort") : cloudPlanLine(view));
}

function snapshotPlanView(snapshot: CloudPlanSnapshot): CloudPlanView | null {
  const label = snapshot.tier === undefined ? null : cloudPlanLabel(snapshot.tier);
  if (snapshot.status === "paid") return { kind: "paid", label: cloudPlanLabel(snapshot.tier), checking: false, ...(trialRunning(snapshot.trial) ? { trial: true as const } : {}) };
  if (snapshot.status === "attention") return { kind: "attention", label };
  if (snapshot.status === "signin") return { kind: "reauth", label, reason: "expired" };
  return null;
}

/** My Cloud's own page, from the plan main tells that page: a plan manages in that page's Settings, one being checked
 * waits, and with none read there is nothing to say. */
export function cloudProCloudPageView(snapshot: CloudPlanSnapshot | null): CloudProPopupView | "loading" | "offline" {
  if (!snapshot) return "loading";
  if (snapshot.status === "checking") return "offline";
  const view = snapshotPlanView(snapshot);
  if (!view) return "offline";
  const facts = cloudPlanFromSnapshot(snapshot);
  return manageView({ plan: facts.trial ? "trial" : facts.plan, signedIn: view.kind !== "reauth", email: null },
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

export function reportCloudProPopup(action: CloudProPopupAction, who: Who, page: CloudProPopupPage) {
  if (who.email && CLICKS.has(action) && analyticsChoiceKnown()) identifyEmail(who.email);
  track("cloud_pro_popup", { action, plan: who.plan, signed_in: who.signedIn, page });
}

const TITLE = "cloud-pro-popup-title";
const POPUP = "[data-cloud-pro-popup]";
const OTHER_DIALOGS = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-tour-card], [data-cloud-setup-ready]';

/** Any dialog on screen counts, modal or not, and the card that says a new Cloud is set up; never the queue's own popups. */
export function otherDialogOpen(): boolean {
  return [...document.querySelectorAll<HTMLElement>(OTHER_DIALOGS)].some(element => !element.closest(`${POPUP}, ${UPDATES_CONSENT_POPUP}, [data-simple-mode-prompt]`) && element.checkVisibility());
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

export function CloudProPopup({ view, onPrimary, onSeePlans, onNotNow, onClose }: {
  view: CloudProPopupView; onPrimary: () => void; onSeePlans: () => void; onNotNow: () => void; onClose: () => void;
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
  return <div className="ui-scrim fixed inset-0 z-50 flex items-center justify-center p-6" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-labelledby={TITLE} aria-describedby="cloud-pro-popup-body" data-cloud-pro-popup={view.plan} tabIndex={-1}
      className={cn(SHEET, "group/sheet animate-pop-in relative max-h-full w-full max-w-[440px] overflow-y-auto px-6 pb-4 pt-5 outline-none")}>
      <div className="-mx-4 -mt-3">
        <NightCard small>
          <h2 id={TITLE} tabIndex={-1} className="text-[17px] font-medium leading-6 tracking-[-0.008em] outline-none!">{t("cloudProPopup.title")}</h2>
          {view.badge && <Tag className={cn("mt-1.5 self-start", TAG_ON_NIGHT)}>{view.badge}</Tag>}
        </NightCard>
      </div>
      <div id="cloud-pro-popup-body" className="mt-4 flex flex-col gap-4">
        <p className="text-[14px] leading-5 text-ink-secondary [text-wrap:pretty]">{t("cloudIntro.body")}</p>
        <ul className="flex flex-col gap-2 text-[14px] leading-5">
          {view.points.map(point => <li key={point} className="flex items-start gap-2.5"><Check size={16} strokeWidth={1.5} className="mt-0.5 shrink-0 text-ink-tertiary" aria-hidden="true" />{point}</li>)}
        </ul>
        {view.current && <p className="text-[14px] font-medium leading-5">{view.current}</p>}
        {(view.price || view.moneyBack) && <p className="flex flex-col text-[13px] leading-[18px] text-ink-secondary">
          {view.price && <span>{view.price}</span>}{view.moneyBack && <span>{view.moneyBack}</span>}
        </p>}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button type="button" className={cn(PRIMARY, "ui-button-lg")} onClick={onPrimary}>{view.primary.label}</button>
        {view.seePlans && <button type="button" className={cn(QUIET, "ui-button-lg")} onClick={onSeePlans}>{t("pro.seePlans")}</button>}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 border-t-[0.5px] border-ink/10 pt-2">
        <p className="min-w-0 flex-1 text-[12px] leading-4 text-ink-tertiary">{t("pro.disclaimer")}</p>
        <NotNowButton onClick={onNotNow} />
      </div>
      <button type="button" onClick={onClose} aria-label={t("cloudAdd.close")} className={cn(CLOSE, ON_NIGHT, "absolute end-4 top-4")}><X size={16} /></button>
    </div>
  </div>;
}
