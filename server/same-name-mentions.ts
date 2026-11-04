import { resolveMentions } from "../shared/room-mentions.ts";
import { clip } from "./peer-roster.ts";
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
