// Reply style: Default keeps today's replies, Conversational asks for short
// plain replies that the chat shows as several small bubbles.
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { REPLY_STYLES, type ReplyStyle } from "../../../shared/reply-style";
import type { BotPatch } from "./useBotSettingsDerived";

const LABELS = {
  default: ["botSettings.replyStyle.default", "botSettings.replyStyle.defaultHint"],
  conversational: ["botSettings.replyStyle.conversational", "botSettings.replyStyle.conversationalHint"],
} as const satisfies Record<ReplyStyle, readonly [string, string]>;

export function ReplyStyleField({ bot, patch }: { bot: Bot; patch: (patch: BotPatch) => void }) {
  const current: ReplyStyle = bot.replyStyle ?? "default";
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card p-4" data-reply-style>
      <div>
        <div className="text-[15px] font-medium text-ink">{t("botSettings.replyStyle.title")}</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">{t("botSettings.replyStyle.subtitle")}</div>
      </div>
      <div role="radiogroup" aria-label={t("botSettings.replyStyle.title")} className="flex flex-col gap-2">
        {REPLY_STYLES.map((style) => (
          <label key={style} className="flex cursor-pointer items-start gap-2 text-[13px] text-ink">
            <input
              type="radio"
              className="mt-1"
              name={`reply-style-${bot.id}`}
              value={style}
              checked={current === style}
              onChange={() => patch({ replyStyle: style })}
            />
            <span>
              {t(LABELS[style][0])}
              <span className="block text-[12px] text-ink-secondary">{t(LABELS[style][1])}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
