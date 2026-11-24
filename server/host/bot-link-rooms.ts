// Rooms whose members live in more than one of the person's places (server/bot-link/link.ts). A room is one record with
// one transcript, in the place it was made. A bot of another place is a member through its stand-in record
// (server/host/bot-link-host.ts): it is mentioned, picked and listed as any member is, and when its turn comes the turn
// is handed over the link instead of run here. That hand-off is an ordinary assignment in this place's runtime, so it is
// sent once, waits without a clock while the member's place is off or asleep, and stops when the room is stopped. Its
// answer is posted in the room as the member's own line, once.
//
// What crosses: the room's name, its members' names, and what was said in the room since that member was last sent it,
// each line with the note that says who it is from, as a member here reads it. The same person owns both places, and a
// member of a room reads the room. The person's own line crosses as the person's request; a routine's, a webhook's or a
// guest's does not.
//
// A far member stays a member while it cannot be reached (the link is off, its place is unlinked, or its place no longer
// has it): it is named as it was last known, takes no turn, and works again when the link is back. It leaves a room only
// when the person removes it, or when its place's link ends for good. What each member was sent, and what each far
// member is called, is kept in `bot-link-rooms.json`, which exists only while a room has such a member.
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { isLinkedId, parseLinked } from "../bot-link/protocol.ts";
import type { Coordinator, HandoffOpener, HandoffView } from "../coordinator.ts";
import { workOrigin } from "../peer-provenance.ts";
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
const FILE = "bot-link-rooms.json";
const RECORDS_MAX = 2_000;

/** What a far member was last known as, kept so that it can be named while its place cannot be asked. */
interface Known { name: string; color?: string; place: string; placeName: string; botId: string; kind?: "computer" | "cloud"; title?: string; mascotBody?: string; mascotFaceColor?: string; mascotBodyColor?: string; mascotMaterial?: string }
/** One turn handed over: where its words started and ended, so that the same turn sent again says the same and more, never
 * less; and how many members' answers led to it. */
interface Turn { seat: string; hop: number; at: number; composed?: boolean; after?: string; through?: string }
interface Kept {
  v: 1;
  members: Record<string, Known>;
  /** The last line of the room each member was sent, by its work thread there. */
  seats: Record<string, { through: string; at: number }>;
  turns: Record<string, Turn>;
}
/** Why a far member cannot be reached: the link is off or its place is not linked, or its place no longer has it. */
export type FarGone = "off" | "missing";
/** A far bot one of this place's rooms has as a member, as the host makes its stand-in record. */
export interface FarRecord extends Known { id: string; gone?: FarGone }

export interface LinkedRoomsDeps {
  dataDir: string;
  store: Pick<Store, "bot" | "group" | "groups" | "groupTaskByThread" | "activePath" | "messagesFor" | "appendMessage" | "markGroupThreadUnread" | "patchGroup">;
  coordinator(): Coordinator;
  /** The link is on, and whether that place is connected now. */
  on(): boolean;
  linked(peer: string): boolean;
  online(peer: string): boolean;
  /** The bots the linked places have now, by their address here. */
  linkedBots(): ReadonlyArray<{ id: string; peer: string; place: { name: string }; kind?: "computer" | "cloud"; bot: { id: string; name: string; color?: string; title?: string; mascotBody?: string; mascotFaceColor?: string; mascotBodyColor?: string; mascotMaterial?: string } }>;
  selfName(): string;
  /** There is work for a place that is not connected: a computer asks its Cloud for it now, as for any hand-off. */
  wanted(): void;
  personName(threadId: string): string | undefined;
  line(threadId: string, key: ServerLineKey, params: Record<string, string>): string;
  /** The room's lines as a member of it reads them (server/host/room-transcript.ts): each with the note that says who it
   * is from when it is not the person's own, narration left out. `order` is every line of the room, oldest first. */
  window(threadId: string, readerBotId: string): { lines: ReadonlyArray<{ id: string; text: string }>; order: readonly string[]; readable: readonly string[] };
  /** Who stands behind what is being said in this room thread now when it is not the person: a routine, a webhook, a guest. */
  opener?(botId: string, threadId: string): HandoffOpener | undefined;
  /** After a member's answer is in the room: the members it names take their turns, as after any member's answer. */
  follow?(groupId: string, threadId: string, speaker: BotRecord, text: string, hop: number): void;
  maxHops?: number;
  now?: () => number;
  log?(line: string): void;
}

export function createLinkedRooms(deps: LinkedRoomsDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const file = join(deps.dataDir, FILE);
  /** Read once, and only written when a room has a member from another place: with none, no file exists. */
  let kept: Kept = { v: 1, members: {}, seats: {}, turns: {} };
  try {
    const read = JSON.parse(readFileSync(file, "utf8")) as Partial<Kept> | null;
    if (read?.v === 1) kept = { v: 1, members: { ...read.members }, seats: { ...read.seats }, turns: { ...read.turns } };
  } catch { /* none yet */ }
  const save = () => {
    const oldest = <T extends { at: number }>(records: Record<string, T>) => {
      const extra = Object.keys(records).length - RECORDS_MAX;
      if (extra > 0) for (const [id] of Object.entries(records).sort(([, a], [, b]) => a.at - b.at).slice(0, extra)) delete records[id];
    };
    oldest(kept.seats); oldest(kept.turns);
    try {
      if (!Object.keys(kept.members).length && !Object.keys(kept.seats).length && !Object.keys(kept.turns).length) rmSync(file, { force: true });
      else writeFileAtomic(file, JSON.stringify(kept), { mode: 0o600 });
    } catch (error) { deps.log?.(`bot link: what the rooms' far members were sent was not written down (${String(error)})`); }
  };

  const owns = (group: GroupRecord, threadId: string) => (group.dm ? group.threadId === threadId : Boolean(store.groupTaskByThread(group.id, threadId)));
  const seat = (node: HandoffView) => {
    const at = parseRoomWorkThread(node.threadId);
    if (!at || at.linked !== node.botId) return null;
    const group = store.group(at.groupId);
    return { ...at, group: group && owns(group, at.threadId) && group.memberIds.includes(at.linked) ? group : null };
  };
  const farIds = () => new Set(store.groups.filter((group) => !group.dm).flatMap((group) => group.memberIds.filter(isLinkedId)));
  const nameOf = (linked: string, fallback = "Teammate") => store.bot(linked)?.name ?? kept.members[linked]?.name ?? fallback;
  const placeOf = (linked: string) => store.bot(linked)?.home?.placeName ?? kept.members[linked]?.placeName ?? "";
  const note = (threadId: string, linked: string, key: ServerLineKey, more: { ok?: boolean; output?: string; receipt?: string } = {}) => {
    const member = store.bot(linked);
    store.appendMessage(threadId, { role: "bot", kind: "activity", from: { botId: linked, name: nameOf(linked), color: member?.color ?? kept.members[linked]?.color ?? "blue" },
      tool: { name: deps.line(threadId, key, { bot: nameOf(linked), place: placeOf(linked) }), ok: more.ok ?? false, ...(more.output ? { output: more.output } : {}) } },
    more.receipt ? { kind: "bot-link.room-reply", key: more.receipt } : undefined);
  };

  /**
   * What the member reads: where it is, who is there, and what was said in the room after `after`, the last line it was
   * sent (without one: after its own last line), up to `upTo` when the turn was already sent once. Its own lines are left
   * out, since it wrote them. `through` is the last line this covers, whoever wrote it.
   */
  function words(group: GroupRecord, threadId: string, member: BotRecord, after: string | undefined, upTo?: string): { text: string; through?: string } {
    const whole = deps.window(threadId, member.id);
    // The same turn asked for again ends where it ended the first time: what was said later belongs to the next turn.
    const end = upTo === undefined ? -1 : whole.order.indexOf(upTo);
    const order = end >= 0 ? whole.order.slice(0, end + 1) : whole.order, within = new Set(order);
    const window = { order, readable: whole.readable.filter((id) => within.has(id)), lines: whole.lines.filter((line) => within.has(line.id)) };
    const own = new Set(store.messagesFor(threadId).filter((message) => message.role === "bot" && message.from?.botId === member.id).map((message) => message.id));
    const told = after === undefined ? -1 : window.order.indexOf(after);
    const from = told >= 0 ? told : window.order.findLastIndex((id) => own.has(id));
    const since = new Set(window.order.slice(from + 1).filter((id) => !own.has(id)));
    const readable = window.readable.filter((id) => since.has(id)).length;
    const lines: string[] = [];
    let size = 0;
    for (const entry of window.lines.filter((one) => since.has(one.id)).slice(-LINES_MAX).reverse()) {
      const line = entry.text.trim().slice(0, LINE_MAX);
      if (lines.length > 0 && size + line.length > WORDS_MAX) break;
      lines.unshift(line);
      size += line.length;
    }
    // Said plainly, so the member does not take what it reads for all that was said.
    const left = readable - lines.length;
    if (left > 0) lines.unshift(`(${left} earlier ${left === 1 ? "line" : "lines"} said in the room since then ${left === 1 ? "was" : "were"} left out here: only the latest are sent.)`);
    const person = deps.personName(threadId) ?? "The person";
    const others = group.memberIds.filter((id) => id !== member.id).map((id) => store.bot(id)).filter((bot): bot is BotRecord => Boolean(bot) && !bot!.hidden)
      .map((bot) => (bot.home ? `${bot.name} (on ${bot.home.placeName})` : bot.name));
    const place = deps.selfName() || "the person's other place";
    const text = [
      `You are a member of the room "${group.name}" on ${place}, one of ${person}'s own places. ${others.length ? `The other members: ${others.join(", ")}.` : "You are its only bot."} It is your turn to speak there.`,
      lines.length ? `${from >= 0 ? "Said in the room since you last spoke" : "Said in the room"}:\n${lines.join("\n")}` : "Nothing new was said in the room.",
      "Answer with what you say to the room: your answer is posted there as your line, under your name. To bring another member in, write @ and its name.",
    ].join("\n\n");
    const through = window.order.at(-1);
    return { text, ...(through ? { through } : {}) };
  }

  /** Remembers each far member of a room as it is now, and forgets the ones no room has any more. */
  function sync(): void {
    const ids = farIds();
    if (ids.size === 0 && Object.keys(kept.members).length === 0 && Object.keys(kept.seats).length === 0) return;
    const live = new Map(deps.linkedBots().map((one) => [one.id, one]));
    const before = JSON.stringify([kept.members, Object.keys(kept.seats)]);
    for (const key of Object.keys(kept.seats)) { const at = parseRoomWorkThread(key); if (!at || store.group(at.groupId)?.memberIds.includes(at.linked) !== true) delete kept.seats[key]; }
    for (const id of ids) {
      const one = live.get(id);
      if (one) kept.members[id] = { name: one.bot.name, place: one.peer, placeName: one.place.name, botId: one.bot.id, ...(one.kind ? { kind: one.kind } : {}), ...(one.bot.color ? { color: one.bot.color } : {}),
        ...(one.bot.title ? { title: one.bot.title } : {}), ...(one.bot.mascotBody ? { mascotBody: one.bot.mascotBody } : {}), ...(one.bot.mascotFaceColor ? { mascotFaceColor: one.bot.mascotFaceColor } : {}),
        ...(one.bot.mascotBodyColor ? { mascotBodyColor: one.bot.mascotBodyColor } : {}), ...(one.bot.mascotMaterial ? { mascotMaterial: one.bot.mascotMaterial } : {}) };
    }
    for (const id of Object.keys(kept.members)) if (!ids.has(id)) delete kept.members[id];
    if (JSON.stringify([kept.members, Object.keys(kept.seats)]) !== before) save();
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
      // It stays a member while it cannot be reached, and takes no turn: the room says why.
      if (member.home?.gone || !deps.on() || !address || !deps.linked(address.peer)) {
        note(threadId, member.id, member.home?.gone === "missing" ? "server.rooms.linkedMissing" : "server.rooms.linkedGone");
        return true;
      }
      sync();
      const coordinator = deps.coordinator();
      const thread = roomWorkThread(member.id, group.id, threadId);
      const waiting = coordinator.active().find((node) => node.botId === member.id && node.threadId === thread && node.status === "queued");
      const online = deps.online(address.peer);
      if (waiting) {
        // What is said now joins the turn that waits, and that turn is as near to the person as its nearest line: a line
        // the person writes into a turn that an answer's mention began is followed by its own mentions again.
        const turn = kept.turns[waiting.id];
        if (!turn || hop < turn.hop) { kept.turns[waiting.id] = { ...turn, seat: thread, hop: Math.min(hop, turn?.hop ?? hop), at: turn?.at ?? now() }; save(); }
      } else {
        // The room asks, not a bot: the root's own name is the room's, in the link's address space so that no turn is ever run for it here.
        const root = roomRoot(hop), seatHere = { groupId: group.id, threadId, botId: `link-room-${group.id}` };
        const path = store.activePath(threadId);
        const latest = path.findLast((message) => message.kind === "text" && Boolean(message.text))?.text ?? "";
        // Whose words these are, as for a member's turn here: the person's own line is the person's request; a routine's,
        // a webhook's, a guest's or another app's is not.
        const opener = deps.opener?.(seatHere.botId, threadId);
        const origin = workOrigin(path.findLast((message) => message.role === "user" && message.kind === "text" && Boolean(message.text)));
        try {
          coordinator.beginTurn({ id: root, address: seatHere, brief: latest.slice(0, 2_000), level: "full", ...(opener ? { opener } : {}), origin });
          const { node } = coordinator.enqueue(seatHere, root, undefined, { botId: member.id, threadId: thread }, latest.slice(0, 2_000) || `Your turn in the room ${group.name}`, { mode: "work", reply: "poll", thread: "standing" });
          kept.turns[node.id] = { seat: thread, hop, at: now() };
          save();
          coordinator.endTurn(root, { ok: true, text: "" });
        } catch (error) {
          try { coordinator.endTurn(root, { ok: false, text: "" }); } catch { /* the root never began */ }
          const why = error instanceof Error ? error.message : String(error);
          deps.log?.(`bot link: ${member.name}'s room turn was not handed over (${why})`);
          note(threadId, member.id, "server.rooms.linkedNotSent", { output: redactSecretsInText(why).slice(0, 400) });
          return true;
        }
      }
      if (!online) deps.wanted();
      // Said once for each wait: a second message written while the place is away adds no second line.
      if (!online && !waiting) note(threadId, member.id, "server.rooms.linkedAway", { ok: true });
      return true;
    },

    /** The words of a room turn, worked out as it is sent. The same turn sent again (its place of work restarted, or
     * this one did) starts where it started the first time, so nothing it was to carry is lost. */
    brief(node: HandoffView): { from: { botId: string; name: string }; text: string; person?: string } | undefined {
      const at = seat(node), member = at?.group ? store.bot(at.linked) : null;
      if (!at?.group || !member) return undefined;
      const turn: Turn = kept.turns[node.id] ?? { seat: node.threadId, hop: hopOf(node.rootId), at: now() };
      const again = turn.composed === true;
      if (!again) { turn.composed = true; const after = kept.seats[node.threadId]?.through; if (after) turn.after = after; }
      const { text, through } = words(at.group, at.threadId, member, turn.after, again ? turn.through : undefined);
      if (through && !again) { turn.through = through; kept.seats[node.threadId] = { through, at: now() }; }
      kept.turns[node.id] = turn;
      save();
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
      const turn = kept.turns[child.id];
      if (turn) {
        // A turn that did not end with an answer was not heard: the next one starts where this one started.
        if (child.status !== "completed" && turn.composed && turn.through && kept.seats[turn.seat]?.through === turn.through) {
          if (turn.after) kept.seats[turn.seat] = { through: turn.after, at: now() }; else delete kept.seats[turn.seat];
        }
        delete kept.turns[child.id];
        save();
      }
      const group = store.group(at.groupId);
      if (!group || !owns(group, at.threadId)) return true;
      const member = store.bot(at.linked);
      const from = { botId: at.linked, name: nameOf(at.linked, name), color: member?.color ?? kept.members[at.linked]?.color ?? "blue" };
      const said = child.status === "completed" ? redactSecretsInText(child.result.trim()) : "";
      if (said) {
        // Posted under the assignment's id, so a report made twice (a restart between the two) leaves one line.
        const lines = store.activePath(at.threadId).length;
        store.appendMessage(at.threadId, { role: "bot", kind: "text", text: said, from }, { kind: "bot-link.room-reply", key: child.id });
        if (store.activePath(at.threadId).length === lines) return true;
        store.markGroupThreadUnread(group.id, at.threadId, true);
        const hop = turn?.hop ?? hopOf(parent?.id ?? child.parentId);
        if (member && !member.home?.gone && group.memberIds.includes(member.id) && hop < (deps.maxHops ?? 3)) {
          try { deps.follow?.(group.id, at.threadId, member, said, hop); } catch (error) { deps.log?.(`bot link: the mentions in ${from.name}'s answer were not followed (${String(error)})`); }
        }
        return true;
      }
      if (child.status === "cancelled") return true;
      note(at.threadId, at.linked, child.status === "completed" ? "server.rooms.linkedNoAnswer" : "server.rooms.linkedFailed",
        { receipt: child.id, ...(child.status !== "completed" && child.result.trim() ? { output: redactSecretsInText(child.result.trim()).slice(0, 2_000) } : {}) });
      return true;
    },

    sync,

    /** Whether any room here has a member from another place. */
    any: (): boolean => farIds().size > 0,

    /**
     * The far members of this place's rooms that cannot be reached now, as records to find them by: the link is off or
     * their place is not linked ("off"), or their place no longer has that bot ("missing"). They stay members, are named
     * as they were last known, and take no turn until they can be reached again.
     */
    absent(): FarRecord[] {
      const ids = farIds();
      if (ids.size === 0) return [];
      const live = new Set(deps.on() ? deps.linkedBots().map((one) => one.id) : []);
      return [...ids].filter((id) => !live.has(id)).map((id) => {
        const address = parseLinked(id), known = kept.members[id];
        return { ...(known ?? { name: "Teammate", place: address?.peer ?? "", placeName: "", botId: address?.botId ?? "" }), id,
          gone: deps.on() && address && deps.linked(address.peer) ? "missing" as const : "off" as const };
      });
    },

    /** A room's members from other places, for the app: who each is, where it lives, and whether it can be reached. */
    far(group: Pick<GroupRecord, "memberIds" | "dm">): Array<{ id: string; name: string; place: string; state: "ok" | FarGone }> {
      if (group.dm) return [];
      return group.memberIds.filter(isLinkedId).map((id) => { const bot = store.bot(id); return { id, name: nameOf(id), place: placeOf(id), state: bot?.home ? bot.home.gone ?? "ok" as const : "off" as const }; });
    },

    /** A place's link ended for good (it did not connect for the link's whole term): its bots leave the rooms here, and
     * each room says so once. Turning the link off, or a place being unlinked, removes nobody. */
    expired(peer: string, placeName: string): void {
      for (const group of store.groups) {
        if (group.dm) continue;
        const gone = group.memberIds.filter((id) => parseLinked(id)?.peer === peer);
        if (!gone.length) continue;
        const names = gone.map((id) => nameOf(id)).join(", ");
        store.patchGroup(group.id, { memberIds: group.memberIds.filter((id) => !gone.includes(id)) });
        store.appendMessage(group.threadId, { role: "bot", kind: "activity", tool: { name: deps.line(group.threadId, "server.rooms.linkedEnded", { bots: names, place: placeName }), ok: false } });
      }
      sync();
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
