import { pageIsThisComputer } from "@/lib/companion-bridge";
import type { ReactNode } from "react";
import type { AppSettingsSection } from "@/state/store";
import { t } from "@/lib/i18n";
import { appVersion } from "@/lib/app-links";
import { SIMPLE_ONLY } from "@/lib/simple-only";
import type { LocaleKey } from "@/locales";
import { productName } from "../lib/brand";
import { AnalyticsRow } from "./AnalyticsRow";
import { UpdatesConsentRow } from "./UpdatesConsent";
import { OpenAtLoginRow } from "./OpenAtLoginRow";
import { DefaultBotSidebarRow } from "./DefaultBotControls";
import { TalkShortcutRow } from "./TalkShortcutRow";
import { SpeechInputSettings } from "./SpeechInputSettings";
import { AttachmentStorageSettings } from "./AttachmentStorageSettings";
import { DiagnosticsRow } from "./DiagnosticsRow";
import { EnginesSettings } from "./EnginesSettings";
import { LocalComputerSection } from "./LocalComputerSection";
import { PeopleSection } from "./PeopleSection";
import { ActivitySection } from "./ActivitySection";
import { BuiltInBrowserRow, ServerSitesRow } from "./BrowserSettingsRows";
import { VaultSettings } from "./VaultSettings";
import { OrganizationSettings } from "./OrganizationSettings";
import { CloudPlanRow, CloudPlanFootnote, useCloudPlan } from "./ProIntroduction";
import { CloudUsageDetails, CloudUsageSummaryView, useCloudUsageSettings } from "./CloudUsageMeter";
import { Card, SettingRow, SettingsDisclosureRow, SettingsGroup, SettingsRows } from "./SettingsPrimitives";
import { UsageSection } from "./UsageSection";
import { PlanUsageSummary } from "./PlanUsage";
import { SkinPicker } from "./SkinPicker";
import { useSkinChoice } from "./ThemeRow";
import { resolveSkin, SKINS } from "@/lib/skins";
import { PlaceLookRows } from "./PlaceLookCard";
import { ChromeRailRow } from "./ChromeRailToggle";
import { WindowFrameRow } from "./WindowFrameRow";
import { ProfileSummaryRow } from "./ProfileSettings";
import { AwayEmailsSetting } from "./AwayEmailsSetting";
import { ImportSettings } from "./ImportSettings";
import { NotificationRows } from "./NotificationSettingsRows";
import { ServerUpdateRow } from "./ServerUpdateRow";
import { AdvancedModeRow, BrowserProfilesRow, ColorUserBubblesRow, FollowUpRow, LanguageRow, ReplayTourRow, SendKeyRow, ToolCallsRow, UpdatesRow } from "./AppSettingsRows";
import { RoomTurnTimeoutSettings } from "./RoomTurnTimeoutSettings";
import { McpCallTimeoutSettings } from "./McpCallTimeoutSettings";
import { ThreadConcurrencySettings } from "./ThreadConcurrencySettings";
import { AutomaticRecoverySettings } from "./AutomaticRecoverySettings";
import { ThreadCleanupSettings } from "./ThreadCleanupSettings";
import { CacheKeepWarmSettings } from "./CacheKeepWarmSettings";
import { SavedStepsRow } from "./SavedStepsRow";
import { ThemeRow } from "./ThemeRow";
import { AdminOnly } from "./AdminOnly";
import { DefaultBotSettings } from "./NewBotDialog";

export type SimpleDisclosureId = "ai-more" | "ai-keys" | "computer-elsewhere" | "billing-limits";

export type Disclose = (id: SimpleDisclosureId) => { id: SimpleDisclosureId; open: boolean; onToggle: () => void };

export const SIMPLE_ADVANCED_ONLY: readonly LocaleKey[] = [
  "settings.font.title", "settings.chatWidth.title", "settings.pinnedCircles.title", "settings.universalPins.title", "settings.runCard.title",
];

export const SIMPLE_MORE_LIMITS: readonly LocaleKey[] = [
  "settings.roomTurns.title", "settings.mcpCalls.title", "settings.threads.title", "settings.recovery.title", "settings.threadCleanup.title",
  "settings.keepWarm.title", "settings.savedSteps.title",
];

type Has = (id: AppSettingsSection) => boolean;

export function SimpleGeneralPage({ has, peopleOpen, onLooks, onMore }: { has: Has; peopleOpen: boolean; onLooks: () => void; onMore?: () => void }) {
  return (
    <>
      {(has("general") || has("people")) && (
        <SettingsGroup label={t("settings.group.account")} block="general">
          <SettingsRows>
            {has("general") && <ProfileSummaryRow />}
            {has("general") && <AwayEmailsSetting row />}
            {has("general") && <CloudPlanRow place="account" />}
            {has("people") && <div data-settings-block="people" className="scroll-mt-4"><PeopleSection simple startOpen={peopleOpen} /></div>}
          </SettingsRows>
        </SettingsGroup>
      )}
      {has("appearance") && (
        <SettingsGroup label={t("settings.section.appearance")} block="appearance">
          <SettingsRows>
            <ThemeRow simple />
            <LooksRow onLooks={onLooks} />
            <PlaceLookRows />
            <ChromeRailRow />
            <WindowFrameRow />
            <ColorUserBubblesRow simple />
          </SettingsRows>
        </SettingsGroup>
      )}
      {has("appearance") && (
        <SettingsGroup label={t("settings.simple.group.typing")}>
          <SettingsRows>
            <LanguageRow simple />
            <SendKeyRow simple />
            <FollowUpRow simple />
          </SettingsRows>
        </SettingsGroup>
      )}
      {has("appearance") && (
        <SettingsGroup label={t("notifications.title")}>
          <SettingsRows><NotificationRows simple /></SettingsRows>
        </SettingsGroup>
      )}
      {has("general") && (
        <SettingsGroup label={t("settings.simple.group.system")}>
          <SettingsRows>
            <OpenAtLoginRow simple />
            <DefaultBotSidebarRow simple />
            <TalkShortcutRow />
            <SpeechInputSettings />
            <AttachmentStorageSettings />
            <AnalyticsRow simple />
          </SettingsRows>
        </SettingsGroup>
      )}
      {has("import") && <SettingsGroup label={t("settings.section.import")} block="import"><AdminOnly><ImportSettings /></AdminOnly></SettingsGroup>}
      {has("organization") && <SettingsGroup label={t("settings.section.organization")} block="organization"><OrganizationSettings /></SettingsGroup>}
      {has("activity") && <SettingsGroup label={t("settings.section.activity")} block="activity"><ActivitySection /></SettingsGroup>}
      {onMore && (
        <div data-settings-block="more" className="scroll-mt-4">
          <SettingsRows>
            <SettingRow title={t("settings.simple.more.title")} subtitle={t("settings.simple.more.subtitle")}>
              <button type="button" className="ui-button" data-settings-more="" onClick={onMore}>{t("settings.simple.more.open")}</button>
            </SettingRow>
          </SettingsRows>
        </div>
      )}
      {!SIMPLE_ONLY && <div data-settings-block="advanced-mode" className="scroll-mt-4">
        <SettingsRows><AdvancedModeRow simple /></SettingsRows>
      </div>}
    </>
  );
}

function LooksRow({ onLooks }: { onLooks: () => void }) {
  const choice = useSkinChoice();
  const current = SKINS.find((skin) => skin.id === resolveSkin(choice))?.name;
  // A fixed theme is named under the label; Follow system says which it switches between.
  const hint = choice === "system" ? t("settings.simple.themes.followHint") : current;
  return (
    <SettingRow title={t("settings.theme.title")} subtitle={hint}>
      <button type="button" className="ui-button" onClick={onLooks}>{t("settings.simple.themes.browse")}</button>
    </SettingRow>
  );
}

export function SimpleLooksPage({ onBack, toolCalls = true }: { onBack: () => void; toolCalls?: boolean }) {
  return (
    <>
      <div><button type="button" className="ui-button" onClick={onBack}>{t("settings.simple.looks.back")}</button></div>
      <div data-settings-block="looks"><SkinPicker /></div>
      {toolCalls && <SettingsRows><ToolCallsRow /></SettingsRows>}
    </>
  );
}

type MoreSection = { id: AppSettingsSection; labelKey: LocaleKey };

export function SimpleMorePage({ sections, onOpen, onBack }: { sections: readonly MoreSection[]; onOpen: (id: AppSettingsSection) => void; onBack: () => void }) {
  return (
    <>
      <div><button type="button" className="ui-button" onClick={onBack}>{t("settings.simple.looks.back")}</button></div>
      {sections.length > 0 && (
        <SettingsGroup block="more-sections">
          <SettingsRows>
            {sections.map(({ id, labelKey }) => (
              <SettingRow key={id} title={t(labelKey)}>
                <button type="button" className="ui-button" data-settings-more-section={id} onClick={() => onOpen(id)}>{t("settings.simple.more.open")}</button>
              </SettingRow>
            ))}
          </SettingsRows>
        </SettingsGroup>
      )}
      <SettingsGroup label={t("settings.simple.more.limits")} block="limits">
        <div className="flex flex-col gap-3">
          <Card title={t("settings.roomTurns.title")} subtitle={t("settings.roomTurns.subtitle")}><RoomTurnTimeoutSettings /></Card>
          <Card title={t("settings.mcpCalls.title")} subtitle={t("settings.mcpCalls.subtitle")}><McpCallTimeoutSettings /></Card>
          <ThreadConcurrencySettings />
          <AutomaticRecoverySettings />
          <ThreadCleanupSettings />
          <CacheKeepWarmSettings />
          <SettingsRows><SavedStepsRow /></SettingsRows>
        </div>
      </SettingsGroup>
    </>
  );
}

export function SimpleAiPage({ has, disclose, connections }: { has: Has; disclose: Disclose; connections: ReactNode }) {
  return (
    <>
      {has("engines") && (
        <div data-settings-block="engines" className="flex scroll-mt-4 flex-col gap-7">
          <AdminOnly>
            <EnginesSettings simple more={disclose("ai-more")} />
            <SettingsRows><DefaultBotSettings simple /></SettingsRows>
          </AdminOnly>
        </div>
      )}
      {has("connections") && (
        <AdminOnly>
          <SettingsDisclosureRow title={t("settings.section.connections")} block="connections" {...disclose("ai-keys")}>
            {connections}
          </SettingsDisclosureRow>
        </AdminOnly>
      )}
    </>
  );
}

export type RemoteAccessCards = Record<"client" | "domain" | "pairing" | "companion", ReactNode>;

export function SimpleComputerPage({ has, remoteAccess, servers, disclose }: { has: Has; remoteAccess: RemoteAccessCards; servers: ReactNode; disclose: Disclose }) {
  return (
    <>
      {has("computer") && <SettingsGroup label={t("settings.simple.computer.bots")} block="computer"><AdminOnly><LocalComputerSection /></AdminOnly></SettingsGroup>}
      {has("companion") && (
        <SettingsGroup label={t(pageIsThisComputer() ? "settings.section.phoneDevices" : "settings.section.thisServer")} block="companion">
          {remoteAccess.companion}
          {remoteAccess.pairing}
          {remoteAccess.domain}
        </SettingsGroup>
      )}
      {has("computer") && (
        <SettingsGroup label={t("settings.experimental.browser")} block="browser">
          <SettingsRows><BuiltInBrowserRow /><ServerSitesRow /></SettingsRows>
          <BrowserProfilesRow />
        </SettingsGroup>
      )}
      {has("logins") && <div data-settings-block="logins" className="scroll-mt-4"><VaultSettings /></div>}
      {(has("companion") || has("desktopWorkspaces")) && (
        <SettingsDisclosureRow title={t("settings.simple.computer.elsewhere")} block="elsewhere" {...disclose("computer-elsewhere")}>
          {has("desktopWorkspaces") && <div data-settings-block="desktopWorkspaces" className="flex scroll-mt-4 flex-col gap-4">{servers}</div>}
          {has("companion") && <div data-settings-block="remote" className="flex scroll-mt-4 flex-col gap-4 empty:hidden">{remoteAccess.client}</div>}
        </SettingsDisclosureRow>
      )}
    </>
  );
}

export function SimpleBillingPage({ has, disclose, cloudAccount }: { has: Has; disclose: Disclose; cloudAccount: ReactNode }) {
  const { usage, upgrade, dialog } = useCloudUsageSettings();
  const plan = useCloudPlan();
  const signedOut = plan?.view.kind === "signed-out" || plan?.view.kind === "removed";
  return (
    <>
      <div data-settings-block="usage" className="scroll-mt-4">
        {usage ? <CloudUsageSummaryView usage={usage} upgrade={upgrade}>{dialog}</CloudUsageSummaryView> : <AdminOnly note="settings.adminOnly.usage"><PlanUsageSummary /></AdminOnly>}
      </div>
      {(usage || has("usage")) && (
        <SettingsDisclosureRow title={t("settings.simple.billing.limits")} {...disclose("billing-limits")}>
          {usage && <CloudUsageDetails usage={usage} upgrade={upgrade} />}
          {has("usage") && <AdminOnly note="settings.adminOnly.usage"><UsageSection /></AdminOnly>}
        </SettingsDisclosureRow>
      )}
      {has("cloudAccount") && (
        <SettingsGroup label={t("settings.simple.billing.plan")} block="cloudAccount" footnote={<CloudPlanFootnote />}>
          <SettingsRows><CloudPlanRow place="plan" usage={usage} upgrade={upgrade} /></SettingsRows>
          {signedOut ? null : <div className="flex flex-col gap-4">{cloudAccount}</div>}
        </SettingsGroup>
      )}
    </>
  );
}

const versionTitle = () => `${productName()} ${appVersion()}`;

export function SimpleUpdatesPage({ remoteActive }: { remoteActive: boolean }) {
  return (
    <SettingsGroup block="updates">
      <SettingsRows>
        {window.ogb?.updater ? <UpdatesRow title={versionTitle()} /> : <ServerUpdateRow title={versionTitle()} />}
        <UpdatesConsentRow />
        {!remoteActive && <ReplayTourRow />}
        <DiagnosticsRow simple />
      </SettingsRows>
    </SettingsGroup>
  );
}
