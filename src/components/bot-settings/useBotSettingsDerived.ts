// Every value the old SettingsPanel derived from state before rendering,
// lifted verbatim (SettingsPanel.tsx:541-611) so the section files that
// consume them (Identity, Soul, and — in later commits — the rest) can
// stay pure prop-takers. This hook is the one place in the bot settings
// dialog that still reaches into useStore.
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { browserAvailable, browserUnavailableReason, builtInBrowserEnabled } from "@/lib/feature-flags";
import { instanceSupportsLocalComputer, localComputerDisabledReason, localComputerSelectable } from "@/lib/local-computer";
import { stateForBot } from "@/lib/mascot";
import { placeOffered } from "@/lib/place";
import { useStore, type Bot } from "@/state/store";
import { approvalModeFor } from "../../../shared/approval-mode";
import { connectorGrantsState, type ConnectorGrantsState } from "@/lib/connector-grants";

export type BotPatch = Partial<
  Pick<
    Bot,
    | "name"
    | "title"
    | "description"
    | "soul"
    | "notifications"
    | "cloudBackend"
    | "autoStartVps"
    | "color"
    | "mascotExpression"
    | "mascotBody"
    | "avatarUrl"
    | "avatarCrop"
    | "avatarZoom"
    | "avatarFocusX"
    | "avatarFocusY"
    | "alwaysAllow"
    | "autoApprove"
    | "approvalMode"
    | "speakReplies"
    | "voice"
    | "chiefOfStaff"
    | "managedSections"
    | "approvePeerComms"
    | "composio"
    | "browser"
    | "mcpServers"
    | "modelSelection"
  >
> & {
  computer?: Bot["computer"] | null;
  /** null drops the explicit record and returns the bot to the legacy
   * all-tools boolean. */
  connectorTools?: Bot["connectorTools"] | null;
  acknowledgeLocalAuto?: boolean;
  confirmFullAccess?: boolean;
  acknowledgePeerScope?: boolean;
};

export function useBotSettingsDerived(bot: Bot) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  // An OMB Cloud home never offers this computer (shared/cloud-home.ts).
  const localSelectable = placeOffered("local", state.config) && localComputerSelectable({ capabilities, providerSupportsLocal });
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  const patch = (p: BotPatch) => dispatch({ type: "updateBot", botId: bot.id, patch: p });
  const activeState = stateForBot(bot);
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  // The approval level (ask / auto / full / custom) as the shared rule reads
  // it from the record — bots saved before approvalMode existed still carry
  // only autoApprove. Full and Custom need the packaged desktop's trusted
  // channel (SettingsPanel used the same test before the dialog replaced it).
  const approvalMode = approvalModeFor(bot);
  const trustedModesAvailable = Boolean(window.ogb?.approvals && capabilities.host.packaged);
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const canUseConnectedApps = engine?.capabilities?.composioMcp === true;
  const canUseVps = engine?.capabilities?.computerMcp === true && engine.driverKind !== "boxAgent";
  const connectedAppsConfigured = state.config?.composio?.configured === true;
  const connectedAppsEnabled = bot.composio !== false;
  const connectorGrantState: ConnectorGrantsState = connectorGrantsState(bot);
  const canUseBrowser = engine?.capabilities?.browserMcp === true;
  const desktopBrowser = browserAvailable(state.config);
  const browserBlockedOnWindows = window.ogb?.platform === "win32" && !desktopBrowser;
  const browserFeature = builtInBrowserEnabled(state.config);
  const browserAllowed = bot.browser !== false;
  const browserEnabled = browserFeature && browserAllowed;
  // "Works on: Browser" needs everything the switch needs except the switch
  // itself; the boat-native Computer engine has no browser-only mode.
  const browserSelectable = desktopBrowser && browserFeature && canUseBrowser && engine?.driverKind !== "boxAgent";
  const browserDisabledReason = !desktopBrowser
    ? browserUnavailableReason(state.config)
    : !browserFeature
      ? "The built-in browser is switched off under App Settings → Experimental"
      : "This model engine cannot use the built-in browser";
  const sectionName = bot.section?.trim() || "General";
  const currentChief = state.bots.find(
    (candidate) =>
      candidate.chiefOfStaff &&
      (candidate.section?.trim() || "") === (bot.section?.trim() || ""),
  );
  const botRoutines = state.routines.filter((routine) => routine.botId === bot.id);
  const activeBotRoutines = botRoutines.filter((routine) => routine.enabled).length;

  return {
    patch,
    engine,
    approvalMode,
    trustedModesAvailable,
    canCoordinate,
    canUseConnectedApps,
    canUseVps,
    connectedAppsConfigured,
    connectedAppsEnabled,
    connectorGrantState,
    canUseBrowser,
    desktopBrowser,
    browserBlockedOnWindows,
    browserFeature,
    browserAllowed,
    browserEnabled,
    browserSelectable,
    browserDisabledReason,
    sectionName,
    currentChief,
    botRoutines,
    activeBotRoutines,
    localSelectable,
    localDisabledReason,
    activeState,
    mascotMotion,
  };
}
