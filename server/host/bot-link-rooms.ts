// Rooms whose members live in more than one of the person's places (server/bot-link/link.ts). A room is one record with
// one transcript, in the place it was made. A bot of another place is a member through its stand-in record
// (server/host/bot-link-host.ts): it is mentioned, picked and listed as any member is, and when its turn comes the turn
// is handed over the link instead of run here. That hand-off is an ordinary assignment in this place's runtime, so it is
// sent once, waits without a clock while the member's place is off or asleep, and stops when the room is stopped. Its
// answer is posted in the room as the member's own line, once.
//
// What crosses: the room's name, its members' names, and what was said in the room since that member last spoke. The
// same person owns both places, and a member of a room reads the room.
import { randomUUID } from "node:crypto";

import { isLinkedId, parseLinked } from "../bot-link/protocol.ts";
import type { Coordinator, HandoffView } from "../coordinator.ts";
import { redactSecretsInText } from "../redact.ts";
import type { ServerLineKey } from "../server-lines.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";

/** The thread name a room turn's hand-off carries: one for each member and room thread, so the member's work thread in
 * its own place continues from turn to turn. */
const ROOM_THREAD = /^(link-[0-9a-f]{8}-.+):room:([^:]+):([^:]+)$/su;
export const roomWorkThread = (linked: string, groupId: string, threadId: string): string => `${linked}:room:${groupId}:${threadId}`;
export const parseRoomWorkThread = (threadId: string): { linked: string; groupId: string; threadId: string } | null => {
  const found = ROOM_THREAD.exec(threadId);
  return found ? { linked: found[1]!, groupId: found[2]!, threadId: found[3]! } : null;
};
/** The root a room turn hangs from carries how many members' answers led to it, so two bots cannot call each other for ever. */
const ROOM_ROOT = /^link-room-(\d)-/u;
const roomRoot = (hop: number): string => `link-room-${Math.max(0, Math.min(9, hop))}-${randomUUID()}`;
const hopOf = (rootId: string | undefined): number => Number(ROOM_ROOT.exec(rootId ?? "")?.[1] ?? 0);

/** As many of the room's latest lines as one hand-off carries, and no more characters than this. */
const LINES_MAX = 40;
const WORDS_MAX = 9_000;
const LINE_MAX = 3_000;

export interface LinkedRoomsDeps {
  store: Pick<Store, "bot" | "group" | "groups" | "groupTaskByThread" | "activePath" | "appendMessage" | "markGroupThreadUnread" | "patchGroup">;
  coordinator(): Coordinator;
  /** The link is on, and whether that place is connected now. */
  on(): boolean;
  linked(peer: string): boolean;
  online(peer: string): boolean;
  selfName(): string;
  /** There is work for a place that is not connected: a computer asks its Cloud for it now, as for any hand-off. */
  wanted(): void;
  personName(threadId: string): string | undefined;
  line(threadId: string, key: ServerLineKey, params: Record<string, string>): string;
  /** After a member's answer is in the room: the members it names take their turns, as after any member's answer. */
  follow?(groupId: string, threadId: string, speaker: BotRecord, text: string, hop: number): void;
  maxHops?: number;
  log?(line: string): void;
}

export function createLinkedRooms(deps: LinkedRoomsDeps) {
  const { store } = deps;
  /** The last line each waiting or running turn was sent with, so the next turn's words start after it. Lost on a
   * restart, when the words start after the member's own last line instead. */
  const sentThrough = new Map<string, string>();

  const owns = (group: GroupRecord, threadId: string) => (group.dm ? group.threadId === threadId : Boolean(store.groupTaskByThread(group.id, threadId)));
  const seat = (node: HandoffView) => {
    const at = parseRoomWorkThread(node.threadId);
    if (!at || at.linked !== node.botId) return null;
    const group = store.group(at.groupId);
    return { ...at, group: group && owns(group, at.threadId) && group.memberIds.includes(at.linked) ? group : null };
  };

  /** What the member reads: where it is, who is there, and what was said since it last spoke or was last told. */
  function words(group: GroupRecord, threadId: string, member: BotRecord): { text: string; through?: string } {
    const path = store.activePath(threadId);
    const told = sentThrough.get(roomWorkThread(member.id, group.id, threadId));
    const from = Math.max(path.findLastIndex((message) => message.role === "bot" && message.kind === "text" && message.from?.botId === member.id), told ? path.findIndex((message) => message.id === told) : -1);
    const said = path.slice(from + 1).filter((message) => message.kind === "text" && Boolean(message.text?.trim()));
    const person = deps.personName(threadId) ?? "The person";
    const lines: string[] = [];
    let size = 0;
    for (const message of said.slice(-LINES_MAX).reverse()) {
      const line = `${message.role === "user" ? message.sender?.name ?? person : message.from?.name ?? "A bot"}: ${message.text!.trim().slice(0, LINE_MAX)}`;
      if (lines.length > 0 && size + line.length > WORDS_MAX) break;
      lines.unshift(line);
      size += line.length;
    }
    const others = group.memberIds.filter((id) => id !== member.id).map((id) => store.bot(id)).filter((bot): bot is BotRecord => Boolean(bot) && !bot!.hidden)
      .map((bot) => (bot.home ? `${bot.name} (on ${bot.home.placeName})` : bot.name));
    const place = deps.selfName() || "the person's other place";
    const text = [
      `You are a member of the room "${group.name}" on ${place}, one of ${person}'s own places. ${others.length ? `The other members: ${others.join(", ")}.` : "You are its only bot."} It is your turn to speak there.`,
      lines.length ? `${from >= 0 ? "Said in the room since you last spoke" : "Said in the room"}:\n${lines.join("\n")}` : "Nothing new was said in the room.",
      "Answer with what you say to the room: your answer is posted there as your line, under your name. To bring another member in, write @ and its name.",
    ].join("\n\n");
    return { text, ...(said.length ? { through: said.at(-1)!.id } : {}) };
  }

  return {
    /** Whether a turn of this room member is one this module forwards. */
    forwards: (bot: Pick<BotRecord, "id" | "home"> | null | undefined): boolean => Boolean(bot?.home) && isLinkedId(bot!.id),

    /**
     * A room member that lives elsewhere takes its turn: handed over the link, never run here. Returns at once (the
     * room goes on with its other members); the answer is posted when it comes. A turn that still waits to be sent is
     * not queued a second time: it is sent with everything said up to the moment it goes.
     */
    memberTurn(group: GroupRecord, threadId: string, member: BotRecord, hop: number): boolean {
      const address = parseLinked(member.id);
      if (!deps.on() || !address || !deps.linked(address.peer)) {
        store.appendMessage(threadId, { role: "bot", kind: "activity", from: { botId: member.id, name: member.name, color: member.color },
          tool: { name: deps.line(threadId, "server.rooms.linkedGone", { bot: member.name, place: member.home?.placeName ?? "" }), ok: false } });
        return true;
      }
      const coordinator = deps.coordinator();
      const thread = roomWorkThread(member.id, group.id, threadId);
      const waiting = coordinator.active().some((node) => node.botId === member.id && node.threadId === thread && node.status === "queued");
      const online = deps.online(address.peer);
      if (!waiting) {
        // The room asks, not a bot: the root's own name is the room's, in the link's address space so that no turn is ever run for it here.
        const root = roomRoot(hop), seatHere = { groupId: group.id, threadId, botId: `link-room-${group.id}` };
        const latest = store.activePath(threadId).findLast((message) => message.kind === "text" && Boolean(message.text))?.text ?? "";
        try {
          coordinator.beginTurn({ id: root, address: seatHere, brief: latest.slice(0, 2_000), level: "full" });
          coordinator.enqueue(seatHere, root, undefined, { botId: member.id, threadId: thread }, latest.slice(0, 2_000) || `Your turn in the room ${group.name}`, { mode: "work", reply: "poll", thread: "standing" });
          coordinator.endTurn(root, { ok: true, text: "" });
        } catch (error) {
          try { coordinator.endTurn(root, { ok: false, text: "" }); } catch { /* the root never began */ }
          const why = error instanceof Error ? error.message : String(error);
          deps.log?.(`bot link: ${member.name}'s room turn was not handed over (${why})`);
          store.appendMessage(threadId, { role: "bot", kind: "activity", from: { botId: member.id, name: member.name, color: member.color },
            tool: { name: deps.line(threadId, "server.rooms.linkedNotSent", { bot: member.name, place: member.home?.placeName ?? "" }), ok: false, output: redactSecretsInText(why).slice(0, 400) } });
          return true;
        }
      }
      if (!online) deps.wanted();
      // Said once for each wait: a second message written while the place is away adds no second line.
      if (!online && !waiting) {
        store.appendMessage(threadId, { role: "bot", kind: "activity", from: { botId: member.id, name: member.name, color: member.color },
          tool: { name: deps.line(threadId, "server.rooms.linkedAway", { bot: member.name, place: member.home?.placeName ?? "" }), ok: true } });
      }
      return true;
    },

    brief(node: HandoffView): { from: { botId: string; name: string }; text: string; person?: string } | undefined {
      const at = seat(node), member = at?.group ? store.bot(at.linked) : null;
      if (!at?.group || !member) return undefined;
      const { text, through } = words(at.group, at.threadId, member);
      if (through) sentThrough.set(node.threadId, through);
      const person = deps.personName(at.threadId);
      return { from: { botId: `room-${at.group.id}`, name: at.group.name }, text, ...(person ? { person } : {}) };
    },

    member: (groupId: string, linked: string): boolean => store.group(groupId)?.memberIds.includes(linked) === true,

    problem(node: HandoffView): string | undefined {
      const at = seat(node);
      if (!at) return undefined;
      return at.group ? undefined : "That room is gone, or the bot is no longer a member of it.";
    },

    reply(child: HandoffView, parent: HandoffView | undefined, name: string): boolean {
      const at = parseRoomWorkThread(child.threadId);
      if (!at || at.linked !== child.botId) return false;
      const group = store.group(at.groupId);
      if (!group || !owns(group, at.threadId)) return true;
      const member = store.bot(at.linked);
      const from = { botId: at.linked, name: member?.name ?? name, color: member?.color ?? "blue" };
      const said = child.status === "completed" ? redactSecretsInText(child.result.trim()) : "";
      if (said) {
        // Posted under the assignment's id, so a report made twice (a restart between the two) leaves one line.
        const lines = store.activePath(at.threadId).length;
        store.appendMessage(at.threadId, { role: "bot", kind: "text", text: said, from }, { kind: "bot-link.room-reply", key: child.id });
        if (store.activePath(at.threadId).length === lines) return true;
        store.markGroupThreadUnread(group.id, at.threadId, true);
        const hop = hopOf(parent?.id ?? child.parentId);
        if (member && group.memberIds.includes(member.id) && hop < (deps.maxHops ?? 3)) {
          try { deps.follow?.(group.id, at.threadId, member, said, hop); } catch (error) { deps.log?.(`bot link: the mentions in ${from.name}'s answer were not followed (${String(error)})`); }
        }
        return true;
      }
      if (child.status === "cancelled") return true;
      store.appendMessage(at.threadId, { role: "bot", kind: "activity", from,
        tool: { name: deps.line(at.threadId, child.status === "completed" ? "server.rooms.linkedNoAnswer" : "server.rooms.linkedFailed", { bot: from.name, place: member?.home?.placeName ?? "" }), ok: false,
          ...(child.status !== "completed" && child.result.trim() ? { output: redactSecretsInText(child.result.trim()).slice(0, 2_000) } : {}) } }, { kind: "bot-link.room-reply", key: child.id });
      return true;
    },

    /** A place was unlinked, or the link was turned off: its bots leave the rooms here, since nothing can reach them. */
    placesLeft(): void {
      for (const group of store.groups) {
        if (group.dm || !group.memberIds.some(isLinkedId)) continue;
        const kept = group.memberIds.filter((id) => { const address = parseLinked(id); return !isLinkedId(id) || Boolean(address && deps.on() && deps.linked(address.peer)); });
        // A room whose every member lived there keeps its record and its words; its members are simply not found.
        if (kept.length === group.memberIds.length || kept.length === 0) continue;
        store.patchGroup(group.id, { memberIds: kept });
      }
    },
  };
}

export type LinkedRooms = ReturnType<typeof createLinkedRooms>;

/** What index.ts lends so that the members a far member's answer names take their turns as after any member's answer. */
export interface RoomFollowPorts<Operation extends { cancelled: boolean }> {
  members(groupId: string): BotRecord[];
  /** The members `text` mentions. */
  mentioned(text: string, members: BotRecord[]): BotRecord[];
  begin(groupId: string, threadId: string, botIds: string[]): Operation;
  finish(groupId: string, operation: Operation): void;
  /** One turn after another in each room thread. */
  queue: Map<string, Promise<void>>;
  wait(operation: Operation, threadId: string, bot: BotRecord): Promise<"run" | "skip" | "stop">;
  run(groupId: string, threadId: string, botId: string, hop: number, spoken: Set<string>, operation: Operation): Promise<boolean>;
}

export function followRoomMentions<Operation extends { cancelled: boolean }>(ports: RoomFollowPorts<Operation>): NonNullable<LinkedRoomsDeps["follow"]> {
  return (groupId, threadId, speaker, text, hop) => {
    const next = ports.mentioned(text, ports.members(groupId).filter((member) => member.id !== speaker.id));
    if (!next.length) return;
    const operation = ports.begin(groupId, threadId, next.map((member) => member.id));
    const turns = (ports.queue.get(threadId) ?? Promise.resolve()).then(async () => {
      const spoken = new Set<string>([speaker.id]);
      for (const member of next) {
        if (operation.cancelled) break;
        const verdict = await ports.wait(operation, threadId, member);
        if (verdict === "stop") break;
        if (verdict === "skip") continue;
        if (!(await ports.run(groupId, threadId, member.id, hop + 1, spoken, operation))) break;
      }
    }).finally(() => ports.finish(groupId, operation));
    ports.queue.set(threadId, turns.catch(() => {}));
  };
}
