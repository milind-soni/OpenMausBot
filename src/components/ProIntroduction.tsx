import { useEffect, useState } from "react";
import { Cloud, Crown } from "lucide-react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { useStore } from "@/state/store";
import { buyOfferAllowed, cloudPlanLine, cloudPlanView, moneyBackLine, offerTrialDays, usd, type CloudPlanView } from "@/lib/cloud-plan";
import { useCloudOffer } from "@/lib/use-cloud-offer";
import { t } from "@/lib/i18n";
import { SettingRow } from "./SettingsPrimitives";
import { UpgradeButton, type UpgradeUi } from "./CloudUsageMeter";
import type { CloudUsage } from "../../electron/cloud-home.mjs";

export function proOfferAvailable(account: CloudAccountState | null): boolean {
  return buyOfferAllowed(cloudPlanView(account));
}

export function useCloudPlan(): { view: CloudPlanView; account: CloudAccountState | null } | null {
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState(next => { updated = true; if (active) setAccount(next); });
    void bridge.state().then(next => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  return bridge ? { view: cloudPlanView(account), account } : null;
}

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
          <p className="mt-1 text-[12px] text-ink-secondary">{t("pro.disclaimer")}</p></div>
      </div>
      <div className="flex flex-col items-end gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="cursor-pointer text-[13px] text-ink-secondary underline underline-offset-2 hover:text-ink"
            onClick={() => dispatch({ type: "openCloudAdd", source: "app_settings" })}>{t("pro.seePlans")}</button>
          <button type="button" className="ui-button ui-button-primary" onClick={() => dispatch({ type: "openCloudAdd", source: "app_settings" })}>{t(trial ? "cloudIntro.start" : "cloudAccount.upgrade")}</button>
        </div>
        {view.kind === "signed-out" && <button type="button" className="cursor-pointer text-[13px] font-medium text-accent-text underline underline-offset-2 hover:text-ink"
          onClick={() => dispatch({ type: "openCloudAdd", source: "app_settings", signIn: true })}>{t("cloudAccount.signIn")}</button>}
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

export function CloudPlanRow({ place, usage = null, upgrade }: { place: "account" | "plan"; usage?: CloudUsage | null; upgrade?: UpgradeUi }) {
  const { dispatch } = useStore();
  const plan = useCloudPlan();
  const offering = plan !== null && buyOfferAllowed(plan.view);
  const offer = useCloudOffer(offering, plan?.account?.offer);
  if (!plan) return null;
  if (offering) {
    const trial = offerTrialDays(offer) !== null;
    const cheapest = offer && offer.plans.length ? Math.min(...offer.plans.map((entry) => entry.amount)) : null;
    return (
      <SettingRow title={t("pro.name")} subtitle={place === "plan" && cheapest !== null ? t("pro.fromPrice", { price: usd(cheapest / 100) }) : t("pro.settingsSummary")}>
        <div className="flex items-center gap-3">
          {place === "plan" && plan.view.kind === "signed-out" && (
            <button type="button" className="cursor-pointer text-[13px] text-ink-secondary hover:text-ink"
              onClick={() => dispatch({ type: "openCloudAdd", source: "app_settings", signIn: true })}>{t("cloudAccount.signIn")}</button>
          )}
          <button type="button" data-cloud-offer={trial ? "trial" : "plans"} className="ui-button ui-button-primary"
            onClick={() => dispatch({ type: "openCloudAdd", source: "app_settings" })}>{t(trial ? "cloudIntro.start" : "cloudAccount.upgrade")}</button>
        </div>
      </SettingRow>
    );
  }
  const line = plan.view.kind === "reauth" ? t("pro.reauthShort") : cloudPlanLine(plan.view);
  if (!line) return null;
  return (
    <SettingRow title={t("pro.name")} subtitle={line}>
      {place === "account" ? (
        <button type="button" data-cloud-plan={plan.view.kind} className="ui-button"
          onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "cloudAccount" })}>{t("settings.simple.account.manage")}</button>
      ) : usage && upgrade ? <UpgradeButton usage={usage} upgrade={upgrade} /> : null}
    </SettingRow>
  );
}

export function CloudPlanFootnote() {
  const plan = useCloudPlan();
  const offering = plan !== null && buyOfferAllowed(plan.view);
  const offer = useCloudOffer(offering, plan?.account?.offer);
  if (!offering) return null;
  return [t("pro.disclaimer"), moneyBackLine(offer)].filter(Boolean).join(" ");
}
