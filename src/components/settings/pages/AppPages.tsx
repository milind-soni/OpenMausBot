import { useState } from "react";
import { Plus } from "lucide-react";
import { productName } from "@/lib/brand";
import { FEEDBACK_URL, HELP_CENTER_URL, desktopAppVersion, openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { AboutDialog } from "../../AboutDialog";
import { AnalyticsRow } from "../../AnalyticsRow";
import { ChatWidthRow, FontRow, SidebarToolsLayoutRow } from "../../AppearanceSelectRows";
import {
  ColorUserBubblesRow, FollowUpRow, HoverThreadsRow, LanguageRow, PinnedCirclesRow, ReplayTourRow, RunCardRow, SendKeyRow, ShowThreadsRow,
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
import { useOtherPlaces } from "../settings-context";

/** A row this page can't change because it lives on This computer: not on the app's own home page (main's home:page). */
const elsewhere = (bridge: unknown, ctx: { desktop: boolean; here: boolean; home: boolean; client: boolean }) => ctx.desktop && !ctx.client && !ctx.here && !ctx.home && !bridge;

export function AppPage() {
  const { ctx } = useSettingsShell();
  const { dispatch } = useStore();
  const [about, setAbout] = useState(false);
  const desk = ctx.desktop && !ctx.client;
  const computer = useSwitchToComputer();
  const appVersionLine = versionLine(desktopAppVersion());
  return <>
    {ctx.desktop && (
      <SettingsGroup label={t("settings.updates.title")} block="updates">
        <SettingsRows>
          {window.ogb?.updater ? <UpdatesRow title={appVersionLine} />
            // On the app's own page with no updater (a package or store build), the version is live and says why
            // there is no button; only another place's page names This computer.
            : ctx.home || ctx.client ? <SettingRow title={appVersionLine} subtitle={t("settings.updates.fromPackage")}>{null}</SettingRow>
              : <InertRow title={appVersionLine} reason={t("settings.inert.checkFromHere", { place: computer.name })}
                control={<button type="button" className="ui-button" tabIndex={-1}>{t("settings.updates.check")}</button>} />}
        </SettingsRows>
      </SettingsGroup>
    )}
    {/* Simple keeps language and notifications here, since General is an Advanced page. */}
    {!ctx.advanced && (
      <SettingsGroup label={t("settings.app.languageNotifications")} block="typing">
        <SettingsRows selectWidth={208}>
          <LanguageRow simple />
          <NotificationRows simple />
        </SettingsRows>
      </SettingsGroup>
    )}
    {/* Your computers is Advanced: in Simple the rail switches places, and the page stays one window tall. */}
    {ctx.desktop && ctx.advanced && (window.ogb?.environments
      ? <ConnectedWorkspacesSettings label={t("settings.app.computers")} description={t("settings.app.computersLine")} />
      : !ctx.client && <PlacesFromHere />)}
    {ctx.desktop && ctx.advanced && <RemoteComputerSection hideWhenUnavailable legacyOnly />}
    <SettingsGroup label={t("sidebar.menu.helpShort")} block="help">
      <SettingsRows>
        <SettingsLinkRow title={t("sidebar.menu.help")} external onClick={() => void openExternalLink(HELP_CENTER_URL)} />
        {/* Simple keeps the Help card short: feedback, shortcuts and the tour are in the outer menu's Help too. */}
        {ctx.advanced && <SettingsLinkRow title={t("sidebar.menu.feedback")} external onClick={() => void openExternalLink(FEEDBACK_URL)} />}
        {ctx.advanced && <SettingsLinkRow title={t("sidebar.menu.shortcuts")} onClick={() => { dispatch({ type: "toggleAppSettings", open: false }); dispatch({ type: "toggleShortcuts", open: true }); }} />}
        {ctx.advanced && !ctx.client && <ReplayTourRow />}
        {desk && ctx.advanced && (window.ogb?.exportDiagnostics ? <DiagnosticsRow simple /> : <InertRow title={t("settings.app.diagnostics")}
          control={<button type="button" className="ui-button" tabIndex={-1}>{t("settings.diagnostics.export")}</button>} />)}
        <div data-settings-block="about" className="contents">
          <SettingsLinkRow title={t("settings.app.about", { app: productName() })} onClick={() => setAbout(true)} />
        </div>
      </SettingsRows>
    </SettingsGroup>
    <AboutDialog open={about} onClose={() => setAbout(false)} />
  </>;
}

/** A Cloud's page in the desktop window: the places list reads the rail through the workspaces bridge, which works on
 * every page; only the environments on this computer need This computer's own page. */
function PlacesFromHere() {
  const { place } = useSettingsShell();
  const others = useOtherPlaces("app");
  const workspaces = window.ogb?.workspaces;
  if (!workspaces) return null;
  return <>
    <SettingsGroup label={t("settings.app.computers")} description={t("settings.app.computersLine")} block="your-computers">
      <SettingsRows icons>
        <SettingRow title={place.name} leading={<PlaceBadge place={place} size={24} />} subtitle={t("servers.managed")}>
          <span className="text-[13px] leading-5 text-ink-secondary">{t("servers.current")}</span>
        </SettingRow>
        {others.map((other) => (
          <SettingRow key={other.key} title={other.name} leading={<PlaceBadge place={{ kind: other.kind === "computer" ? "computer" : "cloud", name: other.name, color: other.color }} size={24} />}
            subtitle={other.kind === "computer" ? t("servers.localHint") : undefined}>
            <button type="button" className="ui-button" data-place-switch={other.key} onClick={other.open}>{t("servers.switch")}</button>
          </SettingRow>
        ))}
        {workspaces.add && <SettingsLinkRow title={t("connect.title")} leading={<span className="flex size-8 items-center justify-center rounded-full bg-ink/[0.05] text-ink-secondary"><Plus size={18} strokeWidth={1.75} aria-hidden="true" /></span>}
          onClick={() => void workspaces.add?.("address")} data={{ "data-server-connect": "" }} />}
      </SettingsRows>
    </SettingsGroup>
    <SettingsGroup label={t("connectedWorkspaces.localTitle")} block="environments">
      <SettingsRows><InertRow title={t("connectedWorkspaces.newEnvironment")} /></SettingsRows>
    </SettingsGroup>
  </>;
}

export function GeneralPage() {
  const { ctx, place, go } = useSettingsShell();
  return <>
    <SettingsGroup label={t("settings.simple.group.typing")} block="typing">
      <SettingsRows selectWidth={208}>
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
    {/* Simple keeps the Look card and Tool calls; the window's layout is Advanced. */}
    {ctx.advanced && <SettingsGroup label={t("settings.appearance.layout")} block="appearance">
      <SettingsRows>
        <ChromeRailRow />
        <WindowFrameRow />
        {ctx.advanced && <><ShowThreadsRow /><HoverThreadsRow /></>}
        {ctx.advanced && <SidebarToolsLayoutRow />}
        {ctx.advanced && <PinnedCirclesRow />}
        {ctx.advanced && <UniversalPinsRow />}
      </SettingsRows>
    </SettingsGroup>}
    {ctx.advanced && <PinnedPanelsSettings />}
  </>;
}
