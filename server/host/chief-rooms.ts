// A room follows its department's Chief of Staff. When the Chief changes, a room the old one led goes to the new one; a room
// that can't be changed then, or that never had its Chief, says so to the person instead.
import { chiefScope } from "../../shared/bot-owner.ts";
import type { GroupDefaultResponder } from "../../shared/wire.ts";
import { conversationLanguage, serverLine } from "../server-lines.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";

export interface ChiefRoomsDeps {
  store: Pick<Store, "groups" | "appendMessage">;
  /** Changes the room as the person would, with the same refusals; throws when it may not change now. */
  updateRoom(groupId: string, patch: { memberIds: string[]; defaultResponder: GroupDefaultResponder }): GroupRecord;
  published(group: GroupRecord): void;
}

const ledBy = (room: Pick<GroupRecord, "defaultResponder">, botId: string): boolean => {
  const lead = room.defaultResponder;
  return lead.kind === "member" ? lead.botId === botId : lead.kind === "auto" && lead.fallbackBotId === botId;
};

/** The department's Chief, when this room is a department's room and that Chief is not in it. */
export function chiefAbsentFrom(room: Pick<GroupRecord, "dm" | "section" | "memberIds">, bots: readonly BotRecord[]): { botId: string; name: string } | undefined {
  if (room.dm) return undefined;
  const scope = chiefScope({ section: room.section });
  const chief = bots.find((bot) => bot.chiefOfStaff && !bot.hidden && chiefScope(bot) === scope);
  return chief && !room.memberIds.includes(chief.id) ? { botId: chief.id, name: chief.name } : undefined;
}

export function createChiefRooms(deps: ChiefRoomsDeps) {
  const { store } = deps;

  function retarget(room: GroupRecord, from: BotRecord, to: BotRecord): GroupRecord | null {
    const lead: GroupDefaultResponder = room.defaultResponder.kind === "auto" ? { kind: "auto", fallbackBotId: to.id } : { kind: "member", botId: to.id };
    try {
      const updated = deps.updateRoom(room.id, { memberIds: [...new Set([...room.memberIds, to.id])], defaultResponder: lead });
      store.appendMessage(room.threadId, { role: "bot", kind: "activity",
        tool: { name: `notice: ${serverLine(conversationLanguage(room.threadId), "server.rooms.chiefRetargeted", { chief: to.name, former: from.name })}`, ok: true } });
      return updated;
    } catch (error) {
      console.warn(`chief rooms: ${room.id} stays as it was: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  return {
    /** `changed`: the bots setChiefOfStaff changed. The new Chief takes over the rooms the old one led, and every room's
     * "no Chief here" line is read again. */
    moved(changed: readonly BotRecord[]): void {
      const to = changed.find((bot) => bot.chiefOfStaff);
      const formers = changed.filter((bot) => !bot.chiefOfStaff);
      if (!changed.length) return;
      for (const room of store.groups) {
        if (room.dm) continue;
        const from = to ? formers.find((bot) => ledBy(room, bot.id)) : undefined;
        deps.published((from && to && retarget(room, from, to)) || room);
      }
    },
  };
}

export type ChiefRooms = ReturnType<typeof createChiefRooms>;
