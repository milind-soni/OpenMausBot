import type { DefaultBotFields } from "./default-bot.ts";

/** The code on a creation an older server refused, `409 { error, code }`, when Starter capped how many bots it made. No server
 * sends it now; clients still read it from one that does. `error` is plain text any client can show. */
export const BOT_LIMIT_CODE = "bot_limit";

/** The code on a turn refused because its bot is paused: a Starter Cloud keeps only so many bots awake. */
export const BOT_PAUSED_CODE = "bot_paused";

/** The bots a plan's awake limit counts. A place's MausBot comes with it; an archived bot or one that moved away isn't at work here. */
export function botsTowardLimit(bots: ReadonlyArray<Pick<DefaultBotFields, "defaultBot"> & { hidden?: boolean; movedTo?: unknown }>): number {
  return bots.filter((bot) => !bot.defaultBot && !bot.hidden && !bot.movedTo).length;
}
