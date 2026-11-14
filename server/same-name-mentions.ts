import { parseMentionPicks, resolveMentions } from "../shared/room-mentions.ts";
import { clip, peerName, sharedNameChoices } from "./peer-roster.ts";
import { serverLine } from "./server-lines.ts";

type Member = { id: string; name: string; title?: string; chiefOfStaff?: boolean; hidden?: boolean };

/** Why a person's line cannot go into this room: it @-tags a name several active members share and none of them was
 * picked from the @ list. Null when it can go. */
export function sameNameRefusal(
  text: string,
  members: readonly Member[],
  picked: readonly string[] | undefined,
  language: string | undefined,
): string | null {
  const [sharing] = resolveMentions(text, members, picked).ambiguous;
  if (!sharing) return null;
  const choices = sharing.map((bot) => {
    const name = clip(bot.name, 80);
    const role = clip(bot.title ?? "", 120) || (bot.chiefOfStaff ? serverLine(language, "server.rooms.sameName.chief") : "");
    return role ? serverLine(language, "server.rooms.sameName.choice", { name, role }) : name;
  });
  const name = clip(sharing[0]!.name, 80);
  return choices.length === 2
    ? serverLine(language, "server.rooms.sameName.two", { name, first: choices[0]!, second: choices[1]! })
    : serverLine(language, "server.rooms.sameName.many", { name, count: choices.length, choices: choices.join("; ") });
}

/** The same refusal for a bot or another app: each bot of that name with its id, so it sends again by id. `posted`: a
 * bot's post_to_room, which takes the ids in mention_ids; `sent`: a send to the room's messages, in mentions. */
export function sameNameRefusalForBots(
  text: string,
  members: readonly Member[],
  picked: readonly string[] | undefined,
  room: string,
  how: "posted" | "sent",
): string | null {
  const [sharing] = resolveMentions(text, members, picked).ambiguous;
  if (!sharing) return null;
  const again = how === "posted" ? "Post it again with the id of the one you mean in mention_ids." : "Send it again with the id of the one you mean in mentions.";
  return `${sharing.length} bots in the room "${peerName(room)}" are named "${peerName(sharing[0]!.name)}", so nothing was ${how}: ${sharedNameChoices(sharing)}. ${again}`;
}

/** A bot's post_to_room into a room: its mention_ids checked, then its @names. Null when it can go. */
export function roomPostRefusal(
  rawPicks: unknown,
  text: string,
  room: { name: string; memberIds: readonly string[] },
  bot: (id: string) => Member | null | undefined,
): { status: 400 | 409; error: string } | null {
  const picked = parseMentionPicks(rawPicks);
  if (picked === null) return { status: 400, error: "mention_ids must be a list of up to 20 bot ids" };
  const members = room.memberIds.map(bot).filter((member): member is Member => Boolean(member));
  const error = sameNameRefusalForBots(text, members, picked, room.name, "posted");
  return error ? { status: 409, error } : null;
}

/** What a person reads under a bot's room reply about @names it reached nobody with: a bot outside the room, or a name
 * several of the other members share. */
export function unreachedMentionLines(
  text: string,
  members: readonly Member[],
  outsiders: readonly Member[],
  language: string | undefined,
): string[] {
  const outside = resolveMentions(text, outsiders).bots
    .filter((bot, at, all) => all.findIndex((other) => other.name === bot.name) === at)
    .map((bot) => serverLine(language, "server.rooms.mentionMissed", { bot: bot.name }));
  const shared = resolveMentions(text, members).ambiguous
    .map((sharing) => serverLine(language, "server.rooms.sameNameMissed", { name: clip(sharing[0]!.name, 80) }));
  return [...outside, ...shared];
}

/** Told to a bot every turn in a room where other members share a name: who they are, by id, since an @mention of that
 * name reaches none of them. Empty when no name is shared. */
export function sharedNamesNote(others: readonly Member[], canCoordinate: boolean): string {
  const byName = new Map<string, Member[]>();
  for (const bot of others) {
    if (bot.hidden || !bot.name.trim()) continue;
    const key = bot.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), bot]);
  }
  const sharing = [...byName.values()].filter((group) => group.length > 1);
  if (!sharing.length) return "";
  const named = sharing.map((group) => `"${peerName(group[0]!.name)}" is ${sharedNameChoices(group)}`).join("; ");
  return `Some members here share a name, so an @mention of that name reaches none of them: ${named}.${canCoordinate ? " To bring one in, use coordinate_bots with its id." : ""}`;
}
