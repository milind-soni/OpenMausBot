import { X } from "lucide-react";

import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { useStore, type Message } from "@/state/store";
import { HelperSetup } from "./HelperSetup";

export const HELPER_ASK_KEYS: readonly LocaleKey[] = [
  "helperIntro.ask.overview", "helperIntro.ask.inbox", "helperIntro.ask.routine", "helperIntro.ask.howto",
];

/** MausBot's first message, in the viewer's language. Its asks go once one is tapped, it is dismissed, or the person
 * writes anything after it (`asksDone`). */
export function HelperIntro({ botId, threadId, message, asksDone }: { botId: string; threadId: string; message: Message; asksDone: boolean }) {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const name = bot?.name ?? "MausBot";
  const team = bot?.defaultBot?.person ? state.config?.team?.name : undefined;
  const ask = (key: LocaleKey) => dispatch({ type: "answerCard", botId, threadId, messageId: message.id, answer: t(key) });
  return (
    <div data-helper-intro={message.id} className="flex w-full flex-col items-start gap-2">
      <div className="w-fit max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed text-ink">
        <p className="font-medium">{t("helperIntro.title", { name })}</p>
        <p className="mt-1">{t("helperIntro.body")}</p>
        {bot?.chiefOfStaff && <p className="mt-1">{t("helperIntro.chief")}</p>}
        {team && <p className="mt-1">{t("helperIntro.team", { team })}</p>}
        {!asksDone && <p className="mt-1 text-ink-secondary">{t("helperIntro.try")}</p>}
      </div>
      {!asksDone && <HelperSetup />}
      {!asksDone && (
        <div role="group" aria-label={t("helperIntro.asks")} className="flex max-w-full flex-wrap items-center gap-1.5">
          {HELPER_ASK_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              data-helper-ask={key}
              onClick={() => ask(key)}
              className="rounded-full border border-hairline/60 bg-app px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
            >
              {t(key)}
            </button>
          ))}
          <button
            type="button"
            data-helper-dismiss=""
            onClick={() => dispatch({ type: "dismissCard", botId, threadId, messageId: message.id })}
            aria-label={t("helperIntro.dismiss")}
            title={t("helperIntro.dismiss")}
            className="flex size-7 items-center justify-center rounded-full text-ink-tertiary hover:bg-raised-hover hover:text-ink"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
