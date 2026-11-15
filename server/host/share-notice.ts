// Sharing a team bot with a person tells that person, once, in their inbox: "Ada shared Quotes with you." Sharing with
// everyone tells nobody, and neither does adding someone who could already use the bot.
import { sharedLevel, type BotAccess } from "../../shared/bot-access.ts";
import { nameFromEmail } from "../../shared/bot-owner.ts";
import type { TeamRole } from "../cloud-team.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord, Store } from "../store.ts";
import type { Delivery } from "./person-inbox.ts";

export interface ShareNoticeDeps {
  /** The team's current members. */
  people(): ReadonlyArray<{ email: string; role: TeamRole }>;
  /** The name a member chose, when they chose one. */
  profileName(email: string): string | undefined;
  store(): Pick<Store, "tasks">;
  inbox(): { deliver(person: string, delivery: Delivery): unknown };
}

/** The members `after` lets use the bot who could not before: named one by one, never through "everyone", and never an
 * admin, who reaches every bot already. */
export function newlyShared(before: BotAccess, after: BotAccess, people: ReadonlyArray<{ email: string; role: TeamRole }>): string[] {
  return people.filter((person) => person.role === "member" && Object.hasOwn(after.people, person.email)
    && sharedLevel(before, person.email) === "none").map((person) => person.email);
}

export function createShareNotice(deps: ShareNoticeDeps) {
  return (auth: RequestAuth, bot: BotRecord, before: BotAccess, after: BotAccess): void => {
    const by = auth.kind === "session" ? auth.session.email?.trim().toLowerCase() : undefined;
    const name = by ? deps.profileName(by)?.trim() || nameFromEmail(by) : "An admin";
    const main = deps.store().tasks(bot.id).filter((task) => !task.routineRunId).sort((a, b) => a.createdAt - b.createdAt)[0];
    for (const email of newlyShared(before, after, deps.people())) {
      if (email === by) continue;
      deps.inbox().deliver(personKey({ id: "", email }), {
        kind: "notice", from: { name, ...(by ? { email: by } : {}) }, ...(main ? { origin: { botId: bot.id, threadId: main.threadId } } : {}),
        text: `${name} shared ${bot.name} with you.`, title: `${bot.name} is shared with you`, notify: "done",
      });
    }
  };
}
