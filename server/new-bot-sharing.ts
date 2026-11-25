// Who a bot is shared with as it is made. Security invariant: this is on the record before anyone is told the bot
// exists, so a bot that starts restricted is never shown to someone who may not see it.
import { visibilityFromAccess, type BotAccess } from "../shared/bot-access.ts";
import { ownerEmail } from "../shared/bot-owner.ts";
import type { BotVisibility } from "../shared/wire.ts";
import type { RequestAuth } from "./request-auth.ts";

export type NewBotSharing = { access?: BotAccess; visibility?: BotVisibility };

/** `asked` is what the request making the bot chose, if it chose; `owner` is who will look after the bot. */
export type NewBotSharingRule = (asked: BotVisibility | undefined, owner: string | null) => NewBotSharing;

const restricted = (asked: BotVisibility | undefined): NewBotSharing => (asked && asked !== "everyone" ? { visibility: structuredClone(asked) } : {});

/** Anywhere but a Team Cloud: everyone who can sign in, unless the request restricted it. */
export const sharedUnlessRestricted: NewBotSharingRule = (asked) => restricted(asked);

/** A Team Cloud: a bot is its owner's until they share it, as a document is. A request that says who sees it wins, and
 * is kept as it always was. */
export const privateUntilShared: NewBotSharingRule = (asked, owner) => {
  if (asked) return restricted(asked);
  const access: BotAccess = { everyone: "none", people: {} };
  return { access, visibility: visibilityFromAccess(access, owner) };
};

/** A bot another bot makes is shared exactly as its maker is: bots reach each other only with the same audience. */
export function sharedAsMaker(maker: NewBotSharing): NewBotSharing {
  return { ...restricted(maker.visibility), ...(maker.access === undefined ? {} : { access: structuredClone(maker.access) }) };
}

/** Who looks after a bot a profile is about to become. */
export const newBotOwner = (profile: { createdBy?: string; reportsTo?: string }): string | null => {
  const email = profile.reportsTo?.trim() || profile.createdBy?.trim();
  return email ? ownerEmail(email) : null;
};

/** The Team Cloud member behind a request, recorded as the one who made what it makes; nothing anywhere else. */
export function teamCreator(auth: RequestAuth): { createdBy?: string } {
  const email = auth.kind === "session" && auth.session.membershipAuthority === "team" ? auth.session.email : undefined;
  return email ? { createdBy: email } : {};
}
