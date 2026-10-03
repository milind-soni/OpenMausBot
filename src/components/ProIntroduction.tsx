// The Pro plans card (one of the one-time notices, src/lib/notices.ts) and
// its permanent place in Settings.
import { useEffect, useState } from "react";
import { CalendarClock, Cloud, Crown, Monitor, Sparkles } from "lucide-react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { CLOUD_LINK_SETTINGS, useStore } from "@/state/store";
import { PRO_URL } from "@/lib/app-links";
import { buyOfferAllowed, cloudPlanLine, cloudPlanView, type CloudPlanView } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { LinkButton, NoticeCard, NotNowButton } from "./NoticeCard";

/** The OMB Cloud plans, monthly, as on the website. Every price is plus
 * applicable tax, and none is ever shown as a struck-through or "was" price. */
export const CLOUD_PERSONAL_PRICE = "$29";
export const CLOUD_PRO_PRICE = "$49";
export const CLOUD_MAX_PRICE = "$99";

/** The plan as the native snapshot says; null without a bridge (a browser,
 * a remote page, a Cloud guest): the notices are for the desktop app only. */
export function useCloudPlan(): CloudPlanView | null {
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

/** Opens the plans on the website. */
export function ProLink({ onOpened }: { onOpened?: () => void }) {
  return <LinkButton url={PRO_URL} label={t("pro.getTeam")} onOpened={onOpened} />;
}

/** Always available in Settings, independent of the introduction's dismissal.
 * Someone with a plan (or one being linked, or one this app cannot check
 * right now) sees that plan here instead, and the way to it. */
export function ProSettingsCard() {
  const { dispatch } = useStore();
  const view = useCloudPlan();
  if (!view) return null;
  if (buyOfferAllowed(view)) {
    return <section aria-label={t("pro.title")} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline/50 p-3">
      <div className="flex items-center gap-3">
        <Crown className="text-ink-secondary" size={18} aria-hidden="true" />
        <div><h3 className="text-[14px] font-semibold text-ink">{t("pro.title")}</h3>
          <p className="mt-1 text-[12px] text-ink-secondary">{t("pro.summary")}</p>
          <p className="mt-1 text-[12px] text-ink-secondary">{t("pro.fromPrice", { price: CLOUD_PERSONAL_PRICE })}</p></div>
      </div>
      <div className="flex flex-col items-end gap-1">
        {view.kind === "signed-out" && <SignInFirst onSignIn={() => dispatch(CLOUD_LINK_SETTINGS)} />}
        <ProLink />
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

const BULLET = "flex items-start gap-2.5";
const BULLET_ICON = "mt-px shrink-0 text-ink-secondary";

export function ProIntroductionCard({ onDismiss, onSignIn }: { onDismiss: () => void; onSignIn?: () => void }) {
  return <NoticeCard titleId="pro-introduction-title" icon={Crown} title={t("pro.title")} onDismiss={onDismiss}>
    <p className="mt-1 text-[12.5px] text-ink-secondary">{t("pro.summary")}</p>
    <ul className="my-3 space-y-2 text-[12.5px]">
      <li className={BULLET}><Cloud size={17} className={BULLET_ICON} aria-hidden="true" />{t("pro.alwaysOn")}</li>
      <li className={BULLET}><Monitor size={17} className={BULLET_ICON} aria-hidden="true" />{t("pro.computers")}</li>
      <li className={BULLET}><CalendarClock size={17} className={BULLET_ICON} aria-hidden="true" />{t("pro.included")}</li>
      <li className={BULLET}><Sparkles size={17} className={BULLET_ICON} aria-hidden="true" />{t("pro.priority")}</li>
    </ul>
    <p className="text-[12.5px]">{t("pro.prices", { personal: CLOUD_PERSONAL_PRICE, pro: CLOUD_PRO_PRICE, max: CLOUD_MAX_PRICE })}</p>
    <p className="mb-3 mt-1 text-[11.5px] text-ink-secondary">{t("pro.tax")}</p>
    {onSignIn && <div className="mb-2"><SignInFirst onSignIn={onSignIn} /></div>}
    <div className="flex flex-wrap items-center gap-3">
      <ProLink onOpened={onDismiss} />
      <NotNowButton onClick={onDismiss} />
    </div>
    <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary">{t("pro.disclaimer")}</p>
  </NoticeCard>;
}
