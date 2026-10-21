import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { openBotSettings } from "./bot-panel/panel-link";

export function BotAccessButtons() {
  const { state, dispatch } = useStore();
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {(state.bots ?? []).filter((bot) => !bot.hidden).map((bot) => (
        <button
          key={bot.id}
          type="button"
          onClick={() => { dispatch({ type: "togglePlugins", open: false }); openBotSettings(dispatch, "access", { botId: bot.id, page: "mcp" }); }}
          className="rounded-lg bg-control px-2.5 py-1.5 text-ink hover:bg-raised-hover"
        >
          {t("whop.botSettings", { name: bot.name })}
        </button>
      ))}
    </div>
  );
}

export function BotAccessDisclosure({ paragraphs }: { paragraphs: string[] }) {
  return (
    <details className="mt-1 text-[12px] text-ink-secondary">
      <summary className="cursor-pointer">{t("whop.access")}</summary>
      {paragraphs.map((text) => <p key={text} className="mt-2 leading-relaxed">{text}</p>)}
      <BotAccessButtons />
    </details>
  );
}
