import { useState } from "react";
import { productName } from "@/lib/brand";
import { FEEDBACK_URL, HELP_CENTER_URL, appVersion, openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { AboutDialog } from "../../AboutDialog";
import { AnalyticsRow } from "../../AnalyticsRow";
import { ChatWidthRow, FontRow, SidebarToolsLayoutRow } from "../../AppearanceSelectRows";
import {
  ColorUserBubblesRow, FollowUpRow, LanguageRow, PinnedCirclesRow, ReplayTourRow, RunCardRow, SendKeyRow, ShowThreadsRow,
  ToolCallsRow, UniversalPinsRow, UpdatesRow,
} from "../../AppSettingsRows";
import { ChromeRailRow } from "../../ChromeRailToggle";
import { ConnectedWorkspacesSettings } from "../../ConnectedWorkspacesSettings";
import { DiagnosticsRow } from "../../DiagnosticsRow";
import { NotificationRows } from "../../NotificationSettingsRows";
import { OpenAtLoginRow } from "../../OpenAtLoginRow";
import { PinnedPanelsSettings } from "../../PinnedPanelsSettings";
import { RemoteComputerSection } from "../../RemoteComputerSection";
import { SettingRow, SettingsGroup, SettingsLinkRow, SettingsRows, Switch } from "../../SettingsPrimitives";
import { SkinPicker } from "../../SkinPicker";
import { TalkShortcutRow } from "../../TalkShortcutRow";
import { useSkinChoice, ThemeRow } from "../../ThemeRow";
import { WindowFrameRow } from "../../WindowFrameRow";
import { resolveSkin, SKINS } from "@/lib/skins";
import { versionLine } from "../settings-context";
import { useSettingsShell } from "../settings-shell";
import { PlaceBadge } from "../SettingsNav";
import { InertRow, useSwitchToComputer } from "../inert";

const elsewhere = (bridge: unknown, ctx: { desktop: boolean; here: boolean; client: boolean }) => ctx.desktop && !ctx.client && !ctx.here && !bridge;

export function AppPage() {
  const { ctx } = useSettingsShell();
  const { dispatch } = useStore();
  const [about, setAbout] = useState(false);
  const desk = ctx.desktop && !ctx.client;
  const computer = useSwitchToComputer();
  return <>
    {ctx.desktop && (
      <SettingsGroup label={t("settings.updates.title")} block="updates">
        <SettingsRows>
          {window.ogb?.updater ? <UpdatesRow title={versionLine()} />
            : <InertRow title={versionLine()} reason={t("settings.inert.checkFromHere", { place: computer.name })}
              control={<button type="button" className="ui-button" tabIndex={-1}>{t("settings.updates.check")}</button>} />}
        </SettingsRows>
      </SettingsGroup>
    )}
    {ctx.desktop && (
      <SettingsGroup label={t("settings.app.computers")} description={t("settings.app.computersLine")} block="your-computers">
        {window.ogb?.environments ? <ConnectedWorkspacesSettings /> : !ctx.client && (
          <SettingsRows><InertRow title={t("connectedWorkspaces.localTitle")} control={<button type="button" className="ui-button" tabIndex={-1}>{t("connectedWorkspaces.newEnvironment")}</button>} /></SettingsRows>
        )}
        <RemoteComputerSection hideWhenUnavailable legacyOnly />
      </SettingsGroup>
    )}
    <SettingsGroup label={t("sidebar.menu.helpShort")} block="help">
      <SettingsRows>
        <SettingsLinkRow title={t("sidebar.menu.help")} external onClick={() => void openExternalLink(HELP_CENTER_URL)} />
        <SettingsLinkRow title={t("sidebar.menu.feedback")} external onClick={() => void openExternalLink(FEEDBACK_URL)} />
        <SettingsLinkRow title={t("sidebar.menu.shortcuts")} onClick={() => { dispatch({ type: "toggleAppSettings", open: false }); dispatch({ type: "toggleShortcuts", open: true }); }} />
        {!ctx.client && <ReplayTourRow />}
        {desk && (window.ogb?.exportDiagnostics ? <DiagnosticsRow simple /> : <InertRow title={t("settings.app.diagnostics")}
          control={<button type="button" className="ui-button" tabIndex={-1}>{t("settings.diagnostics.export")}</button>} />)}
      </SettingsRows>
    </SettingsGroup>
    <SettingsGroup label={t("sidebar.menu.about")} block="about">
      <SettingsRows>
        <SettingsLinkRow title={t("settings.app.about", { app: productName() })} value={appVersion()} onClick={() => setAbout(true)} />
      </SettingsRows>
    </SettingsGroup>
    <AboutDialog open={about} onClose={() => setAbout(false)} />
  </>;
}

export function GeneralPage() {
  const { ctx, place, go } = useSettingsShell();
  return <>
    <SettingsGroup label={t("settings.simple.group.typing")} block="typing">
      <SettingsRows>
        <LanguageRow simple />
        <SendKeyRow simple />
        <FollowUpRow simple />
        {window.ogb?.talkShortcut ? <TalkShortcutRow /> : elsewhere(window.ogb?.talkShortcut, ctx) && ctx.cloud ? <InertRow title={t("settings.search.talk")} control={<span className="text-[13px] leading-5 text-ink-secondary">{t("settings.general.talkOff")}</span>} /> : null}
      </SettingsRows>
    </SettingsGroup>
    <SettingsGroup label={t("notifications.title")} block="notifications"
      footnote={!ctx.client && <>{t("settings.general.awayEmails")}{" "}<button type="button" className="cursor-pointer text-accent-text hover:underline" onClick={() => go("bots", "about-you")}>{`${place.name} › ${t("settings.page.bots")}`}</button></>}>
      <SettingsRows><NotificationRows simple /></SettingsRows>
    </SettingsGroup>
    {ctx.desktop && !ctx.client && (
      <SettingsGroup label={t("settings.general.startup")} block="startup">
        <SettingsRows>{window.ogb?.openAtLogin ? <OpenAtLoginRow simple /> : <InertRow title={t("settings.openAtLogin.title")} control={<Switch checked={false} tabIndex={-1} aria-label={t("settings.openAtLogin.title")} />} />}</SettingsRows>
      </SettingsGroup>
    )}
    <SettingsGroup label={t("settings.general.privacy")} block="privacy">
      <SettingsRows><AnalyticsRow simple /></SettingsRows>
    </SettingsGroup>
  </>;
}

function ThemePickerRow({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const choice = useSkinChoice();
  const current = SKINS.find((skin) => skin.id === resolveSkin(choice))?.name;
  return (
    <SettingRow title={t("settings.theme.title")} subtitle={choice === "system" ? t("settings.simple.themes.followHint") : current}>
      <button type="button" className="ui-button" aria-expanded={open} data-settings-themes="" onClick={onToggle}>{t(open ? "settings.appearance.hideThemes" : "settings.simple.themes.browse")}</button>
    </SettingRow>
  );
}

export function AppearancePage() {
  const { ctx, place, go, anchor } = useSettingsShell();
  const [themes, setThemes] = useState(anchor === "themes");
  return <>
    <SettingsGroup label={t("settings.appearance.look")} block="look">
      <SettingsRows>
        <ThemeRow simple />
        <ThemePickerRow open={themes} onToggle={() => setThemes((open) => !open)} />
        {themes && <div data-settings-block="themes" className="p-4"><SkinPicker /></div>}
        <ColorUserBubblesRow simple />
        {!ctx.client && <SettingsLinkRow title={t("placeLook.sidebarColor")} value={place.name} badge={<PlaceBadge place={place} size={14} />} onClick={() => go("overview", "sidebar")} data={{ "data-settings-door": "sidebar-color" }} />}
      </SettingsRows>
    </SettingsGroup>
    <SettingsGroup label={t("settings.appearance.chat")} block="chat">
      <SettingsRows>
        {!ctx.client && <ToolCallsRow />}
        {ctx.advanced && <RunCardRow />}
        {ctx.advanced && <ChatWidthRow />}
        {ctx.advanced && <FontRow />}
      </SettingsRows>
    </SettingsGroup>
    <SettingsGroup label={t("settings.appearance.layout")} block="appearance">
      <SettingsRows>
        <ChromeRailRow />
        <WindowFrameRow />
        {ctx.advanced && <ShowThreadsRow />}
        {ctx.advanced && <SidebarToolsLayoutRow />}
        {ctx.advanced && <PinnedCirclesRow />}
        {ctx.advanced && <UniversalPinsRow />}
      </SettingsRows>
    </SettingsGroup>
    {ctx.advanced && <PinnedPanelsSettings />}
  </>;
}
