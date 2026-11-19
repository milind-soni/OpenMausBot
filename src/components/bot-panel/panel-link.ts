import type { Action, BotSettingsSection } from "@/state/store";

export function openBotSettings(
  dispatch: (action: Action) => void,
  section: BotSettingsSection,
  { botId }: { botId?: string } = {},
): void {
  dispatch({ type: "toggleSettings", open: true, section, ...(botId !== undefined ? { botId } : {}) });
}
