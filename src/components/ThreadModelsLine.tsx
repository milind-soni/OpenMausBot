// "Switch them too": beside a bot's model, how many of its threads run on a
// model of their own, and one button that moves them onto the bot's. A
// one-time action, not a setting; nothing shows while every thread follows
// the bot.
import { threadsOnOwnModel } from "../../shared/thread-model";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";

export function ThreadModelsLine({ bot, className }: { bot: Bot; className?: string }) {
  const { dispatch } = useStore();
  const count = threadsOnOwnModel(bot.modelSelection, bot.tasks ?? []).length;
  if (count === 0) return null;
  return (
    <div data-thread-models className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-secondary", className)}>
      <span>{count === 1 ? t("model.threadsOwnModelOne") : t("model.threadsOwnModel", { count })}</span>
      <button
        type="button"
        data-switch-them-too
        onClick={() => dispatch({ type: "followBotModel", botId: bot.id })}
        className="-mx-1.5 rounded-lg px-1.5 py-0.5 text-[12.5px] font-medium text-accent-text hover:bg-control/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {count === 1 ? t("model.switchItToo") : t("model.switchThemToo")}
      </button>
    </div>
  );
}
