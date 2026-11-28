// Where a page crash happened, by a fixed word: the script file the failing component came from. A built page's
// component names are shortened by the minifier, but its files keep their module's name (App, SettingsModal, ...), and a
// component stack names the file each component came from. Only a name from CRASH_AREAS leaves; any other is "other".
export const CRASH_AREAS = [
  "App", "index", "rail", "ActivityPanel", "AnnouncementsPage", "AppEventEditor", "BotSettingsDialog",
  "BrowserDesktop", "BrowserPanel", "BrowserProfilesManager", "CloudAddDialog", "CommandAllowlistDialog",
  "ComputerFilesPane", "ComputerPanel", "CookieImportDialog", "DataPanel", "DesktopViewer", "EnginesSettings",
  "FilesView", "GrokMoveDialog", "ImportDialog", "InboxPanel", "InspectorPanel", "KeyboardShortcutsModal",
  "LiveDesktop", "LocalVmWorkspace", "MacLocalControl", "MarkdownFilePreview", "MenuMotion", "NewBotDialog",
  "PhoneAppDialog", "PlacesRail", "PluginsPanel", "ProIntroduction", "PublishedAppsPage",
  "RemoteAgentSettingsPanel", "RoomPanel", "RoutinesPage", "SavedWorkflowsCard", "ServerPairingCard",
  "SettingsModal", "ShareBotDialog", "ShareTemplateDialog", "SignedInSites", "SkillBurgersPage",
  "TailnetComputers", "TeamDialog", "TeamFilesPage", "TeamLibraryPanel", "TeamMapPage", "TeamSettingsDialog",
  "ToolPageShell", "TraceView", "TriggersPage", "VisibilitySection", "VoiceSettings", "VoiceSetupDialog",
  "WebhookTrigger", "WhatChangedView", "WorksOnGrid",
] as const;
export type CrashArea = (typeof CRASH_AREAS)[number];

const KNOWN = new Set<string>(CRASH_AREAS);
/** A built chunk (`/assets/App-BM6OOWwA.js`) or a source module in development (`/src/components/App.tsx?t=1`). */
const FRAME_FILE = /\/(?:assets\/([A-Za-z][\w.]*?)-[\w-]{8}\.js|src\/(?:[\w-]+\/)*([A-Za-z][\w.-]*?)\.tsx?)(?:[?#][^:)\s]*)?:\d+(?::\d+)?\)?\s*$/;

/** The area of the component that threw: the first frame of React's component stack whose file it can name. */
export function crashArea(componentStack: string | null | undefined): CrashArea | "other" {
  for (const line of String(componentStack ?? "").split("\n")) {
    const match = FRAME_FILE.exec(line.trim());
    if (!match) continue;
    const name = match[1] ?? match[2] ?? "";
    return KNOWN.has(name) ? (name as CrashArea) : "other";
  }
  return "other";
}
