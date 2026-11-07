import { useEffect, useRef, useState } from "react";
import type { Bot, Message } from "@/state/store";
import { useTurnLive } from "@/state/turn-status";
import { t } from "@/lib/i18n";
import { sidebarMessage, sidebarStatus, turnNowPhrases } from "@/lib/live-activity";

/** How long a sidebar line holds one phrase before it may show the next, so a busy bot's row doesn't flicker. */
export const SIDEBAR_PHRASE_HOLD_MS = 5000;

/** `text`, but changing at most once per `holdMs`: a newer value waits out the rest of the hold, and the last one wins.
 * Clearing (no text: the step ended) shows at once, so a finished thread never still says it is working. */
export function useHeldText<T extends string | undefined>(text: T, holdMs = SIDEBAR_PHRASE_HOLD_MS): T {
  const [shown, setShown] = useState(text);
  const shownAt = useRef(Date.now());
  useEffect(() => {
    if (text === shown) return;
    const show = () => { shownAt.current = Date.now(); setShown(text); };
    const wait = shownAt.current + holdMs - Date.now();
    if (wait <= 0 || text === undefined) return show();
    const timer = setTimeout(show, wait);
    return () => clearTimeout(timer);
  }, [text, shown, holdMs]);
  return shown;
}

/** The conversation a working bot's row speaks for: the open one when it is working, else the first one that is. */
export function workingThreadId(bot: Pick<Bot, "threadId" | "tasks">): string {
  const tasks = bot.tasks ?? [];
  if (tasks.some((task) => task.threadId === bot.threadId && task.busy)) return bot.threadId;
  return tasks.find((task) => task.busy)?.threadId ?? bot.threadId;
}

export function SidebarWorkingStep({ bot, last }: { bot: Pick<Bot, "threadId" | "tasks">; last?: Message }) {
  const threadId = workingThreadId(bot);
  const live = useTurnLive(threadId);
  const phrase = turnNowPhrases(sidebarStatus(live.status), threadId === bot.threadId ? sidebarMessage(last) : undefined)?.phrases[0];
  const shown = useHeldText(phrase ?? t("chat.activity.thinking"));
  return <span dir="auto" data-sidebar-working-phrase="" className="truncate">{shown}</span>;
}
