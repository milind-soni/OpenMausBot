// The closed scales of the settings spec (§6.8): type, spacing, sizes and surfaces Settings, the outer menu and the
// pairing dialog may use. Classes outside them are listed here as known debt, file by file, and the counts can only go
// down: a new off-scale class fails the test, and fixing one asks for the count to be lowered with it.
//
// Most of the debt sits in the non-Settings branches of shared components (the onboarding importer, the chat's own
// Select variants, the bot panel's usage view) and in builder-detail folds not yet rebuilt (Desktop details, the engine
// cards, browser profiles). Settings' own rows, cards and fields are already clean.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const OFF_SCALE = /(?<![\w-])(?:border-hairline(?:\/\d+)?|bg-inset|leading-relaxed|leading-snug|leading-tight|(?:[pm][xytblr]?|gap(?:-[xy])?|space-[xy])-(?:2\.5|3\.5|0\.75|1\.25|9|10|11|14)|text-\[(?:9|10|15|17|19|22)px\])(?![\w\-./[])/g;

const FILES = [
  "src/components/AboutMeSettings.tsx",
  "src/components/AccountMenu.tsx",
  "src/components/ActivitySection.tsx",
  "src/components/AppSettingsRows.tsx",
  "src/components/AppearanceSelectRows.tsx",
  "src/components/AttachmentStorageSettings.tsx",
  "src/components/AutomaticRecoverySettings.tsx",
  "src/components/BoatOffer.tsx",
  "src/components/BrowserProfilesManager.tsx",
  "src/components/BrowserSettingsRows.tsx",
  "src/components/CacheKeepWarmSettings.tsx",
  "src/components/CloudAccountSettings.tsx",
  "src/components/CloudKeepHere.tsx",
  "src/components/CloudUsageMeter.tsx",
  "src/components/ConnectedWorkspacesSettings.tsx",
  "src/components/CustomDomainSettings.tsx",
  "src/components/DecisionModelSettings.tsx",
  "src/components/DiagnosticsRow.tsx",
  "src/components/EnginesSettings.tsx",
  "src/components/EveryBotRules.tsx",
  "src/components/HomeLine.tsx",
  "src/components/ImageGenerationSettings.tsx",
  "src/components/ImportSettings.tsx",
  "src/components/LiveProviderSettings.tsx",
  "src/components/LocalComputerSection.tsx",
  "src/components/MacLocalControl.tsx",
  "src/components/McpCallTimeoutSettings.tsx",
  "src/components/NewBotDialog.tsx",
  "src/components/OllamaServer.tsx",
  "src/components/OpenAiCompatServers.tsx",
  "src/components/OrganizationSettings.tsx",
  "src/components/PairedPhones.tsx",
  "src/components/PhoneDevicesSection.tsx",
  "src/components/PhonesList.tsx",
  "src/components/PinnedPanelsSettings.tsx",
  "src/components/PlaceLookCard.tsx",
  "src/components/PlanUsage.tsx",
  "src/components/ProIntroduction.tsx",
  "src/components/ProfileSettings.tsx",
  "src/components/RoomTurnTimeoutSettings.tsx",
  "src/components/Select.tsx",
  "src/components/ServerList.tsx",
  "src/components/ServerPairingCard.tsx",
  "src/components/SettingsModal.tsx",
  "src/components/SettingsPrimitives.tsx",
  "src/components/ShareLearnedSkillsSettings.tsx",
  "src/components/SidebarPhoneButton.tsx",
  "src/components/SidebarPopoverMenu.tsx",
  "src/components/SidebarProfileMenu.tsx",
  "src/components/SkillReviewSettings.tsx",
  "src/components/SkinPicker.tsx",
  "src/components/SwatchRadios.tsx",
  "src/components/ThreadCleanupSettings.tsx",
  "src/components/ThreadConcurrencySettings.tsx",
  "src/components/UsageSection.tsx",
  "src/components/VaultSettings.tsx",
  "src/components/VpsComputersCard.tsx",
  "src/components/WindowFrameBar.tsx",
  "src/components/WorkersAiKeyCard.tsx",
  "src/components/WorkspaceBackupSettings.tsx",
  "src/components/keys/KeyPanels.tsx",
  "src/components/keys/KeyRow.tsx",
  "src/components/keys/KeysPage.tsx",
  "src/components/settings/AdvancedSection.tsx",
  "src/components/settings/DesktopKinds.tsx",
  "src/components/settings/SettingsDialog.tsx",
  "src/components/settings/SettingsNav.tsx",
  "src/components/settings/SettingsPageHeader.tsx",
  "src/components/settings/SettingsStates.tsx",
  "src/components/settings/SettingsWindow.tsx",
  "src/components/settings/SignOutConfirm.tsx",
  "src/components/settings/inert.tsx",
  "src/components/settings/pages/AccountPages.tsx",
  "src/components/settings/pages/AppPages.tsx",
  "src/components/settings/pages/DataPages.tsx",
  "src/components/settings/pages/PhonePage.tsx",
  "src/components/settings/pages/PlacePages.tsx",
  "src/components/settings/pages/SettingsPageBody.tsx",
  "src/components/settings/plan-parts.tsx",
  "src/components/usage/TraceWaterfall.tsx",
];

/** Known debt: how many off-scale classes each file still has. Lower a count when you fix one; never raise it. */
const DEBT: Record<string, number> = {
  "src/components/AboutMeSettings.tsx": 2,
  "src/components/ActivitySection.tsx": 4,
  "src/components/BrowserProfilesManager.tsx": 10,
  "src/components/CloudAccountSettings.tsx": 2,
  "src/components/CloudUsageMeter.tsx": 9,
  "src/components/EnginesSettings.tsx": 16,
  "src/components/HomeLine.tsx": 1,
  "src/components/ImportSettings.tsx": 8,
  "src/components/LocalComputerSection.tsx": 11,
  "src/components/MacLocalControl.tsx": 2,
  "src/components/NewBotDialog.tsx": 11,
  "src/components/OrganizationSettings.tsx": 3,
  "src/components/PhoneDevicesSection.tsx": 5,
  "src/components/PlanUsage.tsx": 3,
  "src/components/ProIntroduction.tsx": 2,
  "src/components/ProfileSettings.tsx": 3,
  "src/components/Select.tsx": 9,
  "src/components/ServerList.tsx": 4,
  "src/components/SettingsPrimitives.tsx": 3,
  "src/components/SidebarPopoverMenu.tsx": 1,
  "src/components/SidebarProfileMenu.tsx": 2,
  "src/components/SkinPicker.tsx": 6,
  "src/components/SwatchRadios.tsx": 2,
  "src/components/UsageSection.tsx": 11,
  "src/components/VaultSettings.tsx": 6,
  "src/components/VpsComputersCard.tsx": 5,
  "src/components/WorkspaceBackupSettings.tsx": 1,
  "src/components/keys/KeyRow.tsx": 3,
  "src/components/keys/KeysPage.tsx": 2,
  "src/components/usage/TraceWaterfall.tsx": 15,
};

describe("Settings' closed scales (§6.8)", () => {
  it.each(FILES)("%s adds no class outside the scales", (file) => {
    const found = readFileSync(file, "utf8").match(OFF_SCALE) ?? [];
    const allowed = DEBT[file] ?? 0;
    expect(found.length, `off-scale classes in ${file}: ${found.join(" ")}`).toBeLessThanOrEqual(allowed);
  });

  it("keeps the debt list honest: a file that got cleaner says so here", () => {
    const stale = Object.entries(DEBT).filter(([file, allowed]) => (readFileSync(file, "utf8").match(OFF_SCALE) ?? []).length < allowed);
    expect(stale.map(([file]) => file)).toEqual([]);
  });
});
