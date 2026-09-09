// Voice & alerts: this bot's spoken-reply voice and its desktop/phone
// notifications. Moved verbatim from SettingsPanel.tsx (VoiceSettings
// mount ~1026, Notifications ~1028-1046).
import { requestNotificationPermission } from "@/lib/notify";
import type { Bot } from "@/state/store";
import { Switch } from "../SettingsPrimitives";
import { VoiceSettings } from "../VoiceSettings";
import type { useBotSettingsDerived } from "./useBotSettingsDerived";

export function VoiceSection({
  bot,
  derived,
}: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
}) {
  const { patch } = derived;

  return (
    <div className="flex flex-col gap-4">
      <VoiceSettings bot={bot} onPatch={patch} />

      <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
        <div>
          <div className="text-[15px] font-medium text-ink">Notifications</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Get notified when this agent finishes or needs input
          </div>
        </div>
        <Switch
          checked={bot.notifications}
          aria-label="Agent notifications"
          onClick={() => {
            const enabled = !bot.notifications;
            if (enabled) void requestNotificationPermission();
            patch({ notifications: enabled });
          }}
        />
      </div>
    </div>
  );
}
