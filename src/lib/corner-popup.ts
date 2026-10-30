import { emailGateDone } from "@/lib/analytics";
import { hintSeen, MET_CHIEF_HINT, welcomeDue, type WelcomeViewer } from "@/lib/onboarding";
import type { UpdaterState } from "@/lib/updater";
import type { AppState } from "@/state/store";

export function cornerPopupWaits(state: AppState, updater: UpdaterState | null,
  { quiet = false, idle = false, viewer }: { quiet?: boolean; idle?: boolean; viewer?: WelcomeViewer | null } = {}): boolean {
  const busy = idle && (state.bots.some(bot => bot.busy || bot.tasks?.some(task => task.busy))
    || state.groups.some(group => group.working || group.busyBotId));
  const setup = state.welcomeOpen || state.tourOpen
    || welcomeDue(state.config, { remoteClient: false, legacyDone: emailGateDone(), ...(viewer ? { hosted: viewer.hosted, canSave: viewer.canSave, cloudHome: viewer.cloudHome } : {}) });
  return !state.connected || !state.config || setup || busy || quiet || firstChatQuiet(state)
    || state.appSettingsOpen || state.settingsOpen || state.pluginsOpen || state.shortcutsOpen
    || Boolean(updater && (!["idle", "checking"].includes(updater.status) || updater.updated));
}

/** No bot or room has finished a turn yet: a new install's first chat. Promotions wait for its first reply. Unknown (null)
 * until the first snapshot has loaded the bots. */
export function firstReplyPending(state: Pick<AppState, "bots" | "groups" | "hydrated">): boolean | null {
  if (!state.hydrated) return null;
  const answered = (usage: { turns: number } | null | undefined) => (usage?.turns ?? 0) > 0;
  return !state.bots.some((bot) => bot.tasks?.some((task) => answered(task.usage))) && !state.groups.some((group) => answered(group.usage));
}

/** After a first run that met the Chief, its first conversation stays the person's: every corner notice waits until
 * they have written and had a reply. */
export function firstChatQuiet(state: Pick<AppState, "bots" | "groups" | "hydrated" | "config">): boolean {
  return hintSeen(state.config?.onboarding, MET_CHIEF_HINT) && firstReplyPending(state) !== false;
}
