import { blankCode } from "../../shared/skill-command";
import type { MausColor } from "./mascot";
import { mentionRanges, type MentionPeer } from "./mentions";
import { replyAuthor } from "./replies";
import type { Bot, Message } from "@/state/store";

export type RoomAddressee = { key: string; name: string; color?: MausColor };

/** Who a bot's room message speaks to: the author of the message it replies to, then the room bots it @mentions.
 * The sender itself is never listed. A tag a teammate takes (a tie with a bot's name is the teammate's, as the server
 * reads it) names no bot. */
export function roomAddressees(
  message: Pick<Message, "text" | "replyToId" | "from">,
  members: readonly Pick<Bot, "id" | "name" | "color">[],
  transcript: readonly Message[],
  teammates: readonly MentionPeer[] = [],
): RoomAddressee[] {
  const sender = message.from?.botId;
  const out: RoomAddressee[] = [];
  const add = (entry: RoomAddressee) => {
    if (entry.key !== sender && !out.some((seen) => seen.key === entry.key)) out.push(entry);
  };
  const target = message.replyToId ? transcript.find((candidate) => candidate.id === message.replyToId) : undefined;
  if (target?.role === "user") add({ key: `user:${replyAuthor(target)}`, name: replyAuthor(target) });
  else if (target?.from) add({ key: target.from.botId, name: target.from.name, color: target.from.color });
  const text = message.text ?? "";
  if (!text.includes("@")) return out;
  for (const range of mentionRanges(blankCode(text), [...members, ...teammates])) {
    if (range.person) continue;
    const name = text.slice(range.start + 1, range.end).toLowerCase();
    const bot = members.find((member) => member.name.toLowerCase() === name);
    if (bot) add({ key: bot.id, name: bot.name, color: bot.color });
  }
  return out;
}
