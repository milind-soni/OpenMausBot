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

export function sentRow(input: { sender: Who; recipient: Who; threadId: string; title?: string; reason?: string; doneWhen?: string; room?: AddressedRoom; via: SentVia }): Omit<Message, "id" | "at"> {
  const { sender, recipient, threadId, room, via } = input;
  const outside = room && via === "direct" ? room : undefined;
  return {
    role: "bot", kind: "activity",
    from: { botId: sender.id, name: sender.name, color: sender.color },
    tool: {
      name: outside ? `Sent to ${recipient.name} directly: it isn't in ${roomWords(outside)}.` : `Sent to ${recipient.name}${room && !room.here ? ` · ${room.name}` : ""}`,
      ok: true, ...(input.reason ? { output: input.reason } : {}),
    },
    ...(input.doneWhen ? { doneWhen: input.doneWhen } : {}),
    ...(outside ? { sentDirectly: { name: recipient.name, ...(outside.here ? {} : { room: outside.name }) } } : {}),
    ...(room && via === "room"
      ? { comm: { groupId: room.id, threadId, withBotId: recipient.id, withName: recipient.name, withColor: recipient.color } }
      : { threadRef: { botId: recipient.id, threadId, title: input.title ?? "Teammate work" } }),
  };
}
