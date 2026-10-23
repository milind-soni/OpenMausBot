import { EyeOff } from "lucide-react";

import { t } from "@/lib/i18n";
import { DEFAULT_BOT_NAME, myDefaultBot, useViewerEmail } from "@/lib/default-bot";
import { useStore, type Action, type Bot } from "@/state/store";
import { Card, NavRow } from "./bot-panel/rows";
import { SettingRow, Switch } from "./SettingsPrimitives";

/** Hiding MausBot is the Settings switch turned off: one place says whether it is in the sidebar. */
export function showDefaultBot(dispatch: (action: Action) => void, bot: Pick<Bot, "id" | "name">, shown: boolean): void {
  dispatch({ type: "updateBot", botId: bot.id, patch: { sidebarHidden: !shown } });
  if (!shown) dispatch({ type: "notice", notice: { kind: "note", botName: null, text: t("defaultBot.hidden", { name: bot.name }) } });
}

export function HideDefaultBotItem({ bot, onDone }: { bot: Bot; onDone: () => void }) {
  const { dispatch } = useStore();
  return (
    <button
      type="button"
      role="menuitem"
      data-default-bot-hide=""
      onClick={() => { showDefaultBot(dispatch, bot, false); onDone(); }}
      title={t("defaultBot.hideHint")}
      className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
    >
      <EyeOff size={16} className="text-ink-secondary" />
      {t("defaultBot.hide")}
    </button>
  );
}

/** Settings → General: whether the viewer's own MausBot has a row in the sidebar. */
export function DefaultBotSidebarRow() {
  const { state, dispatch } = useStore();
  const bot = myDefaultBot(state.bots, useViewerEmail());
  if (!bot) return null;
  const shown = !bot.sidebarHidden;
  return (
    <SettingRow title={t("defaultBot.show.title", { name: bot.name || DEFAULT_BOT_NAME })} subtitle={t("defaultBot.show.subtitle")}>
      <Switch
        checked={shown}
        data-default-bot-shown=""
        aria-label={t("defaultBot.show.title", { name: bot.name || DEFAULT_BOT_NAME })}
        onClick={() => showDefaultBot(dispatch, bot, !shown)}
      />
    </SettingRow>
  );
}

/** Bot settings: MausBot is never deleted, only taken off the sidebar. */
export function DefaultBotHideRow({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  if (!bot.defaultBot || bot.sidebarHidden) return null;
  return (
    <Card anchor="default-bot">
      <NavRow
        data-panel-row="default-bot-hide"
        icon={EyeOff}
        title={t("defaultBot.hide")}
        hint={t("defaultBot.hideHint")}
        drill={false}
        onClick={() => showDefaultBot(dispatch, bot, false)}
      />
    </Card>
  );
}
