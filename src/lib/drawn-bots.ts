import type { Bot } from "@/state/store";

const drawn = (bot: Bot) => [
  bot.id, bot.name, bot.hidden, bot.sidebarHidden, JSON.stringify(bot.defaultBot ?? null), bot.color, bot.mascotBody, bot.mascotExpression,
  bot.mascotFaceColor, bot.avatarUrl, bot.avatarCrop, bot.avatarZoom, bot.avatarFocusX, bot.avatarFocusY,
].join("\u0001");

/** For a reader that draws other bots only by name, look and whether they are shown: a turn changing none of that
 * keeps the earlier list, so the reader does not render again. */
export function sameDrawnBots(a: readonly Bot[], b: readonly Bot[]): boolean {
  return a.length === b.length && a.every((bot, i) => bot === b[i] || drawn(bot) === drawn(b[i]!));
}
