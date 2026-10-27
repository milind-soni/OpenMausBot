import type { DefaultBotFields } from "../shared/default-bot.ts";

export type TeamRoleOf = (email: string) => "owner" | "admin" | "member" | null;

// Security invariant: a Team Cloud member's MausBot never holds more than its member. Until the server says how to read
// members' roles, and whenever it cannot find one, a member's MausBot holds no Chief powers.
let roleOf: TeamRoleOf = () => null;

export function readTeamRolesWith(resolver: TeamRoleOf): void {
  roleOf = resolver;
}

/** A Chief of Staff's powers: creating, configuring and deleting bots, rooms and routines through its tools, retrying a
 * teammate's thread, and its approval level passing down to the work it hands out. The Chief holds them, and so does the
 * person's MausBot (on a Team Cloud only when its member is an Owner or Admin). Being the Chief (the brief, incidents,
 * escalations, who answers a room) stays with `chiefOfStaff`. */
export function chiefLevel(bot: ({ chiefOfStaff?: boolean } & DefaultBotFields) | null | undefined): boolean {
  if (!bot) return false;
  if (bot.chiefOfStaff === true) return true;
  if (!bot.defaultBot) return false;
  const person = bot.defaultBot.person?.trim().toLowerCase();
  if (!person) return true;
  const role = roleOf(person);
  return role === "owner" || role === "admin";
}

type RoleBot = ({ chiefOfStaff?: boolean } & DefaultBotFields) | null | undefined;

/** The person's MausBot holding a Chief's powers: the only bot shown its notification tools. */
export function holdsMausBotTools<T extends NonNullable<RoleBot>>(bot: T | null | undefined): bot is T {
  return Boolean(bot?.defaultBot) && chiefLevel(bot);
}

/** The role switches a bot's agents tools are listed under: the Chief-only tools, and MausBot's notification pair. */
export function roleToolEnv(bot: RoleBot): { OMB_CHIEF_OF_STAFF: "1" | "0"; OMB_MAUSBOT: "1" | "0" } {
  return { OMB_CHIEF_OF_STAFF: chiefLevel(bot) ? "1" : "0", OMB_MAUSBOT: holdsMausBotTools(bot) ? "1" : "0" };
}
