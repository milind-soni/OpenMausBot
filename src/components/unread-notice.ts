import { useEffect, useState } from "react";

import { botShowsUnread } from "@/lib/bot-unread";
import { nextUnreadHold, unreadSinceByBot, type UnreadHold } from "@/lib/sidebar-layout";
import { newChatThreadId } from "@/state/new-chat";
import type { Bot } from "@/state/store";

import { EFFECTS } from "./CursorAvatar";

export const UNREAD_NOTICE_MS = 2 * EFFECTS.notifying!.glyph!.period;

/** True for UNREAD_NOTICE_MS after `unread` turns on while the row is shown; a bot unread when its row appears holds still. */
export function useUnreadNotice(unread: boolean): boolean {
  const [seen, setSeen] = useState(unread);
  const [noticing, setNoticing] = useState(false);
  if (seen !== unread) {
    setSeen(unread);
    setNoticing(unread);
  }
  useEffect(() => {
    if (!noticing) return;
    const timer = setTimeout(() => setNoticing(false), UNREAD_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [noticing]);
  return noticing;
}

/** Whether `bot` shows unread, and whether its mascot is still playing the notice for it. */
export function useBotUnread(bot: Parameters<typeof botShowsUnread>[0]): { unread: boolean; noticing: boolean } {
  const unread = botShowsUnread(bot);
  return { unread, noticing: useUnreadNotice(unread) };
}

function sameTimes(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  return a.size === b.size && [...a].every(([id, since]) => b.get(id) === since);
}

/** The bot Unread keeps listed while the conversation it was opened in is the open one: `openId`'s current thread, or its
 * blank new chat when `newChatBotId` names it. It lasts for the session only. */
export function useUnreadHold(openId: string | null, bots: readonly Bot[], newChatBotId?: string): UnreadHold | null {
  const unread = unreadSinceByBot(bots);
  const open = bots.find((bot) => bot.id === openId);
  const chat = open && newChatBotId === open.id ? newChatThreadId(open.id) : open?.switchingTo ?? open?.threadId;
  const [seen, setSeen] = useState<{ unread: ReadonlyMap<string, number>; held: UnreadHold | null }>({ unread, held: null });
  const held = nextUnreadHold(seen.held, openId, seen.unread, chat);
  if (held !== seen.held || !sameTimes(unread, seen.unread)) setSeen({ unread, held });
  return held;
}
