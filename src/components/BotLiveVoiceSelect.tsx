import { botCallVoice, GEMINI_LIVE_VOICE_OPTIONS, LIVE_VOICE_OPTIONS } from "../../shared/live-call";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { Select } from "./Select";

/** The bot's own Live call voice. Empty follows the app's default call voice; a saved voice of the other provider's kind shows as the default. */
export function BotLiveVoiceSelect({ bot, gemini, onChange }: {
  bot: Pick<Bot, "name" | "liveVoice">;
  gemini: boolean;
  onChange: (liveVoice: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-ink-secondary">{t("call.live.botVoice", { name: bot.name })}</span>
      <Select size="sm" value={botCallVoice(bot.liveVoice, "", gemini)} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t("call.live.botVoiceDefault")}</option>
        {(gemini ? GEMINI_LIVE_VOICE_OPTIONS : LIVE_VOICE_OPTIONS).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </Select>
    </label>
  );
}
