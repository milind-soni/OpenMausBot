import { botOwner, nameFromEmail, type OwnedBot } from "../../shared/bot-owner.ts";
import { personKey } from "../person-key.ts";

/** The name of the member who looks after a team bot, for a line the bot reads; null when nobody does. */
export function lookedAfterBy(bot: Pick<OwnedBot, "createdBy" | "reportsTo" | "defaultBot">, personName: (person: string) => string | undefined): string | null {
  const email = botOwner(bot);
  if (!email) return null;
  const name = personName(personKey({ id: "", email }));
  return name && name !== email ? name : nameFromEmail(email);
}
