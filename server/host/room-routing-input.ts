// What the room router reads (decider/room-routing.ts): the room, its people and bots, and its recent lines, built here
// from the room so nothing secret or an attachment's markup leaves this machine.
import type { ResolvedSender } from "../../shared/wire.ts";
import type { RoomRoutingInput } from "../decider/room-routing.ts";
import { redactSecretsInText } from "../redact.ts";
import { speakerOf, type PersonName, type ReplyTarget } from "../replies.ts";
import type { BotRecord, GroupRecord, Message } from "../store.ts";
import { roomTurnNarrationIds } from "../room-reply.ts";
import { GROUP_CONTEXT_MESSAGES } from "./room-transcript.ts";
import { extractTurnImages } from "../turn-images.ts";

/** Scrubbed of secrets and attachment markup before it leaves this machine. */
export function roomRoutingInput(
  roomName: string,
  text: string,
  members: readonly BotRecord[],
  history: readonly Message[],
  userName: PersonName,
  sender?: ResolvedSender,
): RoomRoutingInput {
  const clean = (value: string) => redactSecretsInText(extractTurnImages(value).text);
  const humans = new Set<string>(typeof userName === "string" ? [userName] : []);
  const recent = history.flatMap((m) => {
    if (m.kind !== "text" || !m.text) return [];
    if (m.role === "user") {
      const person = speakerOf(userName, m);
      humans.add(person);
      return [{ from: person, text: clean(m.text) }];
    }
    return [{ from: `${m.from?.name ?? "A bot"} (bot)`, text: clean(m.text) }];
  });
  const from = speakerOf(userName, { sender });
  humans.add(from);
  return {
    room: roomName,
    humans: [...humans],
    members: members.map((member) => ({ id: member.id, name: member.name, title: member.title, description: member.description })),
    recent,
    message: { from, text: clean(text) },
  };
}

export function roomReplyBot(group: GroupRecord, replyTo: ReplyTarget | undefined, routableMembers: readonly BotRecord[]) {
  if (!group.dm && group.defaultResponder.kind === "auto" && replyTo?.role === "bot") {
    return routableMembers.find((member) => member.id === replyTo.from?.botId);
  }
}

export function roomRoutingHistory(
  messages: readonly Message[],
  excluded: Set<string>,
  queued?: readonly { rowId?: string }[],
): Message[] {
  for (const item of queued ?? []) {
    if (item.rowId) excluded.add(item.rowId);
  }
  const before = messages.filter((row) => !excluded.has(row.id));
  const narration = roomTurnNarrationIds(before);
  return before.filter((row) => row.kind === "text" && row.text && !narration.has(row.id)).slice(-GROUP_CONTEXT_MESSAGES);
}
