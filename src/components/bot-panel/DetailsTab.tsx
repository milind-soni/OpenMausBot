import { ChevronRight, Sparkles } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { currentTaskBot, type Bot } from "@/state/store";
import { useChatMoreItems } from "../ChatMoreMenu";
import { EffortRow, ModelPicker } from "../ModelPicker";
import type { SidebarMenuItem } from "../SidebarPopoverMenu";
import type { useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import { BotConversations } from "./Conversations";
import { BotKeeps } from "./Keeps";
import type { SimplePageId } from "./page-registry";
import { CardLabel, RowIcon, rowCls, RowText } from "./rows";
import { useStoreSelector } from "@/state/store-select";
import { newChatBot } from "@/state/new-chat";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { approvalModeFor, modelSwitchNeedsAsk } from "../../../shared/approval-mode";

type Derived = ReturnType<typeof useBotSettingsDerived>;

export const CONVERSATION_ITEMS = ["find", "start-fresh", "share-team", "share-person", "usage", "activity", "inspector"];

/** A ⋯ menu item drawn as a panel row: the same label, icon, value and handler. */
export function ItemRow({ item }: { item: SidebarMenuItem }) {
  // Only the usage value is long text that should wrap; shortcuts and other values keep their full width.
  const wrapsValue = item.key === "usage";
  return (
    <button
      type="button"
      data-panel-item={item.key}
      disabled={item.disabled}
      title={item.title}
      aria-pressed={item.active || undefined}
      onClick={item.onSelect}
      className={cn(rowCls, "w-full rounded-[8px] text-left enabled:hover:bg-ink/[0.04] disabled:cursor-default disabled:opacity-45")}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-ink-secondary [&_svg]:size-4" aria-hidden="true">
        {item.icon}
      </span>
      <span className={cn("min-w-0 truncate text-[14px] font-medium", !wrapsValue && "flex-1", item.active ? "text-accent-text" : "text-ink")}>{item.label}</span>
      {item.trailing && <span className={cn("flex items-center", wrapsValue ? "min-w-0 flex-1 justify-end text-right" : "shrink-0")}>{item.trailing}</span>}
      {item.key !== "find" && item.key !== "start-fresh" && <ChevronRight size={15} aria-hidden="true" className="shrink-0 text-ink-tertiary rtl:-scale-x-100" />}
    </button>
  );
}

export function DetailsTab({ bot, derived, onOpen }: {
  bot: Bot;
  derived: Derived;
  onOpen: (page: SimplePageId) => void;
}) {
  const { items } = useChatMoreItems(bot);
  // While a blank chat is open the chat shows it, not the conversation it covers: the Model and Reasoning rows show and
  // set the blank chat's choices, which the first send applies to the conversation it makes.
  const newChat = useStoreSelector((state) => state.newChat);
  const thread = currentTaskBot(newChatBot(bot, newChat));
  // Like the Model row, a Reasoning pick is also the bot's default, so new conversations start at it. A guest's pick
  // stays in their own conversation, and so does one that would move the bot onto an engine its approval level must
  // first drop to Ask for: the Model row asks about that, this row has nowhere to.
  const ownerOrAdmin = useOwnerOrAdmin();
  const instances = useStoreSelector((state) => state.instances);
  const driverOf = (instanceId: string) => instances.find((instance) => instance.instanceId === instanceId)?.driverKind;
  const reasoningSetsDefault = ownerOrAdmin === true
    && !modelSwitchNeedsAsk(approvalModeFor(bot), driverOf(bot.modelSelection.instanceId), driverOf(thread.modelSelection.instanceId));
  const conversationItems = CONVERSATION_ITEMS.flatMap((key) => items.filter((item) => item.key === key));

  return (
    <div data-panel-tabpanel="details">
      {/* One row style down the whole tab: flat rows under quiet labels, no cards. */}
      <section data-panel-card="model" className="pt-2">
        <div data-panel-row="model" className={cn(rowCls, "rounded-[8px]")}>
          <ModelPicker
            key={thread.threadId}
            bot={thread}
            contained
            threadId={thread.threadId}
            label={<span className="flex shrink-0 items-center gap-2.5"><RowIcon icon={Sparkles} /><RowText title={t("model.simple.model")} /></span>}
          />
        </div>
        {/* The picker hides its own reasoning row when contained, so this tab draws it as its own row. */}
        <EffortRow
          bot={thread}
          threadId={thread.threadId}
          updateBotDefault={reasoningSetsDefault}
          compact
          className={cn(rowCls, "min-w-0 flex-1 rounded-[8px]")}
          label={<span className="flex shrink-0 items-center gap-2.5"><RowIcon icon={Sparkles} /><RowText title={t("model.simple.reasoning")} /></span>}
        />
      </section>

      <BotKeeps bot={bot} routines={derived.botRoutines} onOpen={onOpen} />

      <BotConversations bot={bot} />

      {conversationItems.length > 0 && (
        <section data-panel-card="conversation">
          <CardLabel>{t("botPanel.section.conversation")}</CardLabel>
          {conversationItems.map((item) => <ItemRow key={item.key} item={item} />)}
        </section>
      )}
    </div>
  );
}
