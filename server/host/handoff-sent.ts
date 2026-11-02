import { serverLine } from "../server-lines.ts";
import type { Message } from "../store.ts";

type Who = { id: string; name: string; color: string };

/** The room a hand-off was addressed to; `here` when it is the conversation the sender speaks from. */
export type AddressedRoom = { id: string; name: string; here: boolean };

/** "room": into the room's conversation; "lane": a thread of the member's own beside the room; "direct": a thread of the
 *  bot's own, which for an addressed room means the bot isn't one of its members. */
export type SentVia = "room" | "lane" | "direct";

const roomWords = (room: AddressedRoom) => room.here ? "this room" : room.name;

export function outsideRoomNote(room: AddressedRoom | undefined, via: SentVia): string {
  return room && via === "direct" ? `it isn't in ${roomWords(room)}, so it got this directly: ` : "";
}

/** `language`: the sender's conversation's, where the row is shown. */
export function sentRow(input: { sender: Who; recipient: Who; threadId: string; title?: string; reason?: string; doneWhen?: string; room?: AddressedRoom; via: SentVia;
  language?: string }): Omit<Message, "id" | "at"> {
  const { sender, recipient, threadId, room, via, language } = input;
  const outside = room && via === "direct" ? room : undefined;
  const name = outside ? outside.here ? serverLine(language, "server.teammates.sentDirectlyHere", { bot: recipient.name })
    : serverLine(language, "server.teammates.sentDirectly", { bot: recipient.name, room: outside.name })
    : room && !room.here ? serverLine(language, "server.teammates.sentInRoom", { bot: recipient.name, room: room.name })
    : serverLine(language, "server.teammates.sent", { bot: recipient.name });
  return {
    role: "bot", kind: "activity",
    from: { botId: sender.id, name: sender.name, color: sender.color },
    tool: {
      name,
      ok: true, ...(input.reason ? { output: input.reason } : {}),
    },
    ...(input.doneWhen ? { doneWhen: input.doneWhen } : {}),
    ...(outside ? { sentDirectly: { name: recipient.name, ...(outside.here ? {} : { room: outside.name }) } } : {}),
    ...(room && via === "room"
      ? { comm: { groupId: room.id, threadId, withBotId: recipient.id, withName: recipient.name, withColor: recipient.color } }
      : { threadRef: { botId: recipient.id, threadId, title: input.title ?? serverLine(language, "server.teammates.teammateWork") } }),
  };
}

/** The row a requester's conversation shows when a teammate's work comes back, in that conversation's language. */
export function teammateResultRow(language: string | undefined, child: { status: string; result: string; groupId?: string }, botName: string | undefined,
  problem: string | null | undefined, roomName: string | undefined): string {
  if (problem) return serverLine(language, "server.teammates.resultWithheld", { problem });
  const bot = botName ?? serverLine(language, "server.teammates.teammate");
  if (child.status === "completed") {
    return child.groupId ? serverLine(language, "server.teammates.repliedInRoom", { bot, room: roomName || serverLine(language, "server.teammates.room") })
      : serverLine(language, "server.teammates.replied", { bot });
  }
  const key = child.status === "failed" ? "server.teammates.failed" : child.status === "cancelled" ? "server.teammates.cancelled" : "server.teammates.other";
  return serverLine(language, key, { bot, status: child.status, detail: child.result.split("\n", 1)[0]!.slice(0, 180) });
}
