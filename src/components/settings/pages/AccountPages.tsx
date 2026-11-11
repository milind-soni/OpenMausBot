import { t } from "@/lib/i18n";
import { CLOUD_PLAN_URL } from "@/lib/app-links";
import { productName } from "@/lib/brand";
import { usePlaces } from "@/lib/places";
import { useStore } from "@/state/store";
import { CloudAccountSettings } from "../../CloudAccountSettings";
import { CloudUsageDetails, useCloudUsageSettings, CloudUsageSettingsView } from "../../CloudUsageMeter";
import { OrganizationSettings } from "../../OrganizationSettings";
import { SettingRow, SettingsDisclosureRow, SettingsGroup, SettingsLinkRow, SettingsRows } from "../../SettingsPrimitives";
import { UpdatesConsentRow } from "../../UpdatesConsent";
import { useState } from "react";
import { useYou } from "../account-summary";
import { useSettingsShell } from "../settings-shell";
import { PlaceBadge } from "../SettingsNav";
import { profileLabel } from "../../SidebarProfileMenu";

/** Opens This computer on the window's rail (a Cloud's page can't reach this computer's own settings). */
export function useSwitchToComputer(): { name: string; open: () => void } | null {
  const { places } = usePlaces();
  const computer = places.find((place) => place.kind === "computer" && !place.active);
  const open = window.ogb?.workspaces?.open;
  if (!computer || !open) return null;
  return { name: computer.name, open: () => void open(computer.id) };
}

export function AccountPage() {
  const { ctx, place, go } = useSettingsShell();
  const { state, dispatch } = useStore();
  const { profile } = useYou();
  const computer = useSwitchToComputer();
  const bridge = ctx.client ? undefined : window.ogb?.cloudAccount;
  return <>
    <SettingsGroup block="you">
      <SettingsRows>
        <SettingsLinkRow title={t("settings.account.nameRow")} value={profileLabel(profile)} badge={<PlaceBadge place={place} size={14} />}
          onClick={() => go("bots", "about-you")} data={{ "data-account-name-row": "" }} />
      </SettingsRows>
    </SettingsGroup>
    {bridge && <CloudAccountSettings part="account" advanced={ctx.advanced} linkRequest={state.appSettingsCloudLink}
      onSignIn={() => dispatch({ type: "openCloudAdd", source: "app_settings", signIn: true })} />}
    {!bridge && ctx.desktop && ctx.cloud && computer && (
      <SettingsGroup block="mausbot-account">
        <SettingsRows><SettingsLinkRow title={t("settings.account.fromHere", { place: computer.name })} external onClick={computer.open} /></SettingsRows>
      </SettingsGroup>
    )}
    {!ctx.desktop && (
      <SettingsGroup block="mausbot-account">
        <SettingsRows><SettingRow title={t("settings.account.signedInTo", { place: place.name })} subtitle={profile?.email}>{null}</SettingRow></SettingsRows>
      </SettingsGroup>
    )}
    {ctx.organization && (
      <SettingsGroup label={t("settings.section.organization")} block="organization" description={t("cloudAccount.separate")}>
        <OrganizationSettings />
      </SettingsGroup>
    )}
    {ctx.desktop && !ctx.client && window.ogb?.updatesConsent && (
      <SettingsGroup label={t("settings.account.emails", { app: productName() })} block="emails">
        <SettingsRows><UpdatesConsentRow /></SettingsRows>
      </SettingsGroup>
    )}
  </>;
}

export function PlanPage() {
  const { ctx } = useSettingsShell();
  const { state, dispatch } = useStore();
  const { usage, upgrade, dialog } = useCloudUsageSettings();
  const [limits, setLimits] = useState(false);
  if (!ctx.desktop) {
    return (
      <SettingsGroup block="plan">
        <SettingsRows>
          <SettingRow title={t("settings.plan.browserTitle")} subtitle={t("settings.plan.browserLine")}>
            <a className="ui-button" href={CLOUD_PLAN_URL} target="_blank" rel="noreferrer">{t("settings.plan.openBilling")}</a>
          </SettingRow>
        </SettingsRows>
      </SettingsGroup>
    );
  }
  return <>
    <CloudAccountSettings part="plan" advanced={ctx.advanced} cloudHome={ctx.cloud} teamHome={state.config?.team} linkRequest={state.appSettingsCloudLink}
      onAddCloud={() => dispatch({ type: "openCloudAdd", source: "app_settings" })}
      onSignIn={() => dispatch({ type: "openCloudAdd", source: "app_settings", signIn: true })} />
    {usage && (
      <div data-settings-block="this-week" className="flex flex-col gap-6">
        <CloudUsageSettingsView usage={usage} upgrade={upgrade}>{dialog}</CloudUsageSettingsView>
        <SettingsDisclosureRow id="plan-limits" title={t("settings.simple.billing.limits")} open={limits} onToggle={() => setLimits((open) => !open)}>
          <CloudUsageDetails usage={usage} upgrade={upgrade} />
        </SettingsDisclosureRow>
      </div>
    )}
  </>;
}
