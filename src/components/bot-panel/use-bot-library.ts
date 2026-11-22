import { useEffect, useState } from "react";
import type { BotLibrary } from "../../../shared/bot-library";
import { api } from "@/state/api";
import type { Bot } from "@/state/store";
import { knownThreads } from "./library-items";

/** What the bot made in all of its conversations (GET /api/bots/:id/library), read when the Library tab opens and again
 * when the bot gains, loses or switches a conversation; null until it answers, or if it cannot. */
export function useBotLibrary(bot: Pick<Bot, "id" | "threadId" | "tasks">): BotLibrary | null {
  const [library, setLibrary] = useState<{ botId: string; library: BotLibrary } | null>(null);
  const key = `${bot.id}:${bot.threadId}:${[...knownThreads(bot)].sort().join(",")}`;
  useEffect(() => {
    let cancelled = false;
    api<BotLibrary>(`/api/bots/${encodeURIComponent(bot.id)}/library`)
      .then((answer) => { if (!cancelled && Array.isArray(answer?.pages) && Array.isArray(answer.apps) && Array.isArray(answer.files)) setLibrary({ botId: bot.id, library: answer }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [bot.id, key]);
  return library?.botId === bot.id ? library.library : null;
}
