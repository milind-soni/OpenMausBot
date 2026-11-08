import { Calendar, CalendarPlus, Sparkles } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { useChatMoreItems } from "../ChatMoreMenu";
import { ModelPicker } from "../ModelPicker";
import type { SidebarMenuItem } from "../SidebarPopoverMenu";
import type { useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import { BotConversations } from "./Conversations";
import type { SimplePageId } from "./page-registry";
import { TryAsking } from "./TryAsking";
import { Card, CardLabel, panelActionCls, NavRow, RowIcon, rowCls, RowText } from "./rows";

type Derived = ReturnType<typeof useBotSettingsDerived>;

export const CONVERSATION_ITEMS = ["find", "usage", "activity"];

/** A ⋯ menu item drawn as a panel row: the same label, icon, value and handler. */
export function ItemRow({ item }: { item: SidebarMenuItem }) {
  // Only the usage value is long text that should wrap; shortcuts and other values keep their full width.
  const wrapsValue = item.key === "usage";
  return (
    <button
      type="button"
      data-panel-item={item.key}
      disabled={item.disabled}
      aria-pressed={item.active || undefined}
      onClick={item.onSelect}
      className={cn(rowCls, "w-full text-left enabled:hover:bg-ink/[0.03] disabled:cursor-default disabled:opacity-45")}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-ink/[0.05] text-ink-secondary [&_svg]:size-[15px]" aria-hidden="true">
        {item.icon}
      </span>
      <span className={cn("min-w-0 truncate text-[14px] font-medium", !wrapsValue && "flex-1", item.active ? "text-accent-text" : "text-ink")}>{item.label}</span>
      {item.trailing && <span className={cn("flex items-center", wrapsValue ? "min-w-0 flex-1 justify-end text-right" : "shrink-0")}>{item.trailing}</span>}
    </button>
  );
}

export function DetailsTab({ bot, derived, onOpen }: {
  bot: Bot;
  derived: Derived;
  onOpen: (page: SimplePageId) => void;
}) {
  const { items } = useChatMoreItems(bot);
  const routinesOn = derived.botRoutines.filter((routine) => routine.enabled).length;
  const conversationItems = CONVERSATION_ITEMS.flatMap((key) => items.filter((item) => item.key === key));

  return (
    <div data-panel-tabpanel="details">
      <Card anchor="model">
        <div data-panel-row="model" className={rowCls}>
          <ModelPicker
            bot={bot}
            contained
            threadId={bot.threadId}
            label={<span className="flex shrink-0 items-center gap-2.5"><RowIcon icon={Sparkles} /><RowText title={t("model.simple.model")} /></span>}
          />
        </div>
      </Card>

      <BotConversations bot={bot} />

      {derived.botRoutines.length === 0 ? (
        <section data-panel-empty="routines">
          <CardLabel>{t("botSettings.simple.routines")}</CardLabel>
          <p className="mx-1 text-[13px] leading-[18px] text-ink-tertiary">{t("botPanel.routines.empty")}</p>
          <button
            type="button"
            data-panel-page="routines"
            onClick={() => onOpen("routines")}
            className={cn(panelActionCls, "mt-2.5 w-full")}
          >
            <CalendarPlus size={15} aria-hidden="true" className="shrink-0 text-ink-secondary" />
            <span className="truncate">{t("botPanel.routines.add")}</span>
          </button>
        </section>
      ) : (
        <Card label={t("botSettings.simple.routines")} anchor="routines">
          <NavRow
            data-panel-page="routines"
            icon={Calendar}
            title={t("botSettings.simple.routines")}
            value={routinesOn > 0 ? t("botPanel.routinesOn", { count: routinesOn }) : t("botPanel.none")}
            onClick={() => onOpen("routines")}
          />
        </Card>
      )}

      <TryAsking bot={bot} />

      {conversationItems.length > 0 && (
        <Card label={t("botPanel.section.conversation")} anchor="conversation">
          {conversationItems.map((item) => <ItemRow key={item.key} item={item} />)}
        </Card>
      )}
    </div>
  );
}
