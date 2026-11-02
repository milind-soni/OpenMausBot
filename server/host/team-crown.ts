// On a Team Cloud a person's own MausBot is their Chief and holds their inbox, so no other bot someone owns is crowned
// beside it; a bot nobody owns can still be its department's Chief. A crown given before this rule stays as it is.
import { botOwner, type OwnedBot } from "../../shared/bot-owner.ts";

/** Why this PATCH may not crown `bot` on a team, or null. */
export function teamCrownRefusal(team: boolean, bot: (OwnedBot & { name: string; chiefOfStaff?: boolean }) | null, body: { chiefOfStaff?: unknown }): string | null {
  if (!team || body.chiefOfStaff !== true || !bot || bot.chiefOfStaff || bot.defaultBot?.person || !botOwner(bot)) return null;
  return `${bot.name} can't be made a Chief of Staff on a team: each person's own MausBot already looks after their bots and holds their inbox.`;
}
