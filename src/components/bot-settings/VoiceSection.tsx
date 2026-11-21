import { requestNotificationPermission } from "@/lib/notify";
import { t } from "@/lib/i18n";
import { type Bot } from "@/state/store";
import { BotLiveVoiceSelect } from "../BotLiveVoiceSelect";
import { Switch } from "../SettingsPrimitives";
import { VoiceSettings } from "../VoiceSettings";
import type { useBotSettingsDerived } from "./useBotSettingsDerived";
import { useBotEditor } from "./BotEditorContext";
import { sameFields, useStoreSelector } from "@/state/store-select";

export function VoiceSection({
  bot,
  derived,
}: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
}) {
  const { patch } = derived;
  const { draft } = useBotEditor();
  const state = useStoreSelector((s) => ({ config: s.config }), sameFields);
  const live = state.config?.live;
  // Fish Audio and ElevenLabs calls speak in their agent's own voice, so only the other providers have a voice to pick.
  // A bot being created has no call voice yet: new-bot defaults don't keep one.
  const liveVoicePicker = !draft && live?.configured && live.provider !== "fish" && live.provider !== "elevenlabs";

  return (
    <div className="flex flex-col gap-4">
      <VoiceSettings bot={bot} onPatch={patch} />

      {liveVoicePicker && (
        <div data-live-call-voice className="flex flex-col gap-2 rounded-xl bg-card p-4 text-[13px]">
          <div>
            <div className="text-[15px] font-medium text-ink">{t("voice.liveCall.title")}</div>
            <div className="mt-0.5 text-ink-secondary">{t("voice.liveCall.help")}</div>
          </div>
          <BotLiveVoiceSelect bot={bot} gemini={live.provider === "gemini"} onChange={(liveVoice) => patch({ liveVoice })} />
          <div className="text-[12px] text-ink-tertiary">{t("call.live.voiceNext")}</div>
        </div>
      )}

      <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
        <div>
          <div className="text-[15px] font-medium text-ink">{t("voice.notifications.title")}</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            {t("voice.notifications.help")}
          </div>
        </div>
        <Switch
          checked={bot.notifications}
          aria-label={t("voice.notifications.label")}
          onClick={() => {
            const enabled = !bot.notifications;
            if (enabled && !draft) void requestNotificationPermission();
            patch({ notifications: enabled });
          }}
        />
      </div>
    </div>
  );
}
