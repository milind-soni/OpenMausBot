import { botOwner } from "../../shared/bot-owner";
import type { Bot } from "@/state/store";
import { sharedWithOthers } from "@/state/team-side";

type MenuBot = Pick<Bot, "yourAccess" | "access" | "visibility" | "createdBy" | "reportsTo" | "defaultBot">;

/** What a team's User is offered in a bot's menu beyond chatting: a copy of a bot they can edit, and Delete for a bot
 * they look after, which is an admin's once the bot is shared ("shared": shown, with why it can't be done). The server
 * holds the same rule. */
export function userBotMenu(bot: MenuBot, me: string | undefined): { duplicate: boolean; delete: "own" | "shared" | null } {
  const mine = Boolean(me) && !bot.defaultBot && botOwner(bot) === me;
  return { duplicate: bot.yourAccess === "edit" && !bot.defaultBot, delete: !mine ? null : sharedWithOthers(bot) ? "shared" : "own" };
}
