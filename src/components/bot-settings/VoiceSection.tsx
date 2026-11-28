import { requestNotificationPermission } from "@/lib/notify";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { type Bot } from "@/state/store";
import { Select } from "../Select";
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
  const canChooseService = useOwnerOrAdmin() === true;
  const override = bot.liveOverride;
  const provider = override?.provider ?? live?.provider;
  const liveVoicePicker = (override || live?.configured) && provider !== "fish" && provider !== "elevenlabs";
  const fishAgentId = override?.provider === "fish" ? override.fishAgentId ?? "" : "";

  return (
    <div className="flex flex-col gap-4">
      <VoiceSettings bot={bot} onPatch={patch} />

      {!draft && (canChooseService || liveVoicePicker) && (
        <div data-live-call-voice className="flex flex-col gap-2 rounded-xl bg-card p-4 text-[13px]">
          <div>
            <div className="text-[15px] font-medium text-ink">{t("voice.liveCall.title")}</div>
            <div className="mt-0.5 text-ink-secondary">{t("voice.liveCall.help")}</div>
          </div>
          {canChooseService && <label className="flex items-center justify-between gap-2">
            <span className="text-ink-secondary">{t("call.live.provider")}</span>
            <Select size="sm" value={override?.provider ?? ""} onChange={(event) => {
              const provider = event.target.value;
              patch({ liveOverride: provider === "fish" || provider === "openai" ? { provider } : null });
            }}>
              <option value="">{t("voice.liveCall.workspaceProvider")}</option>
              <option value="openai">{t("call.live.provider.openai")}</option>
              <option value="fish">{t("call.live.provider.fish")}</option>
            </Select>
          </label>}
          {canChooseService && override?.provider === "fish" && <label className="flex flex-col gap-1 text-ink-secondary">
            {t("voice.liveCall.fishAgentId")}
            <input key={`${bot.id}:${fishAgentId}`} defaultValue={fishAgentId} type="text" maxLength={128} pattern="[A-Za-z0-9_\-]{1,128}"
              className="rounded-lg border border-hairline bg-inset px-3 py-2 text-ink invalid:border-danger"
              onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur(); }}
              onBlur={(event) => {
                const id = event.currentTarget.value.trim();
                event.currentTarget.value = id;
                if (!event.currentTarget.reportValidity() || id === fishAgentId) return;
                patch({ liveOverride: id ? { provider: "fish", fishAgentId: id } : { provider: "fish" } });
              }} />
            <span className="text-[12px] text-ink-tertiary">{t("voice.liveCall.fishAgentHelp")}</span>
          </label>}
          {liveVoicePicker && <BotLiveVoiceSelect bot={bot} gemini={provider === "gemini"} onChange={(liveVoice) => patch({ liveVoice })} />}
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
