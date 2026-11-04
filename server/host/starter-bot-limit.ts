// A Starter Cloud's bots. Asked at each request, so a plan change counts at once, and only when a new bot is made: a bot that
// already exists never goes anywhere, whatever the plan says now.
import { BOT_LIMIT_CODE, botsTowardLimit, type BotLimitRefusal } from "../../shared/bot-limit.ts";

/** How many bots a Starter Cloud can make, not counting its MausBot. The one number to change. */
export const STARTER_BOT_LIMIT = 5;

export type BotLimitReader = "person" | "bot";

export interface BotLimit {
  /** The most bots this Cloud's plan makes; undefined when its plan has no such limit. */
  limit(): number | undefined;
  /** The answer to making `adding` more, in words for whoever reads them; null when they fit. */
  refusal(adding?: number, reader?: BotLimitReader): BotLimitRefusal | null;
}

function personWords(limit: number, room: number, adding: number): string {
  return room > 0
    ? `This adds ${adding} bots, and your Starter plan has room for ${room} more of its ${limit}. To add them all, upgrade this Cloud.`
    : `You've reached the ${limit} bots Starter includes. To create more, upgrade this Cloud.`;
}

function botWords(limit: number, room: number, adding: number): string {
  const fact = room > 0
    ? `This adds ${adding} bots, and this Cloud's Starter plan has room for ${room} more of its ${limit}`
    : `This Cloud's Starter plan includes ${limit} bots and has no room for another`;
  return `${fact}, so nothing was created. Explain this to the person in one line: to create more bots they need to upgrade this Cloud. Do not retry, and do not try to work around it.`;
}

export function createBotLimit(deps: { starter(): boolean; bots(): Parameters<typeof botsTowardLimit>[0] }): BotLimit {
  const limit = () => (deps.starter() ? STARTER_BOT_LIMIT : undefined);
  return {
    limit,
    refusal(adding = 1, reader = "person") {
      const most = limit();
      if (most === undefined) return null;
      const room = Math.max(0, most - botsTowardLimit(deps.bots()));
      if (adding <= room) return null;
      return { error: (reader === "bot" ? botWords : personWords)(most, room, adding), code: BOT_LIMIT_CODE };
    },
  };
}
