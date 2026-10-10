// What a popup in the window's corner waits for. The Pro introduction and the
// free trial's notice share it, so neither shows over onboarding, an open
// dialog or panel, or an update being offered.
import { emailGateDone } from "@/lib/analytics";
import { currentStep } from "@/lib/guided-tour";
import { welcomeDue, type WelcomeViewer } from "@/lib/onboarding";
import type { UpdaterState } from "@/lib/updater";
import type { AppState } from "@/state/store";

/** True while a corner popup should stay away: the server has not answered,
 * the welcome flow or guided tour is due or open, a dialog or panel is open,
 * an update is being offered, or the caller is `quiet`. `idle`: also while
 * any bot or room is working. `viewer`: who is looking, so a Cloud's own page
 * (whose first run is its engine sign-in) is not taken for a fresh install. */
export function cornerPopupWaits(state: AppState, updater: UpdaterState | null,
  { quiet = false, idle = false, viewer }: { quiet?: boolean; idle?: boolean; viewer?: WelcomeViewer | null } = {}): boolean {
  const record = state.config?.onboarding;
  const busy = idle && (state.bots.some(bot => bot.busy || bot.tasks?.some(task => task.busy))
    || state.groups.some(group => group.working || group.busyBotId));
  const setup = state.welcomeOpen || state.tourOpen || (Boolean(record?.completedAt) && currentStep(record) !== null)
    || welcomeDue(state.config, { remoteClient: false, legacyDone: emailGateDone(), ...(viewer ? { hosted: viewer.hosted, canSave: viewer.canSave, cloudHome: viewer.cloudHome } : {}) });
  return !state.connected || !state.config || setup || busy || quiet
    || state.appSettingsOpen || state.settingsOpen || state.newBotOpen || state.pluginsOpen || state.triggersOpen || state.shortcutsOpen
    || Boolean(updater && !["idle", "checking"].includes(updater.status));
}
