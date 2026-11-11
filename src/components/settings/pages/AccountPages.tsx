import { t } from "@/lib/i18n";
import { CLOUD_PLAN_URL } from "@/lib/app-links";
import { productName } from "@/lib/brand";
import { api, useStore } from "@/state/store";
import { useState } from "react";
import { InertReason, InertRow, useSwitchToComputer } from "../inert";
import { PlaceBadge, YouAvatar } from "../SettingsNav";
import { SignOutConfirm } from "../SignOutConfirm";
import { CloudAccountSettings } from "../../CloudAccountSettings";
import { useCloudUsageSettings } from "../../CloudUsageMeter";
import { OrganizationSettings } from "../../OrganizationSettings";
import { SettingRow, SettingsGroup, SettingsLinkRow, SettingsRows } from "../../SettingsPrimitives";
import { UpdatesConsentRow } from "../../UpdatesConsent";
import { useAccountSummary, useYou } from "../account-summary";
import { useSettingsShell } from "../settings-shell";
import { SpentRow } from "../plan-parts";
import { profileLabel } from "../../SidebarProfileMenu";

export function AccountPage() {
  const { ctx, place, go } = useSettingsShell();
  const { state, dispatch } = useStore();
  const { profile, session } = useYou();
  const summary = useAccountSummary();
  const computer = useSwitchToComputer();
  const [signingOut, setSigningOut] = useState(false);
  const bridge = ctx.client ? undefined : window.ogb?.cloudAccount;
  // A Cloud's page in the desktop window that isn't the app's home: the account lives on This computer until main
  // shares it (S2). The same `home` decides This app's rows, so the two never disagree.
  const elsewhere = ctx.desktop && !ctx.client && !ctx.here && !ctx.home && !bridge;
  const email = summary.email ?? (summary.plan ? profile?.email ?? null : null);
  const sheet = window.ogb?.accountSheet;
  const computerBadge = <PlaceBadge place={{ kind: "computer", name: computer.name, color: null }} size={14} />;
  return <>
    <SettingsGroup block="you">
      <SettingsRows>
        {elsewhere && computer.open
          ? <SettingsLinkRow title={t("settings.account.nameRow")} badge={computerBadge} value={t("settings.account.onPlace", { place: computer.name })} external onClick={computer.open} data={{ "data-account-name-row": "" }} />
          : <SettingsLinkRow title={t("settings.account.nameRow")} value={profileLabel(profile)} onClick={() => go("bots", "about-you")} data={{ "data-account-name-row": "" }} />}
      </SettingsRows>
    </SettingsGroup>
    {bridge && <CloudAccountSettings part="account" advanced={ctx.advanced} linkRequest={state.appSettingsCloudLink}
      onSignIn={() => dispatch({ type: "openCloudAdd", source: "app_settings", signIn: true })} />}
    {elsewhere && (
      <SettingsGroup label={t("settings.account.mausbot", { app: productName() })} block="mausbot-account">
        <SettingsRows icons>
          {/* Who is signed in, with Refresh: a control This computer's page holds, so it is inert here with the reason. */}
          <SettingRow title={email ?? t("settings.account.signedIn")} leading={<YouAvatar size={24} />}
            subtitle={summary.signedIn === false ? t("settings.account.notSignedIn") : t("settings.account.signedIn")}
            inert={ctx.advanced ? <InertReason /> : undefined} inertText={t("settings.inert.fromHere", { place: computer.name })}>
            {ctx.advanced ? <button type="button" className="settings-quiet" tabIndex={-1}>{t("organization.refresh")}</button> : null}
          </SettingRow>
          {sheet && <SettingsLinkRow title={t("accounts.manage")} leading={<span aria-hidden="true" />} onClick={() => void sheet.open().catch(() => {})} data={{ "data-account-manage": "" }} />}
          {computer.open && <SettingsLinkRow title={t("settings.account.fromHere", { place: computer.name })} leading={<span aria-hidden="true" />} external onClick={computer.open} data={{ "data-account-elsewhere": "" }} />}
        </SettingsRows>
      </SettingsGroup>
    )}
    {!ctx.desktop && (
      <SettingsGroup block="mausbot-account">
        <SettingsRows>
          <SettingRow title={t("settings.account.signedInTo", { place: place.name })} subtitle={profile?.email}>{null}</SettingRow>
          {session?.kind === "session" && (
            <SettingRow title={t("settings.account.signOutBrowser")}>
              <button type="button" data-danger="" className="settings-quiet cursor-pointer" onClick={() => setSigningOut(true)}>{t("settings.account.signOutShort")}</button>
            </SettingRow>
          )}
        </SettingsRows>
        {signingOut && <SignOutConfirm browser here={place.name} onConfirm={() => api("/api/auth/logout", { method: "POST" }).finally(() => location.reload())} onClose={() => setSigningOut(false)} />}
      </SettingsGroup>
    )}
    {ctx.organization ? (
      <SettingsGroup label={t("settings.section.organization")} block="organization">
        <OrganizationSettings />
      </SettingsGroup>
    ) : elsewhere && (
      // The organization sign-in is This computer's: it stays in place on a Cloud's page, inert, with the way there.
      <SettingsGroup label={t("settings.section.organization")} block="organization">
        <SettingsRows><InertRow title={t("settings.account.orgSignIn")} control={<button type="button" className="ui-button" tabIndex={-1}>{t("settings.account.signIn")}</button>} /></SettingsRows>
      </SettingsGroup>
    )}
    {ctx.desktop && !ctx.client && window.ogb?.updatesConsent && (
      <SettingsGroup label={t("settings.account.emails", { app: productName() })} block="emails">
        <SettingsRows><UpdatesConsentRow /></SettingsRows>
      </SettingsGroup>
    )}
    {bridge && <CloudAccountSettings part="sign-out" advanced={ctx.advanced} />}
  </>;
}

export function PlanPage() {
  const { ctx, place, go } = useSettingsShell();
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
      extra={!ctx.advanced && !ctx.client && !(ctx.team && !ctx.admin) ? <SpentRow place={place.name} onOpen={() => go("usage")} /> : undefined}
      onAddCloud={() => dispatch({ type: "openCloudAdd", source: "app_settings" })}
      onSignIn={() => dispatch({ type: "openCloudAdd", source: "app_settings", signIn: true })} />
    {dialog}
  </>;
}
