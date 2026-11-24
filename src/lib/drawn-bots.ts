import type { Bot } from "@/state/store";

const drawn = (bot: Bot) => [
  // title and chiefOfStaff: the @-mention menu describes each bot by them.
  bot.id, bot.name, bot.title, bot.chiefOfStaff, bot.hidden, bot.sidebarHidden, JSON.stringify(bot.defaultBot ?? null), bot.color, bot.mascotBody, bot.mascotExpression,
  bot.mascotFaceColor, bot.mascotBodyColor, bot.mascotMaterial, bot.avatarUrl, bot.avatarCrop, bot.avatarZoom, bot.avatarFocusX, bot.avatarFocusY,
].join("\u0001");

/** Whether two versions of a bot look the same wherever it is drawn by name and avatar. */
export function sameDrawnBot(a: Bot, b: Bot): boolean {
  return a === b || drawn(a) === drawn(b);
}

/** For a reader that draws other bots only by name, look and whether they are shown: a turn changing none of that
 * keeps the earlier list, so the reader does not render again. */
export function sameDrawnBots(a: readonly Bot[], b: readonly Bot[]): boolean {
  return a.length === b.length && a.every((bot, i) => sameDrawnBot(bot, b[i]!));
}
