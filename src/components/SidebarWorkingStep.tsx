import type { Bot, Message } from "@/state/store";
import { useTurnLive } from "@/state/turn-status";
import { t } from "@/lib/i18n";
import { turnNowPhrases } from "@/lib/live-activity";

/** The conversation a working bot's row speaks for: the open one when it is working, else the first one that is. */
export function workingThreadId(bot: Pick<Bot, "threadId" | "tasks">): string {
  const tasks = bot.tasks ?? [];
  if (tasks.some((task) => task.threadId === bot.threadId && task.busy)) return bot.threadId;
  return tasks.find((task) => task.busy)?.threadId ?? bot.threadId;
}

export function SidebarWorkingStep({ bot, last }: { bot: Pick<Bot, "threadId" | "tasks">; last?: Message }) {
  const threadId = workingThreadId(bot);
  const live = useTurnLive(threadId);
  const phrase = turnNowPhrases(live.status, threadId === bot.threadId ? last : undefined)?.phrases[0];
  return <span dir="auto" data-sidebar-working-phrase="" className="truncate">{phrase ?? t("chat.activity.thinking")}</span>;
}
