// A Team Cloud bot's owner: the member it reports to. Its questions, approvals, failures and routine results reach that
// member's inbox, and that member's Chief of Staff coordinates it. Off a team no bot carries these fields.

export interface OwnedBot {
  section?: string;
  chiefOfStaff?: boolean;
  createdBy?: string;
  reportsTo?: string;
  /** A Team Cloud member's own MausBot is theirs, whoever else it might be said to report to. */
  defaultBot?: { person?: string };
}

export const ownerEmail = (email: string): string => email.trim().toLowerCase();

/** Who the bot reports to: a member's own MausBot its member, else `reportsTo`, else whoever created it; null for a bot
 * nobody owns, whose asks go to the Admins. */
export function botOwner(bot: Pick<OwnedBot, "createdBy" | "reportsTo" | "defaultBot">): string | null {
  const email = bot.defaultBot?.person?.trim() || bot.reportsTo?.trim() || bot.createdBy?.trim();
  return email ? ownerEmail(email) : null;
}

/** One Chief of Staff per key: a bot someone owns is its owner's Chief, any other one its department's. */
export function chiefScope(bot: OwnedBot): string {
  const owner = botOwner(bot);
  return owner ? `owner:${owner}` : `section:${bot.section?.trim() || ""}`;
}

/** Two Chiefs of Staff in one scope: the same owner on a Team Cloud, the same department anywhere else. */
export function chiefConflict(bots: readonly OwnedBot[]): boolean {
  const seen = new Set<string>();
  for (const bot of bots) {
    if (!bot.chiefOfStaff) continue;
    const scope = chiefScope(bot);
    if (seen.has(scope)) return true;
    seen.add(scope);
  }
  return false;
}

/** `chief` takes the crown of its scope: every other Chief there gives it up. */
export function withOneChief<T extends OwnedBot & { id: string }>(bots: readonly T[], chief: OwnedBot & { id: string }): T[] {
  const scope = chiefScope(chief);
  return bots.map((bot) => (bot.id === chief.id || !bot.chiefOfStaff || chiefScope(bot) !== scope ? bot : { ...bot, chiefOfStaff: false }));
}

/** A member's name until their profile has one: the address before the @, capitalised. */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0]?.replace(/[._-]+/g, " ").trim() || email;
  return local.replace(/(^|\s)(\p{L})/gu, (_match, space: string, letter: string) => `${space}${letter.toUpperCase()}`);
}
