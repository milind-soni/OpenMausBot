import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { productName } from "@/lib/brand";
import { skillsLibraryEnabled } from "@/lib/feature-flags";
import { useStore } from "@/state/store";
import { AdminOnly } from "../../AdminOnly";
import { AutomaticRecoverySettings } from "../../AutomaticRecoverySettings";
import { QuotaSwitchSetting } from "../../QuotaSwitchSetting";
import { AwayEmailsSetting } from "../../AwayEmailsSetting";
import { PausedBotsButton } from "../../AwakeBotsPicker";
import { BuiltInBrowserRow, NewBrowserSettings, ServerSitesRow } from "../../BrowserSettingsRows";
import { CacheKeepWarmSettings } from "../../CacheKeepWarmSettings";
import { TeamPeopleCard } from "../../CloudAccountSettings";
import { CloudKeepHere } from "../../CloudKeepHere";
import { CustomDomainSettings } from "../../CustomDomainSettings";
import { WorkspaceBackupSettings } from "../../WorkspaceBackupSettings";
import { preloadConnectedApps } from "@/lib/connected-apps";
import { DecisionModelSettings } from "../../DecisionModelSettings";
import { DefaultBotSidebarRow } from "../../DefaultBotControls";
import { EnginesSettings } from "../../EnginesSettings";
import { ImageGenerationSettings } from "../../ImageGenerationSettings";
import { LocalComputerSection } from "../../LocalComputerSection";
import { McpCallTimeoutSettings } from "../../McpCallTimeoutSettings";
import { DefaultBotSettings } from "../../NewBotDialog";
import { PlaceLookRows } from "../../PlaceLookCard";
import { ProfileFields } from "../../ProfileSettings";
import { RoomTurnTimeoutSettings } from "../../RoomTurnTimeoutSettings";
import { SavedStepsRow } from "../../SavedStepsRow";
import { Card, SettingRow, SettingsDisclosureRow, SettingsFoldRow, SettingsGroup, SettingsLinkRow, SettingsRows } from "../../SettingsPrimitives";
import { KEY_SECTIONS } from "../../keys/key-catalog";
import { DesktopKinds } from "../DesktopKinds";
import { SkillsSection } from "../../SkillsSection";
import { ThreadConcurrencySettings } from "../../ThreadConcurrencySettings";
import { usePhonePlaceState } from "../phone-status";
import { KeysPage } from "../../keys/KeysPage";
import { BrowserProfilesRow, ExperimentalFeaturesRow, NewBotEffortRow } from "../../AppSettingsRows";
import { ServerUpdateRow } from "../../ServerUpdateRow";
import { versionLine } from "../settings-context";
import { useSettingsShell } from "../settings-shell";
import { AdvancedSection } from "../AdvancedSection";

const GROUPED_NOTE = "omb-settings-grouped-note";
const GROUPED_DAYS = 30;

/** Shown for 30 days to a device that used Settings before it was grouped; never on a new install. */
function useGroupedNote(): [boolean, () => void] {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(GROUPED_NOTE);
      if (raw === "dismissed") return;
      const first = raw ? Number(raw) : null;
      if (first === null) {
        const before = ["omb-skin", "omb-advanced-mode", "omb-send-key"].some((key) => localStorage.getItem(key) !== null);
        if (!before) { localStorage.setItem(GROUPED_NOTE, "dismissed"); return; }
        localStorage.setItem(GROUPED_NOTE, String(Date.now()));
        setShown(true);
        return;
      }
      setShown(Date.now() - first < GROUPED_DAYS * 86_400_000);
    } catch { /* storage may be blocked */ }
  }, []);
  return [shown, () => { setShown(false); try { localStorage.setItem(GROUPED_NOTE, "dismissed"); } catch { /* storage may be blocked */ } }];
}

export function OverviewPage() {
  const { ctx, place, go } = useSettingsShell();
  const { state, dispatch } = useStore();
  const [note, dismiss] = useGroupedNote();
  const phone = usePhonePlaceState(!ctx.client);
  const team = state.config?.team;
  const phoneValue = phone.kind === "paired" || phone.kind === "attention" ? t("settings.glance.phonePaired", { count: phone.count })
    : phone.kind === "none" ? t("settings.glance.notSetUp") : undefined;
  const engines = state.instances.filter((instance) => instance.snapshot.state === "available").length;
  const apps = useConnectedAppCount();
  return <>
    {note && (
      <SettingsRows>
        <div className="flex min-h-11 items-center gap-6 py-2 pl-4 pr-2" data-settings-grouped-note="">
          <p className="min-w-0 flex-1 text-[14px] leading-5 text-ink">{t(ctx.desktop ? "settings.overview.grouped" : "settings.overview.groupedBrowser", { place: place.name })}</p>
          <button type="button" aria-label={t("settings.dismiss")} onClick={dismiss} className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-secondary hover:bg-menu-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"><X size={14} aria-hidden="true" /></button>
        </div>
      </SettingsRows>
    )}
    {place.kind === "server" && !ctx.client && !window.ogb?.updater && <SettingsGroup label={t("settings.updates.title")} block="version"><SettingsRows><ServerUpdateRow title={versionLine()} /></SettingsRows></SettingsGroup>}
    <SettingsGroup label={t("settings.overview.glance")} block="glance">
      <SettingsRows>
        {!ctx.client && <SettingsLinkRow title={t("settings.section.phoneDevices")} value={phoneValue} onClick={() => go("phone")} data={{ "data-glance": "phone" }} />}
        {!ctx.client && <SettingsLinkRow title={t("settings.group.ai")} onClick={() => go("ai", "providers")} data={{ "data-glance": "ai" }}
          value={ctx.admin ? engines > 0 ? t("settings.glance.aiReady", { count: engines }) : t("settings.glance.aiStart") : t("settings.glance.aiAdmin")} />}
        {/* Simple's sidebar footer has Connect apps right beside the avatar, so Simple's Overview leaves the jump out and
            stays one window tall at 900 px even while the grouped note shows. */}
        {ctx.advanced && <SettingsLinkRow title={t("settings.glance.apps")} external value={apps === null ? undefined : apps > 0 ? t("settings.glance.appsConnected", { count: apps }) : t("settings.glance.appsNone")}
          onClick={() => { dispatch({ type: "toggleAppSettings", open: false }); dispatch({ type: "togglePlugins", open: true }); }} data={{ "data-glance": "apps" }} />}
      </SettingsRows>
    </SettingsGroup>
    <SettingsGroup label={t("settings.overview.sidebar")} block="sidebar">
      <SettingsRows><PlaceLookRows /><DefaultBotSidebarRow simple /></SettingsRows>
    </SettingsGroup>
    {/* Simple keeps what a person needs from Data here: back up and bring a backup back. */}
    {!ctx.advanced && !ctx.client && (
      <SettingsGroup label={t("settings.overview.yourData")} block="your-data">
        <AdminOnly><WorkspaceBackupSettings compact /></AdminOnly>
      </SettingsGroup>
    )}
    {ctx.desktop && ctx.cloud && team && team.cloudPage && <div data-settings-block="people-and-plan"><TeamPeopleCard team={team} /></div>}
    {/* Address: a self-hosted server's own web address, Advanced only. A Cloud's address is MausBot's to manage, so it
        has none here (no administrator or proxy steps for a person who has no server to set up). */}
    {place.kind === "server" && !ctx.client && ctx.advanced && <CustomDomainSettings />}
  </>;
}

/** How many apps this place has connected, for At a glance; null until it is known. */
function useConnectedAppCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    void preloadConnectedApps().then((inventory) => { if (alive) setCount(Object.values(inventory.services).filter((status) => status.connected).length); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return count;
}

export function AiPage() {
  const { ctx, anchor } = useSettingsShell();
  const [more, setMore] = useState(false);
  // Simple ends after Providers: Other services is one closed fold row, so the page fits one window.
  const [services, setServices] = useState(ctx.advanced || anchor === "ai-keys");
  // A key asked for by search or a link opens Other services whatever the fold says.
  const shown = ctx.advanced || services || anchor === "ai-keys";
  const count = KEY_SECTIONS.filter((section) => section.id !== "ai").length;
  return <>
    <AdminOnly>
      <div data-settings-block="providers" className="flex scroll-mt-4 flex-col gap-6">
        <EnginesSettings simple more={{ id: "ai-more", open: more, onToggle: () => setMore((open) => !open) }} />
      </div>
      {!ctx.advanced && (
        <SettingsGroup block="ai-keys-fold">
          <SettingsRows>
            <SettingsFoldRow id="ai-other-services" title={t("settings.ai.otherServices")} value={String(count)} open={shown} onToggle={() => setServices(!shown)} />
          </SettingsRows>
        </SettingsGroup>
      )}
      {shown && (
        <SettingsGroup label={ctx.advanced ? t("settings.ai.otherServices") : undefined} block="ai-keys">
          <KeysPage bare exclude={anchor === "ai-keys" ? [] : ["ai"]} />
        </SettingsGroup>
      )}
      <AdvancedSection anchor="backup-model"><SettingsGroup label={t("settings.ai.backupModel")} block="backup-model"><QuotaSwitchSetting /><AutomaticRecoverySettings /></SettingsGroup></AdvancedSection>
      <AdvancedSection anchor="routing"><DecisionModelSettings /></AdvancedSection>
      <AdvancedSection anchor="images"><ImageGenerationSettings /></AdvancedSection>
    </AdminOnly>
  </>;
}

export function BotsPage() {
  const { ctx } = useSettingsShell();
  const { state } = useStore();
  const paused = (state.config?.pausedBots?.length ?? 0) > 0;
  return <>
    {paused && <SettingsGroup block="awake"><SettingsRows><SettingRow title={t("settings.bots.awakeTitle")} subtitle={t("settings.bots.awakeLine")}><PausedBotsButton /></SettingRow></SettingsRows></SettingsGroup>}
    <SettingsGroup label={t("settings.bots.aboutYou")} block="about-you"
      footnote={ctx.here || !ctx.desktop ? t("settings.bots.aboutYouHome", { app: productName() }) : undefined}>
      <div className="flex flex-col gap-2">
        <Card><ProfileFields /></Card>
        <SettingsRows><AwayEmailsSetting row /></SettingsRows>
      </div>
    </SettingsGroup>
    <SettingsGroup label={t("settings.bots.newBots")} block="new-bots">
      <SettingsRows><NewBotEffortRow /><DefaultBotSettings simple /></SettingsRows>
    </SettingsGroup>
    {!(ctx.team && !ctx.admin) && <AdvancedSection anchor="limits" also={["parallel", "group-turns", "tool-time", "keep-warm"]}><SettingsGroup label={t("settings.simple.more.limits")} block="limits">
      <SettingsRows selectWidth={160}>
        <div data-settings-block="group-turns" className="contents"><RoomTurnTimeoutSettings /></div>
        <div data-settings-block="tool-time" className="contents"><McpCallTimeoutSettings /></div>
        <ThreadConcurrencySettings />
        <div data-settings-block="keep-warm" className="contents"><CacheKeepWarmSettings /></div>
      </SettingsRows>
    </SettingsGroup></AdvancedSection>}
    {skillsLibraryEnabled(state.config) && <div data-settings-block="skills"><SkillsSection /></div>}
    <AdvancedSection anchor="early"><div data-settings-block="early"><ExperimentalFeaturesRow /></div></AdvancedSection>
  </>;
}

export function DesktopsPage() {
  const { ctx, anchor } = useSettingsShell();
  const [details, setDetails] = useState(anchor === "desktop-details");
  return <>
    <SettingsGroup label={t("settings.desktops.browserSection")} block="browser">
      <SettingsRows><BuiltInBrowserRow /><ServerSitesRow />{ctx.advanced && <div data-settings-block="new-browser" className="contents"><NewBrowserSettings /></div>}</SettingsRows>
    </SettingsGroup>
    <AdminOnly><DesktopKinds /></AdminOnly>
    <BrowserProfilesRow />
    {ctx.advanced && (
      <AdminOnly>
        <SettingsDisclosureRow id="desktop-details" block="desktop-details" title={t("settings.desktops.detailsTitle")} subtitle={t("settings.desktops.detailsLine")}
          open={details} onToggle={() => setDetails((open) => !open)}>
          <div className="flex flex-col gap-6 px-4 py-4"><LocalComputerSection /></div>
        </SettingsDisclosureRow>
      </AdminOnly>
    )}
    <AdvancedSection anchor="automation"><SettingsGroup label={t("settings.desktops.automation")} block="automation"><SettingsRows><SavedStepsRow /></SettingsRows></SettingsGroup></AdvancedSection>
  </>;
}

export function MoveSection() {
  const { ctx } = useSettingsShell();
  if (!ctx.here || !window.ogb?.cloudSendPage) return null;
  return <CloudKeepHere bridge={window.ogb.cloudSendPage} />;
}
