// Pointing in a room: the person points at parts of a member's page, and the pick goes to the bot that made the
// page. Each bot reads only the parts of its own pages; everyone in the room sees the chips on the message.
import type { AppPointedRef } from "../shared/app.ts";
import { appRow } from "./chat-apps.ts";
import type { AgentCardStore } from "./chat-widgets.ts";
import { preparePointed, type Pointed } from "./pointed.ts";
import { userError } from "./user-errors.ts";

/** refs: the chips on the line; blocks: by bot id, the records of that bot's own pages. */
export type RoomPick = { refs: AppPointedRef[]; blocks: Record<string, string> };

export function prepareRoomPointed(store: Pick<AgentCardStore, "messagesFor">, threadId: string, value: unknown): { ok: true; pick: RoomPick } | Extract<Pointed, { ok: false }> | null {
  const pointed = preparePointed(store, threadId, value);
  if (!pointed || !pointed.ok) return pointed;
  // Valid now, so value is the list of parts; each bot gets the records of its own pages only.
  const byBot = new Map<string, unknown[]>();
  for (const part of value as Array<{ appId: string }>) {
    const botId = appRow(store, threadId, part.appId)?.from?.botId;
    // A room page always names the bot that showed it; one without has nobody to read the pick.
    if (!botId) return { ok: false, status: 404, ...userError("serverError.page.notHere") };
    byBot.set(botId, [...(byBot.get(botId) ?? []), part]);
  }
  const blocks: Record<string, string> = {};
  for (const [botId, parts] of byBot) {
    const own = byBot.size === 1 ? pointed : preparePointed(store, threadId, parts);
    if (!own?.ok) return own ?? { ok: false, status: 404, ...userError("serverError.page.notHere") };
    blocks[botId] = own.block;
  }
  return { ok: true, pick: { refs: pointed.refs, blocks } };
}

export function roomPickBots(pick: RoomPick | undefined): string[] {
  return pick ? Object.keys(pick.blocks) : [];
}

/** Page bots of a pick that will not answer this line (held or gone since it was queued): their part reaches no one.
 * startGroupTurn also reports parts still in the run's pick when its round ends (a turn failed or the round stopped). */
export function undeliveredPickBots(pick: RoomPick | undefined, responders: ReadonlyArray<{ id: string }>): string[] {
  return roomPickBots(pick).filter((id) => !responders.some((responder) => responder.id === id));
}

/** A line that points at a member's page goes to that member first, with anyone the person named too; none otherwise. */
export function pointedResponders<T extends { id: string; hidden?: boolean }>(pick: RoomPick | undefined, members: T[], named: () => T[]): T[] {
  const ids = roomPickBots(pick);
  const pageBots = members.filter((member) => !member.hidden && ids.includes(member.id));
  return pageBots.length ? [...pageBots, ...named().filter((member) => !pageBots.includes(member))] : [];
}

/** Each turn takes its own bot's part out of the pick, so a run works on a copy and the queued line keeps its own. */
export function copyRoomPick(pick: RoomPick): RoomPick {
  return { ...pick, blocks: { ...pick.blocks } };
}

/** The pick text for this bot's turn, once: the bot that made the page reads it on its first turn, no one else does. */
export function takeRoomPick(holder: { pick?: RoomPick } | undefined, botId: string): string {
  const blocks = holder?.pick?.blocks;
  if (!blocks || !Object.hasOwn(blocks, botId)) return "";
  const block = blocks[botId]!;
  delete blocks[botId];
  return block;
}
