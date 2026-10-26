import type { HandoffView } from "../coordinator.ts";
import { peerAllowed, reachRefusal } from "../peer-roster.ts";
import type { GroupRecord, Store } from "../store.ts";

export interface RoomAccessDeps {
  store: Store;
  /** The person a conversation is private to on a Team Cloud; null elsewhere. */
  privateTo?(threadId: string): string | null;
}

/** Security: what is said in a Team Cloud member's private chat never reaches a room. */
export const PRIVATE_CHAT_ROOM_WRITE = "This is a private chat, and nothing said here goes into a room, where others would read it. Hand the work to the bot directly (leave group_id out), or tell the person what you wanted to post so they can post it themselves.";

/** The one copy of "may this bot speak into this room". Every caller — the bot's post_to_room tool, a
 *  webhook's room delivery — maps these problems to its own audience's wording; none adds a rule. */
export type RoomTalksVerdict =
  | { ok: true }
  | { ok: false; problem: "dm" }
  | { ok: false; problem: "not-member" }
  | { ok: false; problem: "private" }
  | { ok: false; problem: "setup" };

export function createRoomAccess({ store, privateTo = () => null }: RoomAccessDeps) {
  function roomRootProblem(node: Pick<HandoffView, "groupId" | "threadId" | "botId">): string | undefined {
    const group = node.groupId ? store.group(node.groupId) : undefined;
    const bot = store.bot(node.botId);
    if (!bot || bot.hidden) return "The addressed agent no longer exists";
    if (!group || !(group.dm ? group.threadId === node.threadId : store.groupTaskByThread(group.id, node.threadId))) return "Destination room task no longer exists";
    if (!group.memberIds.includes(bot.id)) return "The addressed agent is no longer a member of this room";
    return undefined;
  }
  function roomHandoffProblem(node: Pick<HandoffView, "groupId" | "threadId" | "botId"> & Partial<Pick<HandoffView, "kind">>, parent?: Pick<HandoffView, "groupId" | "threadId" | "botId">): string | undefined {
    const group = node.groupId ? store.group(node.groupId) : undefined;
    const bot = store.bot(node.botId);
    if (!bot || bot.hidden) return "The addressed agent no longer exists";
    if (node.groupId && (!group || group.dm || !store.groupTaskByThread(group.id, node.threadId))) return "Destination room task no longer exists";
    if (!node.groupId && !store.taskByThread(bot.id, node.threadId)) return "Destination bot task no longer exists";
    if (group && !group.memberIds.includes(bot.id)) return "The addressed agent is no longer a member of this room";
    // A room job in a thread of its own still answers to its room: a member who left it stops.
    const laneThread = laneRoomThread(node);
    const laneRoom = laneThread ? store.groupByThread(laneThread) : undefined;
    if (laneRoom && !laneRoom.dm && !laneRoom.memberIds.includes(bot.id)) return "The addressed agent is no longer a member of this room";
    if (group && parent && privateTo(parent.threadId)) return PRIVATE_CHAT_ROOM_WRITE;
    if (group && roomSetupPending(group)) return "Destination room setup is unfinished";
    if (parent) {
      const from = store.bot(parent.botId);
      const source = parent.groupId ? store.group(parent.groupId) : undefined;
      if (!from || from.hidden || (parent.groupId ? !source || !source.memberIds.includes(from.id) || !store.groupTaskByThread(source.id, parent.threadId) : !store.taskByThread(from.id, parent.threadId))) return "Source membership or task was removed";
      if (source && group && source.id === group.id && parent.threadId !== node.threadId) return "Same-room work must stay in the originating conversation";
      if (!peerAllowed(from, bot)) return reachRefusal(from, bot)!;
    }
  }

  function laneRoomThread(n: Pick<HandoffView, "botId" | "threadId" | "groupId">): string | undefined {
    if (n.groupId) return undefined;
    const opener = store.taskByThread(n.botId, n.threadId)?.openedBy;
    return opener?.kind === "work" && opener.roomLane && opener.threadId && store.groupByThread(opener.threadId) ? opener.threadId : undefined;
  }

  /** `fromThreadId`: the conversation a bot speaks from; a webhook speaks from none. */
  function roomTalks(bot: { id: string }, group: GroupRecord, fromThreadId?: string): RoomTalksVerdict {
    if (group.dm) return { ok: false, problem: "dm" };
    if (!group.memberIds.includes(bot.id)) return { ok: false, problem: "not-member" };
    if (fromThreadId !== undefined && privateTo(fromThreadId)) return { ok: false, problem: "private" };
    if (roomSetupPending(group)) return { ok: false, problem: "setup" };
    return { ok: true };
  }

  function roomSetupPending(group: GroupRecord): boolean {
    const hasMarker =
      Object.prototype.hasOwnProperty.call(group, "setupCompletedAt") ||
      Object.prototype.hasOwnProperty.call(group, "setupSkippedAt");
    return (
      !group.dm &&
      hasMarker &&
      group.setupCompletedAt == null &&
      group.setupSkippedAt == null &&
      store.messagesFor(group.threadId).length === 0
    );
  }

  return { roomRootProblem, roomHandoffProblem, roomSetupPending, roomTalks, laneRoomThread };
}
