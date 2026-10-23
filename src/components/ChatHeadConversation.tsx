import { ChevronDown } from "lucide-react";

import { t } from "@/lib/i18n";
import { localizedTaskTitle } from "@/lib/task-title";
import { useStore, type Bot } from "@/state/store";
import { openBotSettings } from "./bot-panel/panel-link";
import { sidebarBotActivityTasks } from "./SidebarBotActivity";

/** Simple mode's "Bot / Conversation ▾": the open conversation's title, which opens the bot panel at its conversations. */
export function ChatHeadConversation({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const task = bot.tasks?.find((candidate) => candidate.threadId === bot.threadId);
  if (!task) return null;
  const elsewhere = sidebarBotActivityTasks(bot, state.pendingQueued).filter((other) => other.threadId !== bot.threadId).length;
  return (
    <>
      <span aria-hidden="true" className="shrink-0 text-[14px] text-ink-tertiary">/</span>
      <button
        type="button"
        data-chathead-conversation
        aria-haspopup="dialog"
        title={t("chat.showConversations", { name: bot.name })}
        onClick={() => openBotSettings(dispatch, "overview", { anchor: "conversations" })}
        className="flex h-8 min-w-0 max-w-[260px] items-center gap-1.5 rounded-full px-2.5 text-[13.5px] text-ink-secondary hover:bg-raised-hover hover:text-ink"
      >
        <span dir="auto" className="truncate">{localizedTaskTitle(task.title || t("task.newShort"))}</span>
        {elsewhere > 0 && (
          <span role="img" aria-label={t("task.otherActivity", { count: elsewhere })} className="size-1.5 shrink-0 rounded-full bg-accent" />
        )}
        <ChevronDown size={14} aria-hidden="true" className="shrink-0" />
      </button>
    </>
  );
}
