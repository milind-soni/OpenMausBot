// A server of one person's own lends their computer only to a conversation they started with their own message
// (shared-computers.ts provenRequestPerson). Any other conversation (one a bot, a routine or a webhook started, say) used to
// get an empty list, which reads exactly like a computer that is off: it now gets why, for the bot and for the
// person, in one line each. Only on a server nobody else signs in to, so nobody learns of another person's computer.
import { theirComputer } from "./lent-computers.ts";
import type { LentPlatform } from "./lent-computers.ts";

/** `lent`: the computers the one owner lends this server now; none, and there is nothing to explain. */
export function ownServerLendingRefusal(lent: ReadonlyArray<{ name: string; platform: LentPlatform | null }>): { unavailable: string; say: string } | null {
  if (!lent.length) return null;
  const { theirs, device } = theirComputer(lent);
  return {
    unavailable: `This conversation can't use ${theirs}: it is lent, and not offline, but only a conversation the person started themselves, with their own message, can use it. Tell them so in one sentence with the say field, and don't use another place instead unless they ask.`,
    say: `Only a conversation you start yourself can use your ${device}. Ask for it in a new conversation with this bot.`,
  };
}
