import { useEffect, useState } from "react";

import { botShowsUnread } from "@/lib/bot-unread";
import { withOtherPlace, type PlacedBot } from "@/lib/place-rows";
import { roomThreadAttention } from "@/lib/room-threads";
import { nextUnreadHold, partitionSidebarBots, unreadFilterOrder, unreadFilterSince, unreadSinceByBot, withPrimaryTile, type UnreadHold } from "@/lib/sidebar-layout";
import { newChatThreadId } from "@/state/new-chat";
import type { Bot, Group } from "@/state/store";

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

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

/** The bots the sidebar's Unread filter looks at: every bot the sidebar lists when nothing is searched (the bots hidden
 * from it, the welcome screen's bot, the pins and the top tile or Chief slot left out; the other place's rows in), so a
 * search changes neither its count nor its order. */
export function unreadFilterBots(
  bots: Bot[],
  options: { universalPins: boolean; viewerEmail?: string | null; welcoming: string | null; tile: boolean; defaultBotId?: string; placed: readonly PlacedBot[] },
): Bot[] {
  const parts = partitionSidebarBots(bots, options);
  const listed = withOtherPlace(options.tile ? withPrimaryTile(parts, options.defaultBotId) : parts, options.placed);
  return [...(listed.unsectionedChief ? [listed.unsectionedChief] : []), ...listed.sectionChiefs, ...listed.sectionedBots, ...listed.unsectionedBots];
}

/** Each room showing unread or with a conversation waiting on the person, with the time the Unread filter lists it by:
 * its newest unread or waiting conversation, else its last message. Archived conversations do not count. */
export function unreadFilterRoomSince(groups: readonly Group[], bots: readonly Pick<Bot, "id" | "activity">[]): Map<string, number> {
  return new Map(groups.flatMap((group) => {
    const marked = (group.tasks ?? [{ threadId: group.threadId, title: group.name, createdAt: group.createdAt }]).filter((task) => {
      if (task.archivedAt !== undefined) return false;
      const { waiting, unread } = roomThreadAttention(group, task, bots);
      return waiting || (group.unread && unread);
    });
    if (!group.unread && marked.length === 0) return [];
    const at = marked.length > 0 ? Math.max(...marked.map((task) => task.updatedAt ?? task.createdAt)) : group.messages.at(-1)?.at ?? 0;
    return [[group.id, at] as const];
  }));
}

export type UnreadFilterRow = { bot: Bot; group?: undefined } | { group: Group; bot?: undefined };

/** The sidebar's Unread filter: how many of `bots` and `rooms` show unread or wait on the person, and while it is open,
 * those rows in a fixed order, the bots before the rooms. The open bot or room stays listed until another conversation is
 * open. Nothing is saved; it starts closed. `speakers` are the bots a room's wait is read from. */
export function useUnreadFilter(bots: readonly Bot[], waiting: (bot: Bot) => boolean, openId: string | null, rooms: readonly Group[] = [], speakers: readonly Bot[] = bots) {
  const [open, setOpen] = useState(false);
  const since = new Map([...unreadFilterSince(bots, waiting), ...unreadFilterRoomSince(rooms, speakers)]);
  const byId = new Map<string, UnreadFilterRow>([...rooms.map((group) => [group.id, { group }] as const), ...bots.map((bot) => [bot.id, { bot }] as const)]);
  const shown = openId === null ? undefined : byId.get(openId);
  const chat = shown?.bot ? shown.bot.switchingTo ?? shown.bot.threadId : shown?.group.threadId;
  const [seen, setSeen] = useState<{ since: ReadonlyMap<string, number>; held: UnreadHold | null; order: string[] }>({ since, held: null, order: [] });
  const held = open ? nextUnreadHold(seen.held, openId, seen.since, chat) : null;
  const order = open ? unreadFilterOrder(seen.order, since, held) : [];
  if (held !== seen.held || !sameTimes(since, seen.since) || !sameIds(order, seen.order)) setSeen({ since, held, order });
  return {
    open,
    count: since.size,
    rows: order.flatMap((id) => byId.get(id) ?? []).sort((a, b) => Number(!!a.group) - Number(!!b.group)),
    toggle: () => setOpen((value) => !value),
  };
}
