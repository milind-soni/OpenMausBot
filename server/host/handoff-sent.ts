import type { ModelSelection } from "../contracts.ts";
import { isServerLine, serverLine, type ServerLineKey } from "../server-lines.ts";
import type { Message } from "../store.ts";

export const WAIT_CARD_CLOSED_REASON = "The card it waited on was replaced or closed";

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

const LEVEL_WORDS = {
  default: "server.teammates.effort.default", none: "server.teammates.effort.none", low: "server.teammates.effort.low",
  medium: "server.teammates.effort.medium", high: "server.teammates.effort.high", xhigh: "server.teammates.effort.xhigh", max: "server.teammates.effort.max",
} as const satisfies Record<NonNullable<ModelSelection["effort"]> | "default", ServerLineKey>;

/** The model the work runs on, as the hand-off row names it, by the same rule as the app's own (src/lib/model-with-reasoning.ts):
 * its display name, with its reasoning level ("Opus 5 · High reasoning") only where the engine has a reasoning setting
 * and does not pick reasoning by model variant. */
export function modelWords(language: string | undefined, selection: ModelSelection, engine: { label?: string; levels?: readonly string[]; variants?: boolean } = {}): string {
  const model = engine.label || selection.model;
  if (engine.variants || !engine.levels?.length) return model;
  return serverLine(language, "server.teammates.onModel", { model, level: serverLine(language, LEVEL_WORDS[selection.effort ?? "default"]) });
}

/** `language`: the sender's conversation's, where the row is shown. `model`: the receiving thread's, from modelWords,
 * shown after the row's words. */
export function sentRow(input: { sender: Who; recipient: Who; threadId: string; title?: string; reason?: string; doneWhen?: string; room?: AddressedRoom; via: SentVia;
  language?: string; /** The files passed with it, shown as chips. */ attachments?: Message["attachments"]; model?: string }): Omit<Message, "id" | "at"> {
  const { sender, recipient, threadId, room, via, language } = input;
  const outside = room && via === "direct" ? room : undefined;
  const name = sender.id === recipient.id ? serverLine(language, "server.rooms.openedThread", { title: input.title ?? "" })
    : outside ? outside.here ? serverLine(language, "server.teammates.sentDirectlyHere", { bot: recipient.name })
    : serverLine(language, "server.teammates.sentDirectly", { bot: recipient.name, room: outside.name })
    : room && !room.here ? serverLine(language, "server.teammates.sentInRoom", { bot: recipient.name, room: room.name })
    : serverLine(language, "server.teammates.sent", { bot: recipient.name });
  return {
    role: "bot", kind: "activity",
    from: { botId: sender.id, name: sender.name, color: sender.color },
    tool: {
      name,
      ok: true, ...(input.reason ? { output: input.reason } : {}), ...(input.model && sender.id !== recipient.id ? { assignedModel: input.model } : {}),
    },
    ...(input.doneWhen ? { doneWhen: input.doneWhen } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
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
  const detail = child.status === "cancelled" && isServerLine("server.teammates.waitCardClosed", child.result)
    ? serverLine(language, "server.teammates.waitCardClosed") : child.result;
  return serverLine(language, key, { bot, status: child.status, detail: detail.split("\n", 1)[0]!.slice(0, 180) });
}
