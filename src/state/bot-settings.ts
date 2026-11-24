import type { Action, AppState } from "./store";

export function toggleBotSettings(state: AppState, action: Extract<Action, { type: "toggleSettings" }>): AppState {
  if (action.botId !== undefined && !state.bots.some((bot) => bot.id === action.botId && !bot.hidden)) return state;
  const selectedId = action.fromPane ? state.selectedId : action.botId ?? state.selectedId;
  const open = action.open ?? (action.botId !== undefined || !state.settingsOpen);
  const freshOpen = open && !state.settingsOpen;
  const named = action.section !== undefined;
  return {
    ...state,
    selectedId,
    settingsOpen: open,
    settingsPaneBotId: action.fromPane && open ? action.botId
      : open && state.settingsOpen && !action.botId ? state.settingsPaneBotId : undefined,
    activityOpen: open ? false : state.activityOpen,
    botSettingsSection: action.section ?? state.botSettingsSection,
    botSettingsExpandAccordion: open ? named || (freshOpen && state.botSettingsSectionStored) : false,
    botSettingsExpandRemembered: open ? !named && freshOpen && state.botSettingsSectionStored : false,
    botSettingsSectionStored: named || state.botSettingsSectionStored,
    appSettingsOpen: open ? false : state.appSettingsOpen,
  };
}
