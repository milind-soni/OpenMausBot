// A Team Cloud member's own bots: they delete one only while it is theirs alone. Once a bot is shared with anyone, or
// for any bot they do not look after, deleting stays with the admins, as it always was.
import { botOwner } from "../../shared/bot-owner.ts";
import { accessOf, type AccessBot } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";

export const SHARED_BOT_DELETE_REFUSAL = "Only an admin can delete a bot that is shared. Stop sharing it first, or ask an admin.";

/** Whether anyone but whoever looks after the bot is given it by its sharing. */
export function sharedBeyondOwner(bot: AccessBot): boolean {
  const access = accessOf(bot), owner = botOwner(bot);
  return access.everyone !== "none" || Object.keys(access.people).some((entry) => entry !== owner);
}

/** Why a session without the admin scope may not delete this bot; null for an admin, and for a team member's own bot
 * that nobody else can use. */
export function memberDeleteRefusal(auth: RequestAuth, bot: (AccessBot & { name: string }) | null | undefined, team: boolean): string | null {
  if (auth.kind !== "session" || auth.scopes.includes("admin")) return null;
  const email = team && auth.session.membershipAuthority === "team" ? auth.session.email?.trim().toLowerCase() : undefined;
  if (!email || !bot || botOwner(bot) !== email) return "forbidden: this session lacks the admin scope";
  return sharedBeyondOwner(bot) ? SHARED_BOT_DELETE_REFUSAL : null;
}
