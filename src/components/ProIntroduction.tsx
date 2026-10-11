// The Cloud card in Settings → General: OpenMausBot Cloud for someone who may
// buy (what it does, the Admin's lowest price and money-back, Start free
// trial or Add a Cloud, which open the Add a Cloud dialog), or, for someone
// with a plan, that plan and the way to it. The card after the update is the
// notice queue's (AppNotices, CloudTrialIntro).
import { useEffect, useState } from "react";
import { Cloud, Crown } from "lucide-react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { CLOUD_LINK_SETTINGS, useStore } from "@/state/store";
import { openExternalLink, PRICING_URL, withSource } from "@/lib/app-links";
import { buyOfferAllowed, cloudPlanLine, cloudPlanView, moneyBackLine, offerTrialDays, usd, type CloudPlanView } from "@/lib/cloud-plan";
import { useCloudOffer } from "@/lib/use-cloud-offer";
import { t } from "@/lib/i18n";

/** Only someone signed out, or verified as signed in with no plan, no Cloud
 * and no payment being linked, is ever offered a plan (src/lib/cloud-plan.ts). */
export function proOfferAvailable(account: CloudAccountState | null): boolean {
  return buyOfferAllowed(cloudPlanView(account));
}

/** The plan as the native snapshot says; null without a bridge (a browser, a remote page). */
export function useCloudPlan(): { view: CloudPlanView; account: CloudAccountState | null } | null {
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
  return bridge ? { view: cloudPlanView(account), account } : null;
}

/** Always available in Settings. Someone with a plan (or one being linked,
 * or one this app cannot check right now) sees that plan here instead, and
 * the way to it. */
export function ProSettingsCard() {
  const { dispatch } = useStore();
  const plan = useCloudPlan();
  const offering = plan !== null && buyOfferAllowed(plan.view);
  const offer = useCloudOffer(offering, plan?.account?.offer);
  if (!plan) return null;
  const { view } = plan;
  if (offering) {
    const trial = offerTrialDays(offer) !== null, moneyBack = moneyBackLine(offer);
    const cheapest = offer ? Math.min(...offer.plans.map(entry => entry.amount)) : null;
    return <section aria-label={t("pro.name")} data-cloud-offer={trial ? "trial" : offer ? "plans" : "none"} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline/50 p-3">
      <div className="flex items-center gap-3">
        <Crown className="text-ink-secondary" size={18} aria-hidden="true" />
        <div><h3 className="text-[14px] font-semibold text-ink">{t("pro.name")}</h3>
          <p className="mt-1 text-[12px] text-ink-secondary">{t("pro.settingsSummary")}</p>
          {cheapest !== null && <p className="mt-1 text-[12px] text-ink-secondary">{t("pro.fromPrice", { price: usd(cheapest / 100) })}</p>}
          {moneyBack && <p className="mt-1 text-[12px] text-ink-secondary">{moneyBack}</p>}
          <p className="mt-1 text-[11.5px] text-ink-secondary">{t("pro.disclaimer")}</p></div>
      </div>
      <div className="flex flex-col items-end gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="cursor-pointer text-[12.5px] text-ink-secondary underline underline-offset-2 hover:text-ink"
            onClick={() => void openExternalLink(withSource(PRICING_URL, "app_settings")).catch(() => {})}>{t("pro.seePlans")}</button>
          <button type="button" className="ui-button" onClick={() => dispatch({ type: "openCloudAdd", source: "app_settings" })}>{t(trial ? "cloudIntro.start" : "cloudAccount.upgrade")}</button>
        </div>
        {view.kind === "signed-out" && <button type="button" className="cursor-pointer text-[12.5px] font-medium text-accent-text underline underline-offset-2 hover:text-ink"
          onClick={() => dispatch(CLOUD_LINK_SETTINGS)}>{t("cloudAccount.signIn")}</button>}
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
