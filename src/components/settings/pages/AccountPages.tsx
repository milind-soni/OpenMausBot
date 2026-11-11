import { t } from "@/lib/i18n";
import { CLOUD_PLAN_URL } from "@/lib/app-links";
import { productName } from "@/lib/brand";
import { api, useStore } from "@/state/store";
import { InertRow, useSwitchToComputer } from "../inert";
import { CloudAccountSettings } from "../../CloudAccountSettings";
import { useCloudUsageSettings } from "../../CloudUsageMeter";
import { OrganizationSettings } from "../../OrganizationSettings";
import { SettingRow, SettingsGroup, SettingsLinkRow, SettingsRows } from "../../SettingsPrimitives";
import { UpdatesConsentRow } from "../../UpdatesConsent";
import { useAccountSummary, useYou } from "../account-summary";
import { useSettingsShell } from "../settings-shell";
import { profileLabel } from "../../SidebarProfileMenu";

export function AccountPage() {
  const { ctx, place, go } = useSettingsShell();
  const { state, dispatch } = useStore();
  const { profile, session } = useYou();
  const summary = useAccountSummary();
  const computer = useSwitchToComputer();
  const bridge = ctx.client ? undefined : window.ogb?.cloudAccount;
  // A Cloud's page in the desktop window: the account lives on This computer until main shares it (S2).
  const elsewhere = ctx.desktop && !ctx.client && !ctx.here && !bridge;
  const email = summary.email ?? (summary.plan ? profile?.email ?? null : null);
  const sheet = window.ogb?.accountSheet;
  return <>
    <SettingsGroup block="you">
      <SettingsRows>
        {elsewhere && computer.open
          ? <SettingsLinkRow title={t("settings.account.nameRow")} value={t("settings.account.onPlace", { place: computer.name })} external onClick={computer.open} data={{ "data-account-name-row": "" }} />
          : <SettingsLinkRow title={t("settings.account.nameRow")} value={profileLabel(profile)} onClick={() => go("bots", "about-you")} data={{ "data-account-name-row": "" }} />}
      </SettingsRows>
    </SettingsGroup>
    {bridge && <CloudAccountSettings part="account" advanced={ctx.advanced} linkRequest={state.appSettingsCloudLink}
      onSignIn={() => dispatch({ type: "openCloudAdd", source: "app_settings", signIn: true })} />}
    {elsewhere && (
      <SettingsGroup label={t("settings.account.mausbot", { app: productName() })} block="mausbot-account">
        <SettingsRows>
          <SettingRow title={email ?? t("settings.account.signedIn")} subtitle={summary.signedIn === false ? t("settings.account.notSignedIn") : t("settings.account.signedIn")}>{null}</SettingRow>
          {ctx.advanced && <InertRow title={t("organization.refresh")} control={<button type="button" className="settings-quiet" tabIndex={-1}>{t("organization.refresh")}</button>} />}
          {sheet && <SettingsLinkRow title={t("accounts.manage")} onClick={() => void sheet.open().catch(() => {})} data={{ "data-account-manage": "" }} />}
          {computer.open && <SettingsLinkRow title={t("settings.account.fromHere", { place: computer.name })} external onClick={computer.open} data={{ "data-account-elsewhere": "" }} />}
        </SettingsRows>
      </SettingsGroup>
    )}
    {!ctx.desktop && (
      <SettingsGroup block="mausbot-account">
        <SettingsRows>
          <SettingRow title={t("settings.account.signedInTo", { place: place.name })} subtitle={profile?.email}>{null}</SettingRow>
          {session?.kind === "session" && (
            <SettingRow title={t("settings.account.signOutBrowser")}>
              <button type="button" data-danger="" className="settings-quiet cursor-pointer" onClick={() => { void api("/api/auth/logout", { method: "POST" }).finally(() => location.reload()); }}>{t("settings.account.signOutShort")}</button>
            </SettingRow>
          )}
        </SettingsRows>
      </SettingsGroup>
    )}
    {ctx.organization && (
      <SettingsGroup label={t("settings.section.organization")} block="organization">
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
  if (!ctx.desktop) {
    return (
      <SettingsGroup block="plan">
        <SettingsRows>
          <SettingRow title={t("settings.plan.browserTitle")} subtitle={t("settings.plan.browserLine")}>
            <a className="ui-button ui-button-primary" href={CLOUD_PLAN_URL} target="_blank" rel="noreferrer">{t("settings.plan.openBilling")}</a>
          </SettingRow>
        </SettingsRows>
      </SettingsGroup>
    );
  }
  return <>
    <CloudAccountSettings part="plan" advanced={ctx.advanced} cloudHome={ctx.cloud} teamHome={state.config?.team} linkRequest={state.appSettingsCloudLink}
      usage={usage} upgrade={upgrade}
      onAddCloud={() => dispatch({ type: "openCloudAdd", source: "app_settings" })}
      onSignIn={() => dispatch({ type: "openCloudAdd", source: "app_settings", signIn: true })} />
    {dialog}
  </>;
}
